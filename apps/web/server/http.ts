import type { IncomingMessage, ServerResponse } from "node:http";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); }
}

export function rateLimitError(message: string, remainingMs: number): ApiError {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return new ApiError(429, `${message} ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, Math.max(1, Math.ceil(remainingMs / 1000)));
}

export function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  // Vercel parses the body before invoking a Node function; Vite supplies a stream.
  let parsed: unknown;
  try { parsed = (request as IncomingMessage & { body?: unknown }).body; }
  catch { throw new ApiError(400, "Expected a JSON object."); }
  if (parsed !== undefined) {
    if (Buffer.byteLength(JSON.stringify(parsed)) > 4096) throw new ApiError(413, "Request too large.");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Buffer.isBuffer(parsed)) throw new ApiError(400, "Expected a JSON object.");
    return parsed as Record<string, unknown>;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new ApiError(413, "Request too large.");
    chunks.push(bytes);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new ApiError(400, "Expected a JSON object."); }
}
