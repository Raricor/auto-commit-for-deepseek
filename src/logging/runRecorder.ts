import { appendFile, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type {
    AgentEvent, AgentInfo, AgentUsage, CommitCandidate, NoticeLevel, PlannedGroup,
} from '../types';
import type { Logger } from './logger';
import { redactSecrets } from './logger';

export type RunTrigger = 'generate' | 'retry';
export type RunStatus = 'done' | 'cancelled' | 'declined' | 'error';

export interface RunTotals {
    requests: number;
    promptTokens: number;
    cacheHitTokens: number;
    reasoningTokens: number;
    completionTokens: number;
}

export interface RunRecorderConfig {
    /** Directory that holds the JSONL files; usually <globalStorage>/runs. */
    directory: string;
    trigger: RunTrigger;
    repo: string;
    files: number;
    model: string;
    baseUrl: string;
    effort: string;
    concurrency: number;
    language: string;
    conventionalCommits: boolean;
    minCommits: number;
    maxCommits: number;
    headerNames: string[];
    groupIndex?: number;
    keep: number;
    includePrompts: boolean;
    logger?: Pick<Logger, 'warn'>;
}

interface AgentState {
    info: AgentInfo;
    reasoning: string;
    content: string;
    notes: string[];
    prompt?: string;
}

type JsonRecord = Record<string, unknown>;

/**
 * Appends one run to a JSONL file while the generation runs. Writes are
 * serialized and failures only produce a warning, so recording can never break
 * a generation.
 */
export class RunRecorder {
    private readonly startedAt = Date.now();
    private readonly directory: string;
    private readonly keep: number;
    private readonly includePrompts: boolean;
    private readonly logger?: Pick<Logger, 'warn'>;
    private readonly states = new Map<string, AgentState>();
    private readonly totals: Omit<RunTotals, 'requests'> = {
        promptTokens: 0,
        cacheHitTokens: 0,
        reasoningTokens: 0,
        completionTokens: 0,
    };
    private requests = 0;
    private queue: Promise<void> = Promise.resolve();
    private filePath: string | undefined;
    private readonly disabled: boolean;
    private closed = false;
    private closePromise: Promise<RunTotals> | undefined;

    constructor(config: RunRecorderConfig) {
        this.directory = config.directory;
        this.keep = Math.max(0, Math.min(200, Math.floor(config.keep)));
        this.includePrompts = config.includePrompts;
        this.logger = config.logger;
        this.disabled = this.keep === 0;
        if (this.disabled) { return; }

        this.filePath = join(
            this.directory,
            runFileName(new Date(this.startedAt), config.repo, config.trigger),
        );
        const run: JsonRecord = {
            type: 'run',
            startedAt: new Date(this.startedAt).toISOString(),
            trigger: config.trigger,
            repo: config.repo,
            files: config.files,
            model: config.model,
            baseUrl: config.baseUrl,
            effort: config.effort,
            concurrency: config.concurrency,
            language: config.language,
            conventionalCommits: config.conventionalCommits,
            minCommits: config.minCommits,
            maxCommits: config.maxCommits,
            headerNames: config.headerNames,
            ...(config.groupIndex === undefined ? {} : { groupIndex: config.groupIndex }),
        };
        this.queue = this.queue
            .then(() => this.createFile(run))
            .catch((error) => {
                this.filePath = undefined;
                this.warn(`Could not create a run record: ${errorText(error)}`);
            });
    }

    get path(): string | undefined {
        return this.filePath;
    }

    get elapsedMs(): number {
        return Date.now() - this.startedAt;
    }

    totalsSoFar(): RunTotals {
        return { requests: this.requests, ...this.totals };
    }

    recordGroups(groups: PlannedGroup[]): void {
        this.append({
            type: 'groups',
            groups: groups.map((group) => ({
                index: group.index,
                label: group.label,
                files: group.files,
            })),
        });
    }

    recordCandidate(groupIndex: number, candidate: CommitCandidate): void {
        this.append({
            type: 'candidate',
            groupIndex,
            id: candidate.id,
            message: candidate.message,
            reason: candidate.reason,
            files: candidate.files,
        });
    }

    recordGroupFailed(groupIndex: number, message: string): void {
        this.append({
            type: 'groupFailed',
            groupIndex,
            message: redactSecrets(message),
        });
    }

    recordNotice(level: NoticeLevel, message: string): void {
        this.append({ type: 'notice', level, message: redactSecrets(message) });
    }

    recordReorder(ids: string[]): void {
        this.append({ type: 'reorder', ids });
    }

    /** Stores the full prompt only when the user opted in; never sent to the webview. */
    onAgentPrompt(id: string, prompt: string): void {
        if (this.closed || this.disabled || !this.includePrompts) { return; }
        const state = this.states.get(id);
        if (state) { state.prompt = prompt; }
    }

    onAgentEvent(event: AgentEvent): void {
        if (this.closed || this.disabled) { return; }
        switch (event.type) {
            case 'started':
                this.requests += 1;
                this.states.set(event.agent.id, {
                    info: event.agent,
                    reasoning: '',
                    content: '',
                    notes: [],
                });
                break;
            case 'update': {
                const state = this.states.get(event.id);
                if (!state) { break; }
                if (event.reset) {
                    state.reasoning = '';
                    state.content = '';
                }
                if (event.reasoning) { state.reasoning += event.reasoning; }
                if (event.content) { state.content += event.content; }
                if (event.note) { state.notes.push(redactSecrets(event.note)); }
                break;
            }
            case 'finished': {
                const state = this.states.get(event.id);
                if (!state) { break; }
                this.states.delete(event.id);
                if (event.usage) {
                    this.totals.promptTokens += event.usage.promptTokens;
                    this.totals.cacheHitTokens += event.usage.cacheHitTokens;
                    this.totals.reasoningTokens += event.usage.reasoningTokens;
                    this.totals.completionTokens += event.usage.completionTokens;
                }
                this.append(this.agentRecord(state, {
                    status: event.status,
                    finishedAt: new Date(event.finishedAt).toISOString(),
                    durationMs: Math.max(0, event.finishedAt - state.info.queuedAt),
                    ...(event.usage === undefined ? {} : { usage: event.usage }),
                    ...(event.error === undefined ? {} : { error: redactSecrets(event.error) }),
                }));
                break;
            }
        }
    }

    /**
     * Writes synthetic cancelled rows for agents that never finished, then the
     * end row. Later events are ignored.
     */
    close(status: RunStatus, error?: string): Promise<RunTotals> {
        if (this.closePromise) { return this.closePromise; }
        this.closed = true;
        this.closePromise = (async (): Promise<RunTotals> => {
            if (!this.disabled) {
                const finishedAt = Date.now();
                for (const state of this.states.values()) {
                    this.append(this.agentRecord(state, {
                        status: 'cancelled',
                        finishedAt: new Date(finishedAt).toISOString(),
                        durationMs: Math.max(0, finishedAt - state.info.queuedAt),
                        incomplete: true,
                    }), true);
                }
                this.states.clear();
                this.append({
                    type: 'end',
                    status,
                    ...(error === undefined ? {} : { error: redactSecrets(error) }),
                    finishedAt: new Date(finishedAt).toISOString(),
                    durationMs: Math.max(0, finishedAt - this.startedAt),
                    totals: { requests: this.requests, ...this.totals },
                }, true);
            }
            await this.queue;
            return { requests: this.requests, ...this.totals };
        })();
        return this.closePromise;
    }

    private agentRecord(state: AgentState, tail: JsonRecord): JsonRecord {
        return {
            type: 'agent',
            ...state.info,
            ...tail,
            notes: state.notes,
            reasoning: state.reasoning,
            content: state.content,
            ...(this.includePrompts && state.prompt !== undefined
                ? { prompt: state.prompt }
                : {}),
        };
    }

    private append(record: JsonRecord, force = false): void {
        if (this.disabled || (this.closed && !force)) { return; }
        // Serialize now so the accumulated text can be released right away.
        const line = `${JSON.stringify({ v: 1, ...record })}\n`;
        this.queue = this.queue
            .then(async () => {
                if (!this.filePath) { return; }
                await appendFile(this.filePath, line, 'utf8');
            })
            .catch((error) => {
                this.warn(`Could not write a run record: ${errorText(error)}`);
            });
    }

    private async createFile(run: JsonRecord): Promise<void> {
        await mkdir(this.directory, { recursive: true });
        const base = this.filePath!;
        const extension = extname(base);
        const stem = base.slice(0, -extension.length);
        let candidate = base;
        let suffix = 1;
        const line = `${JSON.stringify({ v: 1, ...run })}\n`;
        for (;;) {
            try {
                await writeFile(candidate, line, { encoding: 'utf8', flag: 'wx' });
                this.filePath = candidate;
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
                candidate = `${stem}-${suffix++}${extension}`;
            }
        }
        await this.prune();
    }

    /** Keeps the newest `keep` files, oldest first by file name. */
    private async prune(): Promise<void> {
        let names: string[];
        try {
            names = (await readdir(this.directory, { withFileTypes: true }))
                .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
                .map((entry) => entry.name)
                .sort();
        } catch (error) {
            this.warn(`Could not list run records: ${errorText(error)}`);
            return;
        }
        const excess = names.length - this.keep;
        for (let index = 0; index < excess; index++) {
            try {
                await unlink(join(this.directory, names[index]));
            } catch (error) {
                this.warn(`Could not delete an old run record: ${errorText(error)}`);
            }
        }
    }

    private warn(message: string): void {
        try {
            this.logger?.warn(message);
        } catch {
            // Logging a write failure must not surface as a generation failure.
        }
    }
}

export function runFileName(date: Date, repo: string, trigger: RunTrigger): string {
    return `${timestampForFile(date)}-${sanitizeRepoName(repo)}-${trigger}.jsonl`;
}

function timestampForFile(date: Date): string {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeRepoName(repo: string): string {
    const safe = repo.replace(/[^A-Za-z0-9._-]/g, '_');
    return safe || 'repo';
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
