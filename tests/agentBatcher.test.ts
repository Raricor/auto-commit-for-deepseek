import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from '../src/types';
import {
    AGENT_BATCH_INTERVAL_MS,
    AgentBatcher,
    mergeAgentEvents,
} from '../src/ui/agentBatcher';

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const startedA: AgentEvent = {
    type: 'started',
    agent: { id: 'a', kind: 'generate', label: 'A', groupIndex: 0, attempt: 1, queuedAt: 1 },
};
const startedB: AgentEvent = {
    type: 'started',
    agent: { id: 'b', kind: 'order', label: 'Order', attempt: 1, queuedAt: 2 },
};
const finishedA: AgentEvent = {
    type: 'finished',
    id: 'a',
    status: 'done',
    finishedAt: 4,
};
const finishedB: AgentEvent = {
    type: 'finished',
    id: 'b',
    status: 'failed',
    error: 'boom',
    finishedAt: 5,
};

test('adjacent updates of the same agent are merged and start/finish keep their order', () => {
    const events: AgentEvent[] = [
        startedA,
        { type: 'update', id: 'a', status: 'thinking', reasoning: 'think 1 ' },
        { type: 'update', id: 'a', status: 'answering', reasoning: 'think 2', content: 'answer ' },
        startedB,
        { type: 'update', id: 'a', content: 'done' },
        finishedA,
        finishedB,
    ];

    const merged = mergeAgentEvents(events);

    assert.deepEqual(merged, [
        startedA,
        {
            type: 'update',
            id: 'a',
            status: 'answering',
            reasoning: 'think 1 think 2',
            content: 'answer ',
        },
        startedB,
        // Separated by startedB, so this update is not adjacent and stays separate.
        { type: 'update', id: 'a', content: 'done' },
        finishedA,
        finishedB,
    ]);
});

test('a reset drops the text accumulated earlier in the batch', () => {
    const events: AgentEvent[] = [
        startedA,
        { type: 'update', id: 'a', status: 'thinking', reasoning: 'old reasoning ', content: 'old answer' },
        { type: 'update', id: 'a', reset: true, status: 'thinking', note: 'retrying 1/3' },
        { type: 'update', id: 'a', reasoning: 'fresh', status: 'answering' },
    ];

    const merged = mergeAgentEvents(events);

    assert.deepEqual(merged, [
        startedA,
        {
            type: 'update',
            id: 'a',
            status: 'answering',
            reasoning: 'fresh',
            reset: true,
            note: 'retrying 1/3',
        },
    ]);
});

test('a reset also clears earlier text when other events separate it', () => {
    const events: AgentEvent[] = [
        startedA,
        { type: 'update', id: 'a', status: 'thinking', reasoning: 'old' },
        startedB,
        { type: 'update', id: 'a', reset: true, reasoning: 'fresh' },
    ];

    assert.deepEqual(mergeAgentEvents(events), [
        startedA,
        { type: 'update', id: 'a', status: 'thinking' },
        startedB,
        { type: 'update', id: 'a', reasoning: 'fresh', reset: true },
    ]);
});

test('updates for different agents are not merged', () => {
    const updateA: AgentEvent = { type: 'update', id: 'a', reasoning: 'a' };
    const updateB: AgentEvent = { type: 'update', id: 'b', reasoning: 'b' };
    assert.deepEqual(mergeAgentEvents([updateA, updateB]), [updateA, updateB]);
});

test('a batch is sent after the interval and not before', async () => {
    assert.equal(AGENT_BATCH_INTERVAL_MS, 100);
    const sent: AgentEvent[][] = [];
    const batcher = new AgentBatcher((events) => sent.push(events), 10);

    batcher.push(startedA);
    assert.equal(sent.length, 0);
    await wait(30);
    assert.deepEqual(sent, [[startedA]]);
});

test('flush sends pending events immediately and leaves nothing queued', () => {
    const sent: AgentEvent[][] = [];
    const batcher = new AgentBatcher((events) => sent.push(events), 10_000);

    batcher.push(startedA);
    batcher.flush();
    batcher.flush();

    assert.deepEqual(sent, [[startedA]]);
});

test('dispose clears the queue and prevents a later send', async () => {
    const sent: AgentEvent[][] = [];
    const batcher = new AgentBatcher((events) => sent.push(events), 10);

    batcher.push(startedA);
    batcher.dispose();
    batcher.flush();
    await wait(30);

    assert.deepEqual(sent, []);
});
