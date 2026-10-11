/** Tracks document scrolling while preserving an explicitly selected sidebar link. */
export function trackActiveSection(ids: readonly string[], setActive: (id: string) => void) {
  let navigating = false;
  let pinned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const elements = () => ids.map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => element !== null);

  function update() {
    const visible = elements().map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top);
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
    const section = atBottom ? visible.at(-1)
      : visible.filter(({ rect }) => rect.top <= window.innerHeight * 0.35).at(-1) ?? visible[0];
    if (section) setActive(section.element.id);
  }

  function finishNavigation() {
    clearTimeout(timer);
    navigating = false;
    // Keep the selected link until another scroll, even after the animation ends.
  }

  function waitForScrollEnd() {
    clearTimeout(timer);
    // Fallback for browsers without scrollend, including clicks that cannot scroll.
    timer = setTimeout(finishNavigation, 180);
  }

  function select(id: string) {
    const element = ids.includes(id) ? document.getElementById(id) : null;
    if (!element) return false;
    pinned = navigating = true;
    setActive(id);
    waitForScrollEnd();
    element.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      block: "start",
    });
    return true;
  }

  function onScroll() {
    if (navigating) { waitForScrollEnd(); return; }
    pinned = false;
    update();
  }
  const onResize = () => { if (!pinned) update(); };
  const onHashChange = () => { select(window.location.hash.slice(1)); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) finishNavigation();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.clientX >= document.documentElement.clientWidth) finishNavigation();
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("scrollend", finishNavigation);
  window.addEventListener("resize", onResize);
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("wheel", finishNavigation, { passive: true });
  window.addEventListener("touchmove", finishNavigation, { passive: true });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("pointerdown", onPointerDown);
  if (!select(window.location.hash.slice(1))) update();

  return {
    select,
    stop() {
      clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", finishNavigation);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("wheel", finishNavigation);
      window.removeEventListener("touchmove", finishNavigation);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
