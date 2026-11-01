import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import aegisIdl from "../../../artifacts/idl/aegis.json";
import dexIdl from "../../../artifacts/idl/demo_dex.json";
import { RPC_RATE_LIMITED, WALLET_REJECTED } from "../../../packages/sdk/src/errors";
import { describeError, FAUCET_NEEDS_SOL, PROGRAM_ERROR_MESSAGES } from "../src/errors";
import { Notice } from "../src/Notice";
import { DEVNET_GUIDANCE, WALLET_CANCELLED } from "../src/wallet-lifecycle";

const clientCodes = [
  "NoDevnetSol", "AccountNotFound", "RpcError", "RpcRateLimited", "RateLimited", "WalletRejected", "UserRejected", "SigningFailed",
  "WalletModifiedTransaction", "InvalidWalletSignature", "WalletSigningError",
  "InsufficientFunds", "InsufficientFundsForFee", "InsufficientFundsForRent",
  "NotRentExempt", "ResultWithNegativeLamports", "AccountAlreadyInUse", "MintMismatch", "OwnerMismatch", "InvalidOwner", "AccountFrozen",
  "VaultNotFound", "VaultAlreadyExists", "DeploymentProgramMismatch", "DeploymentAccountMismatch",
  "DeploymentClusterMismatch", "InvalidDevnetRpcUrl", "InvalidTransaction",
  "TransactionExpired", "ConfirmationTimedOut", "TransactionFailed",
];
const knownCodes = [...new Set([...clientCodes, ...[aegisIdl, dexIdl].flatMap((idl) => idl.errors.map(({ name }) => name))])];
const renderError = (message: unknown) => renderToStaticMarkup(createElement(Notice, { tone: "error", message }));

describe("notice error copy", () => {
  it.each(["Gemini returned HTTP 503", "HTTP 502 Bad Gateway", "UNAVAILABLE: overloaded", "TypeError: failed request", "CustomProgramError(9999)", "Transaction simulation failed: Blockhash not found"])("hides raw infrastructure detail: %s", (message) => {
    const markup = renderError(Object.assign(new Error(message), { detail: "HTTP 429 internal provider detail" }));
    expect(markup).not.toMatch(/HTTP|503|502|429|UNAVAILABLE|TypeError|CustomProgramError|Blockhash|internal provider/);
  });
  it.each(["BlockhashNotFound", "Blockhash not found"])("explains temporary network trouble for %s", (message) => {
    expect(describeError(message).text).toContain("busy or rate limited");
  });

  it("renders a normalized SDK rejection as a neutral cancellation", () => {
    const markup = renderError("WalletRejected");
    expect(markup).toContain('class="notice info" role="status"');
    expect(markup).toContain(WALLET_CANCELLED);
    expect(markup).not.toContain('role="alert"');
  });

  it.each(knownCodes)("never shows known code %s raw", (code) => {
    const detail = describeError(new Error(code));
    expect(detail.text).toMatch(/[.!]$/);
    expect(detail.text).not.toBe("Something went wrong. Try again.");
    expect(detail.code).toBeUndefined();
    expect(renderError(code)).not.toContain(code);
  });

  it("covers every literal client error emitted by the SDK", () => {
    for (const file of ["chain-reader.ts", "wallet.ts", "anchor.ts"]) {
      const source = readFileSync(new URL(`../../../packages/sdk/src/${file}`, import.meta.url), "utf8");
      for (const [, code] of source.matchAll(/new ClientError\("(\w+)"\)/g)) {
        expect(knownCodes, `${file}: ${code}`).toContain(code);
      }
    }
  });

  it("reuses the program explanations", () => {
    for (const { name } of aegisIdl.errors) expect(describeError(name).text).toBe(PROGRAM_ERROR_MESSAGES[name]);
  });

  it("explains RPC congestion and recognizes wallet and rate-limit wrappers", () => {
    expect(describeError("RpcError").text).toBe("The Solana devnet RPC is busy or rate limited. Wait a few seconds and try again.");
    expect(describeError(RPC_RATE_LIMITED)).toEqual(describeError("RpcError"));
    expect(describeError({ cause: { status: 429 } })).toEqual(describeError("RpcError"));
    expect(describeError(WALLET_REJECTED)).toEqual(describeError("WalletRejected"));
    expect(describeError({ cause: { code: 4001 } })).toEqual(describeError("WalletRejected"));
    expect(describeError({ code: "SigningFailed", message: "wallet adapter details" })).toEqual(describeError("SigningFailed"));
  });

  it.each(["insufficient SOL for fees", "insufficient funds for fee", "insufficient lamports"])("explains %s", (message) => {
    expect(describeError(new Error(message))).toEqual(describeError("InsufficientFundsForFee"));
  });

  it.each([...knownCodes, "FutureFundingError"])("handles %s inside partial-success funding messages", (code) => {
    const detail = describeError(`Vault created, but funding failed: ${code}. Use Fund 1,000 to retry.`);
    expect(detail.text).toBe(`Vault created, but funding failed. ${describeError(code).text} Use Fund 1,000 to retry.`);
    expect(detail.text).not.toContain(code);
    expect(detail.code).toBeUndefined();
  });

  it("preserves useful faucet cooldown copy", () => {
    const text = "Faucet limited: wait 10 minutes after the last activity in your testUSDC account.";
    expect(describeError(text)).toEqual({ text });
  });

  it.each(["WalletSigningError", "Vault created, but funding failed: WalletSigningError. Use Fund 1,000 to retry."])("hides internal wallet details for %s", (message) => {
    const error = Object.assign(new Error(message), { detail: "Wallet connection timed out." });
    expect(describeError(error).detail).toBeUndefined();
    expect(renderError(error)).not.toContain("Wallet connection timed out.");
    expect(describeError(error).text).not.toContain("Wallet connection timed out.");
  });

  it.each(["FutureError", "CustomProgramError(6010)", "UNKNOWN_CODE", "constructor"])("hides internal diagnostic %s", (code) => {
    expect(describeError(code)).toEqual({ text: "Something went wrong. Try again." });
    expect(renderError(code)).not.toContain(code);
  });

  it("handles numeric unknown codes and missing errors", () => {
    expect(describeError({ code: 12345, message: "internal detail" })).toEqual({ text: "Something went wrong. Try again." });
    expect(describeError(null)).toEqual({ text: "Something went wrong. Try again." });
  });
});

describe("shared notice layout", () => {
  it.each(["error", "success", "info", "busy"] as const)("renders %s with text grouped between the indicator and dismiss button", (tone) => {
    const markup = renderToStaticMarkup(createElement(Notice, {
      tone, message: "A message long enough to wrap across two lines on a narrow screen.", onDismiss: () => {},
    })).replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, "<svg></svg>");
    expect(markup).toBe(`<div class="notice ${tone}" role="${tone === "error" ? "alert" : "status"}">${tone === "busy" ? "" : "<svg></svg>"}<div class="notice-content"><p>A message long enough to wrap across two lines on a narrow screen.</p></div><button type="button" class="icon-button notice-dismiss" aria-label="Dismiss"><svg></svg></button></div>`);
  });

  it("omits the dismiss control when no dismissal action is provided", () => {
    expect(renderError("RpcError")).not.toContain("<button");
  });

  it("centers every variant and keeps the controls fixed while the message wraps", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    expect(rule(".notice")).toContain("display: flex;");
    expect(rule(".notice")).toContain("flex-direction: row;");
    expect(rule(".notice")).toContain("flex-wrap: nowrap;");
    expect(rule(".notice")).toContain("align-items: center;");
    expect(rule(".notice")).toContain("padding: 12px 16px;");
    expect(rule(".notice-content")).toContain("flex: 1;");
    expect(rule(".notice-content")).toContain("min-width: 0;");
    for (const selector of [".notice > svg", ".notice.busy::before", ".notice-dismiss.icon-button"]) {
      expect(rule(selector)).toContain("flex-shrink: 0;");
      expect(rule(selector)).not.toContain("margin-top");
    }
    expect(rule(".notice-dismiss.icon-button")).toContain("margin-left: auto;");
  });
});

it.each(["NoDevnetSol", "AccountNotFound", "InsufficientFundsForFee", "insufficient lamports for rent"])("links %s to the devnet faucet in a new tab", (code) => {
  const markup = renderError(code);
  expect(markup).toContain("Your wallet has no devnet SOL for fees. Get free devnet SOL, then try again.");
  expect(markup).toContain('<a href="https://faucet.solana.com" target="_blank" rel="noreferrer">Get free devnet SOL</a>');
});

it("never prints raw wallet details or error codes under a notice", () => {
  const markup = renderToStaticMarkup(createElement(Notice, { tone: "error", message: { message: "SigningFailed", code: "WalletSignTransactionError", detail: "Unexpected error" } }));
  expect(markup).not.toContain("Unexpected error");
  expect(markup).not.toContain("WalletSignTransactionError");
  expect(markup).not.toContain("notice-code");
});

it("shows the USDC logo in success toasts but keeps the name when a warning is attached", () => {
  const render = (message: string) => renderToStaticMarkup(createElement(Notice, { tone: "success", message }));
  expect(render("Added 1,000 testUSDC to your vault.")).toContain('<span class="usdc">');
  expect(render(FAUCET_NEEDS_SOL)).toContain(FAUCET_NEEDS_SOL);
  expect(render(FAUCET_NEEDS_SOL)).not.toContain('class="usdc"');
});
