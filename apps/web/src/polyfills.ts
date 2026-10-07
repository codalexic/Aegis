import { Buffer } from "buffer";

// Solana's browser dependencies use Buffer to encode public addresses and accounts.
Object.assign(globalThis, { Buffer });
