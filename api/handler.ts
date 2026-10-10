import type { IncomingMessage, ServerResponse } from "node:http";
import { createPublicHandler } from "../apps/web/server/public-api";

const handlePublic = createPublicHandler();
type VercelRequest = IncomingMessage & { query?: Record<string, string | string[]> };

export default function handler(request: VercelRequest, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "https://aegis.invalid");
  // vercel.json carries the public path when Vercel exposes the destination URL.
  // Some runtimes expose rewrite parameters only through request.query.
  const paths = url.searchParams.getAll("__aegis_path");
  const path = paths.length ? (paths.length === 1 ? paths[0] : undefined) : request.query?.__aegis_path;
  if (url.pathname === "/api/handler" && typeof path === "string") {
    url.pathname = `/api/${path}`;
  }
  // Action POSTs and latest-vault allow only their own query parameters.
  url.searchParams.delete("__aegis_path");
  request.url = `${url.pathname}${url.search}`;
  return handlePublic(request, response);
}
