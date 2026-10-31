import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandLogo } from "./BrandLogo";

/** Shared by the landing page, the connecting loader and the dashboard; only the links change.
 *  On narrow screens the links fold into a menu so the wallet controls always keep their room. */
export function SiteHeader({ home = "/", links, actions }: {
  home?: string; links?: ReactNode; actions?: ReactNode;
}) {
  const header = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const set = () => header.current?.classList.toggle("is-scrolled", window.scrollY > 20);
    window.addEventListener("scroll", set, { passive: true }); set();
    return () => window.removeEventListener("scroll", set);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => { if (!header.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey); window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [open]);
  return <header className="site-header" ref={header}>
    <div className={`site-header-in${open ? " is-open" : ""}`}>
      <a className="site-logo" href={home} aria-label="Aegis home"><BrandLogo height={22} title="" /></a>
      {links && <nav className="site-links" id="site-links" aria-label="Main" onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) setOpen(false);
      }}>{links}</nav>}
      <div className="site-actions">{actions}</div>
      {links && <button type="button" className="site-menu" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="site-links"
        onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 8h16M4 16h16" />}
        </svg>
      </button>}
    </div>
  </header>;
}
