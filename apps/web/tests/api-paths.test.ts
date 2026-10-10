import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  [["[group]/[action].ts", "[endpoint].ts"], 1],
  [["handler.ts", "handler.js"], 1],
  [["agent.ts", "agent/info.ts"], 1],
  [["actions/[action]/index.ts", "actions/[name]/details.ts"], 1],
  [["[...path]/index.ts", "[...rest].ts"], 1],
  [["handler.ts"], 0],
  [["[group]/create.ts", "[group]/fund.ts"], 0],
  [["actions/create.ts", "agent/create.ts"], 0],
] as const)("checks Vercel path conflicts for %j", (paths, status) => {
  const directory = mkdtempSync(join(tmpdir(), "aegis-api-paths-"));
  try {
    for (const path of paths) {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/check-api-paths.mjs", import.meta.url)), directory], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(status);
    expect(status ? result.stderr : result.stdout).toContain(status ? "Conflicting API paths" : "PASS:");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
