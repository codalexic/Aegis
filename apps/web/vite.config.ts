import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { ownerApiPlugin } from "./server/owner-api";
import { agentApiPlugin } from "./server/agent-api";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = process.env.AEGIS_ENV ?? loadEnv(mode, workspaceRoot, "AEGIS_").AEGIS_ENV ?? "mock";
  if (environment !== "mock" && environment !== "localnet") {
    throw new Error("AEGIS_ENV must be mock or localnet.");
  }
  return {
    plugins: [
      ...(environment === "localnet" ? [ownerApiPlugin(workspaceRoot), agentApiPlugin(workspaceRoot)] : []),
      { name: "aegis-browser-read-only", enforce: "pre", resolveId(source, importer) {
        if (source === "@solana/web3.js") return fileURLToPath(new URL("./src/browser-web3.js", import.meta.url));
        if (source === "@solana/spl-token") return fileURLToPath(new URL("./src/browser-token.ts", import.meta.url));
        if (source === "./utils/ed25519" && importer?.endsWith("/web3.js/src/publickey.ts")) {
          return fileURLToPath(new URL("./src/browser-curve.ts", import.meta.url));
        }
      } },
    ],
    // Expose only the environment label, never the contents of the root .env file.
    define: { "import.meta.env.AEGIS_ENV": JSON.stringify(environment), "process.env.ANCHOR_BROWSER": "true" },
    server: {
      // Runtime lastVault updates should not restart the browser session.
      watch: { ignored: ["**/deployments/localnet.json", "**/deployments/localnet.json.tmp"] },
      fs: {
        // Preserve Vite's default deny rules and also protect local Solana keys.
        deny: [".env", ".env.*", "*.swp", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**", "**/.keys/**", "**/*-keypair.json"],
      },
    },
    build: { target: "es2022" },
  };
});
