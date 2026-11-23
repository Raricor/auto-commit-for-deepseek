import type { AgentEvent } from '../types';

/** How long agent events are collected before one batch is posted. */
export const AGENT_BATCH_INTERVAL_MS = 100;

type UpdateEvent = Extract<AgentEvent, { type: 'update' }>;

export interface AgentBatchTimers {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_TIMERS: AgentBatchTimers = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Merges adjacent update events of the same agent. started/finished events are
 * never merged and keep their relative order. A reset drops text accumulated
 * for that agent earlier in the batch, even when other events separate them.
 */
export function mergeAgentEvents(events: readonly AgentEvent[]): AgentEvent[] {
    const merged: AgentEvent[] = [];
    const lastUpdate = new Map<string, number>();

    for (const event of events) {
        if (event.type !== 'update') {
            merged.push(event);
            continue;
        }

        if (event.reset) {
            for (let index = merged.length - 1; index >= 0; index -= 1) {
                const candidate = merged[index];
                if (candidate.type !== 'update' || candidate.id !== event.id) {
                    continue;
                }
                const cleared: UpdateEvent = { type: 'update', id: candidate.id };
                if (candidate.status !== undefined) { cleared.status = candidate.status; }
                if (candidate.note !== undefined) { cleared.note = candidate.note; }
                if (candidate.reset) { cleared.reset = true; }
                merged[index] = cleared;
            }
        }

        const lastIndex = lastUpdate.get(event.id);
        const adjacent = lastIndex !== undefined
            && lastIndex === merged.length - 1
            && (merged[lastIndex] as UpdateEvent).id === event.id;

        if (!adjacent) {
            merged.push({ ...event });
            lastUpdate.set(event.id, merged.length - 1);
            continue;
        }

        const current = merged[lastIndex] as UpdateEvent;
        let reasoning = current.reasoning;
        let content = current.content;
        if (event.reset) {
            reasoning = undefined;
            content = undefined;
        }
        if (event.reasoning !== undefined) {
            reasoning = (reasoning ?? '') + event.reasoning;
        }
        if (event.content !== undefined) {
            content = (content ?? '') + event.content;
        }

        const next: UpdateEvent = { type: 'update', id: event.id };
        const status = event.status ?? current.status;
        if (status !== undefined) { next.status = status; }
        if (reasoning !== undefined) { next.reasoning = reasoning; }
        if (content !== undefined) { next.content = content; }
        if (current.reset || event.reset) { next.reset = true; }
        const note = event.note ?? current.note;
        if (note !== undefined) { next.note = note; }
        merged[lastIndex] = next;
    }

    return merged;
}

/**
 * Collects agent events and posts them as one `agentEvents` batch every
 * `delayMs`. The owner must call `flush()` before posting any other message.
 */
export class AgentBatcher {
    private queue: AgentEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly send: (events: AgentEvent[]) => void,
        private readonly delayMs = AGENT_BATCH_INTERVAL_MS,
        private readonly timers: AgentBatchTimers = DEFAULT_TIMERS,
    ) { }

    push(event: AgentEvent): void {
        this.queue.push(event);
        this.timer ??= this.timers.setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, this.delayMs);
    }

    flush(): void {
        if (this.timer !== undefined) {
            this.timers.clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (this.queue.length === 0) {
            return;
        }
        const queued = this.queue;
        this.queue = [];
        const events = mergeAgentEvents(queued);
        if (events.length > 0) {
            this.send(events);
        }
    }

    dispose(): void {
        if (this.timer !== undefined) {
            this.timers.clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.queue = [];
    }
}
