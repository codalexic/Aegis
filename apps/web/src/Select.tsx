import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons";

const LIST_HEIGHT = 232;

export function Select({ id, label, value, options, disabled, onChange }: {
  id?: string; label?: string; value: string; options: readonly { value: string; label: string }[]; disabled?: boolean; onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    const onOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [open]);

  const show = () => {
    const button = trigger.current!;
    const bottom = button.closest(".calendar") ? window.innerHeight : button.closest(".modal-body")?.getBoundingClientRect().bottom ?? window.innerHeight;
    setAbove(button.getBoundingClientRect().bottom + LIST_HEIGHT > bottom);
    setOpen(true);
  };
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (target !== undefined) { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, target))].focus(); }
    else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); }
  };

  return <div className="select" ref={root}>
    <button type="button" className="field-button" id={id} ref={trigger} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open}
      onClick={() => open ? setOpen(false) : show()}
      onKeyDown={(event) => { if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); show(); } }}>
      <span>{options.find((option) => option.value === value)?.label}</span><Icon name="chevron" size={14} />
    </button>
    {open && <div className={`select-list${above ? " is-above" : ""}`} role="listbox" aria-label={label} onKeyDown={onListKey}>
      {options.map((option) => <button type="button" role="option" tabIndex={-1} key={option.value} className="select-option" aria-selected={option.value === value} data-value={option.value}
        onClick={() => { onChange(option.value); close(); }}>{option.label}</button>)}
    </div>}
  </div>;
}
