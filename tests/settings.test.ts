import assert from 'node:assert/strict';
import test from 'node:test';

let configStore: Record<string, unknown> = {};

const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
nodeModule._load = function (id: string, ...args: unknown[]) {
    if (id === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({
                    get: (key: string, fallback: unknown) =>
                        key in configStore ? configStore[key] : fallback,
                    update: async () => { },
                }),
            },
            ConfigurationTarget: { Global: 1 },
        };
    }
    return originalLoad.call(this, id, ...args);
};
const { getSettings, getEndpointSettings } = require('../src/config/settings');
nodeModule._load = originalLoad;

test('invalid reasoning effort values fall back to the endpoint default', () => {
    configStore = { reasoningEffort: 'turbo' };
    assert.equal(getSettings().reasoningEffort, '');

    configStore = { reasoningEffort: 'medium' };
    assert.equal(getSettings().reasoningEffort, '');

    for (const value of ['', 'none', 'low', 'high', 'max']) {
        configStore = { reasoningEffort: value };
        assert.equal(getSettings().reasoningEffort, value);
    }
});

test('model ids are trimmed and empty ids use the default', () => {
    configStore = { model: '  deepseek-v4-pro  ' };
    assert.equal(getSettings().model, 'deepseek-v4-pro');

    configStore = { model: '   ' };
    assert.equal(getSettings().model, 'deepseek-flash');
});

test('baseUrl loses surrounding whitespace and trailing slashes', () => {
    configStore = { baseUrl: '  https://gateway.test/v1///  ' };
    assert.equal(getEndpointSettings().baseUrl, 'https://gateway.test/v1');

    configStore = { baseUrl: '' };
    assert.equal(getEndpointSettings().baseUrl, 'https://api.deepseek.com');
});

test('request headers keep only string values', () => {
    configStore = {
        requestHeaders: {
            'X-String': 'yes',
            'X-Number': 7,
            'X-Null': null,
            'X-Object': { nested: true },
        },
    };
    assert.deepEqual(getEndpointSettings().headers, { 'X-String': 'yes' });
});

test('maxInputTokens is clamped to the supported range', () => {
    configStore = { maxInputTokens: 1 };
    assert.equal(getEndpointSettings().maxInputTokens, 8192);

    configStore = { maxInputTokens: 9_999_999 };
    assert.equal(getEndpointSettings().maxInputTokens, 1_048_576);

    configStore = { maxInputTokens: 65_536 };
    assert.equal(getEndpointSettings().maxInputTokens, 65_536);
});
