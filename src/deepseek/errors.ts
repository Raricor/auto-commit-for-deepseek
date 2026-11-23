/**
 * Mapping from HTTP/network failures to user-facing `ModelError`s.
 */

import { ModelError, type ModelErrorKind } from '../llm/chatModel';

export const MAX_ERROR_DETAIL = 300;

export function truncate(text: string, max = MAX_ERROR_DETAIL): string {
    return text.length > max ? text.slice(0, max) : text;
}

/** Extracts `error.message` (or a fallback JSON/text field) from a response body. */
export function extractErrorDetail(body: string): string {
    const trimmed = body.trim();
    if (!trimmed) {
        return '';
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
            const record = parsed as Record<string, unknown>;
            const error = record.error;
            if (error && typeof error === 'object') {
                const message = (error as Record<string, unknown>).message;
                if (typeof message === 'string' && message.trim()) {
                    return truncate(message.trim());
                }
            }
            if (typeof error === 'string' && error.trim()) {
                return truncate(error.trim());
            }
            if (typeof record.message === 'string' && record.message.trim()) {
                return truncate(record.message.trim());
            }
        }
    } catch {
        // Plain text body: keep it below.
    }
    return truncate(trimmed);
}

export function kindForStatus(status: number): ModelErrorKind {
    if (status === 401 || status === 403) {
        return 'auth';
    }
    if (status === 402) {
        return 'balance';
    }
    if (status === 429) {
        return 'rate-limit';
    }
    if (status >= 500) {
        return 'server';
    }
    return 'invalid-request';
}

export function isRetryableKind(kind: ModelErrorKind): boolean {
    return kind === 'rate-limit'
        || kind === 'server'
        || kind === 'network'
        || kind === 'timeout';
}

/**
 * Internal `ModelError` that also carries the short retry reason and any
 * `Retry-After` delay parsed from the response.
 */
export class RequestFailure extends ModelError {
    constructor(
        kind: ModelErrorKind,
        message: string,
        status: number | undefined,
        readonly retryMessage: string,
        readonly retryAfterMs?: number,
    ) {
        super(kind, message, status);
    }
}

function endsWithSentencePunctuation(text: string): boolean {
    return /[.!?]$/.test(text);
}

function appendSentence(message: string, detail: string, sentence: string): string {
    if (!detail) {
        return `${message}. ${sentence}`;
    }
    const separator = endsWithSentencePunctuation(detail) ? ' ' : '. ';
    return `${message}: ${detail}${separator}${sentence}`;
}

export function statusFailure(
    status: number,
    baseUrl: string,
    detail: string,
    retryAfterMs?: number,
): RequestFailure {
    const kind = kindForStatus(status);
    if (kind === 'auth') {
        return new RequestFailure(
            kind,
            appendSentence(
                `DeepSeek rejected the API key (HTTP ${status})`,
                detail,
                'Run "AutoCommit For DeepSeek: Set API Key".',
            ),
            status,
            `HTTP ${status} authentication failed`,
            retryAfterMs,
        );
    }
    if (kind === 'balance') {
        return new RequestFailure(
            kind,
            appendSentence(
                `Insufficient DeepSeek balance (HTTP ${status})`,
                detail,
                'Top up at https://platform.deepseek.com/usage.',
            ),
            status,
            `HTTP ${status} insufficient balance`,
            retryAfterMs,
        );
    }
    let message = status === 429
        ? `${baseUrl} kept rate limiting the request (HTTP 429)`
        : status >= 500
            ? `${baseUrl} returned a server error (HTTP ${status})`
            : `${baseUrl} rejected the request (HTTP ${status})`;
    if (detail) {
        message += endsWithSentencePunctuation(detail) ? `: ${detail}` : `: ${detail}.`;
    } else {
        message += '.';
    }
    if (status === 404) {
        message += ' Check the baseUrl and model settings.';
    }
    const retryMessage = status === 429
        ? 'HTTP 429 rate limited'
        : status >= 500
            ? `HTTP ${status} server error`
            : `HTTP ${status}`;
    return new RequestFailure(kind, message, status, retryMessage, retryAfterMs);
}

function findErrorCode(error: unknown): string | undefined {
    const seen = new Set<unknown>();
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
        if (seen.has(current)) {
            break;
        }
        seen.add(current);
        const record = current as Record<string, unknown>;
        if (typeof record.code === 'string' && record.code) {
            return record.code;
        }
        if (Array.isArray(record.errors) && record.errors.length > 0) {
            current = record.errors[0];
            continue;
        }
        current = record.cause;
    }
    return undefined;
}

function describeCode(code: string): string {
    switch (code) {
        case 'ECONNREFUSED':
            return 'connection refused';
        case 'ECONNRESET':
        case 'UND_ERR_SOCKET':
            return 'connection reset';
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return 'DNS lookup failed';
        case 'ETIMEDOUT':
        case 'UND_ERR_CONNECT_TIMEOUT':
        case 'UND_ERR_HEADERS_TIMEOUT':
            return 'connection timed out';
        case 'EPIPE':
            return 'connection closed';
        default:
            return 'network error';
    }
}

export function networkFailure(baseUrl: string, error: unknown): RequestFailure {
    const code = findErrorCode(error);
    const description = code ? describeCode(code) : 'network error';
    let message = `Could not reach ${baseUrl}: ${description}`;
    if (code) {
        message += ` (${code})`;
    } else if (error instanceof Error && error.message) {
        message += ` (${truncate(error.message, 120)})`;
    }
    message += '.';
    return new RequestFailure(
        'network',
        message,
        undefined,
        `${description}${code ? ` (${code})` : ''}`,
    );
}

export function timeoutFailure(baseUrl: string, idleTimeoutMs: number): RequestFailure {
    return new RequestFailure(
        'timeout',
        `${baseUrl} did not send any data for ${idleTimeoutMs} ms (idle timeout).`,
        undefined,
        'idle timeout',
    );
}

export function listTimeoutFailure(baseUrl: string, timeoutMs: number): RequestFailure {
    return new RequestFailure(
        'timeout',
        `${baseUrl} did not answer the model list request within ${timeoutMs} ms.`,
        undefined,
        'model list timeout',
    );
}

export function streamErrorFailure(detail: string): RequestFailure {
    const suffix = detail ? `: ${truncate(detail)}` : '.';
    return new RequestFailure(
        'server',
        `DeepSeek reported an error in the response stream${suffix}`,
        undefined,
        'server error in stream',
    );
}

export function insufficientResourceFailure(): RequestFailure {
    return new RequestFailure(
        'server',
        'DeepSeek ran out of system resources while generating the reply (insufficient_system_resource).',
        undefined,
        'insufficient system resource',
    );
}

export function truncatedStreamFailure(baseUrl: string): RequestFailure {
    return new RequestFailure(
        'network',
        `${baseUrl} closed the stream before the reply finished.`,
        undefined,
        'stream ended before completion',
    );
}

export function emptyBodyFailure(baseUrl: string): RequestFailure {
    return new RequestFailure(
        'network',
        `${baseUrl} returned an empty response body.`,
        undefined,
        'empty response body',
    );
}

/** Parses `Retry-After` as seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
    if (value === null) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        return Math.max(0, Number(trimmed) * 1_000);
    }
    const date = Date.parse(trimmed);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}

export function abortError(): Error {
    const error = new Error('The DeepSeek request was aborted.');
    error.name = 'AbortError';
    return error;
}
