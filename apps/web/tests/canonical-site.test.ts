import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalSiteNotice } from "../src/CanonicalSiteNotice";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([
  ["https://demo.example", false],
  ["https://branch.vercel.app", true],
])("shows the canonical link only on an alternate origin: %s", (origin, visible) => {
  vi.stubEnv("AEGIS_PUBLIC_ORIGIN", "https://demo.example/");
  vi.stubGlobal("window", { location: { origin } });
  const markup = renderToStaticMarkup(createElement(CanonicalSiteNotice));
  if (visible) expect(markup).toContain('href="https://demo.example"');
  else expect(markup).toBe("");
});

it.each(["", "invalid", "javascript:alert(1)"])("omits an unconfigured or invalid canonical origin: %s", (origin) => {
  vi.stubEnv("AEGIS_PUBLIC_ORIGIN", origin);
  expect(renderToStaticMarkup(createElement(CanonicalSiteNotice))).toBe("");
});
