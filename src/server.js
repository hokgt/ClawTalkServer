require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3100;
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
const APP_TOKENS = (process.env.APP_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
const ALLOWED_AGENTS = (process.env.ALLOWED_AGENTS || '').split(',').map(a => a.trim()).filter(Boolean);

// --- Middleware ---
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' }
});
app.use(limiter);

// --- Auth middleware ---
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = auth.substring(7);

  // If no APP_TOKENS configured, accept any token (dev mode)
  if (APP_TOKENS.length === 0) {
    req.appToken = token;
    return next();
  }

  if (!APP_TOKENS.includes(token)) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  req.appToken = token;
  next();
}

// --- Helper: proxy request to OpenClaw ---
function proxyToOpenClaw(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, OPENCLAW_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
        ...options.headers
      }
    };

    const req = client.request(reqOptions, (res) => {
      // For streaming responses
      if (options.stream) {
        resolve({ statusCode: res.statusCode, headers: res.headers, stream: res });
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, data, headers: res.headers });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }

    req.end();
  });
}

// ============================================================
// ROUTES
// ============================================================

// --- Health check (no auth) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// --- List agents ---
app.get('/v1/agents', authenticate, (req, res) => {
  if (ALLOWED_AGENTS.length > 0) {
    const agents = ALLOWED_AGENTS.map(id => ({
      id,
      name: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      status: 'available'
    }));
    return res.json({ agents });
  }

  // No allowed agents configured — return empty
  res.json({ agents: [] });
});

// --- Chat (OpenResponses API) ---
app.post('/v1/responses', authenticate, async (req, res) => {
  try {
    const { model, input, instructions, stream, max_output_tokens, user } = req.body;

    // Extract agent ID from model field: "openclaw:agentId" or "agent:agentId"
    let agentId = 'main';
    if (model) {
      const match = model.match(/^(?:openclaw|agent):(.+)$/);
      if (match) agentId = match[1];
    }

    // Check if agent is allowed
    if (ALLOWED_AGENTS.length > 0 && !ALLOWED_AGENTS.includes(agentId)) {
      return res.status(403).json({ error: `Agent '${agentId}' is not available` });
    }

    const body = {
      model: `openclaw:${agentId}`,
      input,
      ...(instructions && { instructions }),
      ...(max_output_tokens && { max_output_tokens }),
      ...(user && { user }),
      stream: stream || false
    };

    if (stream) {
      // SSE streaming
      const result = await proxyToOpenClaw('/v1/responses', {
        method: 'POST',
        body,
        stream: true,
        headers: { 'x-openclaw-agent-id': agentId }
      });

      res.writeHead(result.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      result.stream.pipe(res);
    } else {
      // Non-streaming
      const result = await proxyToOpenClaw('/v1/responses', {
        method: 'POST',
        body,
        headers: { 'x-openclaw-agent-id': agentId }
      });

      res.status(result.statusCode);
      res.set('Content-Type', 'application/json');
      res.send(result.data);
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Failed to reach OpenClaw Gateway' });
  }
});

// --- Chat (OpenAI-compatible Chat Completions) ---
app.post('/v1/chat/completions', authenticate, async (req, res) => {
  try {
    const { model, messages, stream, max_tokens, user } = req.body;

    // Extract agent ID
    let agentId = 'main';
    if (model) {
      const match = model.match(/^(?:openclaw|agent):(.+)$/);
      if (match) agentId = match[1];
    }

    // Check if agent is allowed
    if (ALLOWED_AGENTS.length > 0 && !ALLOWED_AGENTS.includes(agentId)) {
      return res.status(403).json({ error: `Agent '${agentId}' is not available` });
    }

    // Convert chat completions to OpenResponses format
    const lastUserMsg = messages?.filter(m => m.role === 'user').pop();
    const input = lastUserMsg?.content || '';
    const systemMsgs = messages?.filter(m => m.role === 'system');
    const instructions = systemMsgs?.map(m => m.content).join('\n') || undefined;

    const body = {
      model: `openclaw:${agentId}`,
      input,
      ...(instructions && { instructions }),
      ...(max_tokens && { max_output_tokens: max_tokens }),
      ...(user && { user }),
      stream: false
    };

    const result = await proxyToOpenClaw('/v1/responses', {
      method: 'POST',
      body,
      headers: { 'x-openclaw-agent-id': agentId }
    });

    if (result.statusCode !== 200) {
      res.status(result.statusCode);
      res.set('Content-Type', 'application/json');
      return res.send(result.data);
    }

    // Convert OpenResponses to Chat Completions format
    const openResponse = JSON.parse(result.data);
    const outputText = openResponse.output
      ?.filter(o => o.type === 'message')
      ?.flatMap(o => o.content?.filter(c => c.type === 'output_text')?.map(c => c.text) || [])
      ?.join('') || '';

    const chatResponse = {
      id: `chatcmpl-${openResponse.id || uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `openclaw:${agentId}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: outputText
        },
        finish_reason: 'stop'
      }],
      usage: openResponse.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    res.json(chatResponse);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Failed to reach OpenClaw Gateway' });
  }
});

// --- Pair (validate connection) ---
app.post('/v1/pair', authenticate, async (req, res) => {
  try {
    // Test connectivity to OpenClaw by sending a lightweight request
    const result = await proxyToOpenClaw('/v1/responses', {
      method: 'POST',
      body: {
        model: 'openclaw:main',
        input: 'ping',
        max_output_tokens: 5
      }
    });

    if (result.statusCode === 200) {
      const agents = ALLOWED_AGENTS.length > 0
        ? ALLOWED_AGENTS.map(id => ({
            id,
            name: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            status: 'available'
          }))
        : [{ id: 'main', name: 'Main', status: 'available' }];

      res.json({
        status: 'paired',
        server: 'ClawTalk Relay',
        version: '1.0.0',
        agents
      });
    } else {
      res.status(502).json({ error: 'OpenClaw Gateway unreachable' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach OpenClaw Gateway' });
  }
});

// --- Catch all ---
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`ClawTalk Relay server running on port ${PORT}`);
  console.log(`OpenClaw Gateway: ${OPENCLAW_URL}`);
  console.log(`Allowed agents: ${ALLOWED_AGENTS.length ? ALLOWED_AGENTS.join(', ') : '(all)'}`);
  console.log(`App tokens: ${APP_TOKENS.length ? `${APP_TOKENS.length} configured` : '(dev mode - any token accepted)'}`);
});
