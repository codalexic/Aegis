import type { Plugin } from "vite";

/** Keep Noble's verifier unchanged, but let the browser build drop signing APIs. */
export function walletVerifyPlugin(): Plugin {
  return {
    name: "aegis-wallet-verify-only",
    enforce: "pre",
    transform(source, id) {
      if (!id.endsWith("/@noble/curves/esm/abstract/edwards.js")) return;
      // Noble 1.9.7 returns all APIs from one factory, preventing tree shaking.
      // Fail closed if an upgrade changes that factory rather than silently
      // shipping local signing APIs. No verification or curve arithmetic changes.
      const exports = `return Object.freeze({
        keygen,
        getPublicKey,
        sign,
        verify,
        utils,
        Point,
        lengths,
    });`;
      const privateLength = "        secretKey: _size,";
      if (!source.includes(exports) || !source.includes(privateLength)) {
        throw new Error("Noble browser verification exports changed; review the pinned dependency.");
      }
      return { code: source.replace(exports, "return Object.freeze({ verify, Point });").replace(privateLength, ""), map: null };
    },
  };
}
