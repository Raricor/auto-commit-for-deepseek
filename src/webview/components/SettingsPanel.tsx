import { ChevronDown, ChevronRight, KeyRound, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EndpointStatus, GenerateOptions, ReasoningEffort } from '../../types';

interface Props {
    settings: GenerateOptions;
    models: Array<{ id: string; name: string }>;
    endpoint: EndpointStatus | null;
    prompt: string;
    onUpdate: (key: string, value: unknown) => void;
    onPromptChange: (prompt: string) => void;
    onSetApiKey: () => void;
    onOpenEndpointSettings: () => void;
}

type CommitCountKey = 'minCommits' | 'maxCommits';

const MAX_COMMITS = 200;
const CUSTOM_MODEL = '__custom__';

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort | ''; label: string }> = [
    { value: '', label: 'Endpoint default' },
    { value: 'none', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
];

function apiKeyLabel(source: EndpointStatus['apiKey']): string {
    if (source === 'secret') return 'API key set';
    if (source === 'env') return 'API key from DEEPSEEK_API_KEY';
    return 'No API key';
}

function toCountText(value: number | undefined): string {
    return value && value > 0 ? String(value) : '';
}

function toCount(text: string): number {
    if (text === '') return 0;
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(MAX_COMMITS, parsed));
}

function normalizeCountInput(raw: string): string {
    const digits = raw.replace(/[^\d]/g, '');
    if (digits === '') return '';
    const value = Math.min(MAX_COMMITS, Number.parseInt(digits, 10));
    return value === 0 ? '' : String(value);
}

export default function SettingsPanel({
    settings, models, endpoint, prompt, onUpdate, onPromptChange, onSetApiKey, onOpenEndpointSettings,
}: Props) {
    const [expanded, setExpanded] = useState(true);
    const [minText, setMinText] = useState(toCountText(settings.minCommits));
    const [maxText, setMaxText] = useState(toCountText(settings.maxCommits));
    const [rangeError, setRangeError] = useState(false);
    const [customModel, setCustomModel] = useState(false);
    const [customModelText, setCustomModelText] = useState('');

    const currentModel = settings.model ?? '';
    const isKnownModel = models.some((model) => model.id === currentModel);

    useEffect(() => {
        setMinText(toCountText(settings.minCommits));
    }, [settings.minCommits]);

    useEffect(() => {
        setMaxText(toCountText(settings.maxCommits));
    }, [settings.maxCommits]);

    const beginCustomModel = () => {
        setCustomModelText(isKnownModel ? '' : currentModel);
        setCustomModel(true);
    };

    const commitCustomModel = () => {
        const value = customModelText.trim();
        if (value) onUpdate('model', value);
        setCustomModel(false);
    };

    const handleCountChange = (key: CommitCountKey, raw: string) => {
        const text = normalizeCountInput(raw);
        if (key === 'minCommits') setMinText(text);
        else setMaxText(text);

        const nextMin = key === 'minCommits' ? toCount(text) : toCount(minText);
        const nextMax = key === 'maxCommits' ? toCount(text) : toCount(maxText);
        const invalid = nextMin > 0 && nextMax > 0 && nextMin > nextMax;
        setRangeError(invalid);
        if (invalid) return;

        // Send both so a value that was previously blocked by validation is synced too.
        if (nextMin !== (settings.minCommits ?? 0)) onUpdate('minCommits', nextMin);
        if (nextMax !== (settings.maxCommits ?? 0)) onUpdate('maxCommits', nextMax);
    };

    return (
        <div className="panel-card">
            <button className="panel-toggle" onClick={() => setExpanded(!expanded)}>
                <div className="panel-toggle-left">
                    <Settings size={16} />
                    <span>Configuration</span>
                </div>
                <div className="panel-toggle-right">
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </div>
            </button>

            {expanded && (
                <div className="panel-body">
                    <div className="config-grid">
                        <div className="config-field">
                            <span className="config-label">Model</span>
                            <select
                                className="config-select"
                                value={customModel ? CUSTOM_MODEL : currentModel}
                                onChange={(e) => {
                                    const value = e.target.value;
                                    if (value === CUSTOM_MODEL) {
                                        beginCustomModel();
                                        return;
                                    }
                                    setCustomModel(false);
                                    onUpdate('model', value);
                                }}
                            >
                                {!customModel && !isKnownModel && (
                                    <option value={currentModel}>
                                        {currentModel || 'Endpoint default'}
                                    </option>
                                )}
                                {models.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name || m.id}</option>
                                ))}
                                <option value={CUSTOM_MODEL}>Custom…</option>
                            </select>
                            {customModel && (
                                <input
                                    type="text"
                                    className="config-input config-custom-model"
                                    value={customModelText}
                                    placeholder="Model id"
                                    autoFocus
                                    onChange={(e) => setCustomModelText(e.target.value)}
                                    onBlur={commitCustomModel}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            commitCustomModel();
                                        } else if (e.key === 'Escape') {
                                            setCustomModel(false);
                                        }
                                    }}
                                />
                            )}
                        </div>
                        <div className="config-field">
                            <span className="config-label">Language</span>
                            <select
                                className="config-select"
                                value={settings.language}
                                onChange={(e) => onUpdate('language', e.target.value)}
                            >
                                <option value="en">English</option>
                                <option value="zh">中文</option>
                                <option value="auto">Auto</option>
                            </select>
                        </div>
                    </div>

                    <div className="config-grid">
                        <div className="config-field">
                            <span className="config-label">Min commits</span>
                            <input
                                type="number"
                                className="config-input"
                                min={0}
                                max={MAX_COMMITS}
                                step={1}
                                value={minText}
                                placeholder="No limit"
                                onChange={(e) => handleCountChange('minCommits', e.target.value)}
                            />
                        </div>
                        <div className="config-field">
                            <span className="config-label">Max commits</span>
                            <input
                                type="number"
                                className="config-input"
                                min={0}
                                max={MAX_COMMITS}
                                step={1}
                                value={maxText}
                                placeholder="No limit"
                                onChange={(e) => handleCountChange('maxCommits', e.target.value)}
                            />
                        </div>
                    </div>

                    {rangeError && (
                        <div className="config-error-text" role="alert">Min cannot exceed Max</div>
                    )}

                    <div className="config-field config-field-wide">
                        <span className="config-label">Thinking effort</span>
                        <select
                            className="config-select"
                            value={settings.reasoningEffort ?? ''}
                            onChange={(e) => onUpdate('reasoningEffort', e.target.value)}
                        >
                            {EFFORT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                        <span className="config-hint">
                            Off disables thinking. Endpoint default sends no thinking parameters (DeepSeek uses High).
                        </span>
                    </div>

                    {endpoint && (
                        <div className="config-endpoint">
                            <div className="config-endpoint-header">
                                <span className="config-label">Endpoint</span>
                                <div className="config-endpoint-actions">
                                    <button
                                        type="button"
                                        className="config-endpoint-btn"
                                        onClick={onSetApiKey}
                                    >
                                        <KeyRound size={12} />
                                        Set API key
                                    </button>
                                    <button
                                        type="button"
                                        className="config-endpoint-btn config-endpoint-gear"
                                        title="Endpoint settings"
                                        aria-label="Endpoint settings"
                                        onClick={onOpenEndpointSettings}
                                    >
                                        <Settings size={13} />
                                    </button>
                                </div>
                            </div>
                            <div className="config-endpoint-url" title={endpoint.baseUrl}>
                                {endpoint.baseUrl}
                            </div>
                            <div className={`config-endpoint-key${endpoint.apiKey === 'none' ? ' missing' : ''}`}>
                                {apiKeyLabel(endpoint.apiKey)}
                            </div>
                        </div>
                    )}

                    <label className="config-checkbox-row">
                        <input
                            type="checkbox"
                            checked={settings.conventionalCommits}
                            onChange={(e) => onUpdate('conventionalCommits', e.target.checked)}
                        />
                        Use Conventional Commits format
                    </label>

                    <div className="config-textarea-wrap">
                        <span className="config-label">Custom Prompt</span>
                        <textarea
                            className="config-textarea"
                            value={prompt}
                            onChange={(e) => onPromptChange(e.target.value)}
                            placeholder="Enter additional prompt instructions..."
                            rows={3}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
