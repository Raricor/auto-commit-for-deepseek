import type {
    AgentEvent,
    AgentInfo,
    AgentStatus,
    AgentUsage,
} from '../types';

export const MAX_AGENT_TEXT_LENGTH = 200_000;

export interface AgentRow extends AgentInfo {
    status: AgentStatus;
    reasoning: string;
    content: string;
    reasoningTruncated: boolean;
    contentTruncated: boolean;
    note?: string;
    usage?: AgentUsage;
    error?: string;
    finishedAt?: number;
}

export interface AgentSummary {
    total: number;
    running: number;
    failed: number;
    inputTokens: number;
    cacheHitTokens: number;
    cacheHitRate: number;
    thinkingTokens: number;
    outputTokens: number;
    durationMs: number;
}

export function isAgentRunning(agent: Pick<AgentRow, 'status'>): boolean {
    return agent.status === 'queued'
        || agent.status === 'waiting'
        || agent.status === 'thinking'
        || agent.status === 'answering';
}

function appendText(
    current: string,
    addition: string | undefined,
    alreadyTruncated: boolean,
): { text: string; truncated: boolean } {
    const text = current + (addition ?? '');
    if (text.length <= MAX_AGENT_TEXT_LENGTH) {
        return { text, truncated: alreadyTruncated };
    }
    return {
        text: text.slice(-MAX_AGENT_TEXT_LENGTH),
        truncated: true,
    };
}

export function applyAgentEvents(agents: AgentRow[], events: AgentEvent[]): AgentRow[] {
    let next = agents;
    const indices = new Map(agents.map((agent, index) => [agent.id, index]));

    for (const event of events) {
        if (event.type === 'started') {
            if (indices.has(event.agent.id)) continue;
            if (next === agents) next = [...agents];
            indices.set(event.agent.id, next.length);
            next.push({
                ...event.agent,
                status: 'queued',
                reasoning: '',
                content: '',
                reasoningTruncated: false,
                contentTruncated: false,
            });
            continue;
        }

        const index = indices.get(event.id);
        if (index === undefined) continue;
        const agent = next[index];
        if (next === agents) next = [...agents];

        if (event.type === 'update') {
            const reasoning = event.reset ? '' : agent.reasoning;
            const content = event.reset ? '' : agent.content;
            const nextReasoning = appendText(
                reasoning,
                event.reasoning,
                event.reset ? false : agent.reasoningTruncated,
            );
            const nextContent = appendText(
                content,
                event.content,
                event.reset ? false : agent.contentTruncated,
            );
            next[index] = {
                ...agent,
                status: event.status ?? agent.status,
                reasoning: nextReasoning.text,
                content: nextContent.text,
                reasoningTruncated: nextReasoning.truncated,
                contentTruncated: nextContent.truncated,
                note: event.note ?? agent.note,
            };
        } else {
            next[index] = {
                ...agent,
                status: event.status,
                usage: event.usage,
                error: event.error,
                finishedAt: event.finishedAt,
            };
        }
    }

    return next;
}

export function cancelRunningAgents(agents: AgentRow[]): AgentRow[] {
    if (!agents.some(isAgentRunning)) return agents;
    return agents.map((agent) => isAgentRunning(agent)
        ? { ...agent, status: 'cancelled' as const }
        : agent);
}

export function agentSummary(agents: AgentRow[], now: number): AgentSummary {
    let running = 0;
    let failed = 0;
    let inputTokens = 0;
    let cacheHitTokens = 0;
    let thinkingTokens = 0;
    let outputTokens = 0;
    let earliestQueuedAt: number | undefined;
    let latestFinishedAt: number | undefined;

    for (const agent of agents) {
        if (isAgentRunning(agent)) running += 1;
        if (agent.status === 'failed') failed += 1;
        earliestQueuedAt = earliestQueuedAt === undefined
            ? agent.queuedAt
            : Math.min(earliestQueuedAt, agent.queuedAt);
        if (agent.finishedAt !== undefined) {
            latestFinishedAt = latestFinishedAt === undefined
                ? agent.finishedAt
                : Math.max(latestFinishedAt, agent.finishedAt);
        }
        if (agent.usage) {
            inputTokens += agent.usage.promptTokens;
            cacheHitTokens += agent.usage.cacheHitTokens;
            thinkingTokens += agent.usage.reasoningTokens;
            outputTokens += Math.max(0, agent.usage.completionTokens - agent.usage.reasoningTokens);
        }
    }

    const end = running > 0
        ? Math.max(now, latestFinishedAt ?? now)
        : latestFinishedAt;

    return {
        total: agents.length,
        running,
        failed,
        inputTokens,
        cacheHitTokens,
        cacheHitRate: inputTokens > 0 ? cacheHitTokens / inputTokens : 0,
        thinkingTokens,
        outputTokens,
        durationMs: earliestQueuedAt !== undefined && end !== undefined
            ? Math.max(0, end - earliestQueuedAt)
            : 0,
    };
}

export function agentsForGroup(agents: AgentRow[], groupIndex: number): AgentRow[] {
    return agents.filter((agent) =>
        agent.groupIndex === groupIndex
        && (agent.kind === 'summary' || agent.kind === 'generate'));
}

export function latestGenerateAgent(agents: AgentRow[], groupIndex: number): AgentRow | undefined {
    let latest: AgentRow | undefined;
    for (const agent of agents) {
        if (agent.kind !== 'generate' || agent.groupIndex !== groupIndex) continue;
        if (!latest
            || agent.attempt > latest.attempt
            || (agent.attempt === latest.attempt && agent.queuedAt >= latest.queuedAt)) {
            latest = agent;
        }
    }
    return latest;
}

export function wasRetried(agents: AgentRow[], row: AgentRow): boolean {
    return agents.some((agent) =>
        agent.id !== row.id
        && agent.kind === row.kind
        && agent.label === row.label
        && agent.groupIndex === row.groupIndex
        && agent.attempt > row.attempt);
}
