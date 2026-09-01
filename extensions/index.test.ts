import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchRequirementsRuntime, patchRequirementsStatus, rebuildConfigYaml, resolveCloudflaredBinary } from "./index.ts";

test("rebuildConfigYaml preserves existing rules and updates one target", () => {
  const input = `# existing\ningress:\n  - hostname: one.example.com\n    service: http://localhost:3000\n  - hostname: target.example.com\n    service: http://localhost:9999\n  - service: http_status:404\n`;
  const output = rebuildConfigYaml(input, "target", "example.com", 4173).join("\n");
  assert.match(output, /one\.example\.com\n    service: http:\/\/localhost:3000/);
  assert.match(output, /target\.example\.com\n    service: http:\/\/localhost:4173/);
  assert.equal(output.match(/http_status:404/g)?.length, 1);
});

test("runtime and status patches preserve refined requirements", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-idea-"));
  const requirementsPath = join(root, "requirements.md");
  writeFileSync(requirementsPath, `# demo\n\nStatus: **draft**\n\n## Product Spec\n- Carefully refined requirement\n\n## Runtime\n- Preferred preview URL: not running\n- Public URL: not running\n- Local URL: not running\n- Port: not running\n`);
  const state:any = { requirementsPath };
  patchRequirementsStatus(state, "running");
  patchRequirementsRuntime(state, { running:true, publicUrl:"https://demo.example.com", preferredUrl:"https://demo.example.com", localUrl:"http://localhost:4173", port:4173 });
  const result = readFileSync(requirementsPath, "utf8");
  assert.match(result, /Status: \*\*running\*\*/);
  assert.match(result, /Carefully refined requirement/);
  assert.match(result, /Public URL: https:\/\/demo\.example\.com/);
  rmSync(root, { recursive:true, force:true });
});

test("cloudflared resolver honors configured absolute path", () => {
  assert.equal(resolveCloudflaredBinary({ cloudflaredPath:"/bin/true" }), "/bin/true");
});
