# Token API and MCP server

TAK Portal has a small token-authenticated API at `/api/v1` and an MCP server
(`tools/mcp-server`). Together they let a script or a local AI agent turn user
requests from emails and spreadsheets into portal accounts. The usual setup is
Oh My Pi talking to a model served by oMLX.

## Safety model

- **Tokens are created by global admins only.** Go to Server Settings, then API Tokens.
  Only a SHA-256 hash is stored, and the token is shown once.
- **A token is never a global admin.** It acts as an agency admin, either for the
  agencies you pick or for all agencies (through the all-agencies admin group). So
  the same agency scoping the UI uses applies to it.
- **Only regular users.** The API refuses admin roles and manual group selection.
  Users get their groups from the agency's templates.
- **The usual checks still run**, because the API calls the same `createUser`
  code as the Users page: duplicate usernames, duplicate emails
  (`USERS_BLOCK_DUPLICATE_EMAIL`), the password policy, inactive agencies and
  unknown templates.
- **Validate first.** Every create has a validate endpoint that runs all the
  checks and writes nothing. A batch also catches duplicates inside itself.
- **Optional permissions.** Creating agencies needs an All agencies token with
  *Can create agencies*. Creating mutual aid needs *Can create mutual aid*.
- **No passwords come back.** Mutual aid passwords stay in the portal. Open the
  Mutual Aid page for the packet and QR code.
- **Audited.** Every create is logged in the Audit Log with the actor
  `<token name> (API token)` and `created_method: api`. Revoking a token, or using
  *Revoke all*, takes effect immediately.
- **Identity headers are ignored** on `/api/v1`. Every request needs
  `Authorization: Bearer tpk_...`.

## 1. Deploy

Update the portal as usual. Migration `011_api_tokens.sql` runs automatically at
startup and creates the `api_tokens` table. You don't need any new settings or
`.env` values.

## 2. Route `/api/v1` around Authentik in Caddy

Requests to `/api/v1` don't have an Authentik session, so Caddy has to send them
straight to the portal instead of through `forward_auth`. In the portal's site
block, inside `route { ... }`, add this **after** the `handle @public { ... }`
block and **before** `forward_auth`:

```caddy
		@tokenapi path /api/v1/*
		handle @tokenapi {
			reverse_proxy 127.0.0.1:3000 {
				header_up X-Forwarded-Proto https
				header_up X-Forwarded-Host {host}
				header_up Host {host}
			}
		}
```

Keep the `request_header -X-Authentik-*` lines at the top of the block. The
portal ignores those headers on `/api/v1` anyway. Run `caddy validate`, then
reload Caddy.

Optional hardening: if the agent only runs from your own network, limit the
matcher to that network. Caddy must see the real client IP for this, so the proxy
in front of Caddy has to be listed in `trusted_proxies`.

```caddy
		@tokenapi {
			path /api/v1/*
			client_ip 192.168.1.0/24
		}
```

To check the route, run `curl https://<portal>/api/v1/me`. It should return
`401 {"error":"API token required ..."}` as JSON. An HTML login page means the
request is still going through Authentik.

## 3. Create a token

Go to Server Settings, then API Tokens, and create a token:

- Give it a name you'll recognise in the Audit Log, for example "Mac mini, local LLM".
- Scope it to the agencies you create users for, or to All agencies.
- Tick *Can create agencies* or *Can create mutual aid* only if you want the agent to do that.
- Set an expiration (the default is 90 days).

Copy the token. It is shown only once.

## 4. Install the MCP server on the computer running the agent

Requires Node 20 or newer.

```sh
cd TAK-Portal/tools/mcp-server
npm install
TAK_PORTAL_URL=https://takportal.example.org TAK_PORTAL_TOKEN=tpk_... node server.js   # Ctrl-C to stop; it speaks MCP on stdio
```

### Oh My Pi

Oh My Pi reads MCP servers from `~/.omp/agent/mcp.json` for your user, or from
`.omp/mcp.json` or `.mcp.json` in a project folder. It expands `${VAR}` from
your environment, so the token can stay out of the file:

```json
{
  "mcpServers": {
    "tak-portal": {
      "command": "node",
      "args": ["/Users/you/git/TAK-Portal/tools/mcp-server/server.js"],
      "env": {
        "TAK_PORTAL_URL": "https://takportal.example.org",
        "TAK_PORTAL_TOKEN": "${TAK_PORTAL_TOKEN}"
      }
    }
  }
}
```

Use `/mcp list` and `/mcp test tak-portal` in Oh My Pi to check the connection.

### oMLX directly

oMLX can attach MCP servers itself: run `omlx serve ... --mcp-config mcp.json`
with the same `mcpServers` block. Tool calling needs a model whose chat template
supports tools, such as recent Qwen instruct models.

## Tools

| Tool | What it does |
| --- | --- |
| `whoami` | Shows the token's agencies, permissions and password policy |
| `list_agencies` | Lists agencies with abbreviation, suffix and templates |
| `search_users` | Searches existing users, to check for existing accounts |
| `read_spreadsheet` | Reads a local `.xlsx`, `.csv` or `.tsv` file into rows. Old `.xls` files must be saved as `.xlsx` first |
| `validate_users` | Runs every check and writes nothing. Returns a per-row preview, warnings and errors |
| `create_users` | Creates up to 200 users. Rows succeed or fail independently |
| `validate_agency` / `create_agency` | Checks or creates a new agency and its groups |
| `list_mutual_aid` / `create_mutual_aid` | Lists or creates mutual aid entries |

The server's instructions tell the model to validate, show you the preview, and
create only after you confirm.

Example prompt:

> Here is an email from the Riverbend County Sheriff's Office asking for accounts
> for the people in the attached roster at ~/Downloads/roster.xlsx. Create them
> in TAK Portal under RCSO with their default template. Validate first and show
> me the list before creating anything.

## HTTP API reference

All requests use `Authorization: Bearer tpk_...` and send and receive JSON.

| Method & path | Body / query | Notes |
| --- | --- | --- |
| `GET /api/v1/me` | | Token info, agencies in scope, password policy |
| `GET /api/v1/agencies` | `?templates=false` | Agencies in scope, with templates |
| `GET /api/v1/agencies/:ref/templates` | | `:ref` is a suffix, abbreviation or name |
| `GET /api/v1/users/search` | `?q=&agencySuffix=&page=&pageSize=` | Same search as the Users page |
| `POST /api/v1/users/validate` | `{ "users": [ ... ] }` | Writes nothing |
| `POST /api/v1/users` | `{ "users": [ ... ] }` or one user object | Up to 200 per request |
| `POST /api/v1/agencies/validate` | agency object | Needs *Can create agencies* |
| `POST /api/v1/agencies` | agency object | Needs *Can create agencies* |
| `GET /api/v1/mutual-aid` | | Passwords removed |
| `POST /api/v1/mutual-aid` | `{ type, title, expireEnabled?, expireAt? }` | Needs *Can create mutual aid* |

User row fields:

- Required: `badge`, `agency` (suffix, abbreviation or exact name), `firstName`, `lastName`.
- Optional: `email`, `password`, `template` (defaults to the agency's default template), `radioCallsign`, `role`.

Batch responses look like this:

```json
{
  "dryRun": true, "total": 2, "ok": 1, "failed": 1,
  "results": [
    { "index": 0, "ok": true, "username": "1001rcso",
      "preview": { "name": "Doe, John", "template": "Patrol", "groups": ["RCSO - Patrol"] },
      "warnings": [] },
    { "index": 1, "ok": false, "error": "A user with this email address already exists (jdoe.rcso)." }
  ]
}
```

A created row can report `"syncPending": true`. That means the user was saved in
the portal and is still being pushed to Authentik in the background. Batches of
more than one user always work this way, like CSV import, so a large batch
finishes within proxy timeouts. Check the Users page for sync status.
