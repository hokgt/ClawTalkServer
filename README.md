# ClawTalk Relay Server

Lightweight relay server for ClawTalk mobile apps. Sits between the public internet and your OpenClaw Gateway, forwarding only chat requests while keeping OpenClaw unexposed.

## Architecture

```
Phone → Internet → VPS (ClawTalk Relay) → VPN → OpenClaw Gateway
```

The relay server:
- ✅ Forwards chat messages to OpenClaw
- ✅ Returns agent responses to the mobile app
- ✅ Has its own authentication (app tokens)
- ✅ Rate limiting (60 req/min per IP)
- ✅ Agent allowlist (control which agents are accessible)
- ❌ Does NOT expose OpenClaw dashboard
- ❌ Does NOT expose admin/config endpoints
- ❌ Does NOT expose agent workspace or files

## Quick Start

```bash
# Clone
git clone https://github.com/hokgt/ClawTalkServer.git
cd ClawTalkServer

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your OpenClaw details

# Run
npm start
```

## Configuration

Create a `.env` file:

```env
# Server port
PORT=3100

# OpenClaw Gateway (internal/VPN address — NOT public)
OPENCLAW_URL=http://10.x.x.x:18789

# OpenClaw Gateway auth token (from openclaw.json gateway.auth.token)
OPENCLAW_TOKEN=your_openclaw_gateway_token

# App tokens for mobile clients (comma-separated)
# Leave empty for dev mode (accepts any token)
APP_TOKENS=token1,token2,token3

# Allowed agents (comma-separated)
# Leave empty to allow all agents
ALLOWED_AGENTS=main,cs-indonesia,cs-international
```

## API Endpoints

### Health Check
```
GET /health
```
No auth required. Returns server status.

### Pair (Validate Connection)
```
POST /v1/pair
Authorization: Bearer <app_token>
```
Tests connectivity to OpenClaw and returns available agents.

Response:
```json
{
  "status": "paired",
  "server": "ClawTalk Relay",
  "version": "1.0.0",
  "agents": [
    { "id": "main", "name": "Main", "status": "available" },
    { "id": "cs-indonesia", "name": "Cs Indonesia", "status": "available" }
  ]
}
```

### List Agents
```
GET /v1/agents
Authorization: Bearer <app_token>
```
Returns the list of available agents.

### Chat (OpenResponses API)
```
POST /v1/responses
Authorization: Bearer <app_token>
Content-Type: application/json

{
  "model": "openclaw:main",
  "input": "Hello, what can you do?",
  "stream": false
}
```

### Chat (OpenAI-compatible)
```
POST /v1/chat/completions
Authorization: Bearer <app_token>
Content-Type: application/json

{
  "model": "openclaw:main",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

## Deployment

### With PM2

```bash
npm install -g pm2
pm2 start src/server.js --name clawtalk-relay
pm2 save
pm2 startup
```

### With systemd

```ini
[Unit]
Description=ClawTalk Relay Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/clawtalk-server
ExecStart=/usr/bin/node src/server.js
Restart=always
EnvironmentFile=/opt/clawtalk-server/.env

[Install]
WantedBy=multi-user.target
```

### Behind NPM (Nginx Proxy Manager)

Create a proxy host:
- **Domain**: `relay.yourdomain.com`
- **Forward to**: `localhost:3100`
- **SSL**: Enable Let's Encrypt
- **Websockets**: Enable (for future SSE streaming)

## Security

- **App Tokens**: Each mobile client gets a unique token. Revoke individual clients by removing their token.
- **Agent Allowlist**: Control exactly which agents mobile users can access.
- **Rate Limiting**: 60 requests per minute per IP.
- **No Admin Access**: Only chat endpoints are exposed. OpenClaw dashboard, config, and admin routes are never proxied.
- **Helmet**: Security headers enabled.
- **CORS**: Enabled for mobile app access.

## Mobile App Configuration

In the ClawTalk mobile app:
1. Enter the relay server URL (e.g., `https://relay.yourdomain.com`)
2. Enter your app token
3. The app will call `/v1/pair` to verify and fetch agents
4. Start chatting!

## License

MIT
