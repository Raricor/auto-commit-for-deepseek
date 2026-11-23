import * as vscode from 'vscode';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../deepseek/config';
import type { GenerateOptions, ReasoningEffort } from '../types';

export const SETTINGS_SECTION = 'autocommit-for-deepseek';

const MIN_COMMITS_LIMIT = 200;
const MAX_COMMITS_LIMIT = 200;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const MIN_INPUT_TOKENS = 8192;
const MAX_INPUT_TOKENS = 1048576;
const DEFAULT_MAX_INPUT_TOKENS = 131072;

const REASONING_EFFORTS: ReadonlyArray<ReasoningEffort | ''> = [
    '', 'none', 'low', 'high', 'max',
];

export interface EndpointSettings {
    baseUrl: string;
    headers: Record<string, string>;
    maxInputTokens: number;
}

export function getSettings(): GenerateOptions {
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    return {
        conventionalCommits: config.get<boolean>('conventionalCommits', true),
        language: config.get<string>('language', 'en'),
        model: normalizeModel(config.get<string>('model', DEFAULT_MODEL)),
        minCommits: clampInteger(config.get<number>('minCommits', 0), 0, MIN_COMMITS_LIMIT, 0),
        maxCommits: clampInteger(config.get<number>('maxCommits', 0), 0, MAX_COMMITS_LIMIT, 0),
        reasoningEffort: normalizeReasoningEffort(
            config.get<string>('reasoningEffort', '')
        ),
        concurrency: clampInteger(
            config.get<number>('concurrency', 4),
            MIN_CONCURRENCY,
            MAX_CONCURRENCY,
            4
        ),
    };
}

export function getEndpointSettings(): EndpointSettings {
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    return {
        baseUrl: normalizeBaseUrl(config.get<string>('baseUrl', DEFAULT_BASE_URL)),
        headers: normalizeHeaders(config.get<unknown>('requestHeaders', {})),
        maxInputTokens: clampInteger(
            config.get<number>('maxInputTokens', DEFAULT_MAX_INPUT_TOKENS),
            MIN_INPUT_TOKENS,
            MAX_INPUT_TOKENS,
            DEFAULT_MAX_INPUT_TOKENS
        ),
    };
}

export async function updateSettings(partial: Partial<GenerateOptions>): Promise<void> {
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    if (partial.conventionalCommits !== undefined) {
        await config.update(
            'conventionalCommits',
            partial.conventionalCommits,
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.language !== undefined) {
        await config.update('language', partial.language, vscode.ConfigurationTarget.Global);
    }
    if (partial.model !== undefined) {
        await config.update(
            'model',
            normalizeModel(partial.model),
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.minCommits !== undefined) {
        await config.update(
            'minCommits',
            clampInteger(partial.minCommits, 0, MIN_COMMITS_LIMIT, 0),
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.maxCommits !== undefined) {
        await config.update(
            'maxCommits',
            clampInteger(partial.maxCommits, 0, MAX_COMMITS_LIMIT, 0),
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.reasoningEffort !== undefined) {
        await config.update(
            'reasoningEffort',
            normalizeReasoningEffort(partial.reasoningEffort),
            vscode.ConfigurationTarget.Global
        );
    }
    if (partial.concurrency !== undefined) {
        await config.update(
            'concurrency',
            clampInteger(partial.concurrency, MIN_CONCURRENCY, MAX_CONCURRENCY, 4),
            vscode.ConfigurationTarget.Global
        );
    }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeModel(value: unknown): string {
    if (typeof value !== 'string') {
        return DEFAULT_MODEL;
    }
    return value.trim() || DEFAULT_MODEL;
}

function normalizeBaseUrl(value: unknown): string {
    if (typeof value !== 'string') {
        return DEFAULT_BASE_URL;
    }
    return value.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function normalizeHeaders(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(value)) {
        if (typeof headerValue === 'string') {
            headers[name] = headerValue;
        }
    }
    return headers;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
    if (typeof value !== 'string') {
        return '';
    }
    return REASONING_EFFORTS.includes(value as ReasoningEffort | '')
        ? value as ReasoningEffort | ''
        : '';
}
