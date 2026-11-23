import {
    Check,
    ChevronDown,
    ChevronRight,
    Circle,
    CircleSlash,
    FileText,
    LoaderCircle,
    ScrollText,
    X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    agentSummary,
    agentsForGroup,
    isAgentRunning,
    wasRetried,
} from '../agents';
import type { AgentRow } from '../agents';

interface Props {
    agents: AgentRow[];
    focusAgentId: string | null;
    onFocusHandled: () => void;
    onOpenRunLog: () => void;
    onShowLogs: () => void;
}

interface AgentRowProps {
    row: AgentRow;
    expanded: boolean;
    highlighted: boolean;
    retried: boolean;
    onToggle: (id: string) => void;
    registerRow: (id: string, element: HTMLDivElement | null) => void;
}

function formatCount(value: number): string {
    if (value < 1000) return String(value);
    const scaled = value / 1000;
    return `${scaled.toFixed(1).replace(/\.0$/, '')}k`;
}

function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusText(row: AgentRow, retried: boolean): string {
    if (retried && row.status === 'done') return 'Reply unusable, retried';
    switch (row.status) {
        case 'queued':
            return 'Queued';
        case 'waiting':
            return 'Waiting for DeepSeek…';
        case 'thinking':
            return `Thinking · ${formatCount(row.reasoning.length)} chars`;
        case 'answering':
            return 'Answering…';
        case 'done': {
            const elapsed = formatDuration((row.finishedAt ?? row.queuedAt) - row.queuedAt);
            if (!row.usage) return elapsed;
            const output = Math.max(0, row.usage.completionTokens - row.usage.reasoningTokens);
            return `${elapsed} · in ${formatCount(row.usage.promptTokens)} · out ${formatCount(output)}`;
        }
        case 'failed':
            return 'Failed';
        case 'cancelled':
            return 'Cancelled';
    }
}

function StatusIcon({ row }: { row: AgentRow }) {
    if (row.status === 'queued') return <Circle size={14} />;
    if (isAgentRunning(row)) return <LoaderCircle size={14} className="agent-status-spinner" />;
    if (row.status === 'done') return <Check size={14} />;
    if (row.status === 'failed') return <X size={15} />;
    return <CircleSlash size={14} />;
}

function AgentTextBlock({
    title,
    text,
    truncated,
    streaming,
    output,
}: {
    title: string;
    text: string;
    truncated: boolean;
    streaming: boolean;
    output?: boolean;
}) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const scrolledAway = useRef(false);

    useEffect(() => {
        const element = scrollRef.current;
        if (element && streaming && !scrolledAway.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [text, streaming]);

    return (
        <section className={`agent-text-section${output ? ' output' : ''}`}>
            <h4>{title}</h4>
            {truncated && <div className="agent-truncated">… earlier text omitted</div>}
            <div
                className="agent-text"
                ref={scrollRef}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    scrolledAway.current = element.scrollHeight - element.scrollTop - element.clientHeight > 8;
                }}
            >
                {text}
            </div>
        </section>
    );
}

const AgentRowView = memo(function AgentRowView({
    row,
    expanded,
    highlighted,
    retried,
    onToggle,
    registerRow,
}: AgentRowProps) {
    const firstErrorLine = row.error?.split(/\r?\n/, 1)[0];
    const hasText = row.reasoning.length > 0 || row.content.length > 0;

    return (
        <div
            className={`agent-row agent-status-${row.status}${row.kind === 'summary' ? ' agent-row-summary' : ''}${highlighted ? ' agent-row-highlighted' : ''}`}
            ref={(element) => registerRow(row.id, element)}
        >
            <button
                type="button"
                className="agent-row-header"
                aria-expanded={expanded}
                onClick={() => onToggle(row.id)}
            >
                <span className="agent-row-chevron">
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
                <span className="agent-status-icon" title={row.status}>
                    <StatusIcon row={row} />
                </span>
                <span className="agent-row-main">
                    <span className="agent-row-title-line">
                        <span className="agent-row-label" title={row.label}>{row.label}</span>
                        {row.attempt > 1 && <span className="agent-retry-badge">Retry</span>}
                    </span>
                    <span className="agent-row-status">{statusText(row, retried)}</span>
                    {row.note && <span className="agent-row-note">{row.note}</span>}
                    {row.status === 'failed' && firstErrorLine && (
                        <span className="agent-row-error">{firstErrorLine}</span>
                    )}
                </span>
            </button>
            {expanded && (
                <div className="agent-row-details">
                    {(row.reasoning || row.reasoningTruncated) && (
                        <AgentTextBlock
                            title="Thinking"
                            text={row.reasoning}
                            truncated={row.reasoningTruncated}
                            streaming={row.status === 'thinking'}
                        />
                    )}
                    {(row.content || row.contentTruncated) && (
                        <AgentTextBlock
                            title="Output"
                            text={row.content}
                            truncated={row.contentTruncated}
                            streaming={row.status === 'answering'}
                            output
                        />
                    )}
                    {!hasText && <div className="agent-no-output">No output yet</div>}
                    {row.error && <pre className="agent-full-error">{row.error}</pre>}
                </div>
            )}
        </div>
    );
});

export default function AgentsPanel({
    agents,
    focusAgentId,
    onFocusHandled,
    onOpenRunLog,
    onShowLogs,
}: Props) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [highlightedId, setHighlightedId] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const rowElements = useRef(new Map<string, HTMLDivElement>());
    const summary = useMemo(() => agentSummary(agents, now), [agents, now]);
    const running = summary.running > 0;

    useEffect(() => {
        if (!running) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [running]);

    useEffect(() => {
        if (!focusAgentId) return;
        const id = focusAgentId;
        setExpandedIds((previous) => {
            if (previous.has(id)) return previous;
            const next = new Set(previous);
            next.add(id);
            return next;
        });
        setHighlightedId(id);
        const frame = window.requestAnimationFrame(() => {
            const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            rowElements.current.get(id)?.scrollIntoView({
                block: 'nearest',
                behavior: reducedMotion ? 'auto' : 'smooth',
            });
        });
        const timer = window.setTimeout(() => {
            setHighlightedId((current) => current === id ? null : current);
            onFocusHandled();
        }, 1500);
        return () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timer);
        };
    }, [focusAgentId, onFocusHandled]);

    const toggleRow = useCallback((id: string) => {
        setExpandedIds((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const registerRow = useCallback((id: string, element: HTMLDivElement | null) => {
        if (element) rowElements.current.set(id, element);
        else rowElements.current.delete(id);
    }, []);

    const grouping = useMemo(
        () => agents.filter((agent) => agent.kind === 'group' || agent.kind === 'bucket' || agent.kind === 'merge'),
        [agents],
    );
    const ordering = useMemo(() => agents.filter((agent) => agent.kind === 'order'), [agents]);
    const messageGroups = useMemo(() => {
        const indices = new Set<number>();
        for (const agent of agents) {
            if ((agent.kind === 'summary' || agent.kind === 'generate') && agent.groupIndex !== undefined) {
                indices.add(agent.groupIndex);
            }
        }
        return [...indices].sort((a, b) => a - b).map((groupIndex) => ({
            groupIndex,
            agents: agentsForGroup(agents, groupIndex),
        }));
    }, [agents]);

    const renderRow = (row: AgentRow) => (
        <AgentRowView
            key={row.id}
            row={row}
            expanded={expandedIds.has(row.id)}
            highlighted={highlightedId === row.id}
            retried={wasRetried(agents, row)}
            onToggle={toggleRow}
            registerRow={registerRow}
        />
    );

    return (
        <div className="agents-panel">
            <div className="agents-summary">
                <div className="agents-summary-main">
                    <div className="agents-summary-counts">
                        {summary.total} {summary.total === 1 ? 'request' : 'requests'}
                        {summary.running > 0 && ` · ${summary.running} running`}
                        {summary.failed > 0 && ` · ${summary.failed} failed`}
                    </div>
                    <div className="agents-summary-tokens">
                        Input {formatCount(summary.inputTokens)} ({Math.round(summary.cacheHitRate * 100)}% cached)
                        {' · '}Thinking {formatCount(summary.thinkingTokens)}
                        {' · '}Output {formatCount(summary.outputTokens)}
                        {' · '}{formatDuration(summary.durationMs)}
                    </div>
                </div>
                <div className="agents-summary-actions">
                    <button
                        type="button"
                        className="agent-summary-btn"
                        title="Open run log"
                        aria-label="Open run log"
                        onClick={onOpenRunLog}
                    >
                        <FileText size={14} />
                    </button>
                    <button
                        type="button"
                        className="agent-summary-btn"
                        title="Show output"
                        aria-label="Show output"
                        onClick={onShowLogs}
                    >
                        <ScrollText size={14} />
                    </button>
                </div>
            </div>

            {grouping.length > 0 && (
                <section className="agent-section">
                    <h3>Grouping</h3>
                    <div className="agent-section-rows">{grouping.map(renderRow)}</div>
                </section>
            )}

            {messageGroups.length > 0 && (
                <section className="agent-section">
                    <h3>Messages</h3>
                    <div className="agent-message-groups">
                        {messageGroups.map((group) => (
                            <div className="agent-message-group" key={group.groupIndex}>
                                <div className="agent-group-label">Group {group.groupIndex}</div>
                                {group.agents.filter((row) => row.kind === 'summary').map(renderRow)}
                                {group.agents.filter((row) => row.kind === 'generate').map(renderRow)}
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {ordering.length > 0 && (
                <section className="agent-section">
                    <h3>Ordering</h3>
                    <div className="agent-section-rows">{ordering.map(renderRow)}</div>
                </section>
            )}

            {agents.length === 0 && <div className="agents-empty">No model requests yet.</div>}
        </div>
    );
}
