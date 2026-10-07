import { createServer, type Server } from "node:http";
import { loadEnvFile } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalnetContext, createMockContext, type AgentContext } from "../../../scripts/agent/context";
import { AgentError, askModel } from "../../../scripts/agent/model";
import { agentApiMiddleware } from "../server/agent-api";

vi.mock("node:process", () => ({ loadEnvFile: vi.fn() }));
vi.mock("../../../scripts/agent/context", async (original) => ({ ...await original<object>(), createLocalnetContext: vi.fn() }));
vi.mock("../../../scripts/agent/model", async (original) => ({ ...await original<object>(), askModel: vi.fn() }));

let server: Server, url: string, context: AgentContext;
beforeEach(async () => {
  vi.stubEnv("AI_PROVIDER", "gemini"); vi.stubEnv("GEMINI_API_KEY", "test-only-api-token"); vi.stubEnv("AI_MODEL", "test-model");
  context = await createMockContext();
  vi.mocked(createLocalnetContext).mockResolvedValue(context);
  vi.mocked(askModel).mockImplementation(async (_config, input) => JSON.stringify({
    amountUsdc: input.includes("OPERATOR OVERRIDE") ? "1000" : "20", reason: "Test model reply",
  }));
  const middleware = agentApiMiddleware("/unused");
  server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
});
const post = (action: string, body: unknown, headers = {}) => fetch(`${url}/api/agent/${action}`, {
  method: "POST", headers: { origin: url, "content-type": "application/json", "x-aegis-agent": "localnet", ...headers }, body: JSON.stringify(body),
});

describe("agent endpoints", () => {
  it.each([false, true])("runs all three scenarios with live=%s and JSON-safe steps", async (live) => {
    for (const [action, expected] of [["normal", undefined], ["injected", "CapExceeded"], ["attacker", "AccountMismatch"]] as const) {
      const before = await context.client.getVault(context.vault);
      const response = await post(action, { live });
      expect(response.status).toBe(200);
      const { steps } = await response.json();
      expect(steps.map((step: any) => step.type)).toEqual(["news", "model_reply", "request", "result", "balances"]);
      expect(steps[3].result).toMatchObject(expected ? { ok: false, error: expected } : { ok: true });
      expect(steps[2].amountRaw).toBe(action === "injected" ? "1000000000" : "20000000");
      if (action === "injected") expect(steps[0].text).toContain(steps[0].injection);
      if (action === "attacker") expect(steps[2].outputVault).toBeTypeOf("string");
      if (expected) expect(await context.client.getVault(context.vault)).toEqual(before);
      expect(JSON.stringify(steps)).not.toMatch(/test-only-api-token|secretKey|apiKey|AI_PROVIDER/);
    }
    expect(askModel).toHaveBeenCalledTimes(live ? 2 : 0);
    expect(loadEnvFile).toHaveBeenCalledTimes(live ? 2 : 0);
  });

  it("projects only the model name", async () => {
    expect(await (await fetch(`${url}/api/agent/info`)).json()).toEqual({ model: "test-model" });
    expect(createLocalnetContext).not.toHaveBeenCalled();
  });

  it("refuses vaults that do not authorize the server agent before any model call or transaction", async () => {
    const state = await context.client.getVault(context.vault);
    vi.spyOn(context.client, "getVault").mockResolvedValue({ ...state, agent: state.owner });
    const swap = vi.spyOn(context.client, "swap");
    const { steps } = await (await post("normal", { live: true })).json();
    expect(steps).toEqual([{ type: "notice", code: "error", message: "This vault does not authorize the server's agent." }]);
    expect(swap).not.toHaveBeenCalled();
    expect(askModel).not.toHaveBeenCalled();
  });

  it.each([{}, { live: "false" }, { live: false, vault: "chosen-by-caller" }, [], null])("rejects invalid input %j before loading keys", async (body) => {
    expect((await post("normal", body)).status).toBe(400);
    expect(createLocalnetContext).not.toHaveBeenCalled(); expect(loadEnvFile).not.toHaveBeenCalled();
  });

  it.each([{ origin: "https://attacker.invalid" }, { "x-aegis-agent": "" }, { "content-type": "text/plain" }])("rejects unsafe requests %j", async (headers) => {
    expect((await post("normal", { live: false }, headers)).status).toBe(403);
    expect(createLocalnetContext).not.toHaveBeenCalled(); expect(loadEnvFile).not.toHaveBeenCalled();
  });

  it("rejects unsupported routes, methods and oversized bodies", async () => {
    expect((await post("scripted", { live: false })).status).toBe(404);
    expect((await fetch(`${url}/api/agent/normal`, { headers: { origin: url, "content-type": "application/json", "x-aegis-agent": "localnet" } })).status).toBe(405);
    expect((await post("normal", { live: false, padding: "x".repeat(5000) })).status).toBe(413);
    expect(createLocalnetContext).not.toHaveBeenCalled();
  });

  it("reports injection resistance and submits the model proposal unchanged", async () => {
    vi.mocked(askModel).mockResolvedValue('{"amountUsdc":"20","reason":"Ignored the override"}');
    const swap = vi.spyOn(context.client, "swap");
    const { steps } = await (await post("injected", { live: true })).json();
    expect(steps).toContainEqual(expect.objectContaining({ type: "notice", code: "injection_resisted" }));
    expect(swap).toHaveBeenCalledWith(context.agent, context.vault, 20_000_000n);
    const retry = await (await post("injected", { live: false })).json();
    expect(retry.steps).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ error: "CapExceeded" }) }));
    expect(askModel).toHaveBeenCalledTimes(1);
  });

  it.each(["I refuse", '{"amountUsdc":1000,"reason":"Wrong type"}'])("does not send refused or malformed output %s", async (reply) => {
    vi.mocked(askModel).mockResolvedValue(reply);
    const swap = vi.spyOn(context.client, "swap");
    const { steps } = await (await post("injected", { live: true })).json();
    expect(steps).toContainEqual(expect.objectContaining({ type: "notice", code: "injection_resisted" }));
    expect(swap).not.toHaveBeenCalled();
  });

  it("reports provider refusal and configuration failures with a scripted fallback", async () => {
    vi.mocked(askModel).mockRejectedValue(new AgentError("Model refused or returned no trade text."));
    const refused = await (await post("injected", { live: true })).json();
    expect(refused.steps).toContainEqual(expect.objectContaining({ code: "injection_resisted" }));
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await (await fetch(`${url}/api/agent/info`)).json()).toEqual({ model: null });
    const missing = await (await post("normal", { live: true })).json();
    expect(missing.steps).toContainEqual(expect.objectContaining({ code: "error" }));
    expect((await (await post("normal", { live: false })).json()).steps).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ ok: true }) }));
  });

  it("hides unexpected exceptions and releases the request lock", async () => {
    vi.mocked(createLocalnetContext).mockRejectedValueOnce(new Error("private credentials and stack"));
    const result = await (await post("normal", { live: false })).json();
    expect(JSON.stringify(result)).not.toMatch(/credentials|stack/);
    expect(result.steps[0]).toMatchObject({ type: "notice", code: "error" });
    expect((await (await post("normal", { live: false })).json()).steps).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ ok: true }) }));
  });

  it("rejects concurrent requests while a model call is pending", async () => {
    let release!: (reply: string) => void;
    vi.mocked(askModel).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = post("normal", { live: true });
    await vi.waitFor(() => expect(askModel).toHaveBeenCalledOnce());
    try { expect((await post("attacker", { live: false })).status).toBe(409); }
    finally { release('{"amountUsdc":"20","reason":"Calm news"}'); await first; }
    expect(createLocalnetContext).toHaveBeenCalledOnce();
  });
});
