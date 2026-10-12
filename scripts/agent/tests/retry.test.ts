import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentError, askModel, LIVE_FALLBACK_NOTE, ModelHttpError, ModelUnavailableError } from "../model";
import { runAgent, type Step } from "../run";
import { createMockContext } from "../context";

const config = { provider: "gemini" as const, model: "test", apiKey: "test-credential" };
const reply = '{"amountUsdc":"20","reason":"Calm"}';
const success = async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: reply }] } }] });
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([429, 500, 502, 503, 504])("retries Gemini %s with exponential backoff and jitter", async (status) => {
  const send = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response("busy", { status }))
    .mockImplementationOnce(async () => new Response("busy", { status })).mockImplementation(success);
  const pending = askModel(config, "input", send);
  await vi.advanceTimersByTimeAsync(524); expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(924); expect(send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe(reply);
  expect(send).toHaveBeenCalledTimes(3);
});

it.each(["UNAVAILABLE", "overloaded", "RESOURCE_EXHAUSTED"])("retries transient Gemini payload %s", async (status) => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { status } })).mockImplementation(success);
  const pending = askModel(config, "input", send);
  await vi.runAllTimersAsync();
  expect(await pending).toBe(reply); expect(send).toHaveBeenCalledTimes(2);
});

it.each([new TypeError("fetch failed"), new DOMException("timeout", "TimeoutError")])("retries a network failure without exposing its details", async (error) => {
  const send = vi.fn<typeof fetch>().mockRejectedValueOnce(error).mockImplementation(success);
  const pending = askModel(config, "input", send);
  await vi.runAllTimersAsync();
  expect(await pending).toBe(reply); expect(send).toHaveBeenCalledTimes(2);
});

it("bounds even hung fetches and response bodies to twelve seconds and aborts every attempt", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
  const started = Date.now();
  const assertion = expect(askModel(config, "input", send)).rejects.toBeInstanceOf(ModelUnavailableError);
  await vi.runAllTimersAsync(); await assertion;
  expect(Date.now() - started).toBeLessThanOrEqual(12_000);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true);
});

it("also bounds an error response body which never finishes", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => ({
    ok: false, status: 503, text: () => new Promise(() => {}),
  }) as Response);
  const started = Date.now();
  const assertion = expect(askModel(config, "input", send)).rejects.toBeInstanceOf(ModelUnavailableError);
  await vi.runAllTimersAsync(); await assertion;
  expect(Date.now() - started).toBeLessThanOrEqual(12_000);
});

it.each([400, 401, 403])("does not retry Gemini %s configuration failures", async (status) => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("private details", { status }));
  await expect(askModel(config, "input", send)).rejects.toBeInstanceOf(ModelHttpError);
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(["normal", "injected"] as const)("automatically executes only the recorded %s scenario after exhausted Gemini retries", async (scenario) => {
  const context = await createMockContext(), steps: Step[] = [];
  const swap = vi.spyOn(context.client, "swap");
  const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("private diagnostics", { status: 503 }));
  const pending = runAgent(context, scenario, (input) => askModel(config, input, send), (_message, step) => { if (step) steps.push(step); });
  await vi.runAllTimersAsync();
  expect(await pending).toBe(true);
  expect(send).toHaveBeenCalledTimes(3);
  expect(swap).toHaveBeenCalledExactlyOnceWith(context.agent, context.vault, scenario === "normal" ? 20_000_000n : 1_000_000_000n);
  expect(steps).toContainEqual({ type: "notice", code: "live_fallback", message: LIVE_FALLBACK_NOTE });
  expect(steps).toContainEqual(expect.objectContaining({ type: "model_reply", source: "scripted" }));
  expect(JSON.stringify(steps)).not.toMatch(/HTTP|503|private diagnostics/);
  expect((await context.client.getVault(context.vault)).spentRaw).toBe(scenario === "normal" ? 20_000_000n : 0n);
});

it("does not disguise a model refusal as a transient outage", async () => {
  const context = await createMockContext(), swap = vi.spyOn(context.client, "swap");
  await expect(runAgent(context, "normal", async () => { throw new AgentError("Model refused"); }, vi.fn())).rejects.toThrow("Model refused");
  expect(swap).not.toHaveBeenCalled();
});

it("keeps a confirmed result when a subsequent balance read fails", async () => {
  const context = await createMockContext(), steps: Step[] = [];
  const state = await context.client.getVault(context.vault);
  vi.spyOn(context.client, "getVault").mockResolvedValueOnce(state).mockRejectedValue(new Error("RPC unavailable"));
  expect(await runAgent(context, "normal", async () => reply, (_message, step) => { if (step) steps.push(step); })).toBe(true);
  expect(steps).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ ok: true }) }));
  expect(steps).toContainEqual(expect.objectContaining({ type: "notice", code: "refresh_pending" }));
});
