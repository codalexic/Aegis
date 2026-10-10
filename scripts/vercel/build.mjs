import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = new URL("../../.vercel/output/", import.meta.url);
const fn = new URL("functions/api/handler.func/", output);
execFileSync(process.execPath, ["apps/web/scripts/check-api-paths.mjs"], { cwd: root, stdio: "inherit" });
await rm(output, { recursive: true, force: true });
execFileSync("pnpm", ["--filter", "web", "build"], {
  cwd: root, stdio: "inherit", env: { ...process.env, AEGIS_ENV: "devnet" },
});
await mkdir(fn, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/vercel/handler.ts"],
  outfile: fileURLToPath(new URL("handler.mjs", fn)),
  bundle: true, platform: "node", format: "esm", target: "node24",
  metafile: true,
  // Bundled CommonJS dependencies still require Node builtins. Never inline env values.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const __filename = import.meta.filename; const __dirname = import.meta.dirname;' },
  plugins: [{
    name: "public-deployment",
    setup(build) {
      // The shared SDK's default deployment is localnet; this artifact is devnet only.
      build.onResolve({ filter: /(^|\/)deployments\/localnet\.json$/ }, () => ({
        path: fileURLToPath(new URL("../../deployments/devnet.json", import.meta.url)),
      }));
    },
  }, {
    name: "optional-node-fetch-encoding",
    setup(build) {
      // node-fetch catches this missing optional charset decoder today. Preserve that
      // behavior inside the bundle; JSON RPC never uses its textConverted() method.
      build.onResolve({ filter: /^encoding$/ }, () => ({ path: "encoding", namespace: "optional" }));
      build.onLoad({ filter: /.*/, namespace: "optional" }, () => ({ contents: 'throw new Error("Optional charset decoder is not installed");' }));
    },
  }],
});
for (const artifact of Object.values(result.metafile.outputs)) {
  for (const dependency of artifact.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`Unbundled dependency: ${dependency.path}`);
  }
}
for (const input of Object.keys(result.metafile.inputs)) {
  if (/(^|\/)\.keys\/|(^|\/)\.env($|\.)|(^|\/)deployments\/localnet\.json$/.test(input)) {
    throw new Error("Private or localnet input in public function");
  }
}
await writeFile(new URL(".vc-config.json", fn), JSON.stringify({
  runtime: "nodejs24.x", handler: "handler.mjs", launcherType: "Nodejs", maxDuration: 180,
}, null, 2) + "\n");
await cp(new URL("../../apps/web/dist/", import.meta.url), new URL("static/", output), { recursive: true });
await cp(new URL("config.json", import.meta.url), new URL("config.json", output));
console.log("PASS: Vercel Build Output API v3; devnet static site and one bundled Node 24 ESM function.");
