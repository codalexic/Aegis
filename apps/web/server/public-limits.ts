import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { ApiError, rateLimitError } from "./http";

/** Warm-instance protection. The documented Vercel WAF rule also covers cold starts. */
export class IpLimiter {
  private entries = new Map<string, number[]>();
  constructor(private readonly clock = Date.now) {}
  take(ip: string, group: "agent" | "faucet") {
    const now = this.clock();
    const window = group === "agent" ? 60_000 : 600_000;
    const cap = group === "agent" ? 6 : 10;
    for (const [key, times] of this.entries) if (now - times.at(-1)! >= 600_000) this.entries.delete(key);
    const key = `${group}:${ip}`;
    const times = (this.entries.get(key) ?? []).filter((at) => now - at < window);
    if (times.length >= cap) throw rateLimitError(group === "agent" ? "Agent IP limit reached. Try again in" : "Faucet busy on this network. Try again in", times[0] + window - now);
    if (!this.entries.has(key) && this.entries.size >= 10_000) {
      const nextExpiry = Math.min(...Array.from(this.entries.values(), (entry) => entry.at(-1)! + 600_000));
      throw rateLimitError("Demo is busy. Try again in", nextExpiry - now);
    }
    this.entries.set(key, [...times, now]);
  }
}

export function vercelIp(request: IncomingMessage): string {
  // Vercel overwrites this header. Never accept caller-supplied body/query IPs.
  const ip = request.headers["x-vercel-forwarded-for"];
  if (typeof ip !== "string" || !isIP(ip)) throw new ApiError(503, "Trusted request IP unavailable.");
  return ip;
}
