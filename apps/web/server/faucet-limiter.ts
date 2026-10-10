import { ApiError } from "./http";

/** Reserve before awaiting RPC. Uncertain sends retain their allowance to prevent duplicate minting. */
export class FaucetLimiter {
  private wallets = new Map<string, number>();
  private requests: number[] = [];
  constructor(private readonly clock = Date.now, private readonly hourlyCap = 10) {}
  take(wallet: string) {
    const now = this.clock();
    for (const [address, at] of this.wallets) if (now - at >= 600_000) this.wallets.delete(address);
    this.requests = this.requests.filter((at) => now - at < 3_600_000);
    const last = this.wallets.get(wallet);
    if (last !== undefined) throw new ApiError(429, `Faucet limited: this wallet can claim again in ${Math.ceil((600_000 - now + last) / 60_000)} minutes (once per 10 minutes).`);
    if (this.requests.length >= this.hourlyCap) throw new ApiError(429, "Faucet hourly limit reached (10 claims per hour). Try again later.");
    this.wallets.set(wallet, now); this.requests.push(now);
  }
}
