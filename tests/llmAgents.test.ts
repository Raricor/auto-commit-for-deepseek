import assert from 'node:assert/strict';
import test from 'node:test';
import type { CancellationToken } from 'vscode';
import {
    ModelError, type ChatModel, type ChatRequestOptions, type ChatResult,
    type ChatStreamHandlers,
} from '../src/llm/chatModel';
import type {
    AgentEvent, AgentInfo, AgentUsage, FileChange, GenerateOptions,
} from '../src/types';

// VS Code is only available inside the extension host. Replace that boundary;
// grouping, budgeting, concurrency, generation and agent events stay real.
const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
class CancellationError extends Error {}
nodeModule._load = function (id: string, ...args: unknown[]) {
    if (id === 'vscode') {
        return { CancellationError };
    }
    return originalLoad.call(this, id, ...args);
};
const service = require('../src/llm/llmService') as typeof import('../src/llm/llmService');
nodeModule._load = originalLoad;

const options: GenerateOptions = { conventionalCommits: true, language: 'en' };
const reply = (message: string) => JSON.stringify({ message, reason: 'Keep the intended behavior consistent.' });
const change = (path: string, diff = '+new behavior\n'): FileChange => ({ path, type: 'modified', diff });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const usage: AgentUsage = {
    promptTokens: 100, cacheHitTokens: 40, cacheMissTokens: 60,
    completionTokens: 20, reasoningTokens: 5,
};

type Handler = (
    prompt: string,
    handlers: ChatStreamHandlers,
    signal: AbortSignal,
    call: number,
) => ChatResult | Promise<ChatResult>;

function chatResult(content: string, reasoning = ''): ChatResult {
    return { content, reasoning, finishReason: 'stop', usage };
}

function abortError(): Error {
    const error = new Error('The request was aborted.');
    error.name = 'AbortError';
    return error;
}

function cancellation() {
    let cancelled = false;
    const listeners = new Set<(event?: unknown) => unknown>();
    const token = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested(listener: (event?: unknown) => unknown) {
            if (cancelled) {
                listener();
                return { dispose() { /* Already cancelled. */ } };
            }
            listeners.add(listener);
            return { dispose() { listeners.delete(listener); } };
        },
    };
    return {
        token: token as CancellationToken,
        cancel: () => {
            if (cancelled) { return; }
            cancelled = true;
            for (const listener of [...listeners]) { listener(); }
            listeners.clear();
        },
    };
}

function setup(handler: Handler, maxInputTokens = 64_000, charsPerToken = 3) {
    const prompts: string[] = [];
    const requestOptions: ChatRequestOptions[] = [];
    const signals: AbortSignal[] = [];
    let calls = 0;

    const model: ChatModel = {
        id: 'test-model', name: 'Test model', maxInputTokens,
        countTokens: async (text: string) => Math.ceil(Buffer.byteLength(text) / charsPerToken),
        request: async (
            prompt: string,
            optionsSeen: ChatRequestOptions,
            handlers: ChatStreamHandlers,
            signal: AbortSignal,
        ) => {
            prompts.push(prompt);
            requestOptions.push(optionsSeen);
            signals.push(signal);
            const response = await handler(prompt, handlers, signal, calls++);
            if (signal.aborted) { throw abortError(); }
            return response;
        },
    };
    return { model, prompts, requestOptions, signals };
}

const isGrouping = (prompt: string) => prompt.startsWith('You are an expert Git commit assistant.');
const isMerge = (prompt: string) => prompt.startsWith('You are an expert Git commit merger.');
const isOrdering = (prompt: string) => prompt.startsWith('You are an expert Git commit orderer.');
const isGeneration = (prompt: string) => prompt.includes('commit message generator');
const isSummary = (prompt: string) => prompt.startsWith('Summarize the supplied');

function groupingFiles(prompt: string): string[] {
    return [...prompt.matchAll(/^--- FILE: (.+?) \([^)]*\) ---$/gm)].map(match => match[1]);
}

function groupingReply(prompt: string, labelFor: (files: string[]) => string): string {
    const files = groupingFiles(prompt);
    return JSON.stringify([{ label: labelFor(files), files }]);
}

function mergeSingletonReply(prompt: string): string {
    return JSON.stringify([...prompt.matchAll(/^- (g\d+): label:/gm)].map((match, index) => ({
        label: `Merged group ${index + 1}`,
        groups: [match[1]],
    })));
}

function orderOriginalReply(prompt: string): string {
    return JSON.stringify([...new Set(prompt.matchAll(/\b(c\d+)\b/g))].map(match => match[1]));
}

function groupLabel(prompt: string): string {
    const match = prompt.match(/\nGroup: (.*)\n/);
    return match ? match[1] : 'group';
}

function started(events: AgentEvent[]): AgentInfo[] {
    return events.filter((event): event is Extract<AgentEvent, { type: 'started' }> =>
        event.type === 'started').map(event => event.agent);
}

function finished(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'finished' }>> {
    return events.filter((event): event is Extract<AgentEvent, { type: 'finished' }> =>
        event.type === 'finished');
}

function assertEveryAgentSettles(events: AgentEvent[]): void {
    const starts = started(events);
    const ends = finished(events);
    assert.equal(ends.length, starts.length, 'every started agent must finish exactly once');
    assert.equal(new Set(starts.map(agent => agent.id)).size, starts.length, 'agent ids are unique');
    for (const agent of starts) {
        assert.equal(ends.filter(end => end.id === agent.id).length, 1, `agent ${agent.id} has one finished event`);
    }
}

// ─── 1. full bucketed run: every kind, every label, balanced events ──────────

test('a complete bucketed run emits balanced agents with the expected kinds and labels', async () => {
    const changes = [
        ...Array.from({ length: 60 }, (_, i) => change(`src/a/file-${i}.ts`, '+changed line\n'.repeat(150))),
        ...Array.from({ length: 60 }, (_, i) => change(`src/b/file-${i}.ts`, '+changed line\n'.repeat(150))),
    ];
    const env = setup((prompt, handlers) => {
        if (isSummary(prompt)) {
            handlers.onContent?.('A concise summary of the supplied changes.');
            return chatResult('A concise summary of the supplied changes.');
        }
        if (isGrouping(prompt)) {
            return chatResult(groupingReply(prompt, files => `Feature ${files[0].split('/').slice(0, 2).join('/')}`));
        }
        if (isMerge(prompt)) { return chatResult(mergeSingletonReply(prompt)); }
        if (isGeneration(prompt)) {
            const content = reply(`feat: ${groupLabel(prompt)}`);
            handlers.onContent?.(content);
            return chatResult(content);
        }
        if (isOrdering(prompt)) { return chatResult(orderOriginalReply(prompt)); }
        throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    });
    const events: AgentEvent[] = [];

    const result = await service.generateCommits(
        env.model, changes, options, cancellation().token, undefined, {
            onAgentEvent: event => events.push(event),
        },
    );

    assert.equal(result.failed.length, 0);
    assert.equal(result.candidates.length, 2);
    assertEveryAgentSettles(events);

    const starts = started(events);
    const kinds = new Set(starts.map(agent => agent.kind));
    for (const kind of ['bucket', 'merge', 'summary', 'generate', 'order'] as const) {
        assert.ok(kinds.has(kind), `a ${kind} agent ran`);
    }

    const buckets = starts.filter(agent => agent.kind === 'bucket');
    assert.deepEqual(buckets.map(agent => agent.label).sort(), [
        'Bucket 1/2 · src/a (60 files)',
        'Bucket 2/2 · src/b (60 files)',
    ]);
    assert.ok(buckets.every(agent => agent.attempt === 1));

    const merges = starts.filter(agent => agent.kind === 'merge');
    assert.deepEqual(merges.map(agent => agent.label), ['Merge 2 groups from 2 buckets']);
    assert.equal(merges[0].attempt, 1);

    const summaries = starts.filter(agent => agent.kind === 'summary');
    assert.ok(summaries.length >= 2, 'each generation group needed diff summaries');
    for (const agent of summaries) {
        assert.match(agent.label, /^Summarize \d+ files: Merged group [12]( \(part \d+\))?$/);
        assert.ok(agent.groupIndex === 0 || agent.groupIndex === 1);
        assert.equal(agent.attempt, 1);
    }

    const generations = starts.filter(agent => agent.kind === 'generate');
    assert.deepEqual(generations.map(agent => agent.label), ['Merged group 1', 'Merged group 2']);
    assert.deepEqual(generations.map(agent => agent.groupIndex), [0, 1]);
    assert.ok(generations.every(agent => agent.attempt === 1));

    const orders = starts.filter(agent => agent.kind === 'order');
    assert.deepEqual(orders.map(agent => agent.label), ['Order 2 commits']);

    // The successful generate agents carry the mock usage to their finished event.
    const done = finished(events).filter(event => event.status === 'done');
    const generatedIds = new Set(generations.map(agent => agent.id));
    for (const event of done.filter(event => generatedIds.has(event.id))) {
        assert.deepEqual(event.usage, usage);
    }
});

// ─── 2. status order and streamed text ──────────────────────────────────────

test('an agent moves started → waiting → thinking → answering → finished with full text', async () => {
    const content = reply('feat: streamed');
    const middle = Math.floor(content.length / 2);
    const env = setup((_prompt, handlers) => {
        handlers.onReasoning?.('reasoning ');
        handlers.onReasoning?.('in two parts');
        handlers.onContent?.(content.slice(0, middle));
        handlers.onContent?.(content.slice(middle));
        return chatResult(content, 'reasoning in two parts');
    });
    const events: AgentEvent[] = [];

    const result = await service.generateCommits(
        env.model, [change('src/only.ts')], options, cancellation().token, undefined, {
            onAgentEvent: event => events.push(event),
        },
    );
    assert.equal(result.candidates[0].candidate.message, 'feat: streamed');

    const statuses: string[] = [];
    for (const event of events) {
        if (event.type === 'started') { statuses.push('started'); }
        if (event.type === 'update' && event.status) { statuses.push(event.status); }
        if (event.type === 'finished') { statuses.push(event.status); }
    }
    assert.deepEqual(statuses, ['started', 'waiting', 'thinking', 'answering', 'done']);

    const reasoning = events
        .filter((event): event is Extract<AgentEvent, { type: 'update' }> => event.type === 'update')
        .map(event => event.reasoning ?? '').join('');
    const streamed = events
        .filter((event): event is Extract<AgentEvent, { type: 'update' }> => event.type === 'update')
        .map(event => event.content ?? '').join('');
    assert.equal(reasoning, 'reasoning in two parts');
    assert.equal(streamed, content);
});

test('every started agent receives its full prompt exactly once', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    const env = setup((prompt) => {
        if (isGrouping(prompt)) {
            return chatResult(JSON.stringify([{
                label: 'Feature',
                files: files.map(file => file.path),
            }]));
        }
        if (isGeneration(prompt)) { return chatResult(reply('feat: prompt')); }
        throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    });
    const events: AgentEvent[] = [];
    const prompts = new Map<string, string>();
    const promptOrder: string[] = [];

    const result = await service.generateCommits(
        env.model, files, options, cancellation().token, undefined, {
            onAgentEvent: event => events.push(event),
            onAgentPrompt: (id, prompt) => {
                promptOrder.push(id);
                prompts.set(id, prompt);
            },
        },
    );

    assert.equal(result.candidates.length, 1);
    const starts = started(events);
    assert.ok(starts.length > 0);
    assert.equal(prompts.size, starts.length);
    assert.deepEqual(promptOrder, starts.map(agent => agent.id));
    for (const agent of starts) {
        const prompt = prompts.get(agent.id);
        assert.ok(prompt && prompt.length > 0, `agent ${agent.id} received its prompt`);
    }
});

// ─── 3. concurrency limit and queueing ──────────────────────────────────────
test('with concurrency 1 the next generation agent waits for the previous finished event', async () => {
    const files = [change('src/a.ts'), change('src/b.ts')];
    const env = setup((prompt) => {
        if (isGrouping(prompt)) {
            return chatResult(JSON.stringify(files.map(file => ({ label: file.path, files: [file.path] }))));
        }
        if (isGeneration(prompt)) { return chatResult(reply(`feat: ${groupLabel(prompt)}`)); }
        throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    });
    const events: AgentEvent[] = [];

    const result = await service.generateCommits(
        env.model, files, { ...options, concurrency: 1 }, cancellation().token, undefined, {
            onAgentEvent: event => events.push(event),
        },
    );
    assert.equal(result.candidates.length, 2);

    const agentOrder = started(events).map(agent => agent.id);
    const generationIds = new Set(started(events)
        .filter(agent => agent.kind === 'generate').map(agent => agent.id));
    const generationOrder = agentOrder.filter(id => generationIds.has(id));
    assert.equal(generationOrder.length, 2, 'both groups were generated');
    for (let index = 1; index < generationOrder.length; index++) {
        const previousFinished = events.findIndex(event =>
            event.type === 'finished' && event.id === generationOrder[index - 1]);
        const nextWaiting = events.findIndex(event =>
            event.type === 'update' && event.id === generationOrder[index] && event.status === 'waiting');
        assert.ok(previousFinished >= 0, 'the previous agent finished');
        assert.ok(nextWaiting > previousFinished, 'the next agent starts only after the previous finished');
    }
});

// ─── 4. unusable output retries as attempt 2 ────────────────────────────────

test('an unusable commit reply is retried as a second generate agent with attempt 2', async () => {
    let generationCalls = 0;
    const env = setup((prompt, handlers) => {
        if (!isGeneration(prompt)) { throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`); }
        generationCalls += 1;
        const content = generationCalls === 1 ? 'not JSON' : reply('feat: recovered');
        handlers.onContent?.(content);
        return chatResult(content);
    });
    const events: AgentEvent[] = [];

    const result = await service.generateCommits(
        env.model, [change('src/only.ts')], options, cancellation().token, undefined, {
            onAgentEvent: event => events.push(event),
        },
    );

    assert.equal(result.candidates[0].candidate.message, 'feat: recovered');
    const generated = started(events).filter(agent => agent.kind === 'generate');
    assert.deepEqual(generated.map(agent => agent.attempt), [1, 2]);
    assertEveryAgentSettles(events);
});

// ─── 5. provider retry resets streamed text ─────────────────────────────────

test('onRetry emits a reset waiting update with a note, then streaming starts fresh', async () => {
    const content = reply('feat: retried');
    const env = setup((_prompt, handlers) => {
        handlers.onContent?.('text from the discarded attempt');
        handlers.onRetry?.({ retry: 1, maxRetries: 3, delayMs: 2_000, message: 'HTTP 429 rate limited' });
        handlers.onReasoning?.('fresh reasoning');
        handlers.onContent?.(content);
        return chatResult(content, 'fresh reasoning');
    });
    const events: AgentEvent[] = [];

    await service.generateCommits(
        env.model, [change('src/only.ts')], options, cancellation().token, undefined, {
            onAgentEvent: event => events.push(event),
        },
    );

    const reset = events.find((event): event is Extract<AgentEvent, { type: 'update' }> =>
        event.type === 'update' && event.reset === true);
    assert.ok(reset, 'a reset update was emitted');
    assert.equal(reset.status, 'waiting');
    assert.match(reset.note ?? '', /HTTP 429 rate limited · retry 1\/3 in 2s/);

    const afterReset = events.slice(events.indexOf(reset) + 1);
    const reasoning = afterReset
        .filter((event): event is Extract<AgentEvent, { type: 'update' }> => event.type === 'update')
        .map(event => event.reasoning ?? '').join('');
    const streamed = afterReset
        .filter((event): event is Extract<AgentEvent, { type: 'update' }> => event.type === 'update')
        .map(event => event.content ?? '').join('');
    assert.equal(reasoning, 'fresh reasoning');
    assert.equal(streamed, content);
});

// ─── 6. provider error aborts the run without dangling agents ───────────────

test('a ModelError fails its agent and cancels queued/in-flight agents without dangling starts', async () => {
    const files = [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')];
    const providerFailure = new ModelError('rate-limit', 'Too many requests', 429);
    const env = setup(async (prompt) => {
        if (isGrouping(prompt)) {
            return chatResult(JSON.stringify(files.map(file => ({ label: file.path, files: [file.path] }))));
        }
        if (!isGeneration(prompt)) { throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`); }
        const label = groupLabel(prompt);
        if (label === 'src/a.ts') { await sleep(100); return chatResult(reply('feat: a')); }
        if (label === 'src/b.ts') { throw providerFailure; }
        return chatResult(reply('feat: c'));
    });
    const events: AgentEvent[] = [];

    let rejection: unknown;
    try {
        await service.generateCommits(
            env.model, files, { ...options, concurrency: 2 }, cancellation().token, undefined, {
                onAgentEvent: event => events.push(event),
            },
        );
    } catch (error) {
        rejection = error;
    }

    assert.equal(rejection, providerFailure);
    assertEveryAgentSettles(events);

    const failing = started(events).find(agent =>
        agent.kind === 'generate' && agent.label === 'src/b.ts');
    assert.ok(failing, 'the failing request has an agent');
    const failingEnd = finished(events).find(event => event.id === failing!.id);
    assert.equal(failingEnd?.status, 'failed');
    assert.match(failingEnd?.error ?? '', /Too many requests/);

    for (const event of finished(events)) {
        assert.ok(
            event.status === 'done' || event.status === 'failed' || event.status === 'cancelled',
            'every agent has a terminal status',
        );
    }
    const cancelled = finished(events).filter(event => event.status === 'cancelled');
    assert.ok(cancelled.length >= 1, 'an unfinished request was cancelled');
});

// ─── 7. user cancellation settles every agent ───────────────────────────────

test('user cancellation gives every started agent a finished event', async () => {
    const files = [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')];
    const c = cancellation();
    let cancelled = false;
    const env = setup((prompt) => {
        if (isGrouping(prompt)) {
            return chatResult(JSON.stringify(files.map(file => ({ label: file.path, files: [file.path] }))));
        }
        if (!isGeneration(prompt)) { throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`); }
        if (!cancelled) {
            cancelled = true;
            c.cancel();
            throw abortError();
        }
        return chatResult(reply('feat: late'));
    });
    const events: AgentEvent[] = [];

    await assert.rejects(
        service.generateCommits(
            env.model, files, { ...options, concurrency: 1 }, c.token, undefined, {
                onAgentEvent: event => events.push(event),
            },
        ),
        CancellationError,
    );

    assertEveryAgentSettles(events);
    assert.ok(finished(events).some(event => event.status === 'cancelled'));
    assert.ok(finished(events).every(event =>
        event.status === 'done' || event.status === 'failed' || event.status === 'cancelled'));
});

// ─── 8. effort mapping ──────────────────────────────────────────────────────

test('reasoning effort maps to ChatRequestOptions effort, and empty omits it', async () => {
    async function run(effort: '' | 'none' | 'max'): Promise<ChatRequestOptions> {
        const env = setup(() => chatResult(reply('feat: effort')));
        await service.generateCommits(
            env.model, [change('src/only.ts')], { ...options, reasoningEffort: effort },
            cancellation().token,
        );
        return env.requestOptions[0];
    }

    assert.deepEqual(await run(''), {});
    assert.deepEqual(await run('none'), { effort: 'none' });
    assert.deepEqual(await run('max'), { effort: 'max' });
});

// ─── 9. a throwing agent-event listener cannot break generation ─────────────

test('an onAgentEvent callback that throws does not affect the generation', async () => {
    const env = setup((prompt, handlers) => {
        if (isGeneration(prompt)) {
            const content = reply('feat: resilient');
            handlers.onContent?.(content);
            return chatResult(content);
        }
        throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    });
    let events = 0;

    const result = await service.generateCommits(
        env.model, [change('src/only.ts')], options, cancellation().token, undefined, {
            onAgentEvent: () => {
                events += 1;
                throw new Error('the host failed to render this event');
            },
        },
    );

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].candidate.message, 'feat: resilient');
    assert.ok(events >= 3, 'the callback was called for several events');
});
