import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsBuild, requireFreePort } from "../support";

describe("conditional Anchor build", () => {
  let root: string;
  async function file(path: string, seconds: number) {
    await writeFile(join(root, path), "fixture");
    await utimes(join(root, path), seconds, seconds);
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aegis-stage-"));
    await mkdir(join(root, "programs/aegis/src"), { recursive: true });
    await mkdir(join(root, "programs/demo_dex/src"), { recursive: true });
    await mkdir(join(root, "target/deploy"), { recursive: true });
    for (const path of ["Anchor.toml", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "programs/aegis/Cargo.toml",
      "programs/aegis/src/lib.rs", "programs/demo_dex/src/lib.rs"]) await file(path, 100);
    for (const name of ["aegis", "demo_dex"]) await file(`target/deploy/${name}.so`, 200);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("skips a build when both programs are current", async () => { expect(await needsBuild(root)).toBe(false); });
  it.each(["aegis", "demo_dex"])("builds when %s is missing", async (name) => {
    await rm(join(root, `target/deploy/${name}.so`));
    expect(await needsBuild(root)).toBe(true);
  });
  it.each(["programs/aegis/src/lib.rs", "programs/demo_dex/src/lib.rs", "programs/aegis/Cargo.toml", "Cargo.lock", "rust-toolchain.toml"])
    ("builds when %s is newer", async (path) => {
      await file(path, 300);
      expect(await needsBuild(root)).toBe(true);
    });
});

it("explains an occupied port and how to free it; leaves a free port available", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  try {
    await expect(requireFreePort(address.port)).rejects.toThrow(`Port ${address.port} is already in use`);
    await expect(requireFreePort(address.port)).rejects.toThrow("kill <PID>");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  await requireFreePort(address.port);
  await requireFreePort(address.port);
});
