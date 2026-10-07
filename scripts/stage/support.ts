import { spawn, type ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function needsBuild(root: string): Promise<boolean> {
  const binaries = await Promise.all(["aegis", "demo_dex"].map(async (name) => {
    try { return (await stat(join(root, "target/deploy", `${name}.so`))).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  }));
  if (binaries.includes(0)) return true;
  const oldestBinary = Math.min(...binaries);
  const sources = ["Anchor.toml", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];
  async function collect(directory: string) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else sources.push(path);
    }
  }
  await collect("programs");
  return (await Promise.all(sources.map(async (path) => (await stat(join(root, path))).mtimeMs)))
    .some((mtime) => mtime > oldestBinary);
}

export async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "EADDRINUSE"
      ? `Port ${port} is already in use. Stop its terminal with Ctrl+C. To find the process, run: lsof -nP -iTCP:${port} -sTCP:LISTEN; then stop that process with kill <PID>.`
      : `Cannot bind port ${port}: ${error.code ?? "unknown error"}.`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

export interface ManagedProcess {
  child: ChildProcess;
  exited: Promise<string>;
  failure?: string;
}

export function startProcess(root: string, name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): ManagedProcess {
  // Each service owns a process group, including pnpm/tsx/Vite and the validator.
  const child = spawn(command, args, { cwd: root, detached: true, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, NO_DNA: "1", ...env } });
  const managed: ManagedProcess = { child, exited: Promise.resolve("") };
  managed.exited = new Promise((resolve) => {
    const finish = (message: string) => { managed.failure = message; resolve(message); };
    child.once("error", () => finish(`Could not start ${name}; check that ${command} is installed.`));
    child.once("exit", (code, signal) => finish(`${name} exited (${signal ?? code}).`));
  });
  child.stdout!.pipe(process.stdout, { end: false });
  return managed;
}

export async function stopProcess(managed: ManagedProcess): Promise<void> {
  const pid = managed.child.pid;
  if (!pid) return;
  function signalGroup(signal: NodeJS.Signals | 0): boolean {
    try { process.kill(-pid!, signal); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  }
  if (!signalGroup("SIGTERM")) return;
  const deadline = Date.now() + 6_000;
  while (signalGroup(0) && Date.now() < deadline) await delay(100);
  // pnpm may exit before its grandchildren. Check the whole group, not only the wrapper.
  if (signalGroup(0)) signalGroup("SIGKILL");
  await managed.exited;
}

export async function waitUntil(check: () => Promise<boolean>, description: string, processes: ManagedProcess[], signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    for (const process of processes) if (process.failure) throw new Error(process.failure);
    if (await check()) return;
    await delay(250, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description}. Check the service output above.`);
}
