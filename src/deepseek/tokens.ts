/**
 * Conservative local token estimation.
 *
 * There is no tokenizer endpoint, so ASCII code points count as 0.4 tokens
 * and everything else as 0.75. Every successful request with a `usage` object
 * calibrates the per-model factor upward, never downward.
 */

export function estimateTokens(text: string): number {
    let weighted = 0;
    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        weighted += codePoint < 128 ? 0.4 : 0.75;
    }
    return Math.ceil(weighted) + 4;
}

export class TokenEstimator {
    /** Calibration factor in [1, 3]; the historical maximum. */
    private factor = 1;

    /** Calibrated estimate used by `ChatModel.countTokens`. */
    count(text: string): number {
        return Math.ceil(estimateTokens(text) * this.factor);
    }

    /** Records one actual/estimated prompt-token ratio after a successful request. */
    observe(prompt: string, promptTokens: number): void {
        if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
            return;
        }
        const estimate = estimateTokens(prompt);
        if (estimate <= 0) {
            return;
        }
        const ratio = promptTokens / estimate;
        if (!Number.isFinite(ratio)) {
            return;
        }
        this.factor = Math.max(this.factor, Math.min(3, Math.max(1, ratio)));
    }
}
