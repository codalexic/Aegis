import { defineConfig } from "vitest/config";

// These Node tests do not start Vite or load owner credentials.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
