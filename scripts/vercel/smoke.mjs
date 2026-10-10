import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[2] !== "--isolated") {
  const isolated = await mkdtemp(join(tmpdir(), "aegis-vercel-"));
  try {
    await cp(new URL("../../.vercel/output/", import.meta.url), isolated, { recursive: true });
    await cp(new URL(import.meta.url), join(isolated, "smoke.mjs"));
    execFileSync(process.execPath, ["smoke.mjs", "--isolated"], {
      cwd: isolated, stdio: "inherit", timeout: 30_000,
      // No repo loaders, NODE_PATH, signing keys, model key, or inherited .env.
      env: { AEGIS_PUBLIC_ORIGIN: "https://aegis.example" },
    });
  } finally { await rm(isolated, { recursive: true, force: true }); }
} else {
  assert.equal(process.versions.node.split(".")[0], "24");
  const config = JSON.parse(await readFile("config.json", "utf8"));
  assert.equal(config.version, 3);
  assert.deepEqual(await readdir("functions"), ["api"]);
  assert.deepEqual(await readdir("functions/api"), ["handler.func"]);
  const directory = "functions/api/handler.func";
  const runtime = JSON.parse(await readFile(`${directory}/.vc-config.json`, "utf8"));
  assert.deepEqual(runtime, { runtime: "nodejs24.x", handler: "handler.mjs", launcherType: "Nodejs", maxDuration: 180 });
  assert.deepEqual((await readdir(directory)).sort(), [".vc-config.json", "handler.mjs"]);
  const { default: handler } = await import(pathToFileURL(join(process.cwd(), directory, runtime.handler)));
  assert.equal(typeof handler, "function");
  const api = config.routes.find((route) => route.dest?.startsWith("/api/handler?"));
  const discovery = config.routes.find((route) => route.headers);
  assert.equal(discovery.continue, true);
  assert(new RegExp(discovery.src).test("/actions.json"));
  assert(!new RegExp(discovery.src).test("/actionsXjson"));
  const pages = config.routes.find((route) => route.dest === "/index.html");
  assert(new RegExp(pages.src).test("/actions/create"));
  assert(new RegExp(pages.src).test("/actions"));
  assert(!new RegExp(pages.src).test("/unknown"));
  assert(config.routes.some((route) => route.handle === "filesystem"));
  assert((await readFile("static/index.html", "utf8")).includes("<html"));
  assert((await readFile("static/aegis.png")).length > 0);
  assert(JSON.parse(await readFile("static/actions.json", "utf8")).rules.length > 0);

  const server = createServer((request, response) => {
    // Apply the emitted API rewrite, preserving the caller's query string.
    const incoming = new URL(request.url, "https://aegis.example");
    const destination = new URL(incoming.pathname.replace(new RegExp(api.src), api.dest), incoming);
    for (const [key, value] of incoming.searchParams) destination.searchParams.append(key, value);
    request.url = destination.pathname + destination.search;
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500; response.end(error.message);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  function cors(response) {
    for (const key of ["Access-Control-Allow-Origin", "X-Blockchain-Ids", "X-Action-Version"]) {
      assert.equal(response.headers.get(key), discovery.headers[key], key);
    }
    assert.equal(response.headers.get("Access-Control-Allow-Headers"),
      discovery.headers["Access-Control-Allow-Headers"] + ", X-Accept-Action-Version, X-Accept-Blockchain-Ids");
    assert.deepEqual(response.headers.get("Access-Control-Expose-Headers").split(/,\s*/).sort(),
      discovery.headers["Access-Control-Expose-Headers"].split(/,\s*/).sort());
    for (const method of ["GET", "POST", "OPTIONS"]) assert(response.headers.get("Access-Control-Allow-Methods").includes(method));
  }
  try {
    for (const action of ["create", "fund", "revoke", "withdraw"]) {
      const response = await fetch(`${base}/api/actions/${action}`);
      assert.equal(response.status, 200); cors(response);
      const body = await response.json();
      assert.equal(body.type, "action");
      assert.equal(body.icon, "https://aegis.example/aegis.png");
      assert(body.links.actions[0].href.startsWith(`/api/actions/${action}`));
      console.log(`PASS: GET /api/actions/${action} -> 200 with CORS/devnet Action headers`);
    }
    const info = await fetch(`${base}/api/agent/info`);
    assert.equal(info.status, 200);
    const body = await info.json();
    assert.equal(body.environment, "devnet"); assert.equal(body.model, null);
    const deployment = await fetch(`${base}/api/deployment`);
    assert.equal(deployment.status, 200);
    assert.equal(body.agent, (await deployment.json()).agent);
    console.log("PASS: GET /api/agent/info -> 200, model=null without GEMINI_API_KEY");
    const options = await fetch(`${base}/api/actions/create`, { method: "OPTIONS" });
    assert.equal(options.status, 204); cors(options);
    const invalid = await fetch(`${base}/api/actions/create?cap=1&cap=2`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: body.agent }),
    });
    assert.equal(invalid.status, 400); cors(invalid);
    for (const path of ["/api/owner/create", "/api/unknown"]) assert.equal((await fetch(`${base}${path}`)).status, 404);
    console.log("PASS: isolated Node 24 function; preflight, query validation, unavailable owner routes, static files and routing config");
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
