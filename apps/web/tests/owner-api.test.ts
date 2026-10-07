import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerApiMiddleware, requireDashboardRequest } from "../server/owner-api";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function request(overrides: Record<string, unknown> = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1", localPort: 5173 },
    headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "content-type": "application/json", "x-aegis-owner": "localnet", ...overrides },
  } as unknown as IncomingMessage;
}

describe("local owner signing boundary", () => {
  it("accepts only the dashboard's loopback JSON request", () => {
    expect(() => requireDashboardRequest(request(), true)).not.toThrow();
    expect(() => requireDashboardRequest(request({ host: "localhost:5173", origin: "http://localhost:5173" }), true)).not.toThrow();
  });

  it.each([
    { origin: "https://attacker.invalid" }, { origin: undefined }, { origin: "null" },
    { "x-aegis-owner": undefined }, { "content-type": "text/plain" },
    { host: "attacker.invalid:5173", origin: "http://attacker.invalid:5173" },
    { host: "localhost:9999", origin: "http://localhost:9999" },
  ])("rejects unsafe request headers %j before reading a key", (headers) => {
    expect(() => requireDashboardRequest(request(headers), true)).toThrow();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects non-loopback callers even with matching headers", () => {
    const input = request();
    Object.defineProperty(input.socket, "remoteAddress", { value: "192.0.2.1" });
    expect(() => requireDashboardRequest(input, true)).toThrow("Loopback");
  });

  it("rejects cross-origin HTTP writes without accessing any files", async () => {
    const middleware = ownerApiMiddleware("/unused");
    const server: Server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/owner/fund`, {
        method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json", "x-aegis-owner": "localnet" }, body: "{}",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Same-origin dashboard JSON requests only." });
      expect(readFile).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
