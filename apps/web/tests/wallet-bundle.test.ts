import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Keypair, MessageV0, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { build } from "vite";
import { expect, it } from "vitest";
import { walletVerifyPlugin } from "../build/wallet-verify";

it("bundles Noble verification without signing APIs and verifies without WebCrypto", async () => {
  const require = createRequire(new URL("../../../packages/sdk/package.json", import.meta.url));
  const noble = require.resolve("@noble/curves/ed25519").replace(/\/ed25519\.js$/, "/esm/ed25519.js");
  const result = await build({
    configFile: false, logLevel: "silent",
    plugins: [walletVerifyPlugin(), {
      name: "verifier-test-entry",
      resolveId(id) { if (id === "virtual:verifier") return id; },
      load(id) { if (id === "virtual:verifier") return `export { ed25519 } from ${JSON.stringify(noble)};`; },
    }],
    build: {
      write: false, target: "es2022", minify: true,
      rolldownOptions: { input: "virtual:verifier", preserveEntrySignatures: "strict", output: { name: "WalletVerifier", format: "iife" } },
    },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one browser bundle");
  const chunk = result.output.find((item) => item.type === "chunk")!;
  expect(chunk.code).not.toMatch(/secretKey|randomSecretKey|hashed private key/);
  const { ed25519 } = runInNewContext(`${chunk.code}; WalletVerifier`, { Uint8Array, Uint32Array, crypto: undefined });
  for (const api of ["sign", "keygen", "getPublicKey", "utils"]) expect(ed25519).not.toHaveProperty(api);

  const owner = Keypair.generate();
  const message = MessageV0.compile({ payerKey: owner.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [] });
  const signed = new VersionedTransaction(message);
  signed.sign([owner]);
  const verify = (bytes: Uint8Array) => ed25519.verify(signed.signatures[0], bytes, owner.publicKey.toBytes(), { zip215: false });
  expect(verify(message.serialize())).toBe(true);
  const altered = message.serialize(); altered[altered.length - 1] ^= 1;
  expect(verify(altered)).toBe(false);
  signed.signatures[0][0] ^= 1;
  expect(verify(message.serialize())).toBe(false);
});
