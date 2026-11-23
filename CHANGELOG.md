# Changelog

## [Unreleased] — 0.1.0

First release of the DeepSeek edition. The grouping, generation, ordering and snapshot-commit
strategy comes from AutoCommit For Github Copilot 1.0.0; the model layer and the UI around it are new.

### Added

- Direct DeepSeek API client: streaming `/chat/completions`, `reasoning_content`, token usage with
  cache hits, retries with backoff for 429/5xx/network errors/idle streams, cancellation.
- Endpoint settings: `baseUrl`, `model` (default `deepseek-flash`), `requestHeaders`,
  `maxInputTokens`; model list from `{baseUrl}/models` merged with presets.
- API key in SecretStorage (`Set API Key` / `Clear API Key` commands), with `DEEPSEEK_API_KEY` as a
  fallback.
- Thinking effort: Endpoint default / Off / Low / High / Max, mapped to DeepSeek's `thinking` and
  `reasoning_effort` parameters.
- **Agents** tab: one row per model request with live thinking, raw output, retries, errors and
  token usage; run totals. Pending commit cards show the live state of their request, and
  **Show thinking** jumps from a commit to its request.

### Changed

- Prompt budgets use a conservative local token estimate (calibrated from reported usage) instead of
  a tokenizer call.
- A provider error now comes from the DeepSeek client after its own retries.
