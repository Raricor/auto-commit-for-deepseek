/**
 * Known DeepSeek model ids and the `/models` endpoint.
 */

import { ModelError } from '../llm/chatModel';
import type { DeepSeekConfig } from './config';
import { buildHeaders, normalizeBaseUrl } from './config';
import {
    abortError,
    extractErrorDetail,
    listTimeoutFailure,
    networkFailure,
    parseRetryAfter,
    statusFailure,
} from './errors';

export const MODEL_PRESETS: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
];

export const LIST_MODELS_TIMEOUT_MS = 10_000;

export function presetName(id: string): string {
    return MODEL_PRESETS.find((preset) => preset.id === id)?.name ?? id;
}

export async function listModels(
    config: Pick<DeepSeekConfig, 'baseUrl' | 'apiKey' | 'headers'>,
    signal?: AbortSignal,
): Promise<Array<{ id: string; name: string }>> {
    if (signal?.aborted) {
        throw abortError();
    }
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, LIST_MODELS_TIMEOUT_MS);
    const onAbort = (): void => {
        controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        let response: Response;
        try {
            response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: buildHeaders(
                    { apiKey: config.apiKey ?? '', headers: config.headers ?? {} },
                    { Accept: 'application/json' },
                ),
                signal: controller.signal,
            });
        } catch (error) {
            if (signal?.aborted) {
                throw abortError();
            }
            if (timedOut) {
                throw listTimeoutFailure(baseUrl, LIST_MODELS_TIMEOUT_MS);
            }
            throw networkFailure(baseUrl, error);
        }

        let text = '';
        try {
            text = await response.text();
        } catch (error) {
            if (signal?.aborted) {
                throw abortError();
            }
            if (timedOut) {
                throw listTimeoutFailure(baseUrl, LIST_MODELS_TIMEOUT_MS);
            }
            text = '';
        }
        if (signal?.aborted) {
            throw abortError();
        }
        if (!response.ok) {
            throw statusFailure(
                response.status,
                baseUrl,
                extractErrorDetail(text),
                parseRetryAfter(response.headers.get('retry-after')),
            );
        }

        let payload: unknown;
        try {
            payload = JSON.parse(text);
        } catch {
            throw new ModelError('protocol', `${baseUrl} returned an invalid model list.`);
        }
        const record = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : undefined;
        if (!record || !Array.isArray(record.data)) {
            throw new ModelError('protocol', `${baseUrl} returned an invalid model list.`);
        }

        const models: Array<{ id: string; name: string }> = MODEL_PRESETS.map((preset) => ({ ...preset }));
        const seen = new Set(models.map((model) => model.id));
        for (const entry of record.data) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const id = (entry as Record<string, unknown>).id;
            if (typeof id !== 'string' || !id || seen.has(id)) {
                continue;
            }
            seen.add(id);
            models.push({ id, name: id });
        }
        if (signal?.aborted) {
            throw abortError();
        }
        return models;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
