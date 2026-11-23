import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { afterEach } from 'node:test';
import {
    AgentLog, formatAgentFinished, redactSecrets, type Logger,
} from '../src/logging/logger';
import { RunRecorder } from '../src/logging/runRecorder';
import type { AgentEvent, AgentUsage } from '../src/types';

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs) {
        rmSync(directory, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function tempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'ac-logging-'));
    tempDirs.push(directory);
    return directory;
}

function recorder(directory: string, overrides: Partial<ConstructorParameters<typeof RunRecorder>[0]> = {}) {
    return new RunRecorder({
        directory,
        trigger: 'generate',
        repo: 'my/repo name',
        files: 2,
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        effort: '',
        concurrency: 4,
        language: 'en',
        conventionalCommits: true,
        minCommits: 0,
        maxCommits: 0,
        headerNames: ['X-Tenant'],
        keep: 20,
        includePrompts: false,
        ...overrides,
    });
}

async function readLines(filePath: string): Promise<Array<Record<string, any>>> {
    const text = await readFile(filePath, 'utf8');
    return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

const usage: AgentUsage = {
    promptTokens: 2100,
    cacheHitTokens: 1281,
    cacheMissTokens: 819,
    completionTokens: 1540,
    reasoningTokens: 1200,
};

const started: AgentEvent = {
    type: 'started',
    agent: {
        id: 'a12',
        kind: 'generate',
        label: 'Feature A',
        groupIndex: 0,
        attempt: 1,
        queuedAt: 1000,
    },
};

const finished: AgentEvent = {
    type: 'finished',
    id: 'a12',
    status: 'done',
    usage,
    finishedAt: 4400,
};

const cancelled: AgentEvent = {
    type: 'finished',
    id: 'a12',
    status: 'cancelled',
    finishedAt: 5000,
};

test('a run record contains every row type in emission order', async () => {
    const directory = tempDir();
    const run = recorder(directory);
    run.recordGroups([{ index: 0, label: 'Feature A', files: ['a.ts', 'b.ts'] }]);
    run.onAgentEvent(started);
    run.onAgentEvent({
        type: 'update', id: 'a12', status: 'thinking', reasoning: 'think ', note: 'retry 1/3',
    });
    run.onAgentEvent({ type: 'update', id: 'a12', content: '{"message":"feat: a"}' });
    run.onAgentEvent(finished);
    run.recordCandidate(0, {
        id: 'c0', message: 'feat: a', reason: 'Adds a', files: ['a.ts'], checked: true,
    });
    run.recordGroupFailed(1, 'provider down');
    run.recordNotice('warning', 'Fell back to folder grouping.');
    run.recordReorder(['c0']);
    const totals = await run.close('done');

    assert.ok(run.path);
    assert.match(basename(run.path!), /^\d{8}-\d{6}-my_repo_name-generate\.jsonl$/);
    const rows = await readLines(run.path!);
    assert.deepEqual(rows.map((row) => row.type), [
        'run', 'groups', 'agent', 'candidate', 'groupFailed', 'notice', 'reorder', 'end',
    ]);
    assert.equal(rows.every((row) => row.v === 1), true);

    const runRow = rows[0];
    assert.equal(runRow.trigger, 'generate');
    assert.equal(runRow.repo, 'my/repo name');
    assert.equal(runRow.files, 2);
    assert.equal(runRow.effort, '');
    assert.deepEqual(runRow.headerNames, ['X-Tenant']);

    const agentRow = rows[2];
    assert.equal(agentRow.id, 'a12');
    assert.equal(agentRow.kind, 'generate');
    assert.equal(agentRow.status, 'done');
    assert.equal(agentRow.durationMs, 3400);
    assert.equal(agentRow.reasoning, 'think ');
    assert.equal(agentRow.content, '{"message":"feat: a"}');
    assert.deepEqual(agentRow.notes, ['retry 1/3']);
    assert.deepEqual(agentRow.usage, usage);
    assert.equal('prompt' in agentRow, false);

    assert.deepEqual(rows[3], {
        v: 1, type: 'candidate', groupIndex: 0, id: 'c0', message: 'feat: a',
        reason: 'Adds a', files: ['a.ts'],
    });
    assert.equal(rows[4].message, 'provider down');
    assert.deepEqual(rows[5], {
        v: 1, type: 'notice', level: 'warning', message: 'Fell back to folder grouping.',
    });
    assert.deepEqual(rows[6], { v: 1, type: 'reorder', ids: ['c0'] });

    const end = rows.at(-1)!;
    assert.equal(end.status, 'done');
    assert.equal(typeof end.finishedAt, 'string');
    assert.equal(end.totals.requests, 1);
    assert.deepEqual(end.totals, {
        requests: 1,
        promptTokens: 2100,
        cacheHitTokens: 1281,
        reasoningTokens: 1200,
        completionTokens: 1540,
    });
    assert.deepEqual(totals, end.totals);
});

test('reset clears the earlier attempt so only the last text is recorded', async () => {
    const directory = tempDir();
    const run = recorder(directory);
    run.onAgentEvent(started);
    run.onAgentEvent({ type: 'update', id: 'a12', reasoning: 'old think', content: 'old answer' });
    run.onAgentEvent({ type: 'update', id: 'a12', reset: true, note: 'retry 1/3' });
    run.onAgentEvent({ type: 'update', id: 'a12', reasoning: 'new think', content: 'new answer' });
    await run.close('done');

    const rows = await readLines(run.path!);
    const agent = rows.find((row) => row.type === 'agent')!;
    assert.equal(agent.reasoning, 'new think');
    assert.equal(agent.content, 'new answer');
    assert.deepEqual(agent.notes, ['retry 1/3']);
});

test('close marks unfinished agents incomplete and ignores later events', async () => {
    const directory = tempDir();
    const run = recorder(directory);
    run.onAgentEvent(started);
    run.onAgentEvent({ type: 'update', id: 'a12', reasoning: 'partial think', content: 'partial answer' });
    await run.close('cancelled');

    run.onAgentEvent(finished);
    run.recordNotice('info', 'late notice');

    const rows = await readLines(run.path!);
    assert.deepEqual(rows.map((row) => row.type), ['run', 'agent', 'end']);
    const agent = rows[1];
    assert.equal(agent.status, 'cancelled');
    assert.equal(agent.incomplete, true);
    assert.equal(agent.reasoning, 'partial think');
    assert.equal(agent.content, 'partial answer');
    assert.equal(rows[2].status, 'cancelled');
});

test('prompts are omitted by default and included when enabled', async () => {
    const directory = tempDir();
    const off = recorder(directory);
    off.onAgentEvent(started);
    off.onAgentPrompt('a12', 'SECRET PROMPT');
    off.onAgentEvent(finished);
    await off.close('done');
    const offAgent = (await readLines(off.path!)).find((row) => row.type === 'agent')!;
    assert.equal('prompt' in offAgent, false);

    const on = recorder(directory, { includePrompts: true });
    on.onAgentEvent(started);
    on.onAgentPrompt('a12', 'SECRET PROMPT');
    on.onAgentEvent(finished);
    await on.close('done');
    const onAgent = (await readLines(on.path!)).find((row) => row.type === 'agent')!;
    assert.equal(onAgent.prompt, 'SECRET PROMPT');
});

test('keep deletes the oldest files and keep=0 disables recording without deleting', async () => {
    const directory = tempDir();
    for (const name of [
        '20000101-000000-old-generate.jsonl',
        '20010101-000000-old-generate.jsonl',
        '20020101-000000-old-generate.jsonl',
    ]) {
        writeFileSync(join(directory, name), '{"v":1,"type":"run"}\n');
    }
    const run = recorder(directory, { keep: 2 });
    await run.close('done');
    const remaining = readdirSync(directory).sort();
    assert.equal(remaining.length, 2);
    assert.equal(remaining.includes('20000101-000000-old-generate.jsonl'), false);
    assert.equal(remaining.includes('20010101-000000-old-generate.jsonl'), false);
    assert.equal(remaining.includes(basename(run.path!)), true);

    const disabledDirectory = tempDir();
    writeFileSync(join(disabledDirectory, 'existing.jsonl'), '{"v":1,"type":"run"}\n');
    const disabled = recorder(disabledDirectory, { keep: 0 });
    disabled.onAgentEvent(started);
    await disabled.close('done');
    assert.equal(disabled.path, undefined);
    assert.deepEqual(readdirSync(disabledDirectory), ['existing.jsonl']);
});

test('run records never contain header values or an API key from an error', async () => {
    const directory = tempDir();
    const run = recorder(directory, {
        headerNames: ['Authorization', 'X-Tenant'],
    });
    run.onAgentEvent(started);
    run.onAgentEvent({
        type: 'finished',
        id: 'a12',
        status: 'failed',
        error: 'HTTP 401: Authorization: Bearer sk-super-secret',
        finishedAt: 4400,
    });
    await run.close('error', 'request failed with Bearer sk-super-secret');

    const text = readFileSync(run.path!, 'utf8');
    assert.equal(text.includes('sk-super-secret'), false);
    assert.equal(text.includes('Bearer ***'), true);
    assert.equal(text.includes('Authorization'), true);
});

test('a write failure only warns and close still resolves', async () => {
    const directory = tempDir();
    const blocked = join(directory, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const warnings: string[] = [];
    const run = recorder(blocked, {
        logger: { warn: (message: string) => { warnings.push(message); } },
    });
    run.onAgentEvent(started);
    await assert.doesNotReject(run.close('done'));
    assert.ok(warnings.length > 0);
});

test('logger agent lines match the documented format', () => {
    const messages: string[] = [];
    const logger: Logger = {
        info: (message) => messages.push(`info:${message}`),
        warn: (message) => messages.push(`warn:${message}`),
        error: (message) => messages.push(`error:${message}`),
        debug: (message) => messages.push(`debug:${message}`),
        trace: (message) => messages.push(`trace:${message}`),
        show: () => { },
    };
    const agentLog = new AgentLog(logger);
    agentLog.handle(started);
    agentLog.handle(finished);
    agentLog.handle({
        type: 'update', id: 'a12', note: 'HTTP 429 rate limited · retry 1/3 in 2s',
    });
    agentLog.handle({
        type: 'started',
        agent: { ...started.agent, id: 'a13', label: 'Feature B' },
    });
    agentLog.handle({ type: 'finished', id: 'a13', status: 'cancelled', finishedAt: 6000 });

    assert.deepEqual(messages, [
        'debug:[a12] queued generate "Feature A"',
        'info:[a12] done generate "Feature A" 3.4s · in 2.1k (61% cached) · think 1.2k · out 340',
        'warn:[a12] HTTP 429 rate limited · retry 1/3 in 2s',
        'debug:[a13] queued generate "Feature B"',
        'debug:[a13] cancelled generate "Feature B"',
    ]);
    assert.equal(
        formatAgentFinished(started.agent, 4400, usage),
        '[a12] done generate "Feature A" 3.4s · in 2.1k (61% cached) · think 1.2k · out 340'
    );
});

test('Bearer tokens are redacted in every logger path', () => {
    assert.equal(
        redactSecrets('request failed: Authorization: Bearer sk-abc123 more'),
        'request failed: Authorization: Bearer *** more'
    );
    const messages: string[] = [];
    const logger: Logger = {
        info: (message) => messages.push(`info:${message}`),
        warn: (message) => messages.push(`warn:${message}`),
        error: (message) => messages.push(`error:${message}`),
        debug: (message) => messages.push(`debug:${message}`),
        trace: (message) => messages.push(`trace:${message}`),
        show: () => { },
    };
    const agentLog = new AgentLog(logger);
    agentLog.handle(started);
    agentLog.handle({
        type: 'finished',
        id: 'a12',
        status: 'failed',
        error: 'HTTP 401 Bearer sk-abc123',
        finishedAt: 4400,
    });
    assert.equal(messages.some((message) => message.includes('sk-abc123')), false);
    assert.equal(messages.some((message) => message.includes('Bearer ***')), true);
});
