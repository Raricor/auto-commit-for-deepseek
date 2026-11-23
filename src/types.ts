// ─── Domain types ────────────────────────────────────────────────────────────

export interface GitLogEntry {
    hash: string;
    message: string;
    author: string;
    date: string;
}

export interface FileChange {
    path: string;
    /** Previous path for a rename; both paths are required when rebuilding the index. */
    originalPath?: string;
    type: 'added' | 'modified' | 'deleted' | 'renamed';
    diff: string;
}

export type GroupType = 'source' | 'test' | 'deps' | 'config' | 'docs' | 'misc';

export interface FileGroup {
    groupType: GroupType;
    label: string;
    files: FileChange[];
}

export interface CommitCandidate {
    id: string;
    message: string;
    reason: string;
    files: string[];   // relative paths from repo root
    checked: boolean;
}

/**
 * DeepSeek thinking effort. 'none' sends `thinking: {type: "disabled"}`; the
 * others send `thinking: {type: "enabled"}` plus `reasoning_effort`. The API
 * has exactly these four levels (it maps medium/xhigh to high).
 */
export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';

export interface GenerateOptions {
    conventionalCommits: boolean;
    language: string;  // 'en' | 'zh' | 'auto'
    /** DeepSeek model id, e.g. 'deepseek-flash', 'deepseek-v4-pro'. '' means 'deepseek-flash'. */
    model?: string;
    prompt?: string;   // user's custom instruction
    /** Fewest commits to produce. 0 or undefined: no lower limit. */
    minCommits?: number;
    /** Most commits to produce. 0 or undefined: no upper limit. */
    maxCommits?: number;
    /**
     * '' or undefined: send neither `thinking` nor `reasoning_effort`, so the
     * endpoint uses its default (DeepSeek: thinking on, effort high). This also
     * keeps third-party endpoints that reject those fields working.
     */
    reasoningEffort?: ReasoningEffort | '';
    /** Most model requests in flight at once (1–8). */
    concurrency?: number;
}

/** A commit-sized group decided by the grouping phase, before its message exists. */
export interface PlannedGroup {
    /** Position in grouping order; stable for the whole generation run. */
    index: number;
    label: string;
    files: string[];
}

export type GenerationStage = 'grouping' | 'generating' | 'ordering';

export interface GenerationProgress {
    stage: GenerationStage;
    /** Finished units in this stage (groups while generating, folders while pre-grouping). */
    done?: number;
    total?: number;
    /** Short human-readable detail, e.g. "1300 files pre-grouped into 17 folders". */
    detail?: string;
}

export type NoticeLevel = 'info' | 'warning';

export interface StagedFileInfo {
    path: string;
    type: string;
    /** Empty when `diffOmitted` is true; request the content with `showDiff`. */
    diff: string;
    /** Set when the staged diff is too large to send to the webview at once. */
    diffOmitted?: boolean;
    additions?: number;
    deletions?: number;
}

// ─── Agents: one entry per model request ─────────────────────────────────────

/**
 * What one model request does in the pipeline:
 * - group:    groups all staged files in one request (small changes)
 * - bucket:   groups the files of one pre-grouped folder bucket (large changes)
 * - merge:    merges same-intent groups across buckets
 * - summary:  summarizes diffs (or earlier summaries) that do not fit one generation request
 * - generate: writes the commit message of one group
 * - order:    decides the commit order
 */
export type AgentKind = 'group' | 'bucket' | 'merge' | 'summary' | 'generate' | 'order';

export interface AgentInfo {
    /** Unique for the lifetime of the panel (single-group retries included). */
    id: string;
    kind: AgentKind;
    /** Short title, e.g. "Bucket 3/17 · src/llm (42 files)" or the group label. */
    label: string;
    /** summary/generate: `PlannedGroup.index` of the group this request serves. */
    groupIndex?: number;
    /** 1 for the first request; 2 for the retry after an unusable reply. */
    attempt: number;
    /** Date.now() when the request was queued. */
    queuedAt: number;
}

export type AgentStatus =
    | 'queued'     // waiting for a concurrency slot
    | 'waiting'    // request sent, no streamed text yet
    | 'thinking'   // receiving reasoning_content
    | 'answering'  // receiving content
    | 'done'
    | 'failed'
    | 'cancelled';

/** Mapped from the DeepSeek `usage` object of one request. */
export interface AgentUsage {
    promptTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    /** Includes reasoningTokens. */
    completionTokens: number;
    reasoningTokens: number;
}

export type AgentEvent =
    | { type: 'started'; agent: AgentInfo }
    | {
        type: 'update';
        id: string;
        status?: AgentStatus;
        /** Reasoning text appended since the previous update of this agent. */
        reasoning?: string;
        /** Answer text appended since the previous update of this agent. */
        content?: string;
        /** A transient error is being retried: drop the text received so far. */
        reset?: boolean;
        /** Short note shown on the row, e.g. "429 rate limited, retry 1/3 in 2s". */
        note?: string;
    }
    | {
        type: 'finished';
        id: string;
        status: 'done' | 'failed' | 'cancelled';
        usage?: AgentUsage;
        error?: string;
        /** Date.now() when the request settled. */
        finishedAt: number;
    };

/** Endpoint state shown in the settings panel. Edited in VS Code settings, not in the webview. */
export interface EndpointStatus {
    baseUrl: string;
    /** Where the API key comes from. 'none': generation cannot start. */
    apiKey: 'secret' | 'env' | 'none';
}

// ─── postMessage protocol ────────────────────────────────────────────────────

/** Messages sent from the extension host → webview */
export type ExtensionMessage =
    | { type: 'loading' }
    | { type: 'progress'; progress: GenerationProgress }
    /** Sent once grouping is final; every later candidate or failure refers to one of these groups. */
    | { type: 'groupsPlanned'; groups: PlannedGroup[] }
    | { type: 'addCandidate'; candidate: CommitCandidate; groupIndex?: number }
    /** Generation for this group failed; the webview shows a card that can be retried. */
    | { type: 'groupFailed'; group: PlannedGroup; message: string }
    /** AI commit order, first commit first. Contains the ids of all successful candidates. */
    | { type: 'reorder'; ids: string[] }
    | { type: 'notice'; level: NoticeLevel; message: string }
    /**
     * Agent events in emission order, batched (~100 ms). The host flushes pending
     * events before posting any other message, so e.g. a generate agent has
     * finished before its `addCandidate` arrives. Events for unknown ids are ignored.
     */
    | { type: 'agentEvents'; events: AgentEvent[] }
    | { type: 'endpoint'; endpoint: EndpointStatus }
    | { type: 'done' }
    | { type: 'error'; message: string }
    | { type: 'committed'; count: number; ids: string[] }
    | { type: 'settings'; settings: GenerateOptions }
    | { type: 'availableModels'; models: Array<{ id: string; name: string }> }
    | { type: 'diffContent'; path: string; content: string }
    | { type: 'stagedFiles'; files: StagedFileInfo[] }
    | { type: 'commitHistory'; commits: GitLogEntry[] };

/** Messages sent from the webview → extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'updateSettings'; settings: Partial<GenerateOptions> }
    | { type: 'regenerate'; settings: GenerateOptions }
    /** Generate again for one failed group of the current run, using the current settings. */
    | { type: 'retryGroup'; groupIndex: number; settings: GenerateOptions }
    | { type: 'commit'; ids: string[]; orderedCandidates?: CommitCandidate[] }
    | { type: 'openFile'; path: string }
    | { type: 'showDiff'; path: string }
    | { type: 'cancel' }
    | { type: 'refresh' }
    /** Runs the "Set API Key" command (password input box, stored in SecretStorage). */
    | { type: 'setApiKey' }
    /** Opens VS Code settings filtered to this extension (baseUrl, headers, input limit). */
    | { type: 'openEndpointSettings' };
