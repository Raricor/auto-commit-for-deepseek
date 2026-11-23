import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { ModelError } from '../src/llm/chatModel';
import type { Logger } from '../src/logging/logger';
import type {
    AgentEvent,
    CommitCandidate,
    ExtensionMessage,
    FileChange,
    GenerateOptions,
    PlannedGroup,
} from '../src/types';

const twoFileDiff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' +
    'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n';
const renameDiff = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
const candidateA: CommitCandidate = { id: 'a', message: 'fix: a', reason: 'Correct behavior', files: ['a.ts'], checked: true };
const candidateB: CommitCandidate = { id: 'b', message: 'fix: b', reason: 'Correct behavior', files: ['b.ts'], checked: true };
const renamed: CommitCandidate = { id: 'r', message: 'refactor: rename', reason: 'Keep names clear', files: ['new.ts'], checked: true };
const groups: PlannedGroup[] = [
    { index: 0, label: 'A', files: ['a.ts'] },
    { index: 1, label: 'B', files: ['b.ts'] },
];
const agentStarted: AgentEvent = {
    type: 'started',
    agent: { id: 'agent-1', kind: 'generate', label: 'A', groupIndex: 0, attempt: 1, queuedAt: 1 },
};
const presetModels = [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
];
const API_KEY_SECRET = 'autocommit-for-deepseek.apiKey';

type Events = {
    onProgress?: (progress: unknown) => void;
    onGroupsPlanned?: (planned: PlannedGroup[]) => void;
    onCandidate?: (groupIndex: number, candidate: CommitCandidate) => void;
    onGroupFailed?: (group: PlannedGroup, error: Error) => void;
    onNotice?: (level: 'info' | 'warning', message: string) => void;
    onReorder?: (ids: string[]) => void;
    onAgentEvent?: (event: AgentEvent) => void;
    confirmRequests?: (estimate: { groups: number; requests: number; stage: 'grouping' | 'generation' }) => Promise<boolean>;
};
type GenerationResult = {
    groups: PlannedGroup[];
    candidates: Array<{ groupIndex: number; candidate: CommitCandidate }>;
    failed: Array<{ group: PlannedGroup; error: Error }>;
    declined?: boolean;
};
type ModelConfig = {
    baseUrl: string;
    apiKey: string;
    model: string;
    headers?: Record<string, string>;
    maxInputTokens?: number;
};

let generateCommits: (
    model: unknown,
    changes: FileChange[],
    options: GenerateOptions,
    token: { isCancellationRequested: boolean },
    history: unknown,
    events: Events,
) => Promise<GenerationResult>;
let generateForGroup: (
    model: unknown,
    group: PlannedGroup,
    changes: FileChange[],
    options: GenerateOptions,
    token: { isCancellationRequested: boolean },
    history: unknown,
    onAgentEvent?: (event: AgentEvent) => void,
    onAgentPrompt?: (id: string, prompt: string) => void,
) => Promise<CommitCandidate>;
let createDeepSeekModel: (config: ModelConfig) => unknown;
let listModelsImpl: (config: { baseUrl: string; apiKey: string; headers: Record<string, string> }) => Promise<Array<{ id: string; name: string }>>;
let modelConfigs: ModelConfig[];
let listModelCalls: Array<{ baseUrl: string; apiKey: string; headers: Record<string, string> }>;
let gitCalls: Array<{ method: string; tree?: string; commits?: Array<{ id: string; paths: string[]; message: string }> }>;
let posts: ExtensionMessage[];
let infoMessages: string[];
let errorMessages: Array<{ message: string; options: unknown; items: string[] }>;
let errorChoice: string | undefined;
let warnings: Array<{ message: string; options: unknown; items: string[] }>;
let warningChoice: string | undefined;
let commandsExecuted: Array<{ command: string; args: unknown[] }>;
let inputBoxOptions: Record<string, unknown> | undefined;
let inputBoxResult: string | undefined;
let secretStore: Record<string, string>;
let diffText: string;
let indexTree: string;
let commitResult: { committedIds: string[]; error?: Error };
let configStore: Record<string, unknown>;
let configUpdates: Array<{ key: string; value: unknown; target: unknown }>;
let storageDir: string;
let openedDocuments: string[];
let logEntries: Array<{ level: string; message: string }>;
let logShown: number;
const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs) {
        rmSync(directory, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function createTestLogger(): Logger {
    return {
        info: (message) => logEntries.push({ level: 'info', message }),
        warn: (message) => logEntries.push({ level: 'warn', message }),
        error: (message) => logEntries.push({ level: 'error', message }),
        debug: (message) => logEntries.push({ level: 'debug', message }),
        trace: (message) => logEntries.push({ level: 'trace', message }),
        show: () => { logShown += 1; },
    };
}

class GitService {
    static async getRepository() { return { rootUri: { fsPath: '/test-repo' } }; }
    repoRoot = '/test-repo';
    async getStagedDiff() { return diffText; }
    async getRecentCommits() { return []; }
    async detectLanguage() { return 'en'; }
    async assertCommitIdentityConfigured() { gitCalls.push({ method: 'identity' }); }
    async writeIndexTree() { gitCalls.push({ method: 'writeTree' }); return indexTree; }
    async commitFromSnapshot(tree: string, commits: Array<{ id: string; paths: string[]; message: string }>) {
        gitCalls.push({ method: 'commit', tree, commits });
        return commitResult;
    }
}
class CancellationTokenSource {
    token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() { } }),
    };
    cancel() { this.token.isCancellationRequested = true; }
}

const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
nodeModule._load = function (id: string, ...args: unknown[]) {
    if (id === 'vscode') {
        return {
            CancellationTokenSource,
            CancellationError: class extends Error { },
            ConfigurationTarget: { Global: 1 },
            Uri: {
                file: (fsPath: string) => ({ fsPath }),
            },
            workspace: {
                getConfiguration: () => ({
                    get: (key: string, fallback: unknown) =>
                        key in configStore ? configStore[key] : fallback,
                    update: async (key: string, value: unknown, target: unknown) => {
                        configStore[key] = value;
                        configUpdates.push({ key, value, target });
                    },
                }),
                openTextDocument: async (uri: { fsPath: string }) => ({ uri }),
            },
            window: {
                showInformationMessage: (message: string) => { infoMessages.push(message); },
                showTextDocument: async (document: { uri: { fsPath: string } }) => {
                    openedDocuments.push(document.uri.fsPath);
                },
                showWarningMessage: (message: string, options: unknown, ...items: string[]) => {
                    warnings.push({ message, options, items });
                    return Promise.resolve(warningChoice);
                },
                showErrorMessage: (message: string, ...items: string[]) => {
                    errorMessages.push({ message, options: undefined, items });
                    return Promise.resolve(errorChoice);
                },
                showInputBox: async (options: Record<string, unknown>) => {
                    inputBoxOptions = options;
                    return inputBoxResult;
                },
            },
            commands: {
                executeCommand: async (command: string, ...commandArgs: unknown[]) => {
                    commandsExecuted.push({ command, args: commandArgs });
                },
            },
        };
    }
    if (id === '../git/gitService') { return { GitService }; }
    if (id === '../deepseek') {
        return {
            MODEL_PRESETS: presetModels,
            listModels: (config: { baseUrl: string; apiKey: string; headers: Record<string, string> }) => {
                listModelCalls.push(config);
                return listModelsImpl(config);
            },
            createDeepSeekModel: (config: ModelConfig) => {
                modelConfigs.push(config);
                return createDeepSeekModel(config);
            },
        };
    }
    if (id === '../llm/llmService') {
        return {
            generateCommits: (
                model: unknown,
                changes: FileChange[],
                options: GenerateOptions,
                token: { isCancellationRequested: boolean },
                history: unknown,
                events: Events,
            ) => generateCommits(model, changes, options, token, history, events),
            generateForGroup: (
                model: unknown,
                group: PlannedGroup,
                changes: FileChange[],
                options: GenerateOptions,
                token: { isCancellationRequested: boolean },
                history: unknown,
                onAgentEvent?: (event: AgentEvent) => void,
                onAgentPrompt?: (id: string, prompt: string) => void,
            ) => generateForGroup(
                model, group, changes, options, token, history, onAgentEvent, onAgentPrompt
            ),
        };
    }
    return originalLoad.call(this, id, ...args);
};
const { PanelManager } = require('../src/ui/panelManager');
const { getSettings, getEndpointSettings, updateSettings } = require('../src/config/settings');
nodeModule._load = originalLoad;

function setup(options: { apiKey?: string | null } = {}) {
    gitCalls = [];
    posts = [];
    infoMessages = [];
    errorMessages = [];
    errorChoice = undefined;
    warnings = [];
    warningChoice = undefined;
    commandsExecuted = [];
    inputBoxOptions = undefined;
    inputBoxResult = undefined;
    diffText = twoFileDiff;
    indexTree = 'tree-1';
    commitResult = { committedIds: [] };
    configStore = { 'runLogs.keep': 0 };
    configUpdates = [];
    storageDir = mkdtempSync(join(tmpdir(), 'ac-panel-'));
    tempDirs.push(storageDir);
    openedDocuments = [];
    logEntries = [];
    logShown = 0;
    modelConfigs = [];
    listModelCalls = [];
    secretStore = options.apiKey === null ? {} : { [API_KEY_SECRET]: options.apiKey ?? 'sk-test' };
    delete process.env.DEEPSEEK_API_KEY;
    listModelsImpl = async () => presetModels.map((model) => ({ ...model }));
    createDeepSeekModel = (config) => ({
        id: config.model || 'deepseek-flash',
        name: config.model || 'deepseek-flash',
        maxInputTokens: config.maxInputTokens ?? 131072,
        countTokens: async () => 0,
        request: async () => ({ content: '', reasoning: '', finishReason: 'stop' }),
    });
    generateCommits = async () => ({ groups: [], candidates: [], failed: [] });
    generateForGroup = async () => candidateA;
    const panel = new PanelManager({
        subscriptions: [],
        globalStorageUri: { fsPath: storageDir },
        secrets: {
            get: async (key: string) => secretStore[key],
            store: async (key: string, value: string) => { secretStore[key] = value; },
            delete: async (key: string) => { delete secretStore[key]; },
        },
    }, createTestLogger());
    // PanelManager.post() only needs the webview's message channel in these tests.
    (panel as any).panel = { webview: { postMessage: (message: ExtensionMessage) => posts.push(message) } };
    return panel;
}

function commitsMade() {
    return gitCalls.filter((call) => call.method === 'commit');
}

function stagedFilesMessage(): Extract<ExtensionMessage, { type: 'stagedFiles' }> {
    const message = posts.find(
        (post): post is Extract<ExtensionMessage, { type: 'stagedFiles' }> =>
            post.type === 'stagedFiles'
    );
    assert.ok(message, 'expected a stagedFiles message');
    return message;
}

function endpointMessage(): Extract<ExtensionMessage, { type: 'endpoint' }> {
    const message = [...posts].reverse().find(
        (post): post is Extract<ExtensionMessage, { type: 'endpoint' }> =>
            post.type === 'endpoint'
    );
    assert.ok(message, 'expected an endpoint message');
    return message;
}

async function prepareRun(panel: any) {
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onGroupsPlanned?.(groups);
        events.onCandidate?.(0, candidateA);
        events.onCandidate?.(1, candidateB);
        return {
            groups,
            candidates: [
                { groupIndex: 0, candidate: candidateA },
                { groupIndex: 1, candidate: candidateB },
            ],
            failed: [],
        };
    };
    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
    posts = [];
    gitCalls = [];
}

test('a commit command cannot mutate the index while generation is still running', async () => {
    const panel = setup();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, candidateA);
        started();
        await pending;
        return { groups: [groups[0]], candidates: [{ groupIndex: 0, candidate: candidateA }], failed: [] };
    };
    const running = panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
    await ready;
    try {
        // Simulate the webview trying to submit an already displayed candidate.
        assert.deepEqual(panel.candidates, [candidateA]);
        gitCalls = [];
        await panel.commitSelected(['a']);
        assert.deepEqual(gitCalls, []);
    } finally {
        release();
        await running;
    }
});

test('refuses to commit when the staged snapshot changed after generation', async () => {
    const panel = setup();
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, candidateA);
        return { groups: [groups[0]], candidates: [{ groupIndex: 0, candidate: candidateA }], failed: [] };
    };
    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
    posts = [];
    gitCalls = [];
    indexTree = 'tree-2';

    await panel.commitSelected(['a']);

    assert.equal(commitsMade().length, 0);
    assert.equal(gitCalls.filter((call) => call.method === 'identity').length, 1);
    assert.ok(posts.some((message) =>
        message.type === 'error' &&
        message.message === 'The staged changes have changed since generation. Generate again before committing.'
    ));
    assert.deepEqual(panel.candidates, [candidateA]);
});

test('a partial commit reports successful ids first, then the failure', async () => {
    const panel = setup();
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, candidateA);
        events.onCandidate?.(1, candidateB);
        return {
            groups,
            candidates: [
                { groupIndex: 0, candidate: candidateA },
                { groupIndex: 1, candidate: candidateB },
            ],
            failed: [],
        };
    };
    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
    posts = [];
    gitCalls = [];
    commitResult = { committedIds: ['a'], error: new Error('hook rejected b') };

    await panel.commitSelected(['a', 'b']);

    assert.deepEqual(posts[0], { type: 'committed', count: 1, ids: ['a'] });
    assert.deepEqual(posts[1], { type: 'error', message: 'Commit failed after 1 commit(s): hook rejected b' });
    assert.deepEqual(panel.candidates, [candidateB]);
    assert.deepEqual(infoMessages, []);
    assert.deepEqual(commitsMade()[0].commits?.map((commit) => commit.id), ['a', 'b']);
});

test('a renamed candidate passes both the old and new paths to the snapshot commit', async () => {
    const panel = setup();
    diffText = renameDiff;
    commitResult = { committedIds: ['r'] };
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onCandidate?.(0, renamed);
        return { groups: [groups[0]], candidates: [{ groupIndex: 0, candidate: renamed }], failed: [] };
    };
    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
    gitCalls = [];

    await panel.commitSelected(['r']);

    assert.deepEqual(commitsMade()[0].commits?.[0].paths, ['old.ts', 'new.ts']);
});

test('generation messages are emitted in order and reorder updates the candidate list', async () => {
    const panel = setup();
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onProgress?.({ stage: 'grouping' });
        events.onGroupsPlanned?.(groups);
        events.onCandidate?.(0, candidateA);
        events.onCandidate?.(1, candidateB);
        events.onReorder?.(['b', 'a']);
        return {
            groups,
            candidates: [
                { groupIndex: 0, candidate: candidateA },
                { groupIndex: 1, candidate: candidateB },
            ],
            failed: [],
        };
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.deepEqual(posts.map((message) => message.type), [
        'loading', 'progress', 'groupsPlanned', 'addCandidate', 'addCandidate', 'reorder', 'done',
    ]);
    assert.deepEqual(posts[1], { type: 'progress', progress: { stage: 'grouping' } });
    assert.deepEqual(posts[2], { type: 'groupsPlanned', groups });
    assert.deepEqual(posts[3], { type: 'addCandidate', candidate: candidateA, groupIndex: 0 });
    assert.deepEqual(posts[4], { type: 'addCandidate', candidate: candidateB, groupIndex: 1 });
    assert.deepEqual(posts[5], { type: 'reorder', ids: ['b', 'a'] });
    assert.deepEqual(panel.candidates, [candidateB, candidateA]);
});

test('group failures and notices are forwarded to the webview', async () => {
    const panel = setup();
    const failure = new Error('model unavailable');
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onGroupFailed?.(groups[0], failure);
        events.onNotice?.('warning', 'Grouping fell back to folder rules.');
        return { groups, candidates: [], failed: [{ group: groups[0], error: failure }] };
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.deepEqual(posts, [
        { type: 'loading' },
        { type: 'groupFailed', group: groups[0], message: 'model unavailable' },
        { type: 'notice', level: 'warning', message: 'Grouping fell back to folder rules.' },
        { type: 'done' },
    ]);
});

test('confirmRequests accepts only the Continue choice and uses the expected copy', async () => {
    const panel = setup();
    await panel.loadStagedFiles();
    posts = [];

    warningChoice = 'Continue';
    assert.equal(
        await panel.confirmRequests({ groups: 2, requests: 80, stage: 'grouping' }),
        true
    );
    assert.equal(warnings[0].message, 'Grouping 2 files needs about 80 model requests.');
    assert.deepEqual(warnings[0].options, {
        modal: true,
        detail: 'Large changes are analyzed in several requests. Each request is billed by DeepSeek.',
    });
    assert.deepEqual(warnings[0].items, ['Continue']);

    warningChoice = undefined;
    assert.equal(
        await panel.confirmRequests({ groups: 2, requests: 80, stage: 'grouping' }),
        false
    );
    assert.equal(
        await panel.confirmRequests({ groups: 3, requests: 90, stage: 'generation' }),
        false
    );
    assert.equal(warnings[2].message, 'Generating 3 commits needs about 90 model requests.');
});

test('a declined estimate sends an info notice and then done', async () => {
    const panel = setup();
    warningChoice = undefined;
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        const accepted = await events.confirmRequests?.({
            groups: 3,
            requests: 90,
            stage: 'generation',
        });
        assert.equal(accepted, false);
        return { groups: [], candidates: [], failed: [], declined: true };
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.deepEqual(posts.map((message) => message.type), ['loading', 'notice', 'done']);
    assert.deepEqual(posts[1], {
        type: 'notice',
        level: 'info',
        message: 'Stopped before sending generation requests.',
    });
});

test('retryGroup adds the successful candidate with its group index', async () => {
    const panel = setup();
    await prepareRun(panel);
    let retried: PlannedGroup | undefined;
    let retriedModel: unknown;
    generateForGroup = async (model, group) => { retriedModel = model; retried = group; return candidateB; };

    await panel.retryGroup(1, { language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.equal(retried, groups[1]);
    assert.ok(retriedModel);
    assert.deepEqual(posts, [
        { type: 'addCandidate', candidate: candidateB, groupIndex: 1 },
    ]);
    assert.deepEqual(panel.candidates, [candidateA, candidateB, candidateB]);
});

test('retryGroup reports a failed retry', async () => {
    const panel = setup();
    await prepareRun(panel);
    generateForGroup = async () => { throw new Error('provider down'); };

    await panel.retryGroup(1, { language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.deepEqual(posts, [
        { type: 'groupFailed', group: groups[1], message: 'provider down' },
    ]);
});

test('a retry in flight blocks commits', async () => {
    const panel = setup();
    await prepareRun(panel);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    generateForGroup = async () => { started(); await pending; return candidateB; };

    const retrying = panel.retryGroup(1, { language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
    await ready;
    try {
        gitCalls = [];
        await panel.commitSelected(['b']);
        assert.deepEqual(gitCalls, []);
    } finally {
        release();
        await retrying;
    }
});

test('retryGroup is ignored while a generation run is active', async () => {
    const panel = setup();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onGroupsPlanned?.(groups);
        started();
        await pending;
        return { groups, candidates: [], failed: [] };
    };
    let retried = false;
    generateForGroup = async () => { retried = true; return candidateA; };

    const running = panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
    await ready;
    try {
        posts = [];
        await panel.retryGroup(0, { language: 'en', conventionalCommits: true, model: 'deepseek-flash' });
        assert.equal(retried, false);
        assert.deepEqual(posts, []);
    } finally {
        release();
        await running;
    }
});

test('retryGroup reports a group that is no longer available', async () => {
    const panel = setup();
    await prepareRun(panel);
    let retried = false;
    generateForGroup = async () => { retried = true; return candidateA; };

    await panel.retryGroup(9, { language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.equal(retried, false);
    assert.deepEqual(posts, [{
        type: 'groupFailed',
        group: { index: 9, label: '', files: [] },
        message: 'This group is no longer available. Generate again.',
    }]);
});

test('settings read the new keys, clamp out-of-range values, and persist updates', async () => {
    configStore = {
        minCommits: -7,
        maxCommits: 500,
        reasoningEffort: 'turbo',
        concurrency: 12.9,
    };
    configUpdates = [];
    const clamped = getSettings();
    assert.equal(clamped.minCommits, 0);
    assert.equal(clamped.maxCommits, 200);
    assert.equal(clamped.reasoningEffort, '');
    assert.equal(clamped.concurrency, 8);
    assert.equal(clamped.model, 'deepseek-flash');

    configStore = {
        minCommits: 3.9,
        maxCommits: 2.2,
        reasoningEffort: 'high',
        concurrency: 4.8,
    };
    const rounded = getSettings();
    assert.equal(rounded.minCommits, 3);
    assert.equal(rounded.maxCommits, 2);
    assert.equal(rounded.reasoningEffort, 'high');
    assert.equal(rounded.concurrency, 4);

    await updateSettings({
        minCommits: 5,
        maxCommits: 9,
        reasoningEffort: 'max',
        concurrency: 2,
    });
    assert.deepEqual(configUpdates.map((update) => [update.key, update.value]), [
        ['minCommits', 5],
        ['maxCommits', 9],
        ['reasoningEffort', 'max'],
        ['concurrency', 2],
    ]);
});

test('large staged diffs are omitted while line counts are still sent', async () => {
    const panel = setup();
    const largeLine = `+${'x'.repeat(600 * 1024)}`;
    diffText =
        `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n${largeLine}\n` +
        `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n${largeLine}\n`;

    await panel.loadStagedFiles();

    const message = stagedFilesMessage();
    assert.equal(message.files.length, 2);
    for (const file of message.files) {
        assert.equal(file.diff, '');
        assert.equal(file.diffOmitted, true);
        assert.equal(file.additions, 1);
        assert.equal(file.deletions, 1);
    }
});

test('staged diffs under the limit are sent with line counts', async () => {
    const panel = setup();

    await panel.loadStagedFiles();

    const message = stagedFilesMessage();
    assert.equal(message.files.length, 2);
    for (const file of message.files) {
        assert.ok(file.diff.includes('+new'));
        assert.equal(file.diffOmitted, undefined);
        assert.equal(file.additions, 1);
        assert.equal(file.deletions, 1);
    }
});

test('callbacks from a cancelled run send no further messages', async () => {
    const panel = setup();
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        panel.cancellation.cancel();
        events.onProgress?.({ stage: 'grouping' });
        events.onGroupsPlanned?.(groups);
        events.onCandidate?.(0, candidateA);
        events.onGroupFailed?.(groups[0], new Error('cancelled'));
        events.onNotice?.('info', 'cancelled');
        events.onReorder?.(['a']);
        events.onAgentEvent?.(agentStarted);
        return { groups, candidates: [], failed: [] };
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.deepEqual(posts.map((message) => message.type), ['loading']);
});

test('generation without an API key sends an error and never calls the pipeline', async () => {
    const panel = setup({ apiKey: null });
    let called = false;
    generateCommits = async () => {
        called = true;
        return { groups: [], candidates: [], failed: [] };
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.equal(called, false);
    assert.deepEqual(posts.map((message) => message.type), ['loading', 'error', 'done']);
    assert.deepEqual(posts[1], {
        type: 'error',
        message: 'No DeepSeek API key. Run "AutoCommit For DeepSeek: Set API Key" or set DEEPSEEK_API_KEY.',
    });
    assert.equal(errorMessages.length, 1);
    assert.equal(errorMessages[0].message, posts[1].type === 'error' ? posts[1].message : '');
    assert.deepEqual(errorMessages[0].items, ['Set API Key']);
    assert.deepEqual(secretStore, {});
});

test('an auth failure sends an error and offers to set the API key', async () => {
    const panel = setup();
    generateCommits = async () => {
        throw new ModelError('auth', 'invalid key', 401);
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.deepEqual(posts.map((message) => message.type), ['loading', 'error', 'done']);
    assert.equal(errorMessages.length, 1);
    assert.deepEqual(errorMessages[0].items, ['Set API Key']);
});

test('endpoint reports where the API key comes from', async () => {
    const cases: Array<{ secret?: string; env?: string; source: 'secret' | 'env' | 'none' }> = [
        { secret: 'sk-secret', source: 'secret' },
        { env: 'sk-env', source: 'env' },
        { source: 'none' },
    ];
    for (const item of cases) {
        const panel = setup({ apiKey: item.secret ?? null });
        if (item.env !== undefined) {
            process.env.DEEPSEEK_API_KEY = item.env;
        }
        await panel.handleMessage({ type: 'ready' });
        assert.deepEqual(endpointMessage().endpoint, {
            baseUrl: 'https://api.deepseek.com',
            apiKey: item.source,
        });
        delete process.env.DEEPSEEK_API_KEY;
    }
});

test('a custom model id is kept even when it is not in the model list', async () => {
    const panel = setup();
    await panel.handleMessage({ type: 'ready' });
    posts = [];

    await panel.handleMessage({
        type: 'updateSettings',
        settings: { model: 'my-custom-model' },
    });

    assert.equal(configStore.model, 'my-custom-model');
    const settings = posts.find(
        (post): post is Extract<ExtensionMessage, { type: 'settings' }> =>
            post.type === 'settings'
    );
    assert.ok(settings);
    assert.equal(settings.settings.model, 'my-custom-model');
});

test('a failed model list falls back to the presets', async () => {
    const panel = setup();
    listModelsImpl = async () => { throw new Error('models unavailable'); };

    await panel.handleMessage({ type: 'ready' });

    const message = posts.find(
        (post): post is Extract<ExtensionMessage, { type: 'availableModels' }> =>
            post.type === 'availableModels'
    );
    assert.ok(message);
    assert.deepEqual(message.models, presetModels);
    assert.ok(logEntries.some((entry) =>
        entry.level === 'warn' && entry.message.includes('Failed to load models')
    ));
    assert.ok(listModelCalls[0].apiKey);
});

test('agent events are flushed before the message that follows them', async () => {
    const panel = setup();
    generateCommits = async (_model, _changes, _options, _token, _history, events) => {
        events.onAgentEvent?.(agentStarted);
        events.onCandidate?.(0, candidateA);
        return { groups: [groups[0]], candidates: [{ groupIndex: 0, candidate: candidateA }], failed: [] };
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    assert.deepEqual(posts.map((message) => message.type), [
        'loading', 'agentEvents', 'addCandidate', 'done',
    ]);
    assert.deepEqual(posts[1], { type: 'agentEvents', events: [agentStarted] });
});

test('setApiKey and openEndpointSettings run the matching commands', async () => {
    const panel = setup();

    await panel.handleMessage({ type: 'setApiKey' });
    await panel.handleMessage({ type: 'openEndpointSettings' });

    assert.deepEqual(commandsExecuted, [
        { command: 'autocommit-for-deepseek.setApiKey', args: [] },
        {
            command: 'workbench.action.openSettings',
            args: ['@ext:winterYANGWT.autocommit-for-deepseek'],
        },
    ]);
});

test('the model is built from the current endpoint settings', async () => {
    const panel = setup();
    configStore = {
        baseUrl: ' https://gateway.test/v1/ ',
        requestHeaders: { 'X-Tenant': 'acme', ignored: 7 },
        maxInputTokens: 1,
        model: '  custom-model  ',
    };
    let passedModel: any;
    generateCommits = async (model) => {
        passedModel = model;
        return { groups: [], candidates: [], failed: [] };
    };

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'custom-model' });

    assert.deepEqual(modelConfigs, [{
        baseUrl: 'https://gateway.test/v1',
        apiKey: 'sk-test',
        model: 'custom-model',
        headers: { 'X-Tenant': 'acme' },
        maxInputTokens: 8192,
    }]);
    assert.ok(passedModel);
    assert.equal(passedModel.id, 'custom-model');
});

test('showLogs reveals the channel and openRunLog falls back to the picker', async () => {
    const panel = setup();

    await panel.handleMessage({ type: 'showLogs' });
    await panel.handleMessage({ type: 'openRunLog' });

    assert.equal(logShown, 1);
    assert.deepEqual(commandsExecuted, [
        { command: 'autocommit-for-deepseek.openRunLog', args: [] },
    ]);
    assert.deepEqual(openedDocuments, []);
});

test('generation creates a run record with run and end rows and opens it from the panel', async () => {
    const panel = setup();
    configStore['runLogs.keep'] = 20;

    await panel.generate({ language: 'en', conventionalCommits: true, model: 'deepseek-flash' });

    const runsDirectory = join(storageDir, 'runs');
    const files = readdirSync(runsDirectory);
    assert.equal(files.length, 1);
    const rows = readFileSync(join(runsDirectory, files[0]), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.type), ['run', 'end']);
    assert.equal(rows[0].trigger, 'generate');
    assert.equal(rows[0].repo, 'test-repo');
    assert.equal(rows[1].status, 'done');
    assert.equal(rows[1].totals.requests, 0);
    assert.ok(logEntries.some((entry) =>
        entry.level === 'info' && entry.message.startsWith('Run started')
    ));
    assert.ok(logEntries.some((entry) =>
        entry.level === 'info' && entry.message.startsWith('Run ended · done')
    ));

    await panel.handleMessage({ type: 'openRunLog' });
    assert.deepEqual(openedDocuments, [join(runsDirectory, files[0])]);
    assert.deepEqual(commandsExecuted, []);
});
