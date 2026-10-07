import { Connection } from "@solana/web3.js";

import { DEVNET_RPC_URL, DEVNET_WS_URL, devnetFetch } from "./rpc-fetch";
export { DEVNET_RPC_URL, DEVNET_WS_URL, devnetFetch } from "./rpc-fetch";

export function createDevnetConnection(): Connection {
  return new Connection(DEVNET_RPC_URL, {
    commitment: "confirmed", wsEndpoint: DEVNET_WS_URL,
    fetch: devnetFetch(), disableRetryOnRateLimit: true,
  });
}
