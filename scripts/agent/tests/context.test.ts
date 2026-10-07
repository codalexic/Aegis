import { readFile } from "node:fs/promises";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createLocalnetContext, createChainContext, loadLocalnetAgent, vaultAddress } from "../context";
import { AnchorAegisClient, DEVNET_RPC_URL, DEVNET_WS_URL, type VaultState } from "../../../packages/sdk/src/index";
import deployment from "../../../deployments/localnet.json";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(readFile).mockReset(); });
const address = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

describe("agent identity and vault selection", () => {
  it("loads only the devnet agent key and an explicit vault in devnet mode", async () => {
    const devnet = { ...deployment, environment: "devnet", rpcUrl: DEVNET_RPC_URL, wsUrl: DEVNET_WS_URL };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(devnet)).mockResolvedValueOnce(JSON.stringify(Array(64).fill(0)));
    vi.spyOn(Keypair, "fromSecretKey").mockReturnValue({ publicKey: new PublicKey(deployment.agent) } as Keypair);
    vi.spyOn(AnchorAegisClient.prototype, "getVault").mockResolvedValue({ address: new PublicKey(address) } as VaultState);
    const context = await createChainContext("devnet", address);
    expect(context.client.environment).toBe("devnet");
    expect(context.vault.toBase58()).toBe(address);
    expect(vi.mocked(readFile).mock.calls.map((call) => String(call[0]).split("/").slice(-2).join("/")))
      .toEqual(["deployments/devnet.json", ".keys/devnet-agent.json"]);
  });
  it("rejects a cross-environment deployment before reading a signing key", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(deployment));
    await expect(createChainContext("devnet", address)).rejects.toThrow("environment mismatch");
    expect(readFile).toHaveBeenCalledTimes(1);
  });
  it("fails clearly while the devnet deployment is not ready", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("missing"));
    await expect(createChainContext("devnet", address)).rejects.toThrow("run pnpm devnet:deploy first");
  });
  it("connects the real client with only the agent key and the recorded vault", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ ...deployment, lastVault: address }))
      .mockResolvedValueOnce(JSON.stringify(Array(64).fill(0)));
    vi.spyOn(Keypair, "fromSecretKey").mockReturnValue({ publicKey: new PublicKey(deployment.agent) } as Keypair);
    vi.spyOn(AnchorAegisClient.prototype, "getVault").mockResolvedValue({ address: new PublicKey(address) } as VaultState);
    const context = await createLocalnetContext();
    expect(context.client).toBeInstanceOf(AnchorAegisClient);
    expect(context.vault.toBase58()).toBe(address);
    expect(vi.mocked(readFile).mock.calls.map((call) => String(call[0]).split("/").slice(-2).join("/")))
      .toEqual(["deployments/localnet.json", ".keys/agent.json"]);
  });
  it("mock setup never reads a key file and only accepts its own vault address", async () => {
    const first = await createMockContext();
    const second = await createMockContext(first.vault.toBase58());
    expect(second.vault.equals(first.vault)).toBe(true);
    expect(() => first.agent.secretKey).toThrow("cannot sign");
    expect(readFile).not.toHaveBeenCalled();
    await expect(createMockContext(address)).rejects.toThrow("not in this mock session");
  });

  it("uses explicit --vault and reads only .keys/agent.json", async () => {
    // Dummy bytes are never real credentials; key validation is stubbed for this I/O test.
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(Array(64).fill(0)));
    const parse = vi.spyOn(Keypair, "fromSecretKey").mockReturnValue({ publicKey: new PublicKey(address) } as Keypair);
    const result = await loadLocalnetAgent(address);
    expect(result.vault.toBase58()).toBe(address);
    expect(parse).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(readFile).mock.calls[0][0])).toMatch(/\/\.keys\/agent\.json$/);
  });

  it.each([{ lastVault: address }, { vaults: [new PublicKey(new Uint8Array(32).fill(8)).toBase58(), address] }])(
    "uses the last recorded vault when --vault is absent", async (deployment) => {
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(deployment)).mockResolvedValueOnce(JSON.stringify(Array(64).fill(0)));
      vi.spyOn(Keypair, "fromSecretKey").mockReturnValue({ publicKey: new PublicKey(address) } as Keypair);
      expect((await loadLocalnetAgent()).vault.toBase58()).toBe(address);
      expect(vi.mocked(readFile).mock.calls.map((call) => String(call[0]).split("/").slice(-2).join("/")))
        .toEqual(["deployments/localnet.json", ".keys/agent.json"]);
    },
  );

  it("gives a useful error for a missing vault", async () => {
    vi.mocked(readFile).mockResolvedValue("{}");
    await expect(loadLocalnetAgent()).rejects.toThrow("--vault");
    expect(readFile).toHaveBeenCalledOnce();
    expect(() => vaultAddress("invalid address")).toThrow("valid --vault");
  });

  it("never includes invalid key-file contents in an error", async () => {
    vi.mocked(readFile).mockResolvedValue("private-file-content-not-json");
    await expect(loadLocalnetAgent(address)).rejects.toThrow("Cannot load .keys/agent.json; run pnpm localnet to create a valid test agent key.");
  });
});
