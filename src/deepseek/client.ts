/**
 * One streaming DeepSeek chat-completion request with retries.
 */

import {
    type ChatRequestOptions,
    type ChatResult,
    type ChatStreamHandlers,
} from '../llm/chatModel';
import type { AgentUsage, ReasoningEffort } from '../types';
import {
    RequestFailure,
    abortError,
    emptyBodyFailure,
    extractErrorDetail,
    insufficientResourceFailure,
    isRetryableKind,
    networkFailure,
    parseRetryAfter,
    statusFailure,
    streamErrorFailure,
    timeoutFailure,
    truncatedStreamFailure,
    truncate,
} from './errors';
import type { ResolvedDeepSeekConfig } from './config';
import { buildHeaders } from './config';
import { SseLineReader, parseSseDataLine } from './sse';
import type { TokenEstimator } from './tokens';

interface StreamChoice {
    delta?: {
        reasoning_content?: unknown;
        content?: unknown;
    };
    finish_reason?: unknown;
}

interface StreamChunk {
    choices?: StreamChoice[];
    usage?: unknown;
    error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Maps a DeepSeek `usage` object (including compatible-gateway variants). */
export function mapUsage(value: unknown): AgentUsage | undefined {
    const usage = asRecord(value);
    if (!usage) {
        return undefined;
    }
    const promptTokens = numberOr(usage.prompt_tokens, 0);
    const completionTokens = numberOr(usage.completion_tokens, 0);
    const promptDetails = asRecord(usage.prompt_tokens_details);
    const completionDetails = asRecord(usage.completion_tokens_details);

    const cacheHitTokens = optionalNumber(usage.prompt_cache_hit_tokens)
        ?? optionalNumber(promptDetails?.cached_tokens)
        ?? 0;
    const cacheMissTokens = optionalNumber(usage.prompt_cache_miss_tokens)
        ?? Math.max(0, promptTokens - cacheHitTokens);

    return {
        promptTokens,
        cacheHitTokens,
        cacheMissTokens,
        completionTokens,
        reasoningTokens: optionalNumber(completionDetails?.reasoning_tokens) ?? 0,
    };
}

function applyThinking(body: Record<string, unknown>, effort: ReasoningEffort | undefined): void {
    if (!effort) {
        return;
    }
    if (effort === 'none') {
        body.thinking = { type: 'disabled' };
        return;
    }
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = effort;
}

function errorMessageFrom(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    const record = asRecord(value);
    if (!record) {
        return '';
    }
    if (typeof record.message === 'string' && record.message.trim()) {
        return record.message;
    }
    try {
        return truncate(JSON.stringify(value));
    } catch {
        return '';
    }
}

function retryDelay(
    retry: number,
    retryAfterMs: number | undefined,
    config: ResolvedDeepSeekConfig,
): number {
    if (retryAfterMs !== undefined) {
        return Math.min(config.maxDelayMs, Math.max(0, retryAfterMs));
    }
    const nominal = config.baseDelayMs * 2 ** (retry - 1);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(config.maxDelayMs, Math.max(0, Math.round(nominal * jitter)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(abortError());
    }
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        };
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        }, Math.max(0, ms));
        const onAbort = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function requestAttempt(
    config: ResolvedDeepSeekConfig,
    estimator: TokenEstimator,
    prompt: string,
    options: ChatRequestOptions,
    handlers: ChatStreamHandlers,
    signal: AbortSignal,
): Promise<ChatResult> {
    if (signal.aborted) {
        throw abortError();
    }

    const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
    };
    applyThinking(body, options.effort);

    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimedOut = false;
    const armIdle = (): void => {
        if (idleTimer !== undefined) {
            clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            controller.abort();
        }, config.idleTimeoutMs);
    };
    const onUserAbort = (): void => {
        controller.abort();
    };
    signal.addEventListener('abort', onUserAbort, { once: true });

    try {
        armIdle();
        let response: Response;
        try {
            response = await fetch(`${config.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: buildHeaders(config, {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                }),
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (error) {
            if (signal.aborted) {
                throw abortError();
            }
            if (idleTimedOut) {
                throw timeoutFailure(config.baseUrl, config.idleTimeoutMs);
            }
            throw networkFailure(config.baseUrl, error);
        }
        armIdle();

        if (!response.ok) {
            let bodyText = '';
            try {
                bodyText = await response.text();
            } catch (error) {
                if (signal.aborted) {
                    throw abortError();
                }
                if (idleTimedOut) {
                    throw timeoutFailure(config.baseUrl, config.idleTimeoutMs);
                }
                // A body that cannot be read still leaves the HTTP status
                // meaningful, so classify it from the status alone.
                bodyText = '';
            }
            if (signal.aborted) {
                throw abortError();
            }
            throw statusFailure(
                response.status,
                config.baseUrl,
                extractErrorDetail(bodyText),
                parseRetryAfter(response.headers.get('retry-after')),
            );
        }

        if (signal.aborted) {
            try {
                await response.body?.cancel();
            } catch {
                // The connection is already going away.
            }
            throw abortError();
        }

        handlers.onOpen?.();
        if (signal.aborted) {
            throw abortError();
        }
        if (!response.body) {
            throw emptyBodyFailure(config.baseUrl);
        }
        const reader = response.body.getReader();

        let content = '';
        let reasoning = '';
        let finishReason: string | null = null;
        let usage: AgentUsage | undefined;
        let sawDone = false;
        let failure: RequestFailure | undefined;

        const onLine = (line: string): boolean => {
            if (signal.aborted) {
                throw abortError();
            }
            const data = parseSseDataLine(line);
            if (data === undefined || data === '') {
                return true;
            }
            if (data.trim() === '[DONE]') {
                sawDone = true;
                return false;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(data);
            } catch {
                // A broken event is skipped; the rest of the stream stays usable.
                return true;
            }
            const chunk = asRecord(parsed) as StreamChunk | undefined;
            if (!chunk) {
                return true;
            }
            if (chunk.error) {
                failure = streamErrorFailure(errorMessageFrom(chunk.error));
                return false;
            }
            if (Array.isArray(chunk.choices)) {
                for (const choice of chunk.choices) {
                    if (choice && typeof choice.finish_reason === 'string') {
                        finishReason = choice.finish_reason;
                        if (choice.finish_reason === 'insufficient_system_resource') {
                            failure = insufficientResourceFailure();
                            return false;
                        }
                    }
                }
                const delta = chunk.choices[0]?.delta;
                if (delta && typeof delta === 'object') {
                    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                        reasoning += delta.reasoning_content;
                        handlers.onReasoning?.(delta.reasoning_content);
                        if (signal.aborted) {
                            throw abortError();
                        }
                    }
                    if (typeof delta.content === 'string' && delta.content.length > 0) {
                        content += delta.content;
                        handlers.onContent?.(delta.content);
                        if (signal.aborted) {
                            throw abortError();
                        }
                    }
                }
            }
            if (chunk.usage !== undefined && chunk.usage !== null) {
                const mapped = mapUsage(chunk.usage);
                if (mapped) {
                    usage = mapped;
                }
            }
            return true;
        };
        const lineReader = new SseLineReader(onLine);

        try {
            for (;;) {
                let read: Awaited<ReturnType<typeof reader.read>>;
                try {
                    read = await reader.read();
                } catch (error) {
                    if (signal.aborted) {
                        throw abortError();
                    }
                    if (idleTimedOut) {
                        throw timeoutFailure(config.baseUrl, config.idleTimeoutMs);
                    }
                    throw networkFailure(config.baseUrl, error);
                }
                if (signal.aborted) {
                    throw abortError();
                }
                if (read.done) {
                    lineReader.flush();
                    break;
                }
                armIdle();
                if (!lineReader.feed(read.value)) {
                    break;
                }
            }
        } finally {
            try {
                await reader.cancel();
            } catch {
                // Already ended, aborted or closed by the server.
            }
        }

        if (signal.aborted) {
            throw abortError();
        }
        if (failure) {
            throw failure;
        }
        if (!sawDone && finishReason === null) {
            throw truncatedStreamFailure(config.baseUrl);
        }
        if (usage) {
            estimator.observe(prompt, usage.promptTokens);
        }
        return { content, reasoning, finishReason, usage };
    } finally {
        if (idleTimer !== undefined) {
            clearTimeout(idleTimer);
        }
        signal.removeEventListener('abort', onUserAbort);
    }
}

/**
 * Sends one prompt, retrying transient failures. Text from failed attempts is
 * not part of the returned result; callbacks already emitted it, which is why
 * `onRetry` exists.
 */
export async function requestDeepSeek(
    config: ResolvedDeepSeekConfig,
    estimator: TokenEstimator,
    prompt: string,
    options: ChatRequestOptions,
    handlers: ChatStreamHandlers,
    signal: AbortSignal,
): Promise<ChatResult> {
    let retry = 0;
    for (;;) {
        if (signal.aborted) {
            throw abortError();
        }
        try {
            return await requestAttempt(config, estimator, prompt, options, handlers, signal);
        } catch (error) {
            if (signal.aborted) {
                throw abortError();
            }
            if (error instanceof Error && error.name === 'AbortError') {
                throw error;
            }
            if (!(error instanceof RequestFailure)) {
                throw error;
            }
            if (retry >= config.maxRetries || !isRetryableKind(error.kind)) {
                throw error;
            }
            retry += 1;
            const delayMs = retryDelay(retry, error.retryAfterMs, config);
            if (signal.aborted) {
                throw abortError();
            }
            handlers.onRetry?.({
                retry,
                maxRetries: config.maxRetries,
                delayMs,
                message: error.retryMessage,
            });
            if (signal.aborted) {
                throw abortError();
            }
            await sleep(delayMs, signal);
        }
    }
}
