/**
 * The model boundary of the generation pipeline.
 *
 * `src/llm/` talks to models only through `ChatModel`; `src/deepseek/`
 * implements it on top of the DeepSeek HTTP API. Nothing here may import the
 * `vscode` module, so both sides stay testable with plain Node.
 *
 * Owned by the architecture (Claude). Tasks must not change this file; report
 * back instead if it does not fit.
 */
import type { AgentUsage, ReasoningEffort } from '../types';

export interface ChatRequestOptions {
    /** undefined: send no thinking parameters and let the endpoint decide. */
    effort?: ReasoningEffort;
}

export interface ChatStreamHandlers {
    /** The response started streaming (HTTP 200). Called again after each retry. */
    onOpen?(): void;
    /** `reasoning_content` text, in arrival order. */
    onReasoning?(text: string): void;
    /** `content` text, in arrival order. */
    onContent?(text: string): void;
    /**
     * A transient failure (429, 5xx, network error, idle timeout) will be
     * retried after `delayMs`. Text received so far is discarded; the next
     * attempt calls `onOpen` again.
     */
    onRetry?(info: { retry: number; maxRetries: number; delayMs: number; message: string }): void;
}

export interface ChatResult {
    /** The complete answer (content only, never reasoning). */
    content: string;
    reasoning: string;
    /** `finish_reason` of the reply, e.g. 'stop' or 'length'; null when the stream ended without one. */
    finishReason: string | null;
    usage?: AgentUsage;
}

export interface ChatModel {
    /** API model id sent in the request body. */
    readonly id: string;
    /** Display name, e.g. "DeepSeek V4.1 Flash"; the id for unknown models. */
    readonly name: string;
    /** Most input tokens one request may use, already limited by settings. */
    readonly maxInputTokens: number;
    /** Conservative local estimate; never a network call. */
    countTokens(text: string): Promise<number>;
    /**
     * Sends `prompt` as one user message and streams the reply.
     * - Retries transient failures itself (see `onRetry`).
     * - Rejects with `ModelError` when the request finally fails.
     * - Rejects with an error whose `name` is 'AbortError' when `signal` aborts.
     */
    request(
        prompt: string,
        options: ChatRequestOptions,
        handlers: ChatStreamHandlers,
        signal: AbortSignal,
    ): Promise<ChatResult>;
}

export type ModelErrorKind =
    | 'auth'             // 401: missing or wrong API key
    | 'balance'          // 402: insufficient balance
    | 'invalid-request'  // 400, 422 and other 4xx except 429
    | 'rate-limit'       // 429 after retries
    | 'server'           // 5xx after retries
    | 'network'          // connection failures after retries
    | 'timeout'          // no bytes for too long, after retries
    | 'protocol';        // malformed stream or error object inside the stream

/**
 * A failed model request. The pipeline treats every ModelError as a provider
 * error: the run stops and unfinished groups are marked failed.
 */
export class ModelError extends Error {
    constructor(
        readonly kind: ModelErrorKind,
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'ModelError';
    }
}
