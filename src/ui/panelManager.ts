import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { resolveApiKey } from '../config/apiKey';
import {
    getEndpointSettings, getRunLogSettings, getSettings, updateSettings,
} from '../config/settings';
import { createDeepSeekModel, listModels, MODEL_PRESETS } from '../deepseek';
import { parseDiff, resolveStagingPaths } from '../git/diffAnalyzer';
import { GitIdentityError } from '../git/gitIdentity';
import { GitService } from '../git/gitService';
import {
    AgentLog, formatError, formatGroups, formatRunFinished, formatRunStart,
    redactSecrets, type Logger, NOOP_LOGGER,
} from '../logging/logger';
import {
    RunRecorder, type RunRecorderConfig, type RunStatus, type RunTotals,
} from '../logging/runRecorder';
import { ModelError } from '../llm/chatModel';
import {
    generateCommits,
    generateForGroup,
    type RequestEstimate,
} from '../llm/llmService';
import type {
    CommitCandidate,
    EndpointStatus,
    ExtensionMessage,
    FileChange,
    GenerateOptions,
    GitLogEntry,
    PlannedGroup,
    StagedFileInfo,
    WebviewMessage,
} from '../types';
import { AgentBatcher } from './agentBatcher';

type ModelInfo = { id: string; name: string };

/** Keep one stagedFiles message small enough for the webview to handle. */
const MAX_STAGED_DIFF_LENGTH = 1024 * 1024;

const PANEL_TITLE = 'AutoCommit For DeepSeek';
const PANEL_VIEW_TYPE = 'autocommit-for-deepseek';
const EXTENSION_ID = 'winterYANGWT.autocommit-for-deepseek';
const MISSING_API_KEY_MESSAGE =
    'No DeepSeek API key. Run "AutoCommit For DeepSeek: Set API Key" or set DEEPSEEK_API_KEY.';
const AUTH_API_KEY_MESSAGE =
    'DeepSeek rejected the API key. Run "AutoCommit For DeepSeek: Set API Key" or set DEEPSEEK_API_KEY.';
const SET_API_KEY_ACTION = 'Set API Key';

export class PanelManager {
    private static instance: PanelManager | undefined;

    private panel: vscode.WebviewPanel | undefined;
    private candidates: CommitCandidate[] = [];
    private fileDiffs: Map<string, string> = new Map();
    private fileChanges: FileChange[] = [];
    private sessionLanguage: string | undefined;
    private cancellation: vscode.CancellationTokenSource | undefined;
    private currentRepoRoot: string | undefined;
    private targetRepoUri: vscode.Uri | undefined;
    private recentCommits: GitLogEntry[] = [];
    private availableModels: ModelInfo[] | undefined;
    private agentBatcher: AgentBatcher | undefined;
    private generationRunId = 0;
    private generating = false;
    private retrying = false;
    private generationTree: string | undefined;
    private lastRun: { groups: PlannedGroup[]; changes: FileChange[] } | undefined;
    private readonly agentLog: AgentLog;
    private lastRunLogPath: string | undefined;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger: Logger = NOOP_LOGGER,
    ) {
        this.agentLog = new AgentLog(logger);
    }

    static getInstance(context: vscode.ExtensionContext, logger: Logger = NOOP_LOGGER): PanelManager {
        PanelManager.instance ??= new PanelManager(context, logger);
        return PanelManager.instance;
    }

    async openAndGenerate(targetRepoUri?: vscode.Uri): Promise<void> {
        const switchingRepo =
            !!targetRepoUri &&
            targetRepoUri.fsPath !== this.targetRepoUri?.fsPath;
        if (targetRepoUri) {
            this.targetRepoUri = targetRepoUri;
        }
        const hadPanel = !!this.panel;
        this.ensurePanel();
        this.updatePanelTitle();
        this.panel!.reveal(vscode.ViewColumn.One);

        // If the panel already existed and the user clicked a different repo's
        // ✨ button, refresh the staged files / commit history for the new repo.
        // (For a fresh panel the webview will trigger this via its 'ready' message.)
        if (hadPanel && switchingRepo) {
            await Promise.all([
                this.loadStagedFiles(),
                this.loadCommitHistory(),
            ]);
        }
    }

    private updatePanelTitle(): void {
        if (!this.panel) {
            return;
        }
        const base = PANEL_TITLE;
        if (this.targetRepoUri) {
            const name = this.targetRepoUri.fsPath.split(/[\\/]/).pop();
            this.panel.title = name ? `${base} — ${name}` : base;
        } else {
            this.panel.title = base;
        }
    }

    // ─── Panel lifecycle ────────────────────────────────────────────────────────

    private ensurePanel(): void {
        if (this.panel) {
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            PANEL_VIEW_TYPE,
            PANEL_TITLE,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview'),
                ],
            }
        );
        this.panel.iconPath = vscode.Uri.joinPath(
            this.context.extensionUri, 'images', 'icon.png'
        );

        this.panel.webview.html = buildWebviewHtml(this.panel.webview, this.context.extensionUri);

        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => {
                this.handleMessage(msg).catch((err) => {
                    this.logger.error(formatError('handleMessage failed', err));
                    this.post({ type: 'error', message: String(err) });
                });
            },
            undefined,
            this.context.subscriptions
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.agentBatcher?.dispose();
            this.agentBatcher = undefined;
            this.cancellation?.cancel();
        });
    }

    /** Re-sends endpoint state after settings or the API key change. */
    async notifyEndpointChanged(reloadModels: boolean): Promise<void> {
        if (!this.panel) {
            return;
        }
        await this.postEndpoint();
        if (reloadModels) {
            await this.loadModels();
        }
        // The model may have been edited in VS Code settings, not in the webview.
        this.post({ type: 'settings', settings: this.effectiveSettings() });
    }

    // ─── Message handler ────────────────────────────────────────────────────────

    private async handleMessage(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'ready': {
                await this.postEndpoint();
                await this.loadModels();
                this.post({ type: 'settings', settings: this.effectiveSettings() });
                await Promise.all([
                    this.loadStagedFiles(),
                    this.loadCommitHistory(),
                ]);
                break;
            }

            case 'updateSettings': {
                await updateSettings(msg.settings);
                if (msg.settings.language !== undefined) {
                    this.sessionLanguage =
                        msg.settings.language === 'auto' ? undefined : msg.settings.language;
                }
                if (msg.settings.model !== undefined) {
                    this.post({ type: 'settings', settings: this.effectiveSettings() });
                }
                break;
            }

            case 'regenerate': {
                this.sessionLanguage =
                    msg.settings.language === 'auto' ? undefined : msg.settings.language;
                await this.loadStagedFiles();
                await this.generate(msg.settings);
                break;
            }

            case 'retryGroup': {
                await this.retryGroup(msg.groupIndex, msg.settings);
                break;
            }

            case 'commit': {
                await this.commitSelected(msg.ids, msg.orderedCandidates);
                break;
            }

            case 'openFile': {
                if (!this.currentRepoRoot) {
                    return;
                }
                const uri = vscode.Uri.joinPath(
                    vscode.Uri.file(this.currentRepoRoot),
                    msg.path
                );
                try {
                    await vscode.window.showTextDocument(uri, { preview: true });
                } catch {
                    vscode.window.showWarningMessage(`Could not open file: ${msg.path}`);
                }
                break;
            }

            case 'showDiff': {
                await this.sendFileDiff(msg.path);
                break;
            }

            case 'cancel': {
                this.generationRunId += 1;
                this.cancellation?.cancel();
                this.generating = false;
                this.retrying = false;
                this.post({ type: 'done' });
                break;
            }

            case 'refresh': {
                await Promise.all([
                    this.loadStagedFiles(),
                    this.loadCommitHistory(),
                ]);
                break;
            }

            case 'setApiKey': {
                await vscode.commands.executeCommand('autocommit-for-deepseek.setApiKey');
                break;
            }

            case 'openEndpointSettings': {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    `@ext:${EXTENSION_ID}`
                );
                break;
            }

            case 'showLogs': {
                this.logger.show();
                break;
            }

            case 'openRunLog': {
                await this.openLatestRunLog();
                break;
            }
        }
    }

    // ─── Load models ────────────────────────────────────────────────────────────

    private async loadModels(): Promise<ModelInfo[]> {
        const endpoint = getEndpointSettings();
        const resolved = await resolveApiKey(this.context.secrets);
        if (!resolved) {
            return this.postPresetModels();
        }
        try {
            const models = await listModels({
                baseUrl: endpoint.baseUrl,
                apiKey: resolved.key,
                headers: endpoint.headers,
            });
            this.availableModels = models;
            this.post({ type: 'availableModels', models });
            return models;
        } catch (err) {
            this.logger.warn(formatError('Failed to load models', err));
            return this.postPresetModels();
        }
    }

    private postPresetModels(): ModelInfo[] {
        const models = MODEL_PRESETS.map((model) => ({ ...model }));
        this.availableModels = models;
        this.post({ type: 'availableModels', models });
        return models;
    }

    // ─── Load staged files ──────────────────────────────────────────────────────

    private async loadCommitHistory(): Promise<void> {
        try {
            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!repo) {
                this.post({ type: 'commitHistory', commits: [] });
                return;
            }
            const gitService = new GitService(repo);
            this.recentCommits = await gitService.getRecentCommits(20);
            this.post({ type: 'commitHistory', commits: this.recentCommits });
        } catch (err) {
            this.logger.error(formatError('Failed to load commit history', err));
            this.post({ type: 'commitHistory', commits: [] });
        }
    }

    private async loadStagedFiles(): Promise<void> {
        try {
            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!repo) {
                this.post({ type: 'stagedFiles', files: [] });
                return;
            }
            const gitService = new GitService(repo);
            this.currentRepoRoot = gitService.repoRoot;
            // Remember the actually-resolved repo so subsequent calls stay locked on it.
            this.targetRepoUri = repo.rootUri;
            this.updatePanelTitle();
            const diff = await gitService.getStagedDiff();
            if (!diff.trim()) {
                this.post({ type: 'stagedFiles', files: [] });
                return;
            }
            const changes = parseDiff(diff);
            this.fileChanges = changes;
            this.fileDiffs.clear();
            for (const change of changes) {
                this.fileDiffs.set(change.path, change.diff);
            }
            const omitDiffs =
                changes.reduce((total, change) => total + change.diff.length, 0) >
                MAX_STAGED_DIFF_LENGTH;
            const files: StagedFileInfo[] = changes.map((change) => {
                const { additions, deletions } = countDiffLines(change.diff);
                return {
                    path: change.path,
                    type: change.type,
                    diff: omitDiffs ? '' : change.diff,
                    ...(omitDiffs ? { diffOmitted: true } : {}),
                    additions,
                    deletions,
                };
            });
            this.post({ type: 'stagedFiles', files });
        } catch (err) {
            this.logger.error(formatError('Failed to load staged files', err));
            this.post({ type: 'stagedFiles', files: [] });
        }
    }

    // ─── Generation pipeline ────────────────────────────────────────────────────

    private async generate(overrideSettings?: GenerateOptions): Promise<void> {
        // A new run supersedes any retry that is still in flight.
        this.cancellation?.cancel();
        this.cancellation = new vscode.CancellationTokenSource();
        const token = this.cancellation.token;
        const runId = ++this.generationRunId;
        const isActiveRun = () => runId === this.generationRunId && !token.isCancellationRequested;

        this.generating = true;
        this.retrying = false;
        this.candidates = [];
        this.lastRun = undefined;
        this.agentLog.clear();
        this.post({ type: 'loading' });

        let recorder: RunRecorder | undefined;
        let loggedStart = false;
        let runStatus: RunStatus = 'error';
        let runError: string | undefined;
        const runStartedAt = Date.now();

        try {
            const apiKey = await resolveApiKey(this.context.secrets);
            if (!isActiveRun()) { return; }
            if (!apiKey) {
                this.reportMissingApiKey();
                return;
            }

            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!isActiveRun()) { return; }
            if (!repo) {
                this.post({ type: 'error', message: 'No Git repository found. Make sure the workspace contains a git repository.' });
                return;
            }

            const gitService = new GitService(repo);
            this.currentRepoRoot = gitService.repoRoot;
            this.targetRepoUri = repo.rootUri;

            let settings = overrideSettings ?? this.effectiveSettings();

            if (settings.language === 'auto') {
                settings = { ...settings, language: await gitService.detectLanguage() };
                if (!isActiveRun()) { return; }
            }

            let diff: string;
            let generationTree: string;
            try {
                diff = await gitService.getStagedDiff();
                // Snapshot the exact index content the model is about to see;
                // commitSelected only commits this tree, never the working tree.
                generationTree = await gitService.writeIndexTree();
            } catch (err) {
                this.logger.error(formatError('Failed to read the staged diff', err));
                if (isActiveRun()) {
                    this.post({ type: 'error', message: `Failed to read staged diff: ${String(err)}` });
                }
                return;
            }

            if (!isActiveRun()) { return; }

            if (!diff.trim()) {
                this.post({
                    type: 'error',
                    message: 'No staged changes found. Please run git add to stage files first.',
                });
                return;
            }

            this.generationTree = generationTree;
            const changes = parseDiff(diff);
            this.fileChanges = changes;

            this.fileDiffs.clear();
            for (const change of changes) {
                this.fileDiffs.set(change.path, change.diff);
            }

            if (changes.length === 0) {
                if (isActiveRun()) {
                    this.post({ type: 'error', message: 'Could not analyse the staged changes.' });
                }
                return;
            }

            const endpoint = getEndpointSettings();
            const model = createDeepSeekModel({
                baseUrl: endpoint.baseUrl,
                apiKey: apiKey.key,
                model: settings.model ?? '',
                headers: endpoint.headers,
                maxInputTokens: endpoint.maxInputTokens,
            });

            const headerNames = Object.keys(endpoint.headers);
            const repoName = basename(gitService.repoRoot);
            this.logger.info(formatRunStart({
                trigger: 'generate',
                repo: repoName,
                files: changes.length,
                model: settings.model ?? '',
                effort: settings.reasoningEffort ?? '',
                baseUrl: endpoint.baseUrl,
                concurrency: settings.concurrency ?? 4,
                language: settings.language,
                minCommits: settings.minCommits ?? 0,
                maxCommits: settings.maxCommits ?? 0,
                headerNames,
            }));
            loggedStart = true;
            recorder = this.createRunRecorder({
                trigger: 'generate',
                repo: repoName,
                files: changes.length,
                model: settings.model ?? '',
                baseUrl: endpoint.baseUrl,
                effort: settings.reasoningEffort ?? '',
                concurrency: settings.concurrency ?? 4,
                language: settings.language,
                conventionalCommits: settings.conventionalCommits,
                minCommits: settings.minCommits ?? 0,
                maxCommits: settings.maxCommits ?? 0,
                headerNames,
            });
            this.lastRunLogPath = recorder?.path;

            const result = await generateCommits(
                model,
                changes,
                settings,
                token,
                this.recentCommits,
                {
                    onProgress: (progress) => {
                        if (!isActiveRun()) { return; }
                        this.post({ type: 'progress', progress });
                    },
                    onGroupsPlanned: (groups) => {
                        recorder?.recordGroups(groups);
                        this.logger.info(formatGroups(groups));
                        if (!isActiveRun()) { return; }
                        this.lastRun = { groups, changes };
                        this.post({ type: 'groupsPlanned', groups });
                    },
                    onCandidate: (groupIndex, candidate) => {
                        recorder?.recordCandidate(groupIndex, candidate);
                        if (!isActiveRun()) { return; }
                        this.candidates.push(candidate);
                        this.post({ type: 'addCandidate', candidate, groupIndex });
                    },
                    onGroupFailed: (group, error) => {
                        recorder?.recordGroupFailed(group.index, error.message);
                        this.logger.warn(
                            `Group #${group.index} "${group.label}" failed: ` +
                            redactSecrets(error.message)
                        );
                        if (!isActiveRun()) { return; }
                        this.post({ type: 'groupFailed', group, message: error.message });
                    },
                    onNotice: (level, message) => {
                        recorder?.recordNotice(level, message);
                        if (level === 'warning') {
                            this.logger.warn(message);
                        } else {
                            this.logger.info(message);
                        }
                        if (!isActiveRun()) { return; }
                        this.post({ type: 'notice', level, message });
                    },
                    onReorder: (ids) => {
                        recorder?.recordReorder(ids);
                        this.logger.info(`Commit order: ${ids.join(', ')}`);
                        if (!isActiveRun()) { return; }
                        const byId = new Map(this.candidates.map((candidate) => [candidate.id, candidate]));
                        this.candidates = ids
                            .map((id) => byId.get(id))
                            .filter((candidate): candidate is CommitCandidate => candidate !== undefined);
                        this.post({ type: 'reorder', ids });
                    },
                    onAgentEvent: (event) => {
                        recorder?.onAgentEvent(event);
                        this.agentLog.handle(event);
                        if (!isActiveRun()) { return; }
                        this.getAgentBatcher().push(event);
                    },
                    onAgentPrompt: (id, prompt) => recorder?.onAgentPrompt(id, prompt),
                    confirmRequests: (estimate) => this.confirmRequests(estimate),
                }
            );

            runStatus = !isActiveRun()
                ? 'cancelled'
                : result.declined ? 'declined' : 'done';

            if (result.declined && isActiveRun()) {
                const message = 'Stopped before sending generation requests.';
                recorder?.recordNotice('info', message);
                this.logger.info(message);
                this.post({
                    type: 'notice',
                    level: 'info',
                    message,
                });
            }
        } catch (err) {
            if (!isActiveRun() || token.isCancellationRequested ||
                err instanceof vscode.CancellationError) {
                runStatus = 'cancelled';
            } else {
                runStatus = 'error';
                runError = err instanceof Error ? err.message : String(err);
                this.logger.error(formatError('Generation failed', err));
                this.post({ type: 'error', message: `Generation failed: ${String(err)}` });
                if (err instanceof ModelError && err.kind === 'auth') {
                    this.promptForApiKey(AUTH_API_KEY_MESSAGE);
                }
            }
        } finally {
            await this.finishRunRecord(recorder, runStatus, runError, loggedStart, runStartedAt);
            if (runId === this.generationRunId) {
                this.generating = false;
                if (!token.isCancellationRequested) { this.post({ type: 'done' }); }
            }
        }
    }

    /** Confirms a run that would send many model requests. */
    private async confirmRequests(estimate: RequestEstimate): Promise<boolean> {
        const message = estimate.stage === 'grouping'
            ? `Grouping ${this.fileChanges.length} files needs about ${estimate.requests} model requests.`
            : `Generating ${estimate.groups} commits needs about ${estimate.requests} model requests.`;
        const detail =
            'Large changes are analyzed in several requests. Each request is billed by DeepSeek.';
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true, detail },
            'Continue'
        );
        return choice === 'Continue';
    }

    /** Regenerates one failed group from the last planned run. */
    private async retryGroup(groupIndex: number, overrideSettings?: GenerateOptions): Promise<void> {
        if (this.generating || this.retrying) { return; }

        const run = this.lastRun;
        const group = run?.groups.find((planned) => planned.index === groupIndex);
        if (!run || !group) {
            this.post({
                type: 'groupFailed',
                group: { index: groupIndex, label: '', files: [] },
                message: 'This group is no longer available. Generate again.',
            });
            return;
        }

        this.retrying = true;
        this.agentLog.clear();
        const cancellation = new vscode.CancellationTokenSource();
        this.cancellation = cancellation;
        const token = cancellation.token;

        let recorder: RunRecorder | undefined;
        let loggedStart = false;
        let runStatus: RunStatus = 'error';
        let runError: string | undefined;
        let repoName = this.currentRepoRoot ? basename(this.currentRepoRoot) : 'repo';
        const runStartedAt = Date.now();

        try {
            const apiKey = await resolveApiKey(this.context.secrets);
            if (token.isCancellationRequested) { return; }
            if (!apiKey) {
                this.reportMissingApiKey();
                return;
            }

            let settings = overrideSettings ?? this.effectiveSettings();

            if (settings.language === 'auto') {
                const repo = await GitService.getRepository(this.targetRepoUri);
                if (!repo) {
                    throw new Error(
                        'No Git repository found. Make sure the workspace contains a git repository.'
                    );
                }
                repoName = basename(repo.rootUri.fsPath);
                settings = {
                    ...settings,
                    language: await new GitService(repo).detectLanguage(),
                };
                if (token.isCancellationRequested) { return; }
            }

            const endpoint = getEndpointSettings();
            const model = createDeepSeekModel({
                baseUrl: endpoint.baseUrl,
                apiKey: apiKey.key,
                model: settings.model ?? '',
                headers: endpoint.headers,
                maxInputTokens: endpoint.maxInputTokens,
            });

            const headerNames = Object.keys(endpoint.headers);
            this.logger.info(formatRunStart({
                trigger: 'retry',
                repo: repoName,
                files: run.changes.length,
                model: settings.model ?? '',
                effort: settings.reasoningEffort ?? '',
                baseUrl: endpoint.baseUrl,
                concurrency: settings.concurrency ?? 4,
                language: settings.language,
                minCommits: settings.minCommits ?? 0,
                maxCommits: settings.maxCommits ?? 0,
                headerNames,
                groupIndex: group.index,
            }));
            loggedStart = true;
            recorder = this.createRunRecorder({
                trigger: 'retry',
                repo: repoName,
                files: run.changes.length,
                model: settings.model ?? '',
                baseUrl: endpoint.baseUrl,
                effort: settings.reasoningEffort ?? '',
                concurrency: settings.concurrency ?? 4,
                language: settings.language,
                conventionalCommits: settings.conventionalCommits,
                minCommits: settings.minCommits ?? 0,
                maxCommits: settings.maxCommits ?? 0,
                headerNames,
                groupIndex: group.index,
            });
            this.lastRunLogPath = recorder?.path;

            const candidate = await generateForGroup(
                model,
                group,
                run.changes,
                settings,
                token,
                this.recentCommits,
                (event) => {
                    recorder?.onAgentEvent(event);
                    this.agentLog.handle(event);
                    if (token.isCancellationRequested) { return; }
                    this.getAgentBatcher().push(event);
                },
                (id, prompt) => recorder?.onAgentPrompt(id, prompt),
            );
            if (token.isCancellationRequested) {
                runStatus = 'cancelled';
                return;
            }

            recorder?.recordCandidate(group.index, candidate);
            runStatus = 'done';
            this.candidates.push(candidate);
            this.logger.info(
                `Retry finished · group #${group.index} "${group.label}" · ` +
                firstLine(candidate.message)
            );
            this.post({ type: 'addCandidate', candidate, groupIndex: group.index });
        } catch (err) {
            if (token.isCancellationRequested || err instanceof vscode.CancellationError) {
                runStatus = 'cancelled';
            } else {
                runStatus = 'error';
                runError = err instanceof Error ? err.message : String(err);
                const message = err instanceof Error ? err.message : String(err);
                recorder?.recordGroupFailed(group.index, message);
                this.logger.error(formatError('Retry failed', err));
                this.logger.warn(
                    `Group #${group.index} "${group.label}" retry failed: ` +
                    redactSecrets(message)
                );
                this.post({ type: 'groupFailed', group, message });
                if (err instanceof ModelError && err.kind === 'auth') {
                    this.promptForApiKey(AUTH_API_KEY_MESSAGE);
                }
            }
        } finally {
            await this.finishRunRecord(recorder, runStatus, runError, loggedStart, runStartedAt);
            if (this.cancellation === cancellation) {
                this.retrying = false;
            }
        }
    }

    // ─── Commit execution ───────────────────────────────────────────────────────

    private async commitSelected(ids: string[], orderedCandidates?: CommitCandidate[]): Promise<void> {
        if (this.generating || this.retrying) { return; }
        // Use ordered candidates from webview if provided (user may have reordered/edited)
        const allCandidates = orderedCandidates ?? this.candidates;
        const selected = allCandidates.filter((c) => ids.includes(c.id));
        if (selected.length === 0) {
            return;
        }

        const repo = await GitService.getRepository(this.targetRepoUri);
        if (!repo) {
            this.post({ type: 'error', message: 'Git repository not found.' });
            return;
        }

        const gitService = new GitService(repo);
        this.targetRepoUri = repo.rootUri;

        try {
            await gitService.assertCommitIdentityConfigured();
            const currentTree = await gitService.writeIndexTree();
            if (!this.generationTree || currentTree !== this.generationTree) {
                this.logger.error(
                    'Commit refused: the staged changes changed since generation.'
                );
                this.post({
                    type: 'error',
                    message: 'The staged changes have changed since generation. Generate again before committing.',
                });
                return;
            }

            const commits = selected.map((candidate) => ({
                id: candidate.id,
                paths: resolveStagingPaths(candidate.files, this.fileChanges),
                message: candidate.message,
            }));
            const { committedIds, error } = await gitService.commitFromSnapshot(
                currentTree,
                commits
            );

            if (committedIds.length > 0) {
                // The snapshot method returns ids, not hashes; read the new
                // commits back so the log shows the hash a user can look up.
                const recent = await gitService.getRecentCommits(committedIds.length);
                const usedHashes = new Set<string>();
                for (const id of committedIds) {
                    const candidate = selected.find((item) => item.id === id);
                    const message = firstLine(candidate?.message ?? '');
                    const match = recent.find((commit) =>
                        commit.message === message && !usedHashes.has(commit.hash)
                    );
                    if (match) { usedHashes.add(match.hash); }
                    this.logger.info(
                        `Committed ${match ? match.hash.slice(0, 7) : '(unknown hash)'} ${message}`
                    );
                }
                this.post({ type: 'committed', count: committedIds.length, ids: committedIds });
                this.candidates = this.candidates.filter((c) => !committedIds.includes(c.id));
            }

            if (error) {
                this.logger.error(
                    `Commit failed after ${committedIds.length} commit(s): ` +
                    redactSecrets(error.message)
                );
                this.post({
                    type: 'error',
                    message: `Commit failed after ${committedIds.length} commit(s): ${error.message}`,
                });
            } else {
                void vscode.window.showInformationMessage(
                    `AutoCommit: ${committedIds.length} commit${committedIds.length > 1 ? 's' : ''} created.`
                );
            }

            // Refresh staged-files panel and commit history after committing
            await this.loadStagedFiles();
            await this.loadCommitHistory();
        } catch (err) {
            this.logger.error(formatError('Commit failed', err));
            this.post({
                type: 'error',
                message: err instanceof GitIdentityError
                    ? err.message
                    : `Commit failed: ${String(err)}`,
            });
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private async sendFileDiff(filePath: string): Promise<void> {
        const content = this.fileDiffs.get(filePath);
        if (content !== undefined) {
            this.post({ type: 'diffContent', path: filePath, content });
        } else {
            const repo = await GitService.getRepository(this.targetRepoUri);
            if (!repo) { return; }
            const gitService = new GitService(repo);
            try {
                const fullDiff = await gitService.getStagedDiff();
                const changes = parseDiff(fullDiff);
                const found = changes.find((c) => c.path === filePath);
                if (found) {
                    this.post({ type: 'diffContent', path: filePath, content: found.diff });
                }
            } catch {
                // ignore
            }
        }
    }

    private createRunRecorder(
        config: Omit<RunRecorderConfig, 'directory' | 'keep' | 'includePrompts' | 'logger'>,
    ): RunRecorder | undefined {
        const storage = this.context.globalStorageUri;
        if (!storage) { return undefined; }
        const { keep, includePrompts } = getRunLogSettings();
        if (keep <= 0) { return undefined; }
        return new RunRecorder({
            ...config,
            directory: join(storage.fsPath, 'runs'),
            keep,
            includePrompts,
            logger: this.logger,
        });
    }

    private async finishRunRecord(
        recorder: RunRecorder | undefined,
        status: RunStatus,
        error: string | undefined,
        loggedStart: boolean,
        startedAt: number,
    ): Promise<void> {
        if (!loggedStart) { return; }
        let totals: RunTotals = {
            requests: 0,
            promptTokens: 0,
            cacheHitTokens: 0,
            reasoningTokens: 0,
            completionTokens: 0,
        };
        let durationMs = Date.now() - startedAt;
        if (recorder) {
            try {
                totals = await recorder.close(status, error);
                durationMs = recorder.elapsedMs;
            } catch (err) {
                this.logger.warn(formatError('Failed to close the run record', err));
            }
        }
        this.logger.info(formatRunFinished(status, durationMs, totals));
    }

    private async openLatestRunLog(): Promise<void> {
        const filePath = this.lastRunLogPath;
        if (filePath && existsSync(filePath)) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(document);
            return;
        }
        await vscode.commands.executeCommand('autocommit-for-deepseek.openRunLog');
    }

    private getAgentBatcher(): AgentBatcher {
        this.agentBatcher ??= new AgentBatcher((events) => {
            this.write({ type: 'agentEvents', events });
        });
        return this.agentBatcher;
    }

    private async postEndpoint(): Promise<void> {
        const endpoint = getEndpointSettings();
        const resolved = await resolveApiKey(this.context.secrets);
        const status: EndpointStatus = {
            baseUrl: endpoint.baseUrl,
            apiKey: resolved?.source ?? 'none',
        };
        this.post({ type: 'endpoint', endpoint: status });
    }

    private reportMissingApiKey(): void {
        this.post({ type: 'error', message: MISSING_API_KEY_MESSAGE });
        this.promptForApiKey(MISSING_API_KEY_MESSAGE);
    }

    private promptForApiKey(message: string): void {
        void Promise.resolve(
            vscode.window.showErrorMessage(message, SET_API_KEY_ACTION)
        ).then((choice) => {
            if (choice === SET_API_KEY_ACTION) {
                void vscode.commands.executeCommand('autocommit-for-deepseek.setApiKey');
            }
        });
    }

    private effectiveSettings(): GenerateOptions {
        const base = getSettings();
        if (this.sessionLanguage) {
            return { ...base, language: this.sessionLanguage };
        }
        return base;
    }

    /** Sends pending agent events first, so every other message observes them. */
    private post(msg: ExtensionMessage): void {
        this.agentBatcher?.flush();
        this.write(msg);
    }

    private write(msg: ExtensionMessage): void {
        void this.panel?.webview.postMessage(msg);
    }
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function firstLine(message: string): string {
    return message.split(/\r?\n/, 1)[0];
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    // Only lines before the first hunk can be +++/--- headers; after it a
    // deleted "-- comment" line is a real change.
    let inHunk = false;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@')) { inHunk = true; }
        if (!inHunk) { continue; }
        if (line.startsWith('+')) {
            additions += 1;
        } else if (line.startsWith('-')) {
            deletions += 1;
        }
    }
    return { additions, deletions };
}

function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'index.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <title>AutoCommit For DeepSeek</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars[Math.floor(Math.random() * chars.length)];
    }
    return nonce;
}
