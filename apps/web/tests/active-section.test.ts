import { afterEach, describe, expect, it, vi } from "vitest";
import { trackActiveSection } from "../src/active-section";

const ids = ["overview", "vault", "agent", "activity"];
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture({ height = 1200, hash = "", reducedMotion = false, missing = [] as string[] } = {}) {
  vi.useFakeTimers();
  const page = Object.assign(new EventTarget(), {
    innerHeight: height, scrollY: 0, location: { hash },
    matchMedia: vi.fn(() => ({ matches: reducedMotion })),
  });
  const root = { scrollHeight: 1800, clientWidth: 1440 };
  const sections = new Map(ids.filter((id) => !missing.includes(id)).map((id) => {
    const top = { overview: 0, vault: 250, agent: 850, activity: 1450 }[id]!;
    const height = { overview: 200, vault: 550, agent: 550, activity: 300 }[id]!;
    return [id, {
      id, scrollIntoView: vi.fn(),
      getBoundingClientRect: () => ({ top: top - page.scrollY, bottom: top + height - page.scrollY, height }),
    }];
  }));
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { documentElement: root, getElementById: (id: string) => sections.get(id) ?? null });
  const setActive = vi.fn();
  const tracker = trackActiveSection(ids, setActive);
  cleanups.push(tracker.stop);
  const emit = (type: string, properties = {}) => page.dispatchEvent(Object.assign(new Event(type), properties));
  const scroll = (y: number) => { page.scrollY = y; emit("scroll"); };
  const active = () => setActive.mock.lastCall?.[0];
  return { page, root, sections, tracker, setActive, emit, scroll, active };
}

describe("sidebar section navigation", () => {
  it("selects Activity immediately on a tall viewport and keeps it through and after smooth scrolling", () => {
    const f = fixture();
    expect(f.tracker.select("activity")).toBe(true);
    expect(f.active()).toBe("activity");
    expect(f.sections.get("activity")!.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    for (const y of [150, 300, 450, 600]) {
      f.scroll(y);
      vi.advanceTimersByTime(50);
      expect(f.active()).toBe("activity");
    }
    // Activity's top is still at 850px, outside the old 15–35% observer band.
    expect(f.sections.get("activity")!.getBoundingClientRect().top).toBe(850);
    f.emit("scrollend");
    f.emit("resize");
    vi.advanceTimersByTime(1000);
    expect(f.active()).toBe("activity");
    f.scroll(300);
    expect(f.active()).toBe("vault");
  });

  it.each([596, 600])("selects the last visible section at scroll position %s near the bottom", (y) => {
    const f = fixture();
    f.scroll(450);
    expect(f.active()).toBe("agent");
    f.scroll(y);
    expect(f.active()).toBe("activity");
  });

  it.each(["vault", "agent", "activity"])("honors #%s on load before any scroll", (id) => {
    const f = fixture({ hash: `#${id}` });
    expect(f.active()).toBe(id);
    f.scroll(100);
    expect(f.active()).toBe(id);
    f.emit("scrollend");
    expect(f.active()).toBe(id);
  });

  it("updates the highlight during ordinary scrolling in both directions", () => {
    const f = fixture({ height: 600 });
    for (const [y, id] of [[0, "overview"], [250, "vault"], [850, "agent"], [1200, "activity"], [850, "agent"], [250, "vault"], [0, "overview"]] as const) {
      f.scroll(y);
      expect(f.active()).toBe(id);
    }
  });

  it("ignores missing sections on load, clicks, and bottom detection", () => {
    const f = fixture({ hash: "#activity", missing: ["activity"] });
    expect(f.tracker.select("activity")).toBe(false);
    expect(f.tracker.select("unknown")).toBe(false);
    f.scroll(600);
    expect(f.active()).toBe("agent");
    f.sections.clear();
    expect(() => f.scroll(0)).not.toThrow();
  });

  it("finds sections mounted after tracking started", () => {
    const f = fixture();
    const activity = f.sections.get("activity")!;
    f.sections.delete("activity");
    expect(f.tracker.select("activity")).toBe(false);
    f.sections.set("activity", activity);
    expect(f.tracker.select("activity")).toBe(true);
    expect(f.active()).toBe("activity");
  });

  it("uses instant scrolling when reduced motion is requested", () => {
    const f = fixture({ reducedMotion: true });
    f.tracker.select("activity");
    expect(f.page.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(f.sections.get("activity")!.scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
  });

  it("resumes after animation without scrollend support, including a click that cannot move the page", () => {
    const f = fixture();
    f.scroll(600);
    f.tracker.select("agent");
    vi.advanceTimersByTime(1000);
    // No timeout or bottom check should override the explicit selection.
    expect(f.active()).toBe("agent");
    f.scroll(598);
    expect(f.active()).toBe("activity");
  });

  it.each([
    ["wheel", {}], ["touchmove", {}], ["keydown", { key: "PageUp" }], ["pointerdown", { clientX: 1440 }],
  ])("allows %s to interrupt an ongoing navigation", (type, properties) => {
    const f = fixture();
    f.tracker.select("activity");
    f.emit(type, properties);
    f.scroll(300);
    expect(f.active()).toBe("vault");
  });

  it("honors hash changes and repeated sidebar selections", () => {
    const f = fixture();
    f.tracker.select("activity");
    f.tracker.select("vault");
    f.scroll(300);
    expect(f.active()).toBe("vault");
    f.page.location.hash = "#agent";
    f.emit("hashchange");
    expect(f.active()).toBe("agent");
  });

  it("removes listeners and pending timers when stopped", () => {
    const f = fixture();
    f.tracker.select("activity");
    f.tracker.stop();
    f.setActive.mockClear();
    f.scroll(300);
    f.emit("resize");
    f.page.location.hash = "#vault";
    f.emit("hashchange");
    expect(f.setActive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
