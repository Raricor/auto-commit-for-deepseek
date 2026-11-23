import * as vscode from 'vscode';
import type { AgentEvent, AgentKind, GenerateOptions } from '../types';
import {
    ModelError, type ChatModel, type ChatRequestOptions, type ChatStreamHandlers,
} from './chatModel';
import type { Limiter } from './concurrency';
import { checkCancellation } from './cancellation';
import { fitsPrompt, inputBudget } from './promptBudget';

export interface AgentMeta {
    kind: AgentKind;
    label: string;
    groupIndex?: number;
    /** 1 for the first request; incremented when the same work is sent again. */
    attempt?: number;
}

export interface ModelClient {
    readonly model: ChatModel;
    readonly budget: number;
    /** A budgeted request; countTokens is intentionally not rate-limited. */
    fits(prompt: string): Promise<boolean>;
    /** Sends one budgeted prompt through the shared FIFO limiter, as one agent. */
    send(prompt: string, meta: AgentMeta): Promise<string>;
}

export interface ModelClientOptions {
    model: ChatModel;
    options: GenerateOptions;
    token: vscode.CancellationToken;
    limiter: Limiter;
    /** Receives every lifecycle event of every request. Exceptions are ignored. */
    onAgentEvent?: (event: AgentEvent) => void;
    /** Receives the full prompt of a started request. Exceptions are ignored. */
    onAgentPrompt?: (id: string, prompt: string) => void;
    /** Converts a cancelled request into the caller's cancellation error. */
    onCancelled?: () => void;
    /** Called once for a request that failed at the provider boundary. */
    onProviderError?: (error: unknown) => void;
}

/**
 * Errors thrown by the provider layer. Keeping the original object preserves
 * its identity for callers while letting the pipeline tell provider failures
 * apart from per-group parse/budget failures. Every `ModelError` is a provider
 * error by definition.
 */
const providerErrors = new WeakSet<object>();

export function isProviderError(error: unknown): boolean {
    if (error instanceof ModelError) { return true; }
    return (typeof error === 'object' && error !== null) && providerErrors.has(error);
}

function markProviderError(error: unknown): void {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
        providerErrors.add(error as object);
    }
}

/** Unique for the lifetime of the extension process, retries included. */
let nextAgentNumber = 0;

function createAgentId(): string {
    nextAgentNumber += 1;
    return `a${nextAgentNumber}`;
}

export function createModelClient(config: ModelClientOptions): ModelClient {
    const { model, options, token, limiter } = config;
    const budget = inputBudget(model);
    const onCancelled = config.onCancelled ?? (() => checkCancellation(token));

    const emit = (event: AgentEvent): void => {
        try {
            config.onAgentEvent?.(event);
        } catch {
            // Rendering agent state must never break the request.
        }
    };

    const reportProviderError = (error: unknown): void => {
        markProviderError(error);
        try {
            config.onProviderError?.(error);
        } catch {
            // A provider-error listener must not mask the original failure.
        }
    };

    return {
        model,
        budget,
        async fits(prompt: string): Promise<boolean> {
            // Token counting is local; errors here are budget failures, not
            // provider round-trips, so they are not reported as provider errors.
            return fitsPrompt(prompt, model, budget, token, onCancelled);
        },
        async send(prompt: string, meta: AgentMeta): Promise<string> {
            const id = createAgentId();
            const agent = {
                id,
                kind: meta.kind,
                label: meta.label,
                attempt: meta.attempt ?? 1,
                queuedAt: Date.now(),
                ...(meta.groupIndex === undefined ? {} : { groupIndex: meta.groupIndex }),
            };
            emit({ type: 'started', agent });
            try {
                config.onAgentPrompt?.(id, prompt);
            } catch {
                // Prompt observers (run records) must never break the request.
            }

            let settled = false;
            const settle = (event: AgentEvent): void => {
                if (settled) { return; }
                settled = true;
                emit(event);
            };
            const finishCancelled = (): never => {
                settle({ type: 'finished', id, status: 'cancelled', finishedAt: Date.now() });
                onCancelled();
                throw new vscode.CancellationError();
            };
            const finishFailed = (error: unknown): never => {
                const failure = toError(error);
                settle({
                    type: 'finished', id, status: 'failed',
                    error: failure.message, finishedAt: Date.now(),
                });
                reportProviderError(failure);
                throw error;
            };

            try {
                if (token.isCancellationRequested) { return finishCancelled(); }

                return await limiter.run(async (): Promise<string> => {
                    if (token.isCancellationRequested) { return finishCancelled(); }
                    emit({ type: 'update', id, status: 'waiting' });

                    const abort = linkAbortSignal(token);
                    let sawReasoning = false;
                    let sawContent = false;
                    const handlers: ChatStreamHandlers = {
                        onReasoning(text: string): void {
                            if (!text) { return; }
                            if (!sawReasoning) {
                                sawReasoning = true;
                                emit({ type: 'update', id, status: 'thinking', reasoning: text });
                            } else {
                                emit({ type: 'update', id, reasoning: text });
                            }
                        },
                        onContent(text: string): void {
                            if (!text) { return; }
                            if (!sawContent) {
                                sawContent = true;
                                emit({ type: 'update', id, status: 'answering', content: text });
                            } else {
                                emit({ type: 'update', id, content: text });
                            }
                        },
                        onRetry(info): void {
                            // The provider discarded everything received so far;
                            // the next attempt starts its reasoning/answer again.
                            sawReasoning = false;
                            sawContent = false;
                            emit({
                                type: 'update', id, reset: true, status: 'waiting',
                                note: retryNote(info),
                            });
                        },
                    };

                    try {
                        const result = await model.request(
                            prompt, requestOptionsFor(options), handlers, abort.signal,
                        );
                        if (token.isCancellationRequested) { return finishCancelled(); }
                        settle({
                            type: 'finished', id, status: 'done',
                            usage: result.usage, finishedAt: Date.now(),
                        });
                        return result.content;
                    } catch (error) {
                        if (
                            token.isCancellationRequested ||
                            error instanceof vscode.CancellationError ||
                            isAbortError(error)
                        ) {
                            return finishCancelled();
                        }
                        return finishFailed(error);
                    } finally {
                        abort.dispose();
                    }
                });
            } catch (error) {
                // Any error raised before the limiter callback settled still
                // needs its terminal event: every started has one finished.
                if (!settled) {
                    if (token.isCancellationRequested || isAbortError(error)) {
                        settle({ type: 'finished', id, status: 'cancelled', finishedAt: Date.now() });
                    } else {
                        const failure = toError(error);
                        settle({
                            type: 'finished', id, status: 'failed',
                            error: failure.message, finishedAt: Date.now(),
                        });
                    }
                }
                throw error;
            }
        },
    };
}

function requestOptionsFor(options: GenerateOptions): ChatRequestOptions {
    const effort = options.reasoningEffort;
    return effort ? { effort } : {};
}

function linkAbortSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) { controller.abort(); }
    return {
        signal: controller.signal,
        dispose: () => subscription.dispose(),
    };
}

function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
        (error as { name?: unknown }).name === 'AbortError';
}

function retryNote(info: { retry: number; maxRetries: number; delayMs: number; message: string }): string {
    const message = info.message.trim() || 'Transient provider error';
    return `${message} · retry ${info.retry}/${info.maxRetries} in ${formatDelay(info.delayMs)}`;
}

function formatDelay(delayMs: number): string {
    if (!Number.isFinite(delayMs) || delayMs <= 0) { return 'now'; }
    if (delayMs < 1_000) { return `${Math.round(delayMs)}ms`; }
    const seconds = delayMs / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
