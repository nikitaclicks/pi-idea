import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

type GlobalConfig = {
  /** Base domain for named Cloudflare tunnels, e.g. "1clickdev.com".
   *  The app gets <idea-name>.<domain>. */
  domain?: string;
  /** Cloudflare API token for named tunnel management.
   *  Falls back to PI_IDEA_CF_TOKEN env var. */
  cfToken?: string;
  /** Cloudflare zone ID for the domain. If unset, resolved from the API. */
  cfZoneId?: string;
};

const STATE_TYPE = "pi-idea-state";
const CF_TOKEN_ENV = "PI_IDEA_CF_TOKEN";
const CF_ZONE_ENV = "PI_IDEA_CF_ZONE_ID";
const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "pi-idea.json");
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

function readGlobalConfig(): GlobalConfig {
  try {
    return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeGlobalConfig(config: GlobalConfig) {
  const dir = dirname(GLOBAL_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeJson(GLOBAL_CONFIG_PATH, config);
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
  const globalCfg = readGlobalConfig();
  const domain = globalCfg.domain;
  const cfToken = globalCfg.cfToken || process.env[CF_TOKEN_ENV] || '';
  const cfZoneId = globalCfg.cfZoneId || process.env[CF_ZONE_ENV] || '';
  const features = splitFeatures(meta.summary);
  const featureLines = features.length > 0 ? features.map((f) => `- ${f}`).join("\n") : "- TBD";
  const preferredUrl = runtime.preferredUrl || runtime.publicUrl || runtime.url || runtime.localUrl;
  const runtimeLines = [
    preferredUrl ? `- Preferred preview URL: ${preferredUrl}` : "- Preferred preview URL: not running",
    runtime.publicUrl ? `- Public URL: ${runtime.publicUrl}` : "- Public URL: not running",
    runtime.localUrl ? `- Local URL: ${runtime.localUrl}` : runtime.url ? `- Local URL: ${runtime.url}` : "- Local URL: not running",
    runtime.port ? `- Port: ${runtime.port}` : "- Port: not running",
    domain ? `- Custom domain: ${domain} (subdomain: ${meta.name}.${domain})` : "",
  ].filter(Boolean).join("\n");
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
- Create the standard scripts:
  \`scripts/run.sh\` — start server in background, write {localUrl, port} to runtime.json
  \`scripts/stop.sh\` — kill server + tunnel, write {running: false} to runtime.json
  \`scripts/tunnel.sh\` — start cloudflared, write {publicUrl, preferredUrl} to runtime.json
  \`scripts/status.sh\` — output JSON {running, localUrl, publicUrl, port} to stdout
  \`scripts/restart-server.sh\` — restart ONLY the server, keep tunnel alive (same URL!)
- **SIGHUP hardening**: All background processes MUST use \`nohup\` + \`disown\` so they survive the calling shell exit. Without this, servers die silently when the parent shell finishes.
- **PID files, not pkill**: To stop/restart servers, write the PID to a file (\`.server.pid\`, \`.tunnel.pid\`) and kill by that PID. Never use \`pkill -f\` with a pattern — it matches any process whose command line contains the string (e.g., \`pkill -f \"node server/index.js\"\` will kill ANY Node.js process with \"server\" in its path, including unrelated gateways). Kill by PID file is precise and safe.
- Each script updates \`runtime.json\` directly (port, localUrl, publicUrl, preferredUrl).
- Do not serve on localhost alone. Always use cloudflared tunnel for sharing.
- If \`cloudflared\` is unavailable, stop and ask the user to install it rather than defaulting to localhost.
- For interactive web apps that use WebSockets (Socket.IO, WS, etc.), cloudflared\'s default QUIC protocol drops the \`Upgrade: websocket\` header, causing \`400 Bad Request\` on connection. **Always add \`--protocol http2\` to the cloudflared command** in \`scripts/tunnel.sh\`.
- Verify that the preview works without manual refreshes; avoid stale asset caching during preview and account for shared tunnel preview limitations or transport quirks.

${domain && cfToken ? `## Custom Domain Configuration
- **Base domain**: ${domain}
- **Expected subdomain**: ${meta.name}.${domain}
- **Auth**: Cloudflare API token is available (global config or \`$PI_IDEA_CF_TOKEN\`).
- **Zone ID**: ${cfZoneId || 'auto-resolved from the Cloudflare API'}

### Tunnel setup for custom domain
When a domain and Cloudflare API token are configured, set up a **named Cloudflare tunnel** instead of a quick tunnel:

1. **Generate a tunnel secret**: \`openssl rand -base64 32\` (or use node crypto).
2. **Create the tunnel via Cloudflare API**: \`curl -s -X POST \"https://api.cloudflare.com/client/v4/accounts/\$ACCOUNT_ID/cfd_tunnel\" …\` with the name matching the idea name (\`${meta.name}\`).
3. **Save the credentials** in \`~/.cloudflared/${meta.name}-credentials.json\`.
4. **Create a DNS CNAME record** for \`${meta.name}.${domain}\` pointing to \`<tunnel-id>.cfargotunnel.com\` (proxied).
5. **Create a cloudflared config** at \`~/.cloudflared/config.yml\` with ingress rules for the subdomain.
6. **Start the tunnel using the token**: \`cloudflared tunnel --config ~/.cloudflared/config.yml run --token "\$(cat ~/.cloudflared/${meta.name}-token.json | node -e 'process.stdin.resume();let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).token))')\`.
7. Write the public URL (\`https://${meta.name}.${domain}\`) to runtime.json.
8. **The URL is now permanent** — it won\'t change on restarts.

## Runtime
${runtimeLines}
` : `## Runtime
${runtimeLines}
`}
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

const SCRIPT_TIMEOUT = 60_000; // generous — cloudflared tunnel can take 15s

function scriptPath(idea: IdeaState, name: string) {
  return join(idea.root, "scripts", name);
}

function hasScript(idea: IdeaState, name: string) {
  return existsSync(scriptPath(idea, name));
}

function runScript(idea: IdeaState, name: string, timeout = SCRIPT_TIMEOUT): { ok: boolean; stdout: string; stderr: string } {
  const path = scriptPath(idea, name);
  if (!existsSync(path)) {
    return { ok: false, stdout: "", stderr: `Script not found: ${name}` };
  }
  try {
    const stdout = execSync(`bash "${path}"`, { timeout, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const stdErr = (err as any).stderr?.toString()?.trim() || "";
    const stdOut = (err as any).stdout?.toString()?.trim() || "";
    return { ok: false, stdout: stdOut, stderr: stdErr || String(err) };
  }
}

/** Try to detect a running server by checking common PID files and ports. */
function detectRuntime(idea: IdeaState): { port?: number; pid?: number } {
  // Check common PID files
  for (const pidFile of [".server.pid", "server.pid", ".tunnel.pid", "tunnel.pid"]) {
    const candidate = join(idea.root, pidFile);
    try {
      const pid = parseInt(readFileSync(candidate, "utf8").trim(), 10);
      if (pid > 0) {
        // Cross-platform check: signal 0 tests if the process exists without sending a signal
        try { process.kill(pid, 0); return { pid }; } catch {}
      }
    } catch {}
  }
  return {};
}

/** Try to find which port a server is listening on by scanning common ones. */
function detectServerPort(idea: IdeaState): number | undefined {
  const runtime = readRuntime(idea);
  const candidates = runtime.port ? [runtime.port].flat() : [3000, 3001, 4173, 5173, 8080, 8000];
  for (const port of [candidates].flat()) {
    try {
      execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:${port}`, { encoding: "utf8" });
      return Number(port);
    } catch {}
  }
  return undefined;
}

/** Try alternative names for a script file. */
function findScript(idea: IdeaState, ...names: string[]): string | null {
  for (const name of names) {
    if (existsSync(scriptPath(idea, name))) return name;
  }
  return null;
}

/** Extract a trycloudflare.com URL from text (script output). */
function extractTunnelUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m?.[0];
}

const CF_API = "https://api.cloudflare.com/client/v4";

/** Make a Cloudflare API request. Returns the parsed JSON response result or throws. */
async function cfApi(cfToken: string, method: string, path: string, body?: unknown): Promise<any> {
  const url = `${CF_API}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${cfToken}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const response = await fetch(url, opts);
  const parsed = await response.json() as any;
  if (!parsed.success) {
    const errs = parsed.errors?.map((e: any) => e.message).join("; ") || "unknown error";
    throw new Error(`CF API error (${method} ${path}): ${errs}`);
  }
  return parsed.result;
}

/**
 * Set up a named Cloudflare tunnel for an idea with a custom domain.
 * Creates the tunnel if needed, sets up DNS, saves the tunnel token (used by
 * cloudflared tunnel run --token <token>), writes/updates config.yml with
 * ingress rules for all tunnels, and starts the cloudflared process.
 * Returns the tunnel URL or null on failure.
 */
async function setupNamedTunnel(idea: IdeaState, port?: number): Promise<string | null> {
  const globalCfg = readGlobalConfig();
  const domain = globalCfg.domain;
  const cfToken = globalCfg.cfToken || process.env[CF_TOKEN_ENV] || "";
  if (!domain || !cfToken) return null;

  const tunnelName = idea.name;
  const resolvedPort = port || readRuntime(idea).port || 3000;
  const tunnelUrl = `https://${tunnelName}.${domain}`;

  try {
    // 1. Resolve the zone ID if not cached
    let zoneId = globalCfg.cfZoneId || process.env[CF_ZONE_ENV] || "";
    if (!zoneId) {
      const zones = await cfApi(cfToken, "GET", `/zones?name=${domain}`);
      if (Array.isArray(zones) && zones.length > 0) {
        zoneId = zones[0].id;
        writeGlobalConfig({ ...globalCfg, cfZoneId: zoneId });
      } else {
        throw new Error(`Zone not found for domain: ${domain}`);
      }
    }

    // 2. Resolve the account ID
    const accounts = await cfApi(cfToken, "GET", "/accounts");
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("No Cloudflare account found");
    }
    const accountId = accounts[0].id;

    // 3. Check if a tunnel with this name already exists
    const tunnels: any[] = await cfApi(cfToken, "GET", `/accounts/${accountId}/cfd_tunnel`);
    let tunnelId: string;
    const existingTunnel = Array.isArray(tunnels) ? tunnels.find((t: any) => t.name === tunnelName) : undefined;

    if (existingTunnel) {
      tunnelId = existingTunnel.id;
    } else {
      // 4. Create a new tunnel
      const secret = execSync("node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"base64\"))'", { encoding: "utf8", timeout: 5_000 }).trim();
      const newTunnel = await cfApi(cfToken, "POST", `/accounts/${accountId}/cfd_tunnel`, {
        name: tunnelName,
        tunnel_secret: secret,
      });
      tunnelId = newTunnel.id;
    }

    // 5. Get the tunnel token (used for cloudflared tunnel run --token <token>)
    const rawToken = await cfApi(cfToken, "GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
    const tokenStr = typeof rawToken === "string" ? rawToken : JSON.stringify(rawToken);
    const tokenPath = join(homedir(), ".cloudflared", `${tunnelName}-token.json`);
    const cfDir = dirname(tokenPath);
    if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
    writeJson(tokenPath, { token: tokenStr, id: tunnelId, name: tunnelName });

    // 6. Create DNS CNAME record if not already set
    const dnsRecords: any[] = await cfApi(cfToken, "GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${tunnelName}.${domain}`);
    if (!Array.isArray(dnsRecords) || dnsRecords.length === 0) {
      await cfApi(cfToken, "POST", `/zones/${zoneId}/dns_records`, {
        type: "CNAME",
        name: tunnelName,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 60,
      });
    }

    // 7. Write/update shared cloudflared config.yml (ingress rules only, no top-level tunnel:)
    const configPath = join(homedir(), ".cloudflared", "config.yml");
    let configLines: string[] = [];
    try {
      const existing = readFileSync(configPath, "utf8");
      // Remove old lines for this hostname AND fix any duplicate-service-key issues
      // by parsing into a clean list of ingress rules
      configLines = rebuildConfigYaml(existing, tunnelName, domain, resolvedPort);
    } catch {}

    if (configLines.length === 0) {
      configLines = [
        "# Cloudflare tunnel ingress rules",
        "ingress:",
        `  - hostname: ${tunnelName}.${domain}`,
        `    service: http://localhost:${resolvedPort}`,
        "  - service: http_status:404",
      ];
    }
    // Ensure catch-all 404 at the end
    if (configLines.filter(l => l.includes("http_status:404")).length === 0) {
      configLines.push("  - service: http_status:404");
    }
    writeFileSync(configPath, configLines.join("\n") + "\n", "utf8");

    // 8. Start the tunnel process (it was only configured, not running)
    startTunnelProcess(idea, tokenStr, configPath);

    return tunnelUrl;
  } catch (err) {
    console.error("setupNamedTunnel failed:", String(err));
    return null;
  }
}

/**
 * Rebuild config.yml lines, inserting/updating the rule for one hostname
 * while preserving all other hostnames. This avoids YAML duplicate-key issues.
 * Each hostname block is a clean 2-line entry (hostname + single service).
 */
function rebuildConfigYaml(
  existing: string,
  tunnelName: string,
  domain: string,
  port: number,
): string[] {
  const lines = existing.split("\n");
  const result: string[] = [];
  const targetHostname = `${tunnelName}.${domain}`;
  let inIngress = false;
  let currentHostname: string | null = null;
  let hostnameSeen = false;
  let afterHostname = false; // waiting for service line

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Track ingress section
    if (trimmed.startsWith("ingress:")) {
      inIngress = true;
      result.push(trimmed);
      continue;
    }

    if (!inIngress) {
      // Skip top-level tunnel:/credentials-file: (we use tokens)
      if (trimmed.startsWith("tunnel:") || trimmed.startsWith("credentials-file:")) continue;
      result.push(trimmed);
      continue;
    }

    // Inside ingress section — we need to parse hostname/service blocks
    const hostnameMatch = trimmed.match(/^-\s+hostname:\s+(\S+)/);
    const serviceMatch = trimmed.match(/^\s+service:/);
    const is404 = trimmed.includes("http_status:404");

    if (hostnameMatch) {
      // Finish previous block
      if (currentHostname && currentHostname === targetHostname) {
        hostnameSeen = true;
        // Skip — we'll add the new one later
        currentHostname = null;
        afterHostname = false;
        continue;
      }
      // Emit previous preserved hostname if it had a service
      if (currentHostname && !afterHostname) {
        result.push(`  - hostname: ${currentHostname}`);
      }
      currentHostname = hostnameMatch[1];
      afterHostname = true;
      // Skip the hostname line for now (emit when we see service)
      continue;
    }

    if (serviceMatch && currentHostname) {
      if (currentHostname === targetHostname) {
        hostnameSeen = true;
        // Skip this entire block (both lines)
        currentHostname = null;
        afterHostname = false;
        continue;
      }
      // Emit the preserved hostname + this service
      result.push(`  - hostname: ${currentHostname}`);
      result.push(trimmed);
      currentHostname = null;
      afterHostname = false;
      continue;
    }

    if (is404) {
      result.push(trimmed);
      continue;
    }

    // Unexpected ingress line — pass through
    if (currentHostname && !afterHostname) {
      result.push(`  - hostname: ${currentHostname}`);
      currentHostname = null;
    }
    result.push(trimmed);
  }

  // Flush any dangling hostname
  if (currentHostname && currentHostname !== targetHostname && !afterHostname) {
    result.push(`  - hostname: ${currentHostname}`);
  }

  // Insert the target hostname rule right before the 404 catch-all
  if (!hostnameSeen) {
    const newRule = [`  - hostname: ${targetHostname}`, `    service: http://localhost:${port}`];
    const insertIdx = result.findIndex(l => l.includes("http_status:404"));
    if (insertIdx >= 0) {
      result.splice(insertIdx, 0, ...newRule);
    } else {
      result.push(...newRule);
    }
  } else {
    // Add the rule since it was removed (we skipped it above)
    const newRule = [`  - hostname: ${targetHostname}`, `    service: http://localhost:${port}`];
    const insertIdx = result.findIndex(l => l.includes("http_status:404"));
    if (insertIdx >= 0) {
      result.splice(insertIdx, 0, ...newRule);
    } else {
      result.push(...newRule);
    }
  }

  return result;
}

/**
 * Start cloudflared as a background process using the tunnel token.
 * Uses PID file for lifecycle management.
 */
function startTunnelProcess(idea: IdeaState, token: string, configPath: string): boolean {
  const logPath = join(idea.root, "tunnel.log");
  const pidPath = join(idea.root, ".tunnel.pid");

  // Kill any existing tunnel for this idea
  try {
    const oldPidStr = readFileSync(pidPath, "utf8").trim();
    if (oldPidStr) {
      const oldPid = parseInt(oldPidStr, 10);
      if (oldPid > 0) {
        try { process.kill(oldPid, "SIGTERM"); } catch {}
      }
    }
  } catch {}

  try {
    // Use spawn with detached:true — avoids shell injection, shell dependency,
    // and fragile nohup+&+echo patterns. The child process survives the parent's exit.
    const child = spawn("cloudflared", [
      "tunnel", "--config", configPath, "run", "--token", token
    ], {
      detached: true,
      stdio: ["ignore", fs.openSync(logPath, "a"), fs.openSync(logPath, "a")],
    });
    child.unref();
    const pid = child.pid;
    if (pid > 0) {
      writeFileSync(pidPath, String(pid), "utf8");
      // Wait up to 30s for tunnel to register (poll log file)
      for (let i = 0; i < 30; i++) {
        try {
          const log = readFileSync(logPath, "utf8");
          if (log.includes("Registered tunnel connection")) {
            return true;
          }
        } catch {}
        // Synchronous 1s sleep via Atomics.wait (blocks the event loop briefly, which is fine here)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
    return false;
  } catch (err) {
    console.error("startTunnelProcess failed:", String(err));
    return false;
  }
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
  const globalCfg = readGlobalConfig();
  const preview = runtime.preferredUrl || runtime.publicUrl || runtime.url || runtime.localUrl;
  return [
    `Idea: ${state.name}`,
    `Path: ${state.root}`,
    `Status: ${meta.status}`,
    preview ? `Preview: ${preview}` : "Preview: not running",
    runtime.publicUrl ? `Public URL: ${runtime.publicUrl}` : null,
    runtime.localUrl ? `Local URL: ${runtime.localUrl}` : null,
    runtime.port ? `Port: ${runtime.port}` : "Port: not running",
    globalCfg.domain ? `Domain: ${meta.name}.${globalCfg.domain}` : null,
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
  const globalCfg = readGlobalConfig();
  const lines = [
    `Go ahead with the active idea ${idea.name}.`,
    `Workspace: ${idea.root}`,
    `Read ${idea.requirementsPath} first, then implement the project in that workspace.`,
    "Preserve prior work, update the spec if needed, and apply the latest requested changes.",
    "If the project is runnable, create the standard scripts in scripts/ (see requirements.md for the full contract).",
    "**SIGHUP hardening is mandatory** — all background server processes MUST use `nohup` + `disown` so they survive the calling shell exit. Without this, processes die silently as soon as the agent's shell returns.",
    "Include `scripts/restart-server.sh` — it restarts only the Node server without touching cloudflared, so the tunnel URL stays the same across restarts.",
    "For web apps, do not serve on localhost alone. After implementing the server, create a tunnel with cloudflared, record the public URL as the primary preview URL, and surface only the tunnel URL to the user. The local URL is a fallback for debugging only.",
    "If cloudflared is not available, stop and ask the user to install it rather than defaulting to a localhost-only preview.",
    "For web apps that use WebSockets (Socket.IO, WS, etc.): cloudflared's default QUIC protocol drops the `Upgrade: websocket` header. The tunnel script MUST add `--protocol http2` to the cloudflared command.",
    "Validate the primary flows through the shared tunnel URL itself. Do not leave the preview in a state where users need manual refreshes after actions; fix caching, transport, or realtime update issues as part of the implementation.",
    "When you finish, summarize what changed and include the tunnel URL.",
  ];

  if (globalCfg.domain) {
    const cfToken = globalCfg.cfToken || process.env[CF_TOKEN_ENV] || '';
    const cfZoneId = globalCfg.cfZoneId || process.env[CF_ZONE_ENV] || '';
    lines.push('');
    lines.push(`### Custom Domain: https://${idea.name}.${globalCfg.domain}`);
    lines.push(`This idea has a custom domain configured in ~/.config/pi-idea.json. Use a named Cloudflare tunnel instead of a quick tunnel.`);
    if (cfToken) {
      lines.push(`Cloudflare API token is available (global config or env).`);
      lines.push(`Zone: ${globalCfg.domain} (ID: ${cfZoneId || 'auto-resolved from Cloudflare API'})`);
      lines.push(`The named tunnel will be set up automatically by the /idea run command.`);
      lines.push(`If writing a tunnel.sh script manually, start cloudflared with: cloudflared tunnel --config ~/.cloudflared/config.yml run --token "\$(cat ~/.cloudflared/${idea.name}-token.json | node -e 'process.stdin.resume();let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).token))')\``);
    } else {
      lines.push(`No Cloudflare API token configured. Set $PI_IDEA_CF_TOKEN or run /idea token <token>.`);
    }
  }

  return lines.join('\n');
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
- Standard scripts contract — you MUST create these scripts during implementation:
  \`scripts/run.sh\` — start server in background (use nohup + disown!), write {localUrl, port} to runtime.json
  \`scripts/stop.sh\` — kill server + tunnel, write {running: false} to runtime.json
  \`scripts/tunnel.sh\` — start cloudflared, write {publicUrl, preferredUrl} to runtime.json
  \`scripts/status.sh\` — output JSON {running, localUrl, publicUrl, port} to stdout
  \`scripts/restart-server.sh\` — restart ONLY the server, keep tunnel alive (preserves URL!)
- **SIGHUP hardening**: All background processes MUST use \`nohup\` + \`disown\`. Without this, server and tunnel processes die silently when the agent\'s shell exits.
- **PID files, not pkill**: Write server/tunnel PIDs to files (e.g. \`.server.pid\`, \`.tunnel.pid\`). Kill by PID, never by \`pkill -f\` pattern — that kills any process whose command line happens to contain the search string (unrelated gateways, other Node servers).
- **Tunnel URL volatility**: trycloudflare.com quick tunnels change URL on every start. To keep the same URL across restarts, use \`scripts/restart-server.sh\` (leaves cloudflared running).
- For web apps, use a tunnel — do not serve on localhost alone. After implementing, start cloudflared and record the public tunnel URL as the primary preview URL. The local URL is a fallback for debugging only.
- If cloudflared is unavailable, stop and ask the user to install it rather than defaulting to a localhost-only preview.
- Whenever you start, stop, or change a preview runtime, update runtime.json with public URL as preferredPreviewUrl and local URL as a fallback.
- For interactive web apps that use WebSockets (Socket.IO, WS, etc.), cloudflared\'s default QUIC protocol drops the \`Upgrade: websocket\` header, causing \`400 Bad Request\`. The tunnel script MUST use \`--protocol http2\`.
- Ensure the shared preview behaves correctly without manual refreshes; watch for stale cached assets and tunnel-specific transport or realtime quirks through the shared URL.
- When the user asks for more changes after a previous implementation, update the spec first and then apply the changes only when they explicitly ask you to proceed.
- If a custom domain is configured in the global config at \`~/.config/pi-idea.json\` (check the Custom Domain section in requirements.md), set up a **named Cloudflare tunnel** instead of a quick tunnel. The URL will be https://<idea-name>.<domain> and won't change on restarts.
- \`scripts/tunnel.sh\` for named tunnels should use a cloudflared config file at \`~/.cloudflared/config.yml\` with ingress rules for the specific subdomain, and start cloudflared using \`--token <token>\` (read from \`~/.cloudflared/<idea-name>-token.json\`). Do not use bare \`cloudflared tunnel run\` (no origin cert).
- The Cloudflare API token can come from \`~/.config/pi-idea.json\` (\`cfToken\` field) or the \`$PI_IDEA_CF_TOKEN\` environment variable.
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
    "  /idea run [name]           Start the preview for an existing idea",
    "  /idea status [name]        Show status of active idea or a named one",
    "  /idea ps | running     List all running ideas with URLs",
    "  /idea go               Start implementing the active idea",
    "  /idea restart          Restart server only (keeps tunnel URL)",
    "  /idea domain [domain]  Set or show global custom domain (stored in ~/.config/pi-idea.json)",
    "  /idea token [token]    Set or show global Cloudflare API token (stored in ~/.config/pi-idea.json)",
    "  /idea clear            Detach from the active idea",
    "  /idea help [subcmd]    Show this help, or help for a specific subcommand",
    "",
    "Flags:",
    "  -h, --help             Show this help message",
    "",
    "Examples:",
    "  /idea a todo app with auth and a dashboard",
    "  /idea domain example.com",
    "  /idea use my-todo-app",
    "  /idea status",
    "  /idea go",
  ].join("\n");
}

function subcommandHelp(subcommand: string): string | null {
  const help: Record<string, string> = {
    "ps": `Usage: /idea ps

List all running ideas with their preview URLs and ports.
Scans all idea workspaces, checks runtime state, and runs
status.sh for live verification.

Alias: /idea running`,
    "running": `Usage: /idea running

Alias for /idea ps.`,
    "domain": `Usage: /idea domain [domain]

Set or show the global custom domain for named Cloudflare tunnels.
The domain is stored globally in ~/.config/pi-idea.json and applies
 to all ideas.

If no argument is given, shows the current domain (if set).

When set, the final URL for any idea will be:
  https://<idea-name>.<domain>

Example:
  /idea domain 1clickdev.com
  -> Any idea will be at https://<idea-name>.1clickdev.com

To complete the setup, also configure a Cloudflare API token
with /idea token <token> or via the $PI_IDEA_CF_TOKEN env var.`,
    "token": `Usage: /idea token [token]

Set or show the global Cloudflare API token for named tunnel management.
The token is stored globally in ~/.config/pi-idea.json (or set via
$PI_IDEA_CF_TOKEN env var).

If no argument is given, shows whether a token is configured.

Requires a token with permissions:
  - Cloudflare Tunnel: Edit
  - DNS: Edit`,
    "use": `Usage: /idea use <name>

Attach to an existing idea workspace by its short name.
Use /idea (with no args) to list available ideas.`,
    "status": `Usage: /idea status [name]

Show the current state of an idea, including its path,
status, and any running preview URLs.
Omit name to show the active idea.`,
    "run": `Usage: /idea run [name]

Start the preview for an idea that is already implemented.
If name is provided, attaches to that idea first.
Runs scripts/run.sh and scripts/tunnel.sh.
To restart the server without changing the tunnel URL, use:
  scripts/restart-server.sh
Expects these scripts to have been created by /idea go.`,
    "go": `Usage: /idea go

Tell Pi to start implementing the active idea.
The extension reads requirements.md and begins coding.
Creates standard scripts (run.sh, stop.sh, tunnel.sh, status.sh, restart-server.sh).
SIGHUP hardening (nohup + disown) is required for all background processes.
Only works if an idea is currently active.`,
    "stop": `Usage: /idea stop

Stop the running preview server or tunnel for the active idea.
Runs scripts/stop.sh deterministically.
This kills BOTH the server and tunnel — the tunnel URL will change on next start.`,
    "clear": `Usage: /idea clear

Detach the current Pi session from the active idea.
The idea workspace is preserved and can be re-attached with /idea use.`,
    "restart": `Usage: /idea restart

Restart the server for the active idea without touching the tunnel.
Keeps the same tunnel URL. Runs scripts/restart-server.sh if available.`,
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
        // Try deterministic status script first
        if (hasScript(target, "status.sh")) {
          const result = runScript(target, "status.sh", 10_000);
          if (result.ok && result.stdout) {
            try {
              const status = JSON.parse(result.stdout);
              saveRuntime(target, {
                running: status.running ?? undefined,
                localUrl: status.localUrl ?? undefined,
                publicUrl: status.publicUrl ?? undefined,
                port: status.port ?? undefined,
              });
              if (status.running) saveMeta(target, { status: "running" });
            } catch {}
          }
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

      if (subcommand === "run") {
        const target = rest ? findIdea(rest) : activeIdea;
        if (!target) {
          ctx.ui.notify("No matching idea. Use /idea use <name> or /idea run <name>.", "warning");
          return;
        }
        activeIdea = target;
        persistActiveIdea(pi, activeIdea);
        pi.setSessionName(`${DEFAULT_SESSION_NAME_PREFIX}${activeIdea.name}`);
        updateIdeaStatus(ctx, activeIdea);

        const runScriptName = findScript(activeIdea, "run.sh", "start.sh");
        if (!runScriptName) {
          ctx.ui.notify(`No scripts/run.sh found for ${activeIdea.name}. Run \`/idea go\` to implement it first.`, "warning");
          return;
        }

        ctx.ui.notify(`Running ${activeIdea.name}...`, "info");
        const result = runScript(activeIdea, runScriptName);
        if (!result.ok) {
          ctx.ui.notify(`${runScriptName} failed:\n${result.stderr || result.stdout}`, "error");
          return;
        }
        saveMeta(activeIdea, { status: "running" });

        // Detect actual runtime state (handles older ideas that don't update runtime.json)
        const detectedPort = detectServerPort(activeIdea);
        const pidInfo = detectRuntime(activeIdea);
        const localUrl = detectedPort
          ? `http://127.0.0.1:${detectedPort}`
          : pidInfo.pid
            ? `http://127.0.0.1:${readRuntime(activeIdea).port || 3000}`
            : undefined;
        if (detectedPort || pidInfo.pid) {
          saveRuntime(activeIdea, {
            running: true,
            port: detectedPort || readRuntime(activeIdea).port || undefined,
            localUrl,
          });
        }

        // Try to set up a named tunnel when a domain is configured
        const globalCfg = readGlobalConfig();
        const hasDomain = globalCfg.domain && (globalCfg.cfToken || process.env[CF_TOKEN_ENV]);

        let tunnelUrl: string | undefined;
        if (hasDomain) {
          ctx.ui.notify(`Setting up named tunnel for ${activeIdea.name}.${globalCfg.domain}...`, "info");
          tunnelUrl = await setupNamedTunnel(activeIdea, detectedPort || Number(readRuntime(activeIdea).port) || undefined);
          if (!tunnelUrl) {
            ctx.ui.notify("Named tunnel setup failed, falling back to quick tunnel", "warning");
          }
        }

        if (!tunnelUrl) {
          // Try multiple tunnel script names (quick tunnel fallback)
          const tunnelScript = findScript(activeIdea, "tunnel.sh", "tunnel-run.sh", "tunnel_start.sh");
          if (tunnelScript) {
            ctx.ui.notify("Creating quick tunnel...", "info");
            const tunnelResult = runScript(activeIdea, tunnelScript, 60_000);
            if (!tunnelResult.ok) {
              ctx.ui.notify(`${tunnelScript} failed:\n${tunnelResult.stderr || tunnelResult.stdout}`, "warning");
            }
            tunnelUrl = extractTunnelUrl(tunnelResult.stdout);
            if (!tunnelUrl) {
              try {
                const urlFile = readFileSync(join(activeIdea.root, ".tunnel.url"), "utf8").trim();
                if (urlFile) tunnelUrl = urlFile;
              } catch {}
            }
          }
        }

        // Re-read after tunnel might have updated it
        const runtime = readRuntime(activeIdea);
        const previewUrl = tunnelUrl || runtime.publicUrl || runtime.preferredUrl || localUrl || "unknown";
        if (tunnelUrl) {
          let tunnelPid: number | undefined;
          try {
            const pidStr = readFileSync(join(activeIdea.root, ".tunnel.pid"), "utf8").trim();
            if (pidStr) tunnelPid = parseInt(pidStr, 10);
          } catch {}
          saveRuntime(activeIdea, {
            publicUrl: tunnelUrl,
            preferredUrl: tunnelUrl,
            tunnelPid: tunnelPid || undefined,
          });
        }
        ctx.ui.notify(`${activeIdea.name} running at ${previewUrl}`, "info");
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

        const stopScript = findScript(activeIdea, "stop.sh", "tunnel-stop.sh");
        if (!stopScript) {
          ctx.ui.notify(`No stop script found for ${activeIdea.name}. Run \`/idea go\` to implement it first.`, "warning");
          return;
        }

        ctx.ui.notify(`Stopping ${activeIdea.name}...`, "info");
        const result = runScript(activeIdea, stopScript, 10_000);
        if (!result.ok) {
          ctx.ui.notify(`${stopScript} failed:\n${result.stderr || result.stdout}`, "warning");
        }
        // Also try to kill by PID files
        const detected = detectRuntime(activeIdea);
        if (detected.pid) {
          try {
            execSync(`kill ${detected.pid} 2>/dev/null; rm -f "${join(activeIdea.root, ".server.pid")}" "${join(activeIdea.root, ".tunnel.pid")}"`, { timeout: 3_000 });
          } catch {}
        }
        saveMeta(activeIdea, { status: "stopped" });
        saveRuntime(activeIdea, { running: false });
        ctx.ui.notify(`${activeIdea.name} stopped`, "info");
        return;
      }

      if (subcommand === "domain") {
        const globalCfg = readGlobalConfig();
        if (!rest) {
          if (globalCfg.domain) {
            ctx.ui.notify(`Global domain: ${globalCfg.domain}`, "info");
          } else {
            ctx.ui.notify("No global domain configured. Usage: /idea domain <domain.com>", "info");
          }
          return;
        }
        // Validate basic domain format
        const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;
        if (!domainPattern.test(rest)) {
          ctx.ui.notify(`Invalid domain format: ${rest}`, "warning");
          return;
        }
        writeGlobalConfig({ ...globalCfg, domain: rest.toLowerCase() });
        ctx.ui.notify(`Global domain set to ${rest}. Ideas will appear at https://<idea-name>.${rest.toLowerCase()}`, "info");
        return;
      }

      if (subcommand === "token") {
        const globalCfg = readGlobalConfig();
        if (!rest) {
          if (globalCfg.cfToken) {
            ctx.ui.notify("Cloudflare API token is configured in global config (hidden)", "info");
          } else if (process.env[CF_TOKEN_ENV]) {
            ctx.ui.notify("Using Cloudflare API token from $PI_IDEA_CF_TOKEN environment variable", "info");
          } else {
            ctx.ui.notify("No Cloudflare API token configured. Set $PI_IDEA_CF_TOKEN or use: /idea token <token>", "info");
          }
          return;
        }
        writeGlobalConfig({ ...globalCfg, cfToken: rest });
        ctx.ui.notify("Cloudflare API token saved to ~/.config/pi-idea.json", "info");
        return;
      }

      if (subcommand === "ps" || subcommand === "running") {
        const ideas = listIdeas();
        const running: Array<{name: string; url: string; port: string | number; root: string}> = [];
        for (const idea of ideas) {
          const runtime = readRuntime(idea);
          if (!runtime.running) continue;
          // Try status.sh for a live check
          if (hasScript(idea, "status.sh")) {
            const result = runScript(idea, "status.sh", 8_000);
            if (result.ok && result.stdout) {
              try {
                const status = JSON.parse(result.stdout);
                if (!status.running) continue;
                saveRuntime(idea, { running: true, localUrl: status.localUrl, publicUrl: status.publicUrl, port: status.port });
              } catch {}
            }
          }
          const previewUrl = runtime.preferredUrl || runtime.publicUrl || runtime.localUrl || "unknown";
          running.push({ name: idea.name, url: previewUrl, port: runtime.port ?? "?", root: idea.root });
        }
        if (running.length === 0) {
          ctx.ui.notify("No ideas currently running", "info");
          return;
        }
        const lines = running.map(
          (r, i) => `${i + 1}. ${r.name} — ${r.url} (port ${r.port})`
        );
        ctx.ui.notify(`Running ideas (${running.length}):\n${lines.join("\n")}`, "info");
        return;
      }

      if (subcommand === "restart") {
        if (!activeIdea) {
          ctx.ui.notify("No active idea. Use /idea use <name> first.", "warning");
          return;
        }

        if (!hasScript(activeIdea, "restart-server.sh")) {
          ctx.ui.notify(`No scripts/restart-server.sh found for ${activeIdea.name}. Run \`/idea go\` to implement it first.`, "warning");
          return;
        }

        ctx.ui.notify(`Restarting ${activeIdea.name} server (tunnel stays up)...`, "info");
        const result = runScript(activeIdea, "restart-server.sh");
        if (!result.ok) {
          ctx.ui.notify(`scripts/restart-server.sh failed:\n${result.stderr || result.stdout}`, "error");
          return;
        }
        saveMeta(activeIdea, { status: "running" });
        const runtime = readRuntime(activeIdea);
        const previewUrl = runtime.preferredUrl || runtime.publicUrl || runtime.localUrl || "unknown";
        ctx.ui.notify(`${activeIdea.name} restarted at ${previewUrl} (same URL)`, "info");
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
