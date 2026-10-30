import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountChip, tintWalletIcon } from "../src/App";

const address = "5ZksQm3n7fXo1o9Kc8V2bYwW4hT6rJpLxD3uE1aNwpGq";

describe("account chip", () => {
  it("shows only the wallet logo, without an address or hover popover", () => {
    const markup = renderToStaticMarkup(createElement(AccountChip, { address, walletName: "Phantom", walletIcon: "data:image/svg+xml;base64,AA==" }));
    expect(markup).toContain('src="data:image/svg+xml;base64,AA=="');
    expect(markup).toContain(`aria-label="Owner ${address}"`);
    expect(markup).not.toContain("5Zks…wpGq");
    expect(markup).not.toContain("account-pop");
    expect(markup).not.toContain("Copied!");
  });

  it("falls back to a wallet icon without a connected wallet", () => {
    const markup = renderToStaticMarkup(createElement(AccountChip, { address }));
    expect(markup).not.toContain("<img");
  });
});

describe("wallet icon tint", () => {
  const svg = (body: string) => `data:image/svg+xml;base64,${btoa(body)}`;

  it("redraws an SVG logo with a dark grey tile and a pink mark", () => {
    const tinted = atob(tintWalletIcon(svg('<svg fill="none"><rect fill="#AB9FF2"/><path fill="#FFFDF8"/></svg>')).split(",")[1]);
    expect(tinted).toBe('<svg fill="none"><rect fill="#1C1B1F"/><path fill="#FF2E7E"/></svg>');
  });

  it("leaves non-SVG and unreadable icons unchanged", () => {
    for (const icon of ["data:image/png;base64,AA==", "data:image/svg+xml;base64,AA==", "data:image/svg+xml;base64,%%%"]) {
      expect(tintWalletIcon(icon)).toBe(icon);
    }
  });
});
