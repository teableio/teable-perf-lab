#!/usr/bin/env node
// OpenAI-compatible mock provider. It never calls a real model and reports simulated usage.
// Use it as the AI Gateway/Proxy upstream for L0 load tests, or as a direct target for the k6 AI script.
// Env: PORT, MOCK_TTFT_MS, MOCK_LATENCY_MS, MOCK_ERROR_RATE, MOCK_STATUS, MOCK_PROMPT_TOKENS, MOCK_COMPLETION_TOKENS

import http from 'node:http';
import process from 'node:process';

const port = Number(process.env.PORT || 18081);
const ttftMs = Number(process.env.MOCK_TTFT_MS || 20);
const latencyMs = Number(process.env.MOCK_LATENCY_MS || 100);
const errorRate = Number(process.env.MOCK_ERROR_RATE || 0);
const errorStatus = Number(process.env.MOCK_STATUS || 500);
const promptTokens = Number(process.env.MOCK_PROMPT_TOKENS || 12);
const completionTokens = Number(process.env.MOCK_COMPLETION_TOKENS || 8);

const stats = {
  requests: 0,
  errors: 0,
  streams: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usageFor(body) {
  const maxTokens = Number(body?.max_tokens || completionTokens);
  const completion = Math.max(1, Math.min(maxTokens, completionTokens));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/stats') {
    return json(res, 200, stats);
  }

  if (req.method === 'GET' && path === '/v1/models') {
    return json(res, 200, {
      object: 'list',
      data: [{ id: 'mock-model', object: 'model', owned_by: 'teable-stress' }],
    });
  }

  const isChat =
    req.method === 'POST' &&
    (path === '/v1/chat/completions' || path === '/api/v1/ai-proxy/v1/chat/completions');
  if (!isChat) return json(res, 404, { error: { message: `not found: ${path}` } });

  const body = await readBody(req);
  stats.requests++;
  const usage = usageFor(body);
  stats.promptTokens += usage.prompt_tokens;
  stats.completionTokens += usage.completion_tokens;
  stats.totalTokens += usage.total_tokens;

  if (errorRate > 0 && Math.random() < errorRate) {
    stats.errors++;
    return json(res, errorStatus, {
      error: { message: 'mock provider error', type: 'mock_error' },
    });
  }

  const id = `chatcmpl-mock-${stats.requests}`;
  const model = body?.model || 'mock-model';

  if (body?.stream) {
    stats.streams++;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    await sleep(ttftMs);
    const chunks = ['mock ', 'stream ', 'response'];
    for (const chunk of chunks) {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        })}\n\n`
      );
      await sleep(Math.max(1, Math.floor(latencyMs / chunks.length)));
    }
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  await sleep(ttftMs + latencyMs);
  return json(res, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'mock response' },
        finish_reason: 'stop',
      },
    ],
    usage,
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`AI_MOCK_LISTENING ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
