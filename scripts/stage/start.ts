import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needsBuild, requireFreePort, startProcess, stopProcess, waitUntil, type ManagedProcess } from "./support";

const root = fileURLToPath(new URL("../../", import.meta.url));
const url = "http://127.0.0.1:5173/";

async function main() {
  const started = Date.now();
  const controller = new AbortController();
  const processes: ManagedProcess[] = [];
  const stop = () => controller.abort();
  const interrupted = new Promise<undefined>((resolve) => controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    // Check before building or resetting a chain. Do not stop another terminal's services.
    for (const port of [8899, 5173, 8900, 9900]) await requireFreePort(port);
    if (await needsBuild(root)) {
      controller.signal.throwIfAborted();
      console.log("Building missing or outdated programs...");
      const build = startProcess(root, "Anchor build", "anchor", ["build"]);
      processes.push(build);
      await Promise.race([build.exited, interrupted]);
      controller.signal.throwIfAborted();
      if (build.child.exitCode !== 0) throw new Error(build.failure);
    } else console.log("Programs are up to date; skipping anchor build.");

    controller.signal.throwIfAborted();
    // Run the same entry points as localnet/dev without pnpm lifecycle errors on normal shutdown.
    const localnet = startProcess(root, "Localnet", "pnpm", ["exec", "tsx", "scripts/localnet/start.ts"]);
    processes.push(localnet);
    let seeded = false;
    // RPC health alone becomes true before mints, balances and the deployment file are ready.
    const lines = createInterface({ input: localnet.child.stdout! });
    lines.on("line", (line) => { if (line.startsWith("Wrote deployments/localnet.json (public addresses only).")) seeded = true; });
    try {
      await waitUntil(async () => {
        if (!seeded) return false;
        try {
          const response = await fetch("http://127.0.0.1:8899", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }), signal: AbortSignal.timeout(1_000) });
          return response.ok && (await response.json()).result === "ok";
        } catch { return false; }
      }, "seeded localnet", [localnet], controller.signal);
    } finally { lines.close(); }

    controller.signal.throwIfAborted();
    const dashboard = startProcess(join(root, "apps/web"), "Dashboard", "pnpm",
      ["exec", "vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort", "--logLevel", "error"], { AEGIS_ENV: "localnet" });
    processes.push(dashboard);
    await waitUntil(async () => {
      try {
        const response = await fetch(`${url}api/localnet`, { signal: AbortSignal.timeout(1_000) });
        return response.ok && (await response.json()).environment === "localnet";
      } catch { return false; }
    }, "dashboard", [localnet, dashboard], controller.signal);
    console.log(`\nDashboard ready: ${url} (${((Date.now() - started) / 1000).toFixed(1)}s). Ctrl+C stops the demo.`);
    const failure = await Promise.race([localnet.exited, dashboard.exited, interrupted]);
    if (!controller.signal.aborted) throw new Error(failure ?? "Demo stopped unexpectedly.");
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (processes.length) {
      console.log("Stopping demo services...");
      await Promise.all(processes.map(stopProcess));
      console.log("Demo services stopped.");
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo startup failed.");
  process.exitCode = 1;
});
