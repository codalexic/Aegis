export const PHANTOM_INSTALL_MESSAGE = "Phantom isn't installed. Install it, then refresh this page.";
export const PHANTOM_MOBILE_MESSAGE = "Phantom isn't available in this browser. Install Phantom, then open this page in Phantom.";

export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function phantomBrowseUrl(href: string, configuredOrigin?: string): string {
  const current = new URL(href);
  let origin = current.origin;
  try {
    const canonical = new URL(configuredOrigin ?? "");
    if (canonical.protocol === "https:" && !canonical.username && !canonical.password) origin = canonical.origin;
  } catch { /* Use the current origin when no valid canonical site is configured. */ }
  const url = `${origin}${current.pathname}${current.search}${current.hash}`;
  return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(origin)}`;
}
