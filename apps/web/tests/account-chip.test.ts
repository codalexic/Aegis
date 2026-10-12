import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountChip } from "../src/App";

const address = "5ZksQm3n7fXo1o9Kc8V2bYwW4hT6rJpLxD3uE1aNwpGq";

describe("account chip", () => {
  it("shows the wallet icon and short address, with the full address in the popover", () => {
    const markup = renderToStaticMarkup(createElement(AccountChip, { address, walletName: "Phantom", walletIcon: "data:image/svg+xml;base64,AA==" }));
    expect(markup).toContain('src="data:image/svg+xml;base64,AA=="');
    expect(markup).toContain("5Zks…wpGq");
    expect(markup).toContain("Phantom account");
    expect(markup).toContain(`<code>${address}</code>`);
    expect(markup).toContain("Copy address");
  });

  it("falls back to a wallet icon without a connected wallet", () => {
    const markup = renderToStaticMarkup(createElement(AccountChip, { address }));
    expect(markup).not.toContain("<img");
    expect(markup).toContain("Owner account");
  });
});
