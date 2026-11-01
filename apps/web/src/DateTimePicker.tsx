import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { Select } from "./Select";
import { localDateTime } from "./vault-setup";

const GAP = 6, EDGE = 12;
const WEEKDAYS = Array.from({ length: 7 }, (_, day) => new Date(2023, 0, 1 + day).toLocaleDateString([], { weekday: "narrow" }));
const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" }) }));
const MINUTES = Array.from({ length: 60 }, (_, minute) => ({ value: String(minute), label: String(minute).padStart(2, "0") }));

export function DateTimePicker({ id, value, min, max, invalid, describedBy, onChange }: {
  id: string; value: string; min: number; max: number; invalid?: boolean; describedBy?: string; onChange(value: string): void;
}) {
  const date = new Date(value);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ year: date.getFullYear(), month: date.getMonth() });
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  useEffect(() => { const next = new Date(value); setView({ year: next.getFullYear(), month: next.getMonth() }); }, [value]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect(), panel = popover.current!;
      const below = anchor.bottom + GAP, above = anchor.top - GAP - panel.offsetHeight;
      const top = below + panel.offsetHeight <= window.innerHeight - EDGE ? below : Math.max(EDGE, above);
      panel.style.top = `${top}px`;
      panel.style.left = `${Math.max(EDGE, Math.min(anchor.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - EDGE))}px`;
    };
    place();
    const onOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onOutside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const change = (update: (next: Date) => void) => { const next = new Date(value); update(next); onChange(localDateTime(next.getTime())); };
  const pickDay = (day: number) => {
    const next = new Date(value);
    next.setFullYear(view.year, view.month, day);
    onChange(localDateTime(Math.min(max, Math.max(min, next.getTime()))));
  };
  const today = new Date();
  const count = new Date(view.year, view.month + 1, 0).getDate(), offset = new Date(view.year, view.month, 1).getDay();

  return <div className="datetime" ref={root}>
    <input type="hidden" id={id} value={value} />
    <button type="button" id={`${id}-button`} ref={trigger} aria-haspopup="dialog" className={`field-button${invalid ? " is-invalid" : ""}`} aria-expanded={open} aria-describedby={describedBy} onClick={() => setOpen(!open)}>
      <span>{date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span><Icon name="calendar" size={16} />
    </button>
    {open && <div className="calendar" role="dialog" aria-label="Choose date and time" ref={popover}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <div className="calendar-head">
        <button type="button" className="icon-button calendar-prev" aria-label="Previous month" disabled={new Date(view.year, view.month, 1).getTime() <= min}
          onClick={() => setView(({ year, month }) => month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 })}><Icon name="chevron" size={16} /></button>
        <strong aria-live="polite">{new Date(view.year, view.month).toLocaleDateString([], { month: "long", year: "numeric" })}</strong>
        <button type="button" className="icon-button calendar-next" aria-label="Next month" disabled={new Date(view.year, view.month + 1, 1).getTime() > max}
          onClick={() => setView(({ year, month }) => month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 })}><Icon name="chevron" size={16} /></button>
      </div>
      <div className="calendar-grid">
        {WEEKDAYS.map((name, index) => <span key={index} className="calendar-weekday" aria-hidden="true">{name}</span>)}
        {Array.from({ length: offset }, (_, index) => <span key={`blank-${index}`} />)}
        {Array.from({ length: count }, (_, index) => {
          const day = index + 1, start = new Date(view.year, view.month, day), end = new Date(view.year, view.month, day + 1);
          const selected = date.getFullYear() === view.year && date.getMonth() === view.month && date.getDate() === day;
          const isToday = today.getFullYear() === view.year && today.getMonth() === view.month && today.getDate() === day;
          return <button type="button" key={day} className={`calendar-day${selected ? " is-selected" : ""}${isToday ? " is-today" : ""}`} aria-pressed={selected}
            aria-label={start.toLocaleDateString([], { dateStyle: "full" })} disabled={end.getTime() <= min || start.getTime() > max} onClick={() => pickDay(day)}>{day}</button>;
        })}
      </div>
      <div className="calendar-time">
        <Select label="Hour" value={String(date.getHours())} options={HOURS} onChange={(hour) => change((next) => next.setHours(Number(hour)))} />
        <span aria-hidden="true">:</span>
        <Select label="Minute" value={String(date.getMinutes())} options={MINUTES} onChange={(minute) => change((next) => next.setMinutes(Number(minute), 0))} />
      </div>
    </div>}
  </div>;
}
