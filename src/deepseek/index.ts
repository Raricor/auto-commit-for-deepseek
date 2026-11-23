/**
 * Public entry point of the DeepSeek client.
 *
 * Everything in this directory is plain Node code and must never import
 * `vscode`; the generation pipeline only sees the `ChatModel` interface.
 */

import type { ChatModel, ChatRequestOptions, ChatResult, ChatStreamHandlers } from '../llm/chatModel';
import {
    resolveConfig,
    type DeepSeekConfig,
    type ResolvedDeepSeekConfig,
} from './config';
import { TokenEstimator } from './tokens';
import { requestDeepSeek } from './client';
import { presetName } from './models';

export {
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
} from './config';
export type { DeepSeekConfig } from './config';
export { MODEL_PRESETS, listModels } from './models';
export { ModelError } from '../llm/chatModel';

class DeepSeekChatModel implements ChatModel {
    readonly id: string;
    readonly name: string;
    readonly maxInputTokens: number;
    private readonly config: ResolvedDeepSeekConfig;
    private readonly estimator = new TokenEstimator();

    constructor(config: DeepSeekConfig) {
        this.config = resolveConfig(config);
        this.id = this.config.model;
        this.name = presetName(this.id);
        this.maxInputTokens = this.config.maxInputTokens;
    }

    countTokens(text: string): Promise<number> {
        return Promise.resolve(this.estimator.count(text));
    }

    request(
        prompt: string,
        options: ChatRequestOptions = {},
        handlers: ChatStreamHandlers = {},
        signal: AbortSignal = new AbortController().signal,
    ): Promise<ChatResult> {
        return requestDeepSeek(this.config, this.estimator, prompt, options, handlers, signal);
    }
}

export function createDeepSeekModel(config: DeepSeekConfig): ChatModel {
    return new DeepSeekChatModel(config);
}
