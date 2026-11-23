import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent, AgentInfo, AgentUsage } from '../src/types';
import {
    MAX_AGENT_TEXT_LENGTH,
    agentSummary,
    agentsForGroup,
    applyAgentEvents,
    latestGenerateAgent,
    wasRetried,
} from '../src/webview/agents';
import { initialState, reducer } from '../src/webview/state';
import type { Action, AppState } from '../src/webview/state';

function agent(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
    return {
        id,
        kind: 'generate',
        label: `Group ${id}`,
        groupIndex: 0,
        attempt: 1,
        queuedAt: 1_000,
        ...overrides,
    };
}

function started(info: AgentInfo): AgentEvent {
    return { type: 'started', agent: info };
}

function run(state: AppState, ...actions: Action[]): AppState {
    return actions.reduce(reducer, state);
}

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
    return {
        promptTokens: 1_000,
        cacheHitTokens: 600,
        cacheMissTokens: 400,
        completionTokens: 300,
        reasoningTokens: 100,
        ...overrides,
    };
}

test('agent events apply in order, append text, record usage, and ignore unknown ids', () => {
    const agents = applyAgentEvents([], [
        started(agent('a', { queuedAt: 100 })),
        { type: 'update', id: 'a', status: 'waiting' },
        { type: 'update', id: 'a', status: 'thinking', reasoning: 'step ' },
        { type: 'update', id: 'a', status: 'thinking', reasoning: 'one' },
        { type: 'update', id: 'a', status: 'answering', content: 'feat: ' },
        { type: 'update', id: 'a', status: 'answering', content: 'add things' },
        { type: 'update', id: 'missing', status: 'failed', reasoning: 'ignored' },
        { type: 'finished', id: 'missing', status: 'failed', finishedAt: 90 },
        { type: 'finished', id: 'a', status: 'done', usage: usage(), finishedAt: 900 },
    ]);

    assert.equal(agents.length, 1);
    assert.equal(agents[0].status, 'done');
    assert.equal(agents[0].reasoning, 'step one');
    assert.equal(agents[0].content, 'feat: add things');
    assert.equal(agents[0].reasoningTruncated, false);
    assert.equal(agents[0].contentTruncated, false);
    assert.deepEqual(agents[0].usage, usage());
    assert.equal(agents[0].finishedAt, 900);
});

test('reset clears both text streams and their truncation flags before appending', () => {
    let agents = applyAgentEvents([], [
        started(agent('a')),
        { type: 'update', id: 'a', status: 'thinking', reasoning: 'old reasoning', content: 'old content' },
        {
            type: 'update',
            id: 'a',
            status: 'waiting',
            reset: true,
            reasoning: 'new reasoning',
            content: 'new content',
        },
    ]);

    assert.equal(agents[0].reasoning, 'new reasoning');
    assert.equal(agents[0].content, 'new content');
    assert.equal(agents[0].reasoningTruncated, false);
    assert.equal(agents[0].contentTruncated, false);

    const oversized = `${'a'.repeat(MAX_AGENT_TEXT_LENGTH)}0123456789`;
    agents = applyAgentEvents(agents, [
        { type: 'update', id: 'a', status: 'thinking', reasoning: oversized },
    ]);

    assert.equal(agents[0].reasoning.length, MAX_AGENT_TEXT_LENGTH);
    assert.equal(agents[0].reasoning.endsWith('0123456789'), true);
    assert.equal(agents[0].reasoningTruncated, true);
    assert.equal(agents[0].contentTruncated, false);

    agents = applyAgentEvents(agents, [
        { type: 'update', id: 'a', status: 'thinking', reasoning: 'X' },
    ]);
    assert.equal(agents[0].reasoning.length, MAX_AGENT_TEXT_LENGTH);
    assert.equal(agents[0].reasoning.endsWith('X'), true);
    assert.equal(agents[0].reasoningTruncated, true);
});

test('loading clears agents and active focus; done/error cancel only unfinished agents', () => {
    const events: AgentEvent[] = [
        started(agent('finished')),
        started(agent('unfinished')),
        { type: 'finished', id: 'finished', status: 'done', finishedAt: 2_000 },
    ];
    const loaded = run(initialState, { type: 'AGENT_EVENTS', events });

    const done = run(loaded, { type: 'DONE' });
    assert.equal(done.agents[0].status, 'done');
    assert.equal(done.agents[1].status, 'cancelled');

    const errored = run(loaded, { type: 'ERROR', message: 'boom' });
    assert.equal(errored.agents[0].status, 'done');
    assert.equal(errored.agents[1].status, 'cancelled');
    assert.equal(errored.error, 'boom');

    const cleared = run(
        done,
        { type: 'FOCUS_AGENT', id: 'unfinished' },
        { type: 'SET_LOADING' },
    );
    assert.deepEqual(cleared.agents, []);
    assert.equal(cleared.focusAgentId, null);
});

test('agent summary totals usage, cache rate and duration until now while running', () => {
    const events: AgentEvent[] = [
        started(agent('done', { queuedAt: 1_000 })),
        { type: 'finished', id: 'done', status: 'done', usage: usage(), finishedAt: 5_000 },
        started(agent('running', { queuedAt: 2_000 })),
        { type: 'update', id: 'running', status: 'thinking', reasoning: 'thinking' },
        started(agent('failed', { queuedAt: 3_000 })),
        { type: 'finished', id: 'failed', status: 'failed', finishedAt: 4_000, error: 'nope' },
    ];
    const agents = applyAgentEvents([], events);

    const running = agentSummary(agents, 10_000);
    assert.equal(running.total, 3);
    assert.equal(running.running, 1);
    assert.equal(running.failed, 1);
    assert.equal(running.inputTokens, 1_000);
    assert.equal(running.cacheHitTokens, 600);
    assert.equal(running.cacheHitRate, 0.6);
    assert.equal(running.thinkingTokens, 100);
    assert.equal(running.outputTokens, 200);
    assert.equal(running.durationMs, 9_000);

    const finished = applyAgentEvents(agents, [
        {
            type: 'finished',
            id: 'running',
            status: 'done',
            usage: usage({ promptTokens: 2_000, cacheHitTokens: 1_000, completionTokens: 500, reasoningTokens: 0 }),
            finishedAt: 6_000,
        },
    ]);
    const settled = agentSummary(finished, 20_000);
    assert.equal(settled.running, 0);
    assert.equal(settled.inputTokens, 3_000);
    assert.equal(settled.cacheHitTokens, 1_600);
    assert.equal(settled.thinkingTokens, 100);
    assert.equal(settled.outputTokens, 700);
    assert.equal(settled.durationMs, 5_000);
});

test('latest generate agent and retry detection use attempt and start time', () => {
    const agents = applyAgentEvents([], [
        started(agent('generate-1', { label: 'Group 0', groupIndex: 0, attempt: 1, queuedAt: 100 })),
        started(agent('summary-1', { kind: 'summary', label: 'Summary', groupIndex: 0, queuedAt: 150 })),
        started(agent('generate-2', { label: 'Group 0', groupIndex: 0, attempt: 2, queuedAt: 200 })),
        started(agent('generate-3', { label: 'Other group', groupIndex: 1, attempt: 1, queuedAt: 300 })),
    ]);

    assert.equal(latestGenerateAgent(agents, 0)?.id, 'generate-2');
    assert.equal(latestGenerateAgent(agents, 2), undefined);
    assert.deepEqual(agentsForGroup(agents, 0).map((row) => row.id), ['generate-1', 'summary-1', 'generate-2']);
    assert.equal(wasRetried(agents, agents[0]), true);
    assert.equal(wasRetried(agents, agents[2]), false);
    assert.equal(wasRetried(agents, agents[1]), false);
});

test('endpoint, tab and focus state round-trip through the reducer', () => {
    let state = run(initialState, {
        type: 'SET_ENDPOINT',
        endpoint: { baseUrl: 'https://api.deepseek.com', apiKey: 'secret' },
    });
    assert.deepEqual(state.endpoint, { baseUrl: 'https://api.deepseek.com', apiKey: 'secret' });

    state = run(
        state,
        { type: 'SET_ACTIVE_TAB', activeTab: 'agents' },
        { type: 'FOCUS_AGENT', id: 'agent-1' },
    );
    assert.equal(state.activeTab, 'agents');
    assert.equal(state.focusAgentId, 'agent-1');

    state = run(state, { type: 'SET_ACTIVE_TAB', activeTab: 'commits' });
    assert.equal(state.focusAgentId, null);

    state = run(
        state,
        { type: 'SET_ACTIVE_TAB', activeTab: 'agents' },
        { type: 'FOCUS_AGENT', id: 'agent-2' },
        { type: 'CLEAR_AGENT_FOCUS' },
    );
    assert.equal(state.activeTab, 'agents');
    assert.equal(state.focusAgentId, null);
});
