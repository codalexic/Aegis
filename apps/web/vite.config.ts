import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = process.env.AEGIS_ENV ?? loadEnv(mode, workspaceRoot, "AEGIS_").AEGIS_ENV ?? "mock";
  if (environment !== "mock" && environment !== "localnet") {
    throw new Error("AEGIS_ENV must be mock or localnet.");
  }
  return {
    // Expose only the environment label, never the contents of the root .env file.
    define: { "import.meta.env.AEGIS_ENV": JSON.stringify(environment) },
    server: {
      fs: {
        // Preserve Vite's default deny rules and also protect local Solana keys.
        deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**", "**/.keys/**", "**/*-keypair.json"],
      },
    },
    build: { target: "es2022" },
  };
});
