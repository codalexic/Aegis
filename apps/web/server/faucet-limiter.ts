import { rateLimitError } from "./http";

/** Reserve before awaiting RPC. Uncertain sends retain their allowance to prevent duplicate minting. */
export class FaucetLimiter {
  private wallets = new Map<string, number>();
  private requests: number[] = [];
  constructor(private readonly clock = Date.now, private readonly hourlyCap = 30) {}
  take(wallet: string) {
    const now = this.clock();
    for (const [address, at] of this.wallets) if (now - at >= 600_000) this.wallets.delete(address);
    this.requests = this.requests.filter((at) => now - at < 3_600_000);
    const last = this.wallets.get(wallet);
    const walletWait = last === undefined ? 0 : last + 600_000 - now;
    const hourlyWait = this.requests.length < this.hourlyCap ? 0 : this.requests[0] + 3_600_000 - now;
    if (hourlyWait > 0 && hourlyWait >= walletWait) throw rateLimitError("Faucet hourly limit reached. Try again in", hourlyWait);
    if (walletWait > 0) throw rateLimitError("This wallet can claim again in", walletWait);
    this.wallets.set(wallet, now); this.requests.push(now);
  }

  /** Only release when history rejects the claim before any transaction is sent. */
  release(wallet: string) {
    const at = this.wallets.get(wallet);
    if (at === undefined) return;
    this.wallets.delete(wallet);
    const index = this.requests.indexOf(at);
    if (index !== -1) this.requests.splice(index, 1);
  }
}
