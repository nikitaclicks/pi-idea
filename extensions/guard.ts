/**
 * pi-idea guard — single supervisor daemon for all ideas.
 *
 * Reads idea state files the same way `/idea ps` does (runtime.json,
 * PID files, curl the local origin), compares desired vs observed state,
 * and heals ONLY what is broken:
 *
 *   - runtime says "running" but the server is dead   → restart-server.sh (or run.sh)
 *   - server alive but the public URL is failing      → restart / repair the tunnel unit
 *   - tunnel managed by a legacy PID file             → migrate to the systemd unit
 *
 * Runs under a single systemd user unit (pi-idea-guard.service).
 * All state on disk stays the source of truth; the guard only enforces it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  detectServerPort,
  findScript,
  hasScript,
  listIdeas,
  probePublicUrl,
  readGlobalConfig,
  readRuntime,
  rebuildConfigYaml,
  resolveCloudflaredBinary,
  runScript,
  saveRuntime,
  setupNamedTunnel,
  startTunnelService,
  systemdUserAvailable,
  tunnelServiceState,
} from "./index.ts";

const GUARD_TUNNEL_UNIT = "cloudflared-idea"; // template: cloudflared-idea@<name>.service

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How often the guard scans all ideas. */
const SCAN_INTERVAL_MS = envMs("PI_IDEA_GUARD_INTERVAL", 60_000);
/** Cooldown per idea+kind before healing the same thing again (anti-flapping). */
const HEAL_COOLDOWN_MS = envMs("PI_IDEA_GUARD_COOLDOWN", 10 * 60_000);
/** How often the public URL may be probed per idea. */
const PROBE_COOLDOWN_MS = envMs("PI_IDEA_GUARD_PROBE_INTERVAL", 90_000);
/** Wait after daemon start so tunnel units / servers can settle. */
const BOOT_GRACE_MS = envMs("PI_IDEA_GUARD_BOOT_GRACE", 30_000);

export type GuardObservation = {
  /** Idea's runtime.json says it should be running. */
  desired: boolean;
  /** Local origin answers (PID alive + curl OK). */
  serverAlive: boolean;
  /** systemd tunnel unit state ("unknown" = systemd unavailable). */
  tunnelUnit: "active" | "inactive" | "unknown";
  /** Public URL probe result. null = not probed (no URL, or server down). */
  publicOk: boolean | null;
};

export type GuardAction = "none" | "restart-server" | "heal-tunnel";

/**
 * Pure decision function: given an observation, what should the guard do?
 * - not desired → never touch anything
 * - server dead → restart the server (regardless of tunnel state)
 * - server alive but public failing → heal the tunnel
 */
export function decideGuardAction(obs: GuardObservation): GuardAction {
  if (!obs.desired) return "none";
  if (!obs.serverAlive) return "restart-server";
  if (obs.publicOk === false) return "heal-tunnel";
  return "none";
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Anti-flapping: timestamps of the last heal/probe per idea+kind.
const lastAt = new Map<string, number>();
function stamp(idea: string, kind: string, at: number) {
  lastAt.set(`${idea}:${kind}`, at);
}
function last(idea: string, kind: string): number {
  return lastAt.get(`${idea}:${kind}`) ?? 0;
}

function rewriteIngress(ideaName: string, port: number | undefined): boolean {
  const cfg = readGlobalConfig();
  if (!cfg.domain || !Number.isInteger(port) || (port as number) < 1) return false;
  const configPath = `${process.env.HOME}/.cloudflared/config.yml`;
  try {
    const existing = readFileSync(configPath, "utf8");
    const lines = rebuildConfigYaml(existing, ideaName, cfg.domain, port as number);
    writeFileSync(configPath, lines.join("\n") + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Restart the app server. Prefers restart-server.sh (kills hung PIDs too). */
async function healServer(ideaName: string): Promise<void> {
  const idea = listIdeas().find((i) => i.name === ideaName);
  if (!idea) return;
  const before = detectServerPort(idea);
  const recordedPort = Number(readRuntime(idea).port) || undefined;
  const script = hasScript(idea, "restart-server.sh")
    ? "restart-server.sh"
    : findScript(idea, "run.sh", "start.sh");
  if (!script) {
    log(`ERROR: no restart/run script for ${ideaName}; cannot heal server`);
    return;
  }
  log(`${ideaName}: server down/hung → running scripts/${script}`);
  const result = runScript(idea, script, 60_000);
  if (!result.ok) {
    log(`ERROR: ${script} failed for ${ideaName}: ${result.stderr || result.stdout}`);
  }
  const after = detectServerPort(idea);
  if (!after) {
    log(`ERROR: ${ideaName} still not answering after ${script}`);
    return;
  }
  if (before !== after) {
    saveRuntime(idea, {
      running: true,
      port: after,
      localUrl: `http://127.0.0.1:${after}`,
    });
    // Only touch the tunnel when the server actually moved to a new port.
    if (after !== recordedPort) {
      rewriteIngress(ideaName, after);
      log(`${ideaName}: server back up on port ${after} (was ${before ?? "none"}, recorded ${recordedPort ?? "none"}); ingress updated`);
      // Ingress changed → the tunnel must reload its config to route the new port.
      if (tunnelServiceState(ideaName) === "active") {
        try {
          execSync(`systemctl --user restart ${GUARD_TUNNEL_UNIT}@${ideaName}.service`, {
            timeout: 15_000,
            stdio: "ignore",
          });
          log(`${ideaName}: tunnel unit restarted for new port`);
        } catch (err) {
          log(`ERROR: tunnel unit restart failed for ${ideaName}: ${String(err)}`);
        }
      }
    } else {
      log(`${ideaName}: server back up on port ${after} (same as recorded)`);
    }
  } else {
    log(`${ideaName}: server back up on port ${after}`);
  }
}

/** Repair the tunnel: restart the unit, or migrate legacy/missing setups onto it. */
async function healTunnel(ideaName: string): Promise<void> {
  const idea = listIdeas().find((i) => i.name === ideaName);
  if (!idea) return;
  const runtime = readRuntime(idea);
  // Always make sure ingress points at the port the server actually uses.
  rewriteIngress(ideaName, Number(runtime.port) || undefined);

  const unitState = tunnelServiceState(ideaName);
  if (unitState === "active") {
    try {
      execSync(`systemctl --user restart ${GUARD_TUNNEL_UNIT}@${ideaName}.service`, {
        timeout: 15_000,
        stdio: "ignore",
      });
      log(`${ideaName}: tunnel unit restarted`);
    } catch (err) {
      log(`ERROR: tunnel unit restart failed for ${ideaName}: ${String(err)}`);
    }
    return;
  }

  if (!systemdUserAvailable()) {
    // Legacy fallback: re-run the full named-tunnel setup (hardened spawn).
    const url = await setupNamedTunnel(idea, Number(runtime.port) || undefined);
    log(url ? `${ideaName}: tunnel re-spawned at ${url}` : `ERROR: tunnel heal failed for ${ideaName}`);
    return;
  }

  // systemd available, unit not active → start it from the saved token record.
  const tokenPath = `${process.env.HOME}/.cloudflared/${ideaName}-token.json`;
  if (!existsSync(tokenPath)) {
    log(
      `ERROR: cannot heal tunnel for ${ideaName}: no token record (~/.cloudflared/${ideaName}-token.json missing). ` +
        `Re-run: /idea run ${ideaName}`,
    );
    return;
  }
  try {
    const token = String((JSON.parse(readFileSync(tokenPath, "utf8")) as { token: string }).token);
    const cloudflared = resolveCloudflaredBinary(readGlobalConfig());
    if (!cloudflared) throw new Error("cloudflared binary not found");
    // startTunnelService also installs the unit template and kills legacy PID-file tunnels.
    const ok = startTunnelService(idea, token, cloudflared);
    log(ok ? `${ideaName}: tunnel unit installed and started` : `ERROR: failed to start tunnel unit for ${ideaName}`);
  } catch (err) {
    log(`ERROR: tunnel heal failed for ${ideaName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One pass over all ideas. Returns the number of heal actions attempted. */
export async function scanOnce(): Promise<number> {
  const ideas = listIdeas();
  let actions = 0;
  const now = Date.now();

  for (const idea of ideas) {
    const runtime = readRuntime(idea);
    const desired = runtime.running === true;
    if (!desired) continue;

    const name = idea.name;
    const serverAlive = Boolean(detectServerPort(idea));

    if (!serverAlive) {
      // Skip public probing entirely while the origin is down: the tunnel is fine,
      // the origin just isn't there yet.
      if (now - last(name, "server") < HEAL_COOLDOWN_MS) continue;
      stamp(name, "server", now);
      stamp(name, "probe", now); // suppress public probing right after a restart
      await healServer(name);
      actions++;
      continue;
    }

    // Server is alive — check the public URL (throttled).
    const publicUrl = runtime.publicUrl || runtime.preferredUrl;
    if (!publicUrl) continue;
    if (now - last(name, "probe") < PROBE_COOLDOWN_MS) continue;
    stamp(name, "probe", now);
    const probe = await probePublicUrl(String(publicUrl));
    if (probe.ok) continue;

    log(`${name}: public URL failing (${probe.detail}) — server is up, so the tunnel is the problem`);
    if (now - last(name, "tunnel") < HEAL_COOLDOWN_MS) {
      log(`${name}: tunnel heal skipped (cooldown)`);
      continue;
    }
    stamp(name, "tunnel", now);
    await healTunnel(name);
    actions++;
  }

  return actions;
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const intervalArg = args.find((a) => a.startsWith("--interval="));
  const intervalMs = intervalArg ? Number(intervalArg.slice("--interval=".length)) : SCAN_INTERVAL_MS;

  log(`pi-idea guard started (scan every ${Math.round(intervalMs / 1000)}s, boot grace ${Math.round(BOOT_GRACE_MS / 1000)}s)`);
  if (!once) await sleep(BOOT_GRACE_MS);

  for (;;) {
    try {
      const actions = await scanOnce();
      if (actions > 0) log(`scan complete: ${actions} heal action(s) attempted`);
    } catch (err) {
      log(`ERROR: scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (once) {
      log("--once complete");
      return;
    }
    await sleep(intervalMs);
  }
}

// Run main only when executed directly (not when imported for tests).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log(`fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
