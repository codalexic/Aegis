import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { ApiError } from "./http";

/** Warm-instance protection. The documented Vercel WAF rule also covers cold starts. */
export class IpLimiter {
  private entries = new Map<string, number[]>();
  constructor(private readonly clock = Date.now) {}
  take(ip: string, group: "agent" | "faucet") {
    const now = this.clock();
    const window = group === "agent" ? 60_000 : 600_000;
    const cap = group === "agent" ? 6 : 1;
    for (const [key, times] of this.entries) if (now - times.at(-1)! >= 600_000) this.entries.delete(key);
    const key = `${group}:${ip}`;
    const times = (this.entries.get(key) ?? []).filter((at) => now - at < window);
    if (times.length >= cap) throw new ApiError(429, `${group === "agent" ? "Agent" : "Faucet"} IP limit reached. Try again later.`);
    if (!this.entries.has(key) && this.entries.size >= 10_000) throw new ApiError(429, "Demo is busy. Try again later.");
    this.entries.set(key, [...times, now]);
  }
}

export function vercelIp(request: IncomingMessage): string {
  // Vercel overwrites this header. Never accept caller-supplied body/query IPs.
  const ip = request.headers["x-vercel-forwarded-for"];
  if (typeof ip !== "string" || !isIP(ip)) throw new ApiError(503, "Trusted request IP unavailable.");
  return ip;
}
