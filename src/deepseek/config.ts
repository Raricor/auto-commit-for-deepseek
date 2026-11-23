/**
 * DeepSeek client configuration and defaults.
 *
 * This module is pure Node/TypeScript: it never imports `vscode`, so the
 * client can be tested outside the extension host.
 */

export interface DeepSeekConfig {
    /** Without a trailing '/'; an empty string means DEFAULT_BASE_URL. */
    baseUrl: string;
    apiKey: string;
    /** Empty string means DEFAULT_MODEL. */
    model: string;
    /** Added after the defaults, so these can override any default header. */
    headers?: Record<string, string>;
    maxInputTokens?: number;
    retry?: {
        maxRetries?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
    };
    /** No bytes (keep-alive comments included) for this long means timeout. */
    idleTimeoutMs?: number;
}

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_MAX_INPUT_TOKENS = 131_072;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export interface ResolvedDeepSeekConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    headers: Record<string, string>;
    maxInputTokens: number;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    idleTimeoutMs: number;
}

export function normalizeBaseUrl(value: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
        return DEFAULT_BASE_URL;
    }
    const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
    return withoutTrailingSlash || DEFAULT_BASE_URL;
}

function nonNegative(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, value);
}

export function resolveConfig(config: DeepSeekConfig): ResolvedDeepSeekConfig {
    const maxRetries = nonNegative(config.retry?.maxRetries, DEFAULT_MAX_RETRIES);
    const idleTimeoutMs = nonNegative(config.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    return {
        baseUrl: normalizeBaseUrl(config.baseUrl),
        apiKey: config.apiKey ?? '',
        model: config.model || DEFAULT_MODEL,
        headers: { ...(config.headers ?? {}) },
        maxInputTokens: config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
        maxRetries: Math.floor(maxRetries),
        baseDelayMs: nonNegative(config.retry?.baseDelayMs, DEFAULT_BASE_DELAY_MS),
        maxDelayMs: nonNegative(config.retry?.maxDelayMs, DEFAULT_MAX_DELAY_MS),
        // A zero idle timeout would abort before the request is even sent.
        idleTimeoutMs: Math.max(1, idleTimeoutMs),
    };
}

/**
 * Builds the request headers. Custom headers are applied last through
 * `Headers.set`, which overrides defaults case-insensitively (including
 * `Authorization`).
 */
export function buildHeaders(
    config: Pick<ResolvedDeepSeekConfig, 'apiKey' | 'headers'>,
    extra: Record<string, string>,
): Headers {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${config.apiKey}`);
    for (const [name, value] of Object.entries(extra)) {
        headers.set(name, value);
    }
    for (const [name, value] of Object.entries(config.headers)) {
        headers.set(name, value);
    }
    return headers;
}
