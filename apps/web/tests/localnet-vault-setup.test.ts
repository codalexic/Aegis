import { PublicKey } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
import deployment from "../../../deployments/localnet.json";
import { connectDashboard } from "../src/client";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("sends selected setup and withdrawal values to the localnet owner API as exact strings", async () => {
  const vault = new PublicKey(deployment.pool), recipient = new PublicKey(deployment.inputMint);
  const fetcher = vi.fn(async (url: string) => url === "/api/localnet"
    ? Response.json({ ...deployment, lastVault: vault.toBase58() })
    : Response.json({ ok: true, signature: "local-signature", vault: vault.toBase58() }));
  vi.stubGlobal("fetch", fetcher);
  const connection = await connectDashboard("localnet");
  const result = await connection.newDemo(undefined, { maxTradeRaw: 12_345_678n, budgetRaw: 234_567_891n,
    durationSeconds: 86400n, withdrawAddresses: [recipient] });
  expect(result.vault).toEqual(vault);
  expect(fetcher).toHaveBeenLastCalledWith("/api/owner/new-demo", expect.objectContaining({ body: JSON.stringify({
    maxTradeRaw: "12345678", budgetRaw: "234567891", durationSeconds: "86400", withdrawAddresses: [recipient.toBase58()],
  }) }));
  await connection.withdrawTo(vault, recipient, recipient, 9_007_199_254_740_993n);
  expect(fetcher).toHaveBeenLastCalledWith("/api/owner/withdraw", expect.objectContaining({ body: JSON.stringify({
    mint: recipient.toBase58(), amountRaw: "9007199254740993", recipient: recipient.toBase58(),
  }) }));
  await connection.withdraw(vault, recipient, 1n);
  expect(fetcher).toHaveBeenLastCalledWith("/api/owner/withdraw", expect.objectContaining({ body: JSON.stringify({
    mint: recipient.toBase58(), amountRaw: "1",
  }) }));
});
