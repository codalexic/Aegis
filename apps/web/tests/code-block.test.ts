import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { highlightJson } from "../src/AgentConsole";

it("highlights JSON keys, strings, numbers and literals", () => {
  const json = JSON.stringify({ amountUsdc: "1000", reason: "Scripted", n: 2, ok: true }, null, 2);
  const markup = renderToStaticMarkup(createElement(Fragment, null, ...highlightJson(json)));
  expect(markup).toContain("<span class=\"tok-key\">&quot;amountUsdc&quot;</span>:");
  expect(markup).toContain("<span class=\"tok-string\">&quot;1000&quot;</span>");
  expect(markup).toContain("<span class=\"tok-number\">2</span>");
  expect(markup).toContain("<span class=\"tok-literal\">true</span>");
  expect(markup.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"")).toBe(json);
});
