import { useEffect, useRef, type ReactNode } from "react";
import { BrandLogo } from "./BrandLogo";

/** Shared by the landing page, the connecting loader and the dashboard; only the links change. */
export function SiteHeader({ home = "/", links, collapseLinks = false, actions }: {
  home?: string; links?: ReactNode; collapseLinks?: boolean; actions?: ReactNode;
}) {
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const set = () => header.current?.classList.toggle("is-scrolled", window.scrollY > 20);
    window.addEventListener("scroll", set, { passive: true }); set();
    return () => window.removeEventListener("scroll", set);
  }, []);
  return <header className="site-header" ref={header}>
    <div className="site-header-in">
      <a className="site-logo" href={home} aria-label="Aegis home"><BrandLogo height={22} title="" /></a>
      {links && <nav className={`site-links${collapseLinks ? " is-collapsible" : ""}`} aria-label="Main">{links}</nav>}
      <div className="site-actions">{actions}</div>
    </div>
  </header>;
}
