import type * as vscode from 'vscode';
import type {
    AgentEvent, AgentInfo, AgentUsage, PlannedGroup, ReasoningEffort,
} from '../types';

/**
 * The small surface the extension uses to write to the output channel.
 * Tests replace it with a plain object that records the messages.
 */
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
    trace(message: string): void;
    show(): void;
}

export interface OutputLogger extends Logger, vscode.Disposable {
    readonly channel: vscode.LogOutputChannel;
}

export const NOOP_LOGGER: Logger = {
    info: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
    trace: () => { },
    show: () => { },
};

/** Replaces an authorization token that an error message happened to echo. */
export function redactSecrets(message: string): string {
    return message.replace(/\bBearer\s+\S+/gi, 'Bearer ***');
}

export function createOutputLogger(): OutputLogger {
    // Required lazily so the formatting helpers stay importable in plain Node tests.
    const vscodeApi = require('vscode') as typeof vscode;
    const channel = vscodeApi.window.createOutputChannel(
        'AutoCommit For DeepSeek',
        { log: true }
    );
    return {
        channel,
        info: (message) => channel.info(redactSecrets(message)),
        warn: (message) => channel.warn(redactSecrets(message)),
        error: (message) => channel.error(redactSecrets(message)),
        debug: (message) => channel.debug(redactSecrets(message)),
        trace: (message) => channel.trace(redactSecrets(message)),
        show: () => channel.show(true),
        dispose: () => channel.dispose(),
    };
}

// ─── Run lines ───────────────────────────────────────────────────────────────

export interface RunStartLog {
    trigger: 'generate' | 'retry';
    repo: string;
    files: number;
    model: string;
    effort: ReasoningEffort | '';
    baseUrl: string;
    concurrency: number;
    language: string;
    minCommits: number;
    maxCommits: number;
    headerNames: string[];
    groupIndex?: number;
}

export function formatRunStart(run: RunStartLog): string {
    const effort = run.effort || 'endpoint default';
    const headers = run.headerNames.length > 0 ? run.headerNames.join(', ') : '(none)';
    const group = run.groupIndex === undefined ? '' : ` · group #${run.groupIndex}`;
    const prefix = run.trigger === 'retry' ? 'Retry started' : 'Run started';
    return `${prefix} · repo ${run.repo} · ${run.files} staged files${group} · ` +
        `model ${run.model || 'deepseek-flash'} · effort ${effort} · baseUrl ${run.baseUrl} · ` +
        `concurrency ${run.concurrency} · language ${run.language} · ` +
        `commits ${formatCommitRange(run.minCommits, run.maxCommits)} · headers ${headers}`;
}

function formatCommitRange(minCommits: number, maxCommits: number): string {
    if (minCommits <= 0 && maxCommits <= 0) { return 'no limit'; }
    if (minCommits <= 0) { return `up to ${maxCommits}`; }
    if (maxCommits <= 0) { return `at least ${minCommits}`; }
    return `${minCommits}-${maxCommits}`;
}

export function formatGroups(groups: PlannedGroup[]): string {
    const lines = [`Grouped ${groups.length} group${groups.length === 1 ? '' : 's'}`];
    for (const group of groups) {
        lines.push(`#${group.index} ${group.label} (${group.files.length} files)`);
    }
    return lines.join('\n');
}

export interface RunTotalsLog {
    requests: number;
    promptTokens: number;
    cacheHitTokens: number;
    reasoningTokens: number;
    completionTokens: number;
}

export function formatRunFinished(
    status: 'done' | 'cancelled' | 'declined' | 'error',
    durationMs: number,
    totals: RunTotalsLog,
): string {
    return `Run ended · ${status} · ${formatDuration(durationMs)} · ` +
        `${totals.requests} request${totals.requests === 1 ? '' : 's'} · ` +
        `in ${formatCount(totals.promptTokens)} (${cachePercent(totals)}% cached) · ` +
        `think ${formatCount(totals.reasoningTokens)} · ` +
        `out ${formatCount(Math.max(0, totals.completionTokens - totals.reasoningTokens))}`;
}

// ─── Agent lines ─────────────────────────────────────────────────────────────

export function formatAgentStarted(agent: AgentInfo): string {
    return `[${agent.id}] queued ${agent.kind} "${agent.label}"`;
}

export function formatAgentFinished(agent: AgentInfo, finishedAt: number, usage?: AgentUsage): string {
    const base = `[${agent.id}] done ${agent.kind} "${agent.label}" ` +
        `${formatDuration(Math.max(0, finishedAt - agent.queuedAt))}`;
    if (!usage) { return base; }
    const output = Math.max(0, usage.completionTokens - usage.reasoningTokens);
    return `${base} · in ${formatCount(usage.promptTokens)} ` +
        `(${cachePercent(usage)}% cached) · think ${formatCount(usage.reasoningTokens)} · ` +
        `out ${formatCount(output)}`;
}

export function formatAgentFailed(agent: AgentInfo, error: string): string {
    return `[${agent.id}] failed ${agent.kind} "${agent.label}" · ${redactSecrets(error)}`;
}

export function formatAgentCancelled(agent: AgentInfo): string {
    return `[${agent.id}] cancelled ${agent.kind} "${agent.label}"`;
}

/** Writes one line per agent lifecycle event, keeping the label from `started`. */
export class AgentLog {
    private readonly agents = new Map<string, AgentInfo>();

    constructor(private readonly logger: Logger) { }

    handle(event: AgentEvent): void {
        switch (event.type) {
            case 'started':
                this.agents.set(event.agent.id, event.agent);
                this.logger.debug(formatAgentStarted(event.agent));
                break;
            case 'update':
                if (event.note) {
                    this.logger.warn(`[${event.id}] ${redactSecrets(event.note)}`);
                }
                break;
            case 'finished': {
                const agent = this.agents.get(event.id);
                if (!agent) { break; }
                this.agents.delete(event.id);
                if (event.status === 'done') {
                    this.logger.info(formatAgentFinished(agent, event.finishedAt, event.usage));
                } else if (event.status === 'failed') {
                    this.logger.error(formatAgentFailed(agent, event.error ?? 'Unknown error'));
                } else {
                    this.logger.debug(formatAgentCancelled(agent));
                }
                break;
            }
        }
    }

    clear(): void {
        this.agents.clear();
    }
}

export function formatError(prefix: string, error: unknown): string {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    return `${prefix}: ${redactSecrets(message)}`;
}

// ─── Number formatting ───────────────────────────────────────────────────────

export function formatCount(value: number): string {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (safe < 1000) { return String(Math.round(safe)); }
    const scaled = safe / 1000;
    if (scaled < 10) {
        return `${scaled.toFixed(1).replace(/\.0$/, '')}k`;
    }
    return `${Math.round(scaled)}k`;
}

export function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, milliseconds) / 1000;
    if (seconds < 10) {
        return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
    }
    return `${Math.round(seconds)}s`;
}

function cachePercent(usage: { promptTokens: number; cacheHitTokens: number }): number {
    if (usage.promptTokens <= 0) { return 0; }
    return Math.round((usage.cacheHitTokens / usage.promptTokens) * 100);
}
