import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKCHAIN_IDS } from "@solana/actions";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import deployment from "../../../deployments/localnet.json";
import { actionsMiddleware, type ActionsConfig } from "../api/actions/routes";
import { ActionsService, ActionError, positiveAmount } from "../api/actions/service";
import { instructionCoder, fixture as vaultFixture, info } from "../../../packages/sdk/tests/anchor-helpers";

let server: Server, url: string, config: ActionsConfig, service: ActionsService, connection: Connection;
const owner = Keypair.generate().publicKey;
beforeEach(async () => {
  // The Actions service takes cluster/RPC configuration independently of dashboard mode.
  const selected = { ...deployment, environment: "testnet", rpcUrl: "https://rpc.example.invalid", wsUrl: "wss://rpc.example.invalid" };
  connection = new Connection(selected.rpcUrl, "confirmed"); service = new ActionsService(selected, connection);
  config = { service, origin: "https://aegis.example", chainId: BLOCKCHAIN_IDS.testnet };
  const middleware = actionsMiddleware(async () => config);
  server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const post = (action: string, body: unknown = { account: owner.toBase58() }, method = "POST") => fetch(`${url}/api/actions/${action}`, {
  method, headers: { "content-type": "application/json", origin: "https://dial.to" }, body: method === "POST" ? JSON.stringify(body) : undefined,
});
function cors(response: Response) {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("x-blockchain-ids")).toBe(config.chainId);
  expect(response.headers.get("x-action-version")).toBe("2.4.1");
  expect(response.headers.get("access-control-expose-headers")).toContain("X-Blockchain-Ids");
}

describe("Solana Actions protocol and validation", () => {
  it.each(["create", "fund", "revoke", "withdraw"])("GET and OPTIONS %s are cross-origin and use the configured chain and canonical icon URL", async (action) => {
    const response = await fetch(`${url}/api/actions/${action}`); cors(response);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ type: "action", icon: "https://aegis.example/aegis.png", description: expect.stringContaining("testnet") });
    for (const parameter of data.links.actions[0].parameters ?? []) {
      expect(new RegExp(parameter.pattern).test("1.000001")).toBe(true);
      expect(new RegExp(parameter.pattern).test("1e3")).toBe(false);
    }
    const options = await post(action, undefined, "OPTIONS"); cors(options); expect(options.status).toBe(204);
  });
  it("uses the standard devnet chain ID when configured for devnet", async () => {
    config.chainId = BLOCKCHAIN_IDS.devnet;
    const response = await fetch(`${url}/actions.json`); cors(response);
    expect(response.headers.get("x-blockchain-ids")).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });
  it.each([
    ["create", {}], ["create", { account: "invalid" }], ["create", { account: PublicKey.default.toBase58() }],
    ["create", { account: owner.toBase58(), rpcUrl: "https://attacker.invalid" }],
    ["create", { account: owner.toBase58(), type: "message" }], ["create", { account: owner.toBase58(), data: [] }],
    ["revoke?vault=someone-else", { account: owner.toBase58() }], ["withdraw?destination=attacker", { account: owner.toBase58() }],
    ["fund?amount=20&amount=40", { account: owner.toBase58() }], ["fund?amount=20", { account: owner.toBase58(), data: { amount: "40" } }],
    ["create?__proto__=invalid", { account: owner.toBase58() }],
  ])("rejects malformed POST %s / %j before building", async (action, body) => {
    const build = vi.spyOn(service, "build");
    const response = await post(action as string, body); cors(response);
    expect(response.status).toBe(400); expect((await response.json()).message).toBeTypeOf("string");
    expect(build).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "NaN", "1e3", "1.0000001", "18446744073709.551616", 20, null])("rejects invalid cap %j before RPC", async (cap) => {
    const getSlot = vi.spyOn(connection, "getSlot");
    const response = await post("create", { account: owner.toBase58(), data: { cap } }); cors(response);
    expect(response.status).toBe(400); expect(getSlot).not.toHaveBeenCalled();
  });
  it.each([{}, { amount: "0" }, { amount: 1 }, { amount: "-1" }])("rejects invalid funding %j before looking up a vault", async (data) => {
    const latest = vi.spyOn(service, "latestVault");
    const response = await post("fund", { account: owner.toBase58(), data }); cors(response);
    expect(response.status).toBe(400); expect(latest).not.toHaveBeenCalled();
  });
  it("rejects cap above budget and owner equal to server agent", async () => {
    const getSlot = vi.spyOn(connection, "getSlot");
    expect((await post("create?cap=101&budget=100")).status).toBe(400);
    expect((await post("create", { account: deployment.agent })).status).toBe(400);
    expect(getSlot).not.toHaveBeenCalled();
  });
  it("encodes precise u64 policy values without signing or sending, even with Actions identity configuration present", async () => {
    vi.stubEnv("ACTION_IDENTITY_SECRET", JSON.stringify(Array.from(Keypair.generate().secretKey)));
    vi.spyOn(connection, "getSlot").mockResolvedValue(2);
    vi.spyOn(connection, "getBlockTime").mockResolvedValue(1_800_000_000);
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 });
    const send = vi.spyOn(connection, "sendRawTransaction");
    const response = await post("create", { account: owner.toBase58(), type: "transaction", data: { cap: "9007199254.740993", budget: "18446744073709.551615" } }); cors(response);
    const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200);
    const transaction = VersionedTransaction.deserialize(Buffer.from(result.transaction, "base64"));
    const instructions = TransactionMessage.decompile(transaction.message).instructions;
    expect(instructions).toHaveLength(1); // No injected Action identity or memo.
    const decoded = instructionCoder.decode(instructions[0].data)!;
    expect(decoded.name).toBe("create_vault");
    const args = decoded.data as Record<string, { toString(): string }>;
    expect(args.max_trade_raw.toString()).toBe("9007199254740993");
    expect(args.budget_raw.toString()).toBe("18446744073709551615");
    expect(args.expiry_unix.toString()).toBe("1800003600");
    expect(transaction.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it("returns controlled JSON errors with Action headers for missing vaults, RPC errors, methods and routes", async () => {
    vi.spyOn(service, "latestVault").mockResolvedValue(null);
    const missing = await post("fund?amount=20"); cors(missing); expect(missing.status).toBe(404);
    expect((await missing.json()).message).toContain("No confirmed vault");
    vi.spyOn(service, "build").mockRejectedValue(new Error("private RPC configuration"));
    const failed = await post("create"); cors(failed); expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private RPC");
    const unknown = await post("unknown"); cors(unknown); expect(unknown.status).toBe(404);
    const method = await post("create", undefined, "DELETE"); cors(method); expect(method.status).toBe(405);
    const wrongType = await fetch(`${url}/api/actions/create`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }); cors(wrongType); expect(wrongType.status).toBe(415);
    const tooLarge = await post("create", { account: "a".repeat(5000) }); cors(tooLarge); expect(tooLarge.status).toBe(413);
  });
});

describe("latest-vault discovery and account validation", () => {
  it("preserves decimal amounts above JS precision", () => expect(positiveAmount("9007199254.740993", "Amount")).toBe(9_007_199_254_740_993n));
  it("paginates confirmed history and refuses unavailable transaction history", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ signature: String(i), slot: i, err: { InstructionError: [0, "InvalidArgument"] }, memo: null }));
    const signatures = vi.spyOn(connection, "getSignaturesForAddress").mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    expect(await service.latestVault(owner)).toBeNull();
    expect(signatures.mock.calls[1]).toEqual([owner, { before: "99", limit: 100 }, "confirmed"]);
    signatures.mockResolvedValue([{ ...rows[0], err: null }]);
    const getTransaction = vi.spyOn(connection, "getTransaction").mockResolvedValue(null);
    await expect(service.latestVault(owner)).rejects.toThrow("history is unavailable");
    expect(getTransaction).toHaveBeenCalledWith("0", { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  });
  it("rejects a vault belonging to another owner and malformed program accounts", async () => {
    const fixture = await vaultFixture();
    const get = vi.spyOn(connection, "getAccountInfo").mockResolvedValue(fixture.vaultInfo);
    await expect(service.readVault(fixture.vault, owner)).rejects.toThrow("do not match");
    get.mockResolvedValue(info(fixture.vaultInfo.data, owner));
    await expect(service.readVault(fixture.vault, fixture.owner.publicKey)).rejects.toThrow("do not match");
    get.mockResolvedValue(null);
    await expect(service.readVault(fixture.vault, fixture.owner.publicKey)).rejects.toBeInstanceOf(ActionError);
  });
});
