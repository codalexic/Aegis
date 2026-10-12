import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountChip } from "../src/App";

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
