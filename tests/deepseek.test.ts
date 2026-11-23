import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDeepSeekModel, listModels, MODEL_PRESETS } from '../src/deepseek';
import { ModelError } from '../src/llm/chatModel';
import type { ChatStreamHandlers } from '../src/llm/chatModel';
import type { ReasoningEffort } from '../src/types';

interface TestServer {
    baseUrl: string;
    server: http.Server;
    close(): Promise<void>;
}

async function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<TestServer> {
    const server = http.createServer((req, res) => {
        Promise.resolve(handler(req, res)).catch(() => {
            res.destroy();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        server,
        async close(): Promise<void> {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeSse(res: http.ServerResponse, value: unknown): void {
    res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sendSuccess(
    res: http.ServerResponse,
    content = 'ok',
    usage?: Record<string, unknown>,
): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    writeSse(res, { choices: [{ delta: { content }, finish_reason: null }] });
    writeSse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    if (usage) {
        writeSse(res, { choices: [], usage });
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

function signal(): AbortSignal {
    return new AbortController().signal;
}

/** Fails a test instead of hanging forever when a promise should settle. */
async function rejectWithin(promise: Promise<unknown>, timeoutMs = 2_000): Promise<unknown> {
    const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`promise did not settle within ${timeoutMs} ms`)), timeoutMs);
        promise.catch(() => clearTimeout(timer));
    });
    return Promise.race([promise, timeout]);
}

test('sends the documented body and headers for every thinking effort', async () => {
    const requests: Array<{
        url: string | undefined;
        headers: http.IncomingHttpHeaders;
        body: Record<string, unknown>;
    }> = [];
    const server = await startServer(async (req, res) => {
        const raw = await readBody(req);
        requests.push({
            url: req.url,
            headers: req.headers,
            body: JSON.parse(raw) as Record<string, unknown>,
        });
        sendSuccess(res);
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: `${server.baseUrl}/`,
            apiKey: 'secret',
            model: '',
            headers: {
                Authorization: 'Bearer custom',
                'X-Test-Header': 'yes',
            },
        });
        const efforts: Array<ReasoningEffort | undefined> = [undefined, 'none', 'low', 'high', 'max'];
        for (const effort of efforts) {
            const result = await model.request('prompt text', { effort }, {}, signal());
            assert.equal(result.content, 'ok');
        }

        assert.equal(requests.length, 5);
        for (const request of requests) {
            assert.equal(request.url, '/chat/completions');
            assert.equal(request.headers.authorization, 'Bearer custom');
            assert.equal(request.headers['x-test-header'], 'yes');
            assert.match(String(request.headers['content-type']), /^application\/json/);
            assert.equal(request.headers.accept, 'text/event-stream');

            const body = request.body;
            assert.equal(body.model, 'deepseek-flash');
            assert.deepEqual(body.messages, [{ role: 'user', content: 'prompt text' }]);
            assert.equal(body.stream, true);
            assert.deepEqual(body.stream_options, { include_usage: true });
            assert.equal(body.max_tokens, undefined);
            assert.equal(body.temperature, undefined);
        }

        const [none, low, high, max] = requests.slice(1).map((request) => request.body);
        assert.equal(requests[0].body.thinking, undefined);
        assert.equal(requests[0].body.reasoning_effort, undefined);
        assert.deepEqual(none.thinking, { type: 'disabled' });
        assert.equal(none.reasoning_effort, undefined);
        assert.deepEqual(low.thinking, { type: 'enabled' });
        assert.equal(low.reasoning_effort, 'low');
        assert.deepEqual(high.thinking, { type: 'enabled' });
        assert.equal(high.reasoning_effort, 'high');
        assert.deepEqual(max.thinking, { type: 'enabled' });
        assert.equal(max.reasoning_effort, 'max');
    } finally {
        await server.close();
    }
});

test('uses the default authorization header and exposes preset names', async () => {
    let authorization: string | undefined;
    const server = await startServer(async (req, res) => {
        await readBody(req);
        authorization = req.headers.authorization;
        sendSuccess(res);
    });
    try {
        const known = createDeepSeekModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'deepseek-flash' });
        const unknown = createDeepSeekModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'other-model' });
        assert.equal(known.id, 'deepseek-flash');
        assert.equal(known.name, 'DeepSeek V4.1 Flash');
        assert.equal(known.maxInputTokens, 131_072);
        assert.equal(unknown.name, 'other-model');

        await known.request('hi', {}, {}, signal());
        assert.equal(authorization, 'Bearer k');
    } finally {
        await server.close();
    }
});

test('parses split UTF-8, split lines, CRLF, keep-alives, bad JSON and usage', async () => {
    const server = await startServer(async (req, res) => {
        await readBody(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });

        res.write(': keep-alive\r\n\r\n');

        const reasoningLine = Buffer.from(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Let me ' } }] })}\n\n`,
        );
        const split = Math.floor(reasoningLine.length / 2);
        res.write(reasoningLine.subarray(0, split));
        await tick();
        res.write(reasoningLine.subarray(split));
        await tick();

        const chineseLine = Buffer.from(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '中' } }] })}\n\n`,
        );
        const chineseByte = chineseLine.indexOf(Buffer.from('中'));
        res.write(chineseLine.subarray(0, chineseByte + 1));
        await tick();
        res.write(chineseLine.subarray(chineseByte + 1));
        await tick();

        res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\r\n\r\n`,
        );
        res.write('data: {broken json\n\n');
        res.write(': another keep-alive\n\n');
        writeSse(res, {
            choices: [],
            usage: {
                prompt_tokens: 10,
                prompt_cache_hit_tokens: 4,
                prompt_cache_miss_tokens: 6,
                completion_tokens: 3,
                completion_tokens_details: { reasoning_tokens: 1 },
            },
        });
        writeSse(res, { choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
    });

    try {
        const model = createDeepSeekModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'deepseek-flash' });
        const events: string[] = [];
        const handlers: ChatStreamHandlers = {
            onOpen: () => events.push('open'),
            onReasoning: (text) => events.push(`reasoning:${text}`),
            onContent: (text) => events.push(`content:${text}`),
        };
        const result = await model.request('prompt', {}, handlers, signal());

        assert.equal(result.reasoning, 'Let me ');
        assert.equal(result.content, '中A!');
        assert.equal(result.finishReason, 'stop');
        assert.deepEqual(result.usage, {
            promptTokens: 10,
            cacheHitTokens: 4,
            cacheMissTokens: 6,
            completionTokens: 3,
            reasoningTokens: 1,
        });
        assert.deepEqual(events, [
            'open',
            'reasoning:Let me ',
            'content:中',
            'content:A',
            'content:!',
        ]);
    } finally {
        await server.close();
    }
});

test('maps the compatible-gateway cached_tokens field', async () => {
    const server = await startServer(async (req, res) => {
        await readBody(req);
        sendSuccess(res, 'answer', {
            prompt_tokens: 12,
            prompt_tokens_details: { cached_tokens: 5 },
            completion_tokens: 4,
        });
    });
    try {
        const model = createDeepSeekModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'deepseek-flash' });
        const result = await model.request('prompt', {}, {}, signal());
        assert.deepEqual(result.usage, {
            promptTokens: 12,
            cacheHitTokens: 5,
            cacheMissTokens: 7,
            completionTokens: 4,
            reasoningTokens: 0,
        });
    } finally {
        await server.close();
    }
});

test('does not retry auth, balance, bad-request or not-found responses', async () => {
    const cases: Array<{
        status: number;
        body: string;
        kind: 'auth' | 'balance' | 'invalid-request';
        includes: string[];
    }> = [
        {
            status: 401,
            body: JSON.stringify({ error: { message: 'Authentication Fails.' } }),
            kind: 'auth',
            includes: ['HTTP 401', 'Authentication Fails.', 'Set API Key'],
        },
        {
            status: 402,
            body: JSON.stringify({ error: { message: 'Insufficient Balance' } }),
            kind: 'balance',
            includes: ['HTTP 402', 'Insufficient Balance', 'platform.deepseek.com/usage'],
        },
        {
            status: 400,
            body: JSON.stringify({ error: { message: 'bad payload' } }),
            kind: 'invalid-request',
            includes: ['HTTP 400', 'bad payload'],
        },
        {
            status: 404,
            body: 'plain not found',
            kind: 'invalid-request',
            includes: ['HTTP 404', 'plain not found', 'Check the baseUrl and model settings'],
        },
    ];

    for (const entry of cases) {
        let count = 0;
        const server = await startServer(async (req, res) => {
            await readBody(req);
            count += 1;
            res.writeHead(entry.status, { 'Content-Type': 'application/json' });
            res.end(entry.body);
        });
        try {
            const model = createDeepSeekModel({
                baseUrl: server.baseUrl,
                apiKey: 'k',
                model: 'deepseek-flash',
                retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
            });
            await assert.rejects(
                model.request('prompt', {}, {}, signal()),
                (error: unknown) => {
                    assert.ok(error instanceof ModelError);
                    assert.equal(error.kind, entry.kind);
                    assert.equal(error.status, entry.status);
                    for (const text of entry.includes) {
                        assert.ok(error.message.includes(text), `${error.message} should include ${text}`);
                    }
                    return true;
                },
            );
            assert.equal(count, 1, `HTTP ${entry.status} must not be retried`);
        } finally {
            await server.close();
        }
    }
});

test('honours Retry-After and returns only the successful attempt text', async () => {
    let count = 0;
    const server = await startServer(async (req, res) => {
        await readBody(req);
        count += 1;
        if (count === 1) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
            res.end(JSON.stringify({ error: { message: 'slow down' } }));
            return;
        }
        sendSuccess(res, 'recovered');
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: server.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
        });
        const retries: Array<{ retry: number; maxRetries: number; delayMs: number; message: string }> = [];
        let opened = 0;
        const result = await model.request('prompt', {}, {
            onRetry: (info) => retries.push(info),
            onOpen: () => { opened += 1; },
        }, signal());

        assert.equal(result.content, 'recovered');
        assert.equal(count, 2);
        assert.equal(opened, 1);
        assert.deepEqual(retries, [{
            retry: 1,
            maxRetries: 3,
            delayMs: 0,
            message: 'HTTP 429 rate limited',
        }]);
    } finally {
        await server.close();
    }
});

test('retries 5xx maxRetries times and reports the final server error', async () => {
    let count = 0;
    const server = await startServer(async (req, res) => {
        await readBody(req);
        count += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: server.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
        });
        const retries: number[] = [];
        await assert.rejects(
            model.request('prompt', {}, { onRetry: (info) => retries.push(info.retry) }, signal()),
            (error: unknown) => {
                assert.ok(error instanceof ModelError);
                assert.equal(error.kind, 'server');
                assert.equal(error.status, 503);
                assert.match(error.message, /HTTP 503/);
                assert.match(error.message, /overloaded/);
                return true;
            },
        );
        assert.equal(count, 3);
        assert.deepEqual(retries, [1, 2]);
    } finally {
        await server.close();
    }
});

test('classifies a refused connection as a retryable network error', async () => {
    const probe = await startServer((_req, res) => { res.end(); });
    const baseUrl = probe.baseUrl;
    await probe.close();

    const model = createDeepSeekModel({
        baseUrl,
        apiKey: 'k',
        model: 'deepseek-flash',
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
    });
    await assert.rejects(
        model.request('prompt', {}, {}, signal()),
        (error: unknown) => {
            assert.ok(error instanceof ModelError);
            assert.equal(error.kind, 'network');
            assert.match(error.message, /ECONNREFUSED/);
            return true;
        },
    );
});

test('retries a stream that ends before [DONE] and discards its text', async () => {
    let count = 0;
    const server = await startServer(async (req, res) => {
        await readBody(req);
        count += 1;
        if (count === 1) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            writeSse(res, { choices: [{ delta: { content: 'discarded' }, finish_reason: null }] });
            setTimeout(() => res.destroy(), 10);
            return;
        }
        sendSuccess(res, 'kept');
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: server.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
        });
        const retries: string[] = [];
        const result = await model.request('prompt', {}, {
            onRetry: (info) => retries.push(info.message),
        }, signal());
        assert.equal(result.content, 'kept');
        assert.equal(count, 2);
        assert.equal(retries.length, 1);
        assert.match(retries[0], /stream ended before completion|connection reset/);
    } finally {
        await server.close();
    }
});

test('retries error objects and insufficient_system_resource inside the stream', async () => {
    let errorCount = 0;
    const errorServer = await startServer(async (req, res) => {
        await readBody(req);
        errorCount += 1;
        if (errorCount === 1) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            writeSse(res, { error: { message: 'stream boom', type: 'server_error' } });
            res.end();
            return;
        }
        sendSuccess(res, 'after error');
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: errorServer.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
        });
        const retries: string[] = [];
        const result = await model.request('prompt', {}, {
            onRetry: (info) => retries.push(info.message),
        }, signal());
        assert.equal(result.content, 'after error');
        assert.equal(errorCount, 2);
        assert.match(retries[0], /server error in stream/);
    } finally {
        await errorServer.close();
    }

    let resourceCount = 0;
    const resourceServer = await startServer(async (req, res) => {
        await readBody(req);
        resourceCount += 1;
        if (resourceCount === 1) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            writeSse(res, { choices: [{ delta: {}, finish_reason: 'insufficient_system_resource' }] });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        sendSuccess(res, 'after resource error');
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: resourceServer.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
        });
        const retries: string[] = [];
        const result = await model.request('prompt', {}, {
            onRetry: (info) => retries.push(info.message),
        }, signal());
        assert.equal(result.content, 'after resource error');
        assert.equal(resourceCount, 2);
        assert.match(retries[0], /insufficient system resource/);
    } finally {
        await resourceServer.close();
    }
});

test('times out when no bytes arrive after the response headers', async () => {
    const server = await startServer(async (req, res) => {
        await readBody(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        // Deliberately never write a body event and never end the response.
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: server.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            idleTimeoutMs: 50,
            retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
        });
        let opened = 0;
        await assert.rejects(
            model.request('prompt', {}, { onOpen: () => { opened += 1; } }, signal()),
            (error: unknown) => {
                assert.ok(error instanceof ModelError);
                assert.equal(error.kind, 'timeout');
                return true;
            },
        );
        assert.equal(opened, 1);
    } finally {
        await server.close();
    }
});

test('aborting while reading rejects immediately, sends one request and stops callbacks', async () => {
    let count = 0;
    const server = await startServer(async (req, res) => {
        await readBody(req);
        count += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        writeSse(res, { choices: [{ delta: { content: 'first' }, finish_reason: null }] });
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: server.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
        });
        const controller = new AbortController();
        let retries = 0;
        const request = model.request('prompt', {}, {
            onContent: () => controller.abort(),
            onRetry: () => { retries += 1; },
        }, controller.signal);

        await assert.rejects(
            rejectWithin(request, 1_000),
            (error: unknown) => {
                assert.equal((error as Error).name, 'AbortError');
                return true;
            },
        );
        assert.equal(count, 1);
        assert.equal(retries, 0);
    } finally {
        await server.close();
    }
});

test('aborting during a retry delay rejects without another request', async () => {
    let count = 0;
    const server = await startServer(async (req, res) => {
        await readBody(req);
        count += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'still overloaded' } }));
    });
    try {
        const model = createDeepSeekModel({
            baseUrl: server.baseUrl,
            apiKey: 'k',
            model: 'deepseek-flash',
            retry: { maxRetries: 3, baseDelayMs: 5_000, maxDelayMs: 5_000 },
        });
        const controller = new AbortController();
        const request = model.request('prompt', {}, {
            onRetry: () => {
                setTimeout(() => controller.abort(), 20);
            },
        }, controller.signal);

        await assert.rejects(
            rejectWithin(request, 1_000),
            (error: unknown) => {
                assert.equal((error as Error).name, 'AbortError');
                return true;
            },
        );
        assert.equal(count, 1);
    } finally {
        await server.close();
    }
});

test('an already aborted signal sends no request', async () => {
    let count = 0;
    const server = await startServer(async (_req, res) => {
        count += 1;
        sendSuccess(res);
    });
    try {
        const model = createDeepSeekModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'deepseek-flash' });
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            rejectWithin(model.request('prompt', {}, {}, controller.signal), 500),
            (error: unknown) => {
                assert.equal((error as Error).name, 'AbortError');
                return true;
            },
        );
        assert.equal(count, 0);
    } finally {
        await server.close();
    }
});

test('countTokens estimates conservatively and calibrates upward from usage', async () => {
    let promptTokens = 18;
    const server = await startServer(async (req, res) => {
        const raw = await readBody(req);
        assert.match(raw, /hello/);
        sendSuccess(res, 'ok', {
            prompt_tokens: promptTokens,
            completion_tokens: 1,
            completion_tokens_details: { reasoning_tokens: 0 },
        });
    });
    try {
        const model = createDeepSeekModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'deepseek-flash' });
        assert.equal(await model.countTokens('hello'), 6);
        assert.equal(await model.countTokens('中文'), 6);
        assert.equal(await model.countTokens(''), 4);

        await model.request('hello', {}, {}, signal());
        assert.equal(await model.countTokens('hello'), 18);

        // A later, smaller usage never lowers the historical factor.
        promptTokens = 6;
        await model.request('hello', {}, {}, signal());
        assert.equal(await model.countTokens('hello'), 18);
    } finally {
        await server.close();
    }
});

test('listModels puts presets first and appends unknown unique ids', async () => {
    let authorization: string | undefined;
    let custom: string | undefined;
    const server = await startServer(async (req, res) => {
        await readBody(req);
        authorization = req.headers.authorization;
        custom = typeof req.headers['x-extra'] === 'string' ? req.headers['x-extra'] : undefined;
        assert.equal(req.method, 'GET');
        assert.equal(req.url, '/models');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            object: 'list',
            data: [
                { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
                { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
                { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
                { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
                { id: 'deepseek-coder', object: 'model', owned_by: 'deepseek' },
            ],
        }));
    });
    try {
        const models = await listModels({
            baseUrl: `${server.baseUrl}/`,
            apiKey: 'k',
            headers: { Authorization: 'Bearer custom', 'X-Extra': 'yes' },
        });
        assert.deepEqual(models, [
            ...MODEL_PRESETS.map((preset) => ({ ...preset })),
            { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
            { id: 'deepseek-coder', name: 'deepseek-coder' },
        ]);
        assert.equal(authorization, 'Bearer custom');
        assert.equal(custom, 'yes');
    } finally {
        await server.close();
    }
});

test('listModels maps 401 to ModelError auth without retrying', async () => {
    let count = 0;
    const server = await startServer(async (_req, res) => {
        count += 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails.' } }));
    });
    try {
        await assert.rejects(
            listModels({ baseUrl: server.baseUrl, apiKey: 'bad' }),
            (error: unknown) => {
                assert.ok(error instanceof ModelError);
                assert.equal(error.kind, 'auth');
                assert.equal(error.status, 401);
                assert.match(error.message, /Authentication Fails/);
                return true;
            },
        );
        assert.equal(count, 1);
    } finally {
        await server.close();
    }
});

test('listModels maps a refused connection to ModelError network', async () => {
    const probe = await startServer((_req, res) => { res.end(); });
    const baseUrl = probe.baseUrl;
    await probe.close();
    await assert.rejects(
        listModels({ baseUrl, apiKey: 'k' }),
        (error: unknown) => {
            assert.ok(error instanceof ModelError);
            assert.equal(error.kind, 'network');
            assert.match(error.message, /ECONNREFUSED/);
            return true;
        },
    );
});
