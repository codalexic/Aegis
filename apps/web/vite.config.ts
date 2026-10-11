import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { ownerApiPlugin } from "./server/owner-api";
import { agentApiPlugin } from "./server/agent-api";
import { faucetApiPlugin } from "./server/faucet-api";
import { actionsPlugin } from "./api/actions/plugin";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = process.env.VERCEL === "1" ? "devnet" : process.env.AEGIS_ENV ?? loadEnv(mode, workspaceRoot, "AEGIS_").AEGIS_ENV ?? "mock";
  if (environment !== "mock" && environment !== "localnet" && environment !== "devnet") {
    throw new Error("AEGIS_ENV must be mock, localnet or devnet.");
  }
  const signing = process.env.AEGIS_SIGNING ?? loadEnv(mode, workspaceRoot, "AEGIS_").AEGIS_SIGNING;
  if (signing !== undefined && signing !== "wallet" && signing !== "server") throw new Error("AEGIS_SIGNING must be wallet or server.");
  const walletMode = environment === "devnet" || (environment === "localnet" && signing === "wallet");
  const settings = { ...loadEnv(mode, workspaceRoot, "AEGIS_"), ...process.env };
  const devnetRpcUrl = process.env.VITE_DEVNET_RPC_URL ?? loadEnv(mode, workspaceRoot, "VITE_DEVNET_RPC_URL").VITE_DEVNET_RPC_URL;
  return {
    plugins: [
      ...(environment === "localnet" && !walletMode ? [ownerApiPlugin(workspaceRoot)] : []),
      ...(environment !== "mock" ? [agentApiPlugin(workspaceRoot, environment, walletMode), ...(walletMode ? [faucetApiPlugin(workspaceRoot, environment)] : [])] : []),
      ...(environment !== "mock" ? [actionsPlugin(workspaceRoot, environment, { deploymentPath: settings.AEGIS_ACTIONS_DEPLOYMENT, origin: settings.AEGIS_ACTIONS_ORIGIN })] : []),
      { name: "aegis-browser-read-only", enforce: "pre", resolveId(source, importer) {
        if (source === "@solana/web3.js") return fileURLToPath(new URL("./src/browser-web3.js", import.meta.url));
        if (source === "@solana/spl-token") return fileURLToPath(new URL("./src/browser-token.ts", import.meta.url));
        if (source === "./utils/ed25519" && importer?.endsWith("/web3.js/src/publickey.ts")) {
          return fileURLToPath(new URL("./src/browser-curve.ts", import.meta.url));
        }
      } },
    ],
    // Explicit public settings only; never expose the contents of the root .env file.
    define: { "import.meta.env.AEGIS_ENV": JSON.stringify(environment), "import.meta.env.AEGIS_WALLET": JSON.stringify(walletMode),
      "import.meta.env.VITE_DEVNET_RPC_URL": JSON.stringify(devnetRpcUrl ?? "https://api.devnet.solana.com"), "process.env.ANCHOR_BROWSER": "true" },
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
