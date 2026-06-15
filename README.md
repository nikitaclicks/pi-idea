# pi-idea

A local Pi extension for idea-to-prototype workflows.

## What it does

- `/idea <rough description>` creates a new idea workspace under `~/dev/ideas/`
- generates a short project name
- writes `requirements.md`, `idea.json`, and `runtime.json`
- tells Pi to ask clarifying questions instead of implementing immediately
- keeps an active idea attached to the current Pi session
- lets you iterate naturally in chat after `/idea`
- when you later say `go` in that same Pi session, Pi should implement, run, and optionally tunnel the app in the same workspace

## Commands

- `/idea <description>` — start a new idea
- `/idea` — show current active idea or list existing ideas
- `/idea use <name>` — attach to an existing idea workspace
- `/idea status` — show active idea status
- `/idea go` — explicitly tell Pi to start implementing the active idea
- `/idea stop` — explicitly tell Pi to stop the active app/tunnel
- `/idea clear` — detach the current Pi session from the active idea

After `/idea ...`, you can also just continue talking normally in the same Pi session. The extension injects workspace-specific instructions into Pi's system prompt so ambiguous references like "it", "the app", or plain `go` refer to the active idea.

## Install

```bash
pi install /home/nikita/dev/pi-idea
```

Or test directly:

```bash
pi -e /home/nikita/dev/pi-idea/extensions/index.ts
```

## Workspace layout

Each idea is created under:

```text
~/dev/ideas/<short-name>/
  requirements.md
  idea.json
  runtime.json
  src/
  docs/
  scripts/
```

Pi is expected to update `requirements.md`, implement in `src/`, document in `docs/`, and keep `runtime.json` up to date when it starts/stops local preview processes.
