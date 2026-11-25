# TAK Portal MCP server

Lets a local AI agent (for example Oh My Pi with a model served by oMLX) create
TAK Portal users, agencies and mutual aid through the portal's `/api/v1` token API.

```sh
npm install
TAK_PORTAL_URL=https://takportal.example.org TAK_PORTAL_TOKEN=tpk_... node server.js
npm test   # offline tests
```

Setup (Caddy route, creating a token, Oh My Pi config) and the full tool list:
see [docs/API-AND-MCP.md](../../docs/API-AND-MCP.md).
