import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConsole } from "../src/AgentConsole";
import { connectDashboard } from "../src/client";
import type { Step } from "../../../scripts/agent/run";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});
afterEach(() => vi.clearAllMocks());

async function render(live: boolean, source?: "live" | "scripted" | "fixed", hasVault = true, fallback = false) {
  const connection = await connectDashboard("mock");
  const created = await connection.create();
  const vault = await connection.client.getVault(created.vault!);
  const steps: Step[] = source ? [
    { type: "model_reply", source, reply: { amountUsdc: "20", reason: "Calm market" } },
    { type: "request", amountUsdc: "20", amountRaw: "20000000" },
    { type: "result", result: { ok: true, signature: "mock-1" } },
  ] : [];
  if (fallback) steps.push({ type: "notice", code: "live_fallback", message: "Live AI was busy, so a recorded reply was used." });
  vi.mocked(useState).mockImplementationOnce(() => [live, vi.fn()])
    .mockImplementationOnce(() => ["test-model", vi.fn()])
    .mockImplementationOnce(() => [steps, vi.fn()]);
  return renderToStaticMarkup(createElement(AgentConsole, {
    vault: hasVault ? vault : null, finished: false, disabled: false, onBusy: vi.fn(), onComplete: vi.fn(),
  }));
}

describe("agent scenario and reply copy", () => {
  it("shows automatic fallback outside collapsed details without asking for a scripted retry", async () => {
    const markup = await render(true, "scripted", true, true);
    expect(markup.split('<details class="agent-details">')[0]).toContain("Live AI was busy, so a recorded reply was used.");
    expect(markup).not.toContain("Retry scripted");
  });
  it("explains what each scenario does and why the vault accepts or blocks it", async () => {
    const markup = await render(false);
    expect(markup).toContain("Swaps 20 testUSDC.</p>");
    expect(markup).toContain(">Allowed: within the rules.</p>");
    expect(markup).toContain("Hidden news tells the agent to spend 1,000.</p>");
    expect(markup).toContain(">Blocked: over the per-trade cap.</p>");
    expect(markup).toContain("Tries to send the output to an attacker.</p>");
    expect(markup).toContain(">Blocked: output must stay in the vault.</p>");
    expect(markup).toContain("<strong>Hacker redirect</strong>");
    expect(markup).toMatch(/<button[^>]*>Hacker redirect<\/button>/);
    expect(markup).not.toContain("<strong>Wrong destination</strong>");
  });
  it.each([true, false])("explains the selected mode even before a vault exists: live=%s", async (live) => {
    const markup = await render(live, undefined, false);
    expect(markup).toContain(live
      ? "Live AI: test-model reads the news and decides the amount itself."
      : "Scripted: a recorded reply, no AI call. The on-chain checks are identical.");
    expect(markup).toContain("Set up and fund your vault first.");
  });
  it.each([true, false])("labels actual live replies outside collapsed details regardless of toggle: live=%s", async (live) => {
    const markup = await render(live, "live");
    const resultArea = markup.split('<details class="agent-details">')[0];
    expect(resultArea).toContain('<span class="status">AI decided</span> test-model');
    expect(resultArea).not.toContain("Recorded reply");
  });
  it.each([true, false])("labels recorded replies regardless of toggle: live=%s", async (live) => {
    const markup = await render(live, "scripted");
    expect(markup.split('<details class="agent-details">')[0]).toContain('<span class="status">Recorded reply</span>');
    expect(markup).not.toContain("AI decided");
  });
  it("keeps the fixed hacker request honest when Live AI is selected", async () => {
    const markup = await render(true, "fixed");
    expect(markup).toContain('<span class="status">Fixed hacker request · No AI</span>');
    expect(markup).not.toContain("AI decided");
  });
});
