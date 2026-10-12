import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createPublicHandler } from "../server/public-api";
import { devnetClient, environmentSigner } from "../server/devnet-service";
import { createMockContext } from "../../../scripts/agent/context";

vi.mock("../server/devnet-service", async (original) => ({ ...await original<object>(),
  devnetClient: vi.fn(), environmentSigner: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["normal", "injected"])("the public Vercel handler completes %s automatically through a Gemini outage", async (scenario) => {
  vi.useFakeTimers();
  const context = await createMockContext();
  vi.mocked(devnetClient).mockReturnValue(context.client as unknown as ReturnType<typeof devnetClient>);
  vi.mocked(environmentSigner).mockReturnValue(context.agent);
  const fetcher = vi.fn(async () => new Response("private provider details", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const swap = vi.spyOn(context.client, "swap");
  const handler = createPublicHandler({ AEGIS_PUBLIC_ORIGIN: "https://aegis.example", GEMINI_API_KEY: "test-only-credential" });
  const request = {
    url: `/api/agent/${scenario}`, method: "POST",
    headers: { origin: "https://aegis.example", "content-type": "application/json", "x-aegis-agent": "devnet", "x-vercel-forwarded-for": "203.0.113.1" },
    body: { live: true, vault: context.vault.toBase58() },
  } as unknown as IncomingMessage;
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const pending = handler(request, response as unknown as ServerResponse);
  await vi.runAllTimersAsync(); await pending;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(swap).toHaveBeenCalledTimes(1);
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.anything());
  const body = JSON.parse(response.end.mock.calls[0][0]);
  expect(body.steps).toContainEqual(expect.objectContaining({ type: "model_reply", source: "scripted" }));
  expect(body.steps).toContainEqual({ type: "notice", code: "live_fallback", message: "Live AI was busy, so a recorded reply was used." });
  expect(body.steps).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining(scenario === "normal" ? { ok: true } : { ok: false, error: "CapExceeded" }) }));
  expect(response.end.mock.calls[0][0]).not.toMatch(/HTTP|503|private provider|test-only-credential/);
});
