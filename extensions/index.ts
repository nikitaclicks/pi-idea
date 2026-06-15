import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type IdeaState = {
  name: string;
  root: string;
  requirementsPath: string;
  runtimePath: string;
  metaPath: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
};

type RuntimeState = {
  running?: boolean;
  port?: number | string;
  url?: string;
  localUrl?: string;
  publicUrl?: string;
  preferredUrl?: string;
  startCommand?: string;
  tunnelCommand?: string;
  stopCommand?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type MetaState = {
  name: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "clarifying" | "ready" | "implementing" | "running" | "stopped";
  sessionName?: string;
};

const STATE_TYPE = "pi-idea-state";
const IDEAS_ROOT = (() => {
  const env = process.env.PI_IDEA_ROOT;
  if (env) {
    // Resolve ~ if present, otherwise treat as-is
    return env.startsWith("~/") || env === "~"
      ? join(homedir(), env.slice(1))
      : join(env);
  }
  return join(homedir(), "dev", "ideas");
})();
const DEFAULT_SESSION_NAME_PREFIX = "idea:";
const STOPWORDS = new Set([
  "a", "an", "and", "app", "application", "assistant", "bot", "build", "create",
  "for", "from", "game", "helper", "idea", "implement", "in", "into", "make",
  "platform", "project", "prototype", "simple", "system", "that", "the", "this",
  "tool", "website", "web", "mobile", "service", "with", "using", "workflow",
  "lightweight", "small", "tiny", "personal", "want", "need", "please", "some",
]);

function nowIso() {
  return new Date().toISOString();
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "idea";
}

function suggestName(text: string) {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length >= 3 && !STOPWORDS.has(word),
  );
  const picked: string[] = [];
  for (const word of words) {
    if (picked.includes(word)) continue;
    const trial = [...picked, word].join("-");
    if (trial.length > 24) break;
    picked.push(word);
    if (picked.length >= 2 && trial.length >= 8) break;
  }
  return slugify((picked.length > 0 ? picked : ["idea"]).join("-"));
}

function splitFeatures(text: string) {
  const parts = text
    .replace(/\r/g, "\n")
    .split(/\n+|[.;]+\s*|,\s+|\s+-\s+|\s+and\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 4);
  return [...new Set(parts)].slice(0, 8);
}

function defaultQuestions(summary: string) {
  const lower = summary.toLowerCase();
  const questions = ["Is a mobile-friendly web app okay for v1?"];
  if (["multiplayer", "multi-player", "co-op", "online"].some((token) => lower.includes(token))) {
    questions.push("Should multiplayer use anonymous rooms or shareable links for v1?");
  }
  if (["game", "tic tac toe", "tictactoe", "chess", "cards"].some((token) => lower.includes(token))) {
    questions.push("Should the first version stay browser-based instead of native mobile?");
  }
  questions.push("Do you want auth, or should v1 stay anonymous / no-login?");
  questions.push("What should explicitly stay out of scope for v1?");
  return questions.slice(0, 4);
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function nextIdeaRootDir(baseName: string) {
  ensureDir(IDEAS_ROOT);
  let candidate = join(IDEAS_ROOT, baseName);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = join(IDEAS_ROOT, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function requirementsFor(meta: MetaState, runtime: RuntimeState) {
  const features = splitFeatures(meta.summary);
  const featureLines = features.length > 0 ? features.map((f) => `- ${f}`).join("\n") : "- TBD";
  const preferredUrl = runtime.preferredUrl || runtime.publicUrl || runtime.url || runtime.localUrl;
  const runtimeLines = [
    preferredUrl ? `- Preferred preview URL: ${preferredUrl}` : "- Preferred preview URL: not running",
    runtime.publicUrl ? `- Public URL: ${runtime.publicUrl}` : "- Public URL: not running",
    runtime.localUrl ? `- Local URL: ${runtime.localUrl}` : runtime.url ? `- Local URL: ${runtime.url}` : "- Local URL: not running",
    runtime.port ? `- Port: ${runtime.port}` : "- Port: not running",
    runtime.startCommand ? `- Start command: \`${runtime.startCommand}\`` : "- Start command: TBD",
    runtime.tunnelCommand ? `- Tunnel command: \`${runtime.tunnelCommand}\`` : "- Tunnel command: TBD",
    runtime.stopCommand ? `- Stop command: \`${runtime.stopCommand}\`` : "- Stop command: TBD",
  ].join("\n");
  const questions = defaultQuestions(meta.summary).map((q) => `- ${q}`).join("\n");

  return `# ${meta.name}

Status: **${meta.status}**

## Overview
${meta.summary}

## Open Questions
${questions}

## Core Features
${featureLines}

## Implementation Guidance
- Do not implement until the user explicitly says **go**.
- Keep this file updated as the spec evolves.
- When implementation begins, work inside this project directory.
- Prefer creating reusable run/stop scripts in \`scripts/\`.
- If a preview can run locally, record runtime details in \`runtime.json\`.
- Do not serve on localhost alone. After implementing, create a tunnel with \`cloudflared\` and record the public URL as the primary preview URL. Surface the public tunnel URL as the primary preview URL.
- If \`cloudflared\` is unavailable, stop and ask the user to install it rather than defaulting to localhost.
- For interactive web apps, verify that the preview works without manual refreshes; avoid stale asset caching during preview and account for shared tunnel preview limitations or transport quirks.

## Runtime
${runtimeLines}
`;
}

function createIdea(summary: string): IdeaState {
  const baseName = suggestName(summary);
  const root = nextIdeaRootDir(baseName);
  const src = join(root, "src");
  const docs = join(root, "docs");
  const scripts = join(root, "scripts");
  ensureDir(src);
  ensureDir(docs);
  ensureDir(scripts);

  const createdAt = nowIso();
  const meta: MetaState = {
    name: root.split("/").pop() || baseName,
    summary: summary.trim(),
    createdAt,
    updatedAt: createdAt,
    status: "draft",
    sessionName: `${DEFAULT_SESSION_NAME_PREFIX}${baseName}`,
  };
  const runtime: RuntimeState = {
    running: false,
    startCommand: "scripts/run.sh",
    tunnelCommand: "scripts/tunnel-run.sh",
    stopCommand: "scripts/stop.sh",
    updatedAt: createdAt,
  };

  const metaPath = join(root, "idea.json");
  const runtimePath = join(root, "runtime.json");
  const requirementsPath = join(root, "requirements.md");
  writeJson(metaPath, meta);
  writeJson(runtimePath, runtime);
  writeFileSync(requirementsPath, requirementsFor(meta, runtime), "utf8");

  return {
    name: meta.name,
    root,
    requirementsPath,
    runtimePath,
    metaPath,
    createdAt,
    updatedAt: createdAt,
    summary: meta.summary,
  };
}

function hydrateIdeaState(root: string): IdeaState | null {
  const metaPath = join(root, "idea.json");
  const runtimePath = join(root, "runtime.json");
  const requirementsPath = join(root, "requirements.md");
  if (!existsSync(metaPath)) return null;
  const meta = readJson<MetaState | null>(metaPath, null);
  if (!meta) return null;
  return {
    name: meta.name,
    root,
    requirementsPath,
    runtimePath,
    metaPath,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    summary: meta.summary,
  };
}

function listIdeas() {
  ensureDir(IDEAS_ROOT);
  return readDirSafe(IDEAS_ROOT)
    .map((name) => join(IDEAS_ROOT, name))
    .map((root) => hydrateIdeaState(root))
    .filter((idea): idea is IdeaState => Boolean(idea))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readDirSafe(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [] as string[];
  }
}

function findIdea(token: string) {
  const slug = slugify(token);
  const ideas = listIdeas();
  const exact = ideas.find((idea) => idea.name === slug);
  if (exact) return exact;
  const prefix = ideas.filter((idea) => idea.name.startsWith(slug));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) throw new Error(`Ambiguous idea name: ${prefix.map((idea) => idea.name).join(", ")}`);
  return null;
}

function readMeta(state: IdeaState) {
  return readJson<MetaState>(state.metaPath, {
    name: state.name,
    summary: state.summary,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    status: "draft",
  });
}

function readRuntime(state: IdeaState) {
  return readJson<RuntimeState>(state.runtimePath, { running: false });
}

function saveMeta(state: IdeaState, patch: Partial<MetaState>) {
  const meta = { ...readMeta(state), ...patch, updatedAt: nowIso() };
  writeJson(state.metaPath, meta);
  writeFileSync(state.requirementsPath, requirementsFor(meta, readRuntime(state)), "utf8");
}

function saveRuntime(state: IdeaState, patch: Partial<RuntimeState>) {
  const runtime = { ...readRuntime(state), ...patch, updatedAt: nowIso() };
  writeJson(state.runtimePath, runtime);
  writeFileSync(state.requirementsPath, requirementsFor(readMeta(state), runtime), "utf8");
}

function renderStatus(state: IdeaState) {
  const meta = readMeta(state);
  const runtime = readRuntime(state);
  const preview = runtime.preferredUrl || runtime.publicUrl || runtime.url || runtime.localUrl;
  return [
    `Idea: ${state.name}`,
    `Path: ${state.root}`,
    `Status: ${meta.status}`,
    preview ? `Preview: ${preview}` : "Preview: not running",
    runtime.publicUrl ? `Public URL: ${runtime.publicUrl}` : null,
    runtime.localUrl ? `Local URL: ${runtime.localUrl}` : null,
    runtime.port ? `Port: ${runtime.port}` : "Port: not running",
  ].filter(Boolean).join("\n");
}

function persistActiveIdea(pi: ExtensionAPI, idea: IdeaState | null) {
  pi.appendEntry(STATE_TYPE, { activeIdeaRoot: idea?.root ?? null });
}

function restoreActiveIdea(ctx: ExtensionCommandContext | Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) {
  const entries = ctx.sessionManager.getEntries();
  const match = [...entries]
    .reverse()
    .find((entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: string }).type === "custom" &&
      (entry as { customType?: string }).customType === STATE_TYPE,
    ) as { data?: { activeIdeaRoot?: string | null } } | undefined;
  const root = match?.data?.activeIdeaRoot;
  return root ? hydrateIdeaState(root) : null;
}

function kickoffPrompt(idea: IdeaState) {
  return [
    `We are starting a new idea project called ${idea.name}.`,
    `Workspace: ${idea.root}`,
    `Read ${idea.requirementsPath} and update it as the source of truth for the spec.`,
    "Do not implement anything yet.",
    "Your job right now is to ask concise clarifying questions and refine the requirements.",
    "Only start implementation when I explicitly say 'go'.",
    "When implementation eventually starts, keep all code in this workspace, create reusable run/stop scripts when helpful, and keep runtime.json updated.",
    "Start by reading the requirements file and asking me the next most important questions.",
  ].join("\n");
}

function resumePrompt(idea: IdeaState) {
  return [
    `Resume the idea project ${idea.name}.`,
    `Workspace: ${idea.root}`,
    `Read ${idea.requirementsPath}, ${idea.metaPath}, and ${idea.runtimePath} if present.`,
    "Summarize the current state, say whether anything appears to be running, and wait for my next instruction.",
  ].join("\n");
}

function goPrompt(idea: IdeaState) {
  saveMeta(idea, { status: "ready" });
  return [
    `Go ahead with the active idea ${idea.name}.`,
    `Workspace: ${idea.root}`,
    `Read ${idea.requirementsPath} first, then implement the project in that workspace.`,
    "Preserve prior work, update the spec if needed, and apply the latest requested changes.",
    "If the project is runnable, create scripts/run.sh and scripts/stop.sh when appropriate, and keep runtime.json updated.",
    "For web apps, do not serve on localhost alone. After implementing the server, create a tunnel with cloudflared, record the public URL as the primary preview URL, and surface only the tunnel URL to the user. The local URL is a fallback for debugging only.",
    "If cloudflared is not available, stop and ask the user to install it rather than defaulting to a localhost-only preview.",
    "Validate the primary flows through the shared tunnel URL itself. Do not leave the preview in a state where users need manual refreshes after actions; fix caching, transport, or realtime update issues as part of the implementation.",
    "When you finish, summarize what changed and include the tunnel URL.",
  ].join("\n");
}

function stopPrompt(idea: IdeaState) {
  saveMeta(idea, { status: "stopped" });
  saveRuntime(idea, { running: false });
  return [
    `Stop the active idea project ${idea.name}.`,
    `Workspace: ${idea.root}`,
    `If scripts/stop.sh exists, use it. Otherwise stop any local preview server or tunnel you started for this workspace.`,
    `Update ${idea.runtimePath} so it reflects that nothing is running, including any public tunnel preview state.`,
    "Then tell me what you stopped.",
  ].join("\n");
}

function activeIdeaSystemPrompt(activeIdea: IdeaState) {
  return `
## Active Idea Workspace

There is an active idea project attached to this session.
- Name: ${activeIdea.name}
- Root: ${activeIdea.root}
- Requirements file: ${activeIdea.requirementsPath}
- Metadata file: ${activeIdea.metaPath}
- Runtime file: ${activeIdea.runtimePath}

Behavior rules:
- Treat this idea workspace as the default context for ambiguous references like "it", "the app", or "the project".
- Keep requirements.md updated when the user refines scope or changes requirements.
- Unless the user explicitly says "go", "implement", "build", "run", or clearly asks you to start coding, stay in specification / planning / review mode.
- When the user explicitly says "go" or otherwise asks you to implement, read requirements.md first and then work inside this workspace.
- Prefer reusable scripts/run.sh and scripts/stop.sh for long-running previews.
- For web apps, use a tunnel — do not serve on localhost alone. After implementing, start cloudflared and record the public tunnel URL as the primary preview URL. The local URL is a fallback for debugging only.
- If cloudflared is unavailable, stop and ask the user to install it rather than defaulting to a localhost-only preview.
- Whenever you start, stop, or change a preview runtime, update runtime.json with public URL as preferredPreviewUrl and local URL as a fallback.
- For interactive web apps, ensure the shared preview behaves correctly without manual refreshes; watch for stale cached assets and tunnel-specific transport or realtime quirks through the shared URL.
- When the user asks for more changes after a previous implementation, update the spec first and then apply the changes only when they explicitly ask you to proceed.
`;
}

function sendOrQueue(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string) {
  if (ctx.isIdle()) {
    pi.sendUserMessage(text);
  } else {
    pi.sendUserMessage(text, { deliverAs: "followUp" });
    ctx.ui.notify("Idea request queued as a follow-up", "info");
  }
}

function helpText(): string {
  return [
    "Usage: /idea [subcommand] [args]",
    "",
    "Subcommands:",
    "  /idea <description>    Create a new idea from a rough description",
    "  /idea                  Show current active idea or list existing ideas",
    "  /idea use <name>       Attach to an existing idea workspace",
    "  /idea status [name]    Show status of active idea or a named one",
    "  /idea go               Start implementing the active idea",
    "  /idea stop             Stop the active app/tunnel",
    "  /idea clear            Detach from the active idea",
    "  /idea help [subcmd]    Show this help, or help for a specific subcommand",
    "",
    "Flags:",
    "  -h, --help             Show this help message",
    "",
    "Examples:",
    "  /idea a todo app with auth and a dashboard",
    "  /idea use my-todo-app",
    "  /idea status",
    "  /idea go",
  ].join("\n");
}

function subcommandHelp(subcommand: string): string | null {
  const help: Record<string, string> = {
    "use": `Usage: /idea use <name>

Attach to an existing idea workspace by its short name.
Use /idea (with no args) to list available ideas.`,
    "status": `Usage: /idea status [name]

Show the current state of an idea, including its path,
status, and any running preview URLs.
Omit name to show the active idea.`,
    "go": `Usage: /idea go

Tell Pi to start implementing the active idea.
The extension reads requirements.md and begins coding.
Only works if an idea is currently active.`,
    "stop": `Usage: /idea stop

Stop the running preview server or tunnel for the active idea.
Runs scripts/stop.sh if it exists, then updates runtime.json.`,
    "clear": `Usage: /idea clear

Detach the current Pi session from the active idea.
The idea workspace is preserved and can be re-attached with /idea use.`,
  };
  return help[subcommand] ?? null;
}

function updateIdeaStatus(ctx: ExtensionCommandContext | Parameters<Parameters<ExtensionAPI["on"]>[1]>[1], activeIdea: IdeaState | null) {
  ctx.ui.setStatus("idea", activeIdea ? `idea: ${activeIdea.name}` : undefined);
}

export default function ideaExtension(pi: ExtensionAPI) {
  let activeIdea: IdeaState | null = null;

  pi.on("session_start", async (_event, ctx) => {
    activeIdea = restoreActiveIdea(ctx);
    updateIdeaStatus(ctx, activeIdea);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!activeIdea) return;
    return {
      systemPrompt: `${event.systemPrompt}\n${activeIdeaSystemPrompt(activeIdea)}`,
    };
  });

  pi.registerCommand("idea", {
    description: "Create, resume, and steer an idea workspace",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        if (activeIdea) {
          ctx.ui.notify(renderStatus(activeIdea), "info");
          return;
        }
        const ideas = listIdeas();
        if (ideas.length === 0) {
          ctx.ui.notify(`No ideas yet under ${IDEAS_ROOT}`, "info");
          return;
        }
        ctx.ui.notify(`Ideas: ${ideas.map((idea) => idea.name).join(", ")}`, "info");
        return;
      }

      const [subcommand, ...restParts] = input.split(/\s+/);
      const rest = restParts.join(" ").trim();

      // Handle help flags
      if (["--help", "-h", "help"].includes(subcommand)) {
        if (rest) {
          const subHelp = subcommandHelp(rest);
          ctx.ui.notify(subHelp ?? `Unknown subcommand: ${rest}`, subHelp ? "info" : "warning");
          return;
        }
        ctx.ui.notify(helpText(), "info");
        return;
      }

      if (["status", "show"].includes(subcommand)) {
        const target = rest ? findIdea(rest) : activeIdea;
        if (!target) {
          ctx.ui.notify("No matching active idea", "warning");
          return;
        }
        ctx.ui.notify(renderStatus(target), "info");
        return;
      }

      if (subcommand === "clear") {
        activeIdea = null;
        persistActiveIdea(pi, null);
        updateIdeaStatus(ctx, activeIdea);
        ctx.ui.notify("Cleared active idea for this session", "info");
        return;
      }

      if (subcommand === "use") {
        if (!rest) {
          ctx.ui.notify("Usage: /idea use <name>", "warning");
          return;
        }
        const target = findIdea(rest);
        if (!target) {
          ctx.ui.notify(`No idea found for ${rest}`, "warning");
          return;
        }
        activeIdea = target;
        persistActiveIdea(pi, activeIdea);
        saveMeta(activeIdea, { status: "clarifying" });
        pi.setSessionName(`${DEFAULT_SESSION_NAME_PREFIX}${activeIdea.name}`);
        updateIdeaStatus(ctx, activeIdea);
        ctx.ui.notify(`Attached to ${activeIdea.name}`, "info");
        sendOrQueue(pi, ctx, resumePrompt(activeIdea));
        return;
      }

      if (subcommand === "go") {
        if (!activeIdea) {
          ctx.ui.notify("No active idea. Start one with /idea <description>", "warning");
          return;
        }
        ctx.ui.notify(`Starting implementation for ${activeIdea.name}`, "info");
        sendOrQueue(pi, ctx, goPrompt(activeIdea));
        return;
      }

      if (subcommand === "stop") {
        if (!activeIdea) {
          ctx.ui.notify("No active idea. Use /idea use <name> first.", "warning");
          return;
        }
        ctx.ui.notify(`Requesting stop for ${activeIdea.name}`, "info");
        sendOrQueue(pi, ctx, stopPrompt(activeIdea));
        return;
      }

      const created = createIdea(input);
      activeIdea = created;
      persistActiveIdea(pi, activeIdea);
      pi.setSessionName(`${DEFAULT_SESSION_NAME_PREFIX}${created.name}`);
      updateIdeaStatus(ctx, activeIdea);
      ctx.ui.notify(`Created idea ${created.name} in ${created.root}`, "info");
      sendOrQueue(pi, ctx, kickoffPrompt(created));
    },
  });
}
