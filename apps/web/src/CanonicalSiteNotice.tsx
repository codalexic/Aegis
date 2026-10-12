export function CanonicalSiteNotice() {
  const configuredOrigin = import.meta.env.AEGIS_PUBLIC_ORIGIN;
  if (!configuredOrigin) return null;
  let canonical: URL;
  try { canonical = new URL(configuredOrigin); } catch { return null; }
  if (canonical.protocol !== "https:" || canonical.username || canonical.password || canonical.origin === window.location.origin) return null;
  return <p className="canonical-site-notice" role="status">
    Demo write requests only work on the canonical site. <a href={canonical.origin}>Open {canonical.host}</a> to continue.
  </p>;
}
