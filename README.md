# pi-idea

**Turn a single-shot idea into a live, internet-accessible prototype.**

Type `/idea a multiplayer drawing game` — Pi creates a workspace, asks clarifying questions, and when you say `go`, implements and tunnels the running app so anyone with the URL can try it.

No repo setup, no deploy config, no "let me spin up a server". Just an idea, a quick conversation to nail the scope, and a tunnel URL back.

## How it works

```
You:  /idea a todo app with auth and a dashboard
  ↓
Pi:   Creates ~/dev/ideas/todo-dashboard/
      Writes requirements.md, idea.json, runtime.json
      Asks you clarifying questions
      
You:  [answer questions, refine scope]
      ...then: go
  ↓
Pi:   Implements the app in the workspace
      Starts a dev server
      Opens a cloudflare tunnel (if available)
      Records the public URL in runtime.json
      
You:  Share the URL with anyone
```

## Commands

| Command | What it does |
|---------|-------------|
| `/idea <description>` | Start a new idea from a rough description |
| `/idea` | Show current active idea or list existing ideas |
| `/idea use <name>` | Attach to an existing idea workspace |
| `/idea status` | Show active idea status & preview URLs |
| `/idea run [name]` | Start the preview (server + tunnel) for an existing idea |
| `/idea ps` / `running` | List all running ideas with their URLs and ports |
| `/idea go` | Tell Pi to implement and run the active idea |
| `/idea stop` | Stop the running app / tunnel |
| `/idea domain [domain]` | Set or show **global** custom domain (stored in `~/.config/pi-idea.json`) |
| `/idea token [token]` | Set or show **global** Cloudflare API token (stored in `~/.config/pi-idea.json`) |
| `/idea clear` | Detach from the active idea |

After `/idea`, you can iterate naturally — the extension injects the workspace context into Pi's system prompt so "it", "the app", or plain `go` refer to your active idea.

## Why pi-idea?

- **Zero friction** — no project scaffolding, no decisions upfront
- **Tunnel-first** — when `cloudflared` is available, the app gets a public URL automatically
- **Iterate in chat** — refine requirements, ask for changes, all in one session
- **Workspace-per-idea** — each idea gets its own directory with requirements, source, runtime state

## Install

```bash
pi install npm:pi-idea
```

Or test directly:

```bash
pi -e npm:pi-idea
```

## Global Config: `~/.config/pi-idea.json`

Domain and Cloudflare API token are stored **globally** — one setting for all ideas:

```bash
/idea domain 1clickdev.com         # sets globally
/idea token <your-cloudflare-token> # stored globally
```

After setting these, run `/idea go` on any idea — Pi will set up a **named Cloudflare tunnel** with:
- Stable URL at `https://<idea-name>.<domain>` (e.g. `https://my-app.1clickdev.com`)
- Cloudflared config at `~/.cloudflared/config.yml`
- DNS CNAME record created automatically
- Tunnel credentials saved to `~/.cloudflared/<idea-name>-credentials.json`
- **URL persists across restarts** — use `scripts/restart-server.sh` to redeploy

The token and zone ID can also be set via environment variables:
- `PI_IDEA_CF_TOKEN` — Cloudflare API token
- `PI_IDEA_CF_ZONE_ID` — Cloudflare zone ID (optional, resolved automatically)

### Required token permissions
- Cloudflare Tunnel: Edit
- DNS: Edit

If no domain or token is configured, pi-idea falls back to quick tunnels as before.

## Configuration

Set the ideas workspace root via the `PI_IDEA_ROOT` environment variable:

```bash
export PI_IDEA_ROOT=~/projects/my-ideas
```

Defaults to `~/dev/ideas/` when unset.

## Workspace layout

```text
<ideas-root>/<short-name>/
  requirements.md    — living spec, updated as you refine
  idea.json          — metadata (name, status, timestamps)
  runtime.json       — preview URLs, port, running state
  src/               — implementation
  docs/              — documentation
  scripts/           — run.sh, stop.sh, tunnel-run.sh
```

Pi keeps `runtime.json` up to date so you always know where the app is — local URL, public tunnel URL, and which one is preferred.

When a custom domain is configured, Cloudflare tunnel credentials are stored in `~/.cloudflared/`:
- `~/.cloudflared/<idea-name>-credentials.json` — tunnel secret
- `~/.cloudflared/config.yml` — ingress rules for all named tunnels