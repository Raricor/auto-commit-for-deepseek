# AutoCommit For DeepSeek

A VS Code extension that turns your staged changes into a series of focused git commits, using the
DeepSeek API directly. It groups the changes by intent, writes one message per group in parallel,
orders the commits by dependency, and commits each group from a snapshot of the index.

Every model request is visible while it runs: the **Agents** tab streams DeepSeek's thinking and
answer for each request, with status, retries and token usage.

## Features

- **Direct DeepSeek API**: streams `/chat/completions`; no Copilot or other extension needed.
- **Configurable endpoint**: base URL, model id, extra HTTP headers, per-request input limit. Any
  OpenAI-compatible endpoint that speaks the same streaming format works.
- **Thinking effort**: Endpoint default / Off / Low / High / Max.
- **Agents tab**: one row per request (grouping, folder batches, merge, summaries, messages, ordering)
  with live reasoning, raw output, retries, errors, and input/cache/thinking/output tokens.
- **Intent grouping**: one commit per feature, fix, refactor or chore; large changes (1,000+ files)
  are pre-grouped by folder and grouped in parallel.
- **Parallel generation** with a concurrency limit, per-group retry cards, and AI commit ordering
  with an animated reorder and Undo.
- **Safe commits**: each commit is built from the staged snapshot taken when generation started;
  unstaged edits are never committed.
- Conventional Commits, English / Chinese / auto-detected language, custom instructions,
  commit count range.

## Requirements

- VS Code 1.90 or later with the built-in Git extension.
- A DeepSeek API key (<https://platform.deepseek.com/api_keys>), or a key for your
  OpenAI-compatible endpoint.

## Getting Started

1. Run **AutoCommit For DeepSeek: Set API Key** from the Command Palette and paste your key.
   The key is stored in VS Code's SecretStorage, not in `settings.json`. Alternatively set the
   `DEEPSEEK_API_KEY` environment variable before starting VS Code.
2. Stage your changes (`git add`).
3. Click the ✨ button in the Source Control title bar, or the **AutoCommit For DeepSeek** status
   bar item.
4. Review the generated commits: edit messages, untick, drag to reorder, retry failed groups.
   Open the **Agents** tab to watch the requests, or use **Show thinking** on a commit card.
5. Click **Commit Selected**.

## Extension Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `autocommit-for-deepseek.model` | `string` | `"deepseek-flash"` | Model id, e.g. `deepseek-flash` or `deepseek-v4-pro`; any id your endpoint supports |
| `autocommit-for-deepseek.reasoningEffort` | `"" \| "none" \| "low" \| "high" \| "max"` | `""` | Thinking effort; see below |
| `autocommit-for-deepseek.baseUrl` | `string` | `"https://api.deepseek.com"` | Requests go to `{baseUrl}/chat/completions` |
| `autocommit-for-deepseek.requestHeaders` | `object` | `{}` | Extra HTTP headers; they can override the defaults |
| `autocommit-for-deepseek.maxInputTokens` | `number` (8192–1048576) | `131072` | Input limit of one request, by local estimate |
| `autocommit-for-deepseek.concurrency` | `number` (1–8) | `4` | Most requests in flight at once |
| `autocommit-for-deepseek.conventionalCommits` | `boolean` | `true` | Use Conventional Commits (`feat`, `fix`, `docs`, …) |
| `autocommit-for-deepseek.language` | `"en" \| "zh" \| "auto"` | `"en"` | Message language; `auto` follows your recent commits |
| `autocommit-for-deepseek.minCommits` | `number` (0–200) | `0` | Fewest commits; `0` means no limit |
| `autocommit-for-deepseek.maxCommits` | `number` (0–200) | `0` | Most commits; `0` means no limit |

The panel's settings area edits model, effort, language and the commit range. Use the gear next to
the endpoint to open the remaining settings.

### Thinking effort

| Value | Sent to the API |
| --- | --- |
| `""` (Endpoint default) | nothing; DeepSeek then thinks with effort `high`. Use this for endpoints that reject thinking parameters |
| `none` (Off) | `thinking: {"type": "disabled"}` |
| `low` / `high` / `max` | `thinking: {"type": "enabled"}` and `reasoning_effort` |

DeepSeek has exactly these levels; it treats `medium` and `xhigh` as `high`.

### Endpoint and errors

- Rate limits (429), server errors (5xx), dropped connections and streams that stay silent for
  5 minutes are retried up to 3 times with backoff (honoring `Retry-After`). The Agents tab shows
  each retry.
- A wrong key (401), insufficient balance (402) or a rejected request (4xx) stops the run at once.
  Commits generated so far are kept; unfinished groups become retryable cards.
- The model list comes from `{baseUrl}/models`, merged with the two presets. If the list cannot be
  loaded, only the presets are shown; you can still type any model id.

## How It Works

```
Staged changes (git diff --cached)          ── index snapshot recorded (git write-tree)
        │
        ▼
  Grouping by intent
   ─ 1 file: no request
   ─ up to 100 files: one request with per-file diff evidence
   ─ more files: folder batches grouped in parallel, then one merge request
   ─ replies are repaired; local rules only after two unusable replies
   ─ optional commit count range is enforced
        │
        ▼  (confirmation first if more than 40 requests are expected)
  One message + reason per group, in parallel
   ─ full group diff when it fits the input limit
   ─ otherwise: summarize all diff fragments, then write from the summaries
   ─ a failed group becomes a retryable card; other groups continue
        │
        ▼
  AI commit ordering (dependencies first)
        │
        ▼
  Review in the panel  ──►  git commit per candidate, in order, from the snapshot
```

- **Grouping** follows one rule: each commit is exactly one feature, fix, refactor or chore. Files
  share a group only when they implement that intent together (for example a feature and its tests).
- **Lockfiles and generated files** (`package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`,
  `*.min.js`, `*.map`, `*.snap`, …) are described by their line statistics only.
- **Input limit**: there is no tokenizer endpoint, so prompts are measured with a conservative local
  estimate that is calibrated upward from the `usage` DeepSeek reports. One request uses at most 80%
  of `maxInputTokens`; a grouping request at most 64,000 tokens.
- **Very large changes** (more than 100 files) are pre-grouped by folder into batches of at most 60
  files, grouped in parallel, and joined by one merge request.
- **Ordering** puts dependency/build changes and shared refactors first, keeps docs after their
  feature and tests with the code they test.
- **Committing** takes each candidate's files from the snapshot recorded at the start, so partially
  staged files are committed exactly as staged. Afterwards the index is restored to the snapshot.
  If the staged files change after generation, committing is refused until you generate again.

## Privacy

The staged diffs, your recent commit messages (for language and style) and your custom
instructions are sent to the configured endpoint. Lockfile and generated-file contents are not.

## Commands

| Command | Description |
| --- | --- |
| `AutoCommit For DeepSeek: Generate Commits` | Open the panel and generate from the staged changes |
| `AutoCommit For DeepSeek: Set API Key` | Store the API key in SecretStorage |
| `AutoCommit For DeepSeek: Clear API Key` | Remove the stored key |

## Building From Source

```bash
npm ci
npm run typecheck
npm test            # no network access, no API key needed
npm run package     # produces autocommit-for-deepseek.vsix
code --install-extension autocommit-for-deepseek.vsix
```

## License

GPL-3.0. The grouping, generation and ordering strategy comes from
[AutoCommit For Github Copilot](https://github.com/winterYANGWT/Auto-Commit-For-Github-Copilot)
by the same author. Seti file icons: see `THIRD_PARTY_NOTICES.md`.
