import { expect, it } from "vitest";
import { phantomBrowseUrl } from "../src/phantom-availability";

it.each([undefined, "", "invalid", "javascript:alert(1)", "https://user:password@example.com"])("uses the current URL without a valid canonical origin: %s", (origin) => {
  const href = "https://demo.example/?label=a%20b&source=mobile#/vault";
  expect(phantomBrowseUrl(href, origin)).toBe(`https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=https%3A%2F%2Fdemo.example`);
});

it("uses the canonical origin and preserves the current path, query and fragment", () => {
  const href = "https://branch.vercel.app/demo?source=mobile#/vault";
  const canonical = "https://demo.example/demo?source=mobile#/vault";
  expect(phantomBrowseUrl(href, "https://demo.example/")).toBe(`https://phantom.app/ul/browse/${encodeURIComponent(canonical)}?ref=https%3A%2F%2Fdemo.example`);
});
