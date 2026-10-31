import { useEffect, useRef } from "react";

export const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function ParticleField({ quiet = false }: { quiet?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx) return;
    const reduced = prefersReducedMotion(), interactive = !reduced && !quiet;
    const look = quiet ? { min: 20, area: 32000, radius: 0.9, alpha: 0.85 } : { min: 40, area: 12000, radius: 0.6, alpha: 1 };
    let width = 0, height = 0, count = 0, px = -1e4, py = -1e4, frame = 0, last = 0;
    const RADIUS = 130, MAX = 160;
    const particles = Array.from({ length: MAX }, () => ({
      u: Math.random(), v: Math.random(),
      s: 0.000004 + Math.random() * 0.000008,
      z: Math.random(),
      pink: Math.random() < .5,
      ox: 0, oy: 0, vx: 0, vy: 0,
    }));
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas.clientWidth; height = canvas.clientHeight;
      canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      count = Math.min(MAX, Math.max(look.min, Math.round(width * height / look.area)));
    };
    const wrap = (value: number, max: number) => ((value % max) + max) % max;
    const draw = (t: number) => {
      const dt = last ? Math.min(t - last, 50) : 0;
      last = t;
      const step = dt / 16.67, damp = 0.88 ** step, scroll = window.scrollY;
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < count; i++) {
        const p = particles[i];
        if (!reduced) p.u += p.s * dt;
        const bx = wrap(p.u * width, width), by = wrap(p.v * height - scroll * (0.05 + p.z * 0.2), height);
        if (interactive) {
          const dx = bx + p.ox - px, dy = by + p.oy - py, d = Math.hypot(dx, dy);
          if (d < RADIUS && d > 0.01) {
            const push = (1 - d / RADIUS) ** 2 * (0.6 + p.z) * 1.6 * step;
            p.vx += (dx / d) * push; p.vy += (dy / d) * push;
          }
          p.vx = (p.vx - p.ox * 0.02 * step) * damp; p.vy = (p.vy - p.oy * 0.02 * step) * damp;
          p.ox += p.vx * step; p.oy += p.vy * step;
        }
        const twinkle = 0.75 + 0.25 * Math.sin(t / 2400 + i * 7.3);
        ctx.beginPath();
        ctx.arc(bx + p.ox, by + p.oy, look.radius + p.z * 1.6, 0, Math.PI * 2);
        const alpha = look.alpha * (0.35 + p.z * 0.65) * twinkle;
        ctx.fillStyle = p.pink ? `rgba(255,70,140,${0.5 * alpha})` : `rgba(255,255,255,${0.35 * alpha})`;
        ctx.fill();
      }
      frame = reduced ? 0 : requestAnimationFrame(draw);
    };
    const onPointer = (event: PointerEvent) => { px = event.clientX; py = event.clientY; };
    const onLeave = () => { px = py = -1e4; };
    const redraw = () => { if (reduced) draw(performance.now()); };
    const onResize = () => { size(); redraw(); };
    window.addEventListener("resize", onResize);
    if (reduced) window.addEventListener("scroll", redraw, { passive: true });
    if (interactive) {
      window.addEventListener("pointermove", onPointer, { passive: true });
      document.documentElement.addEventListener("pointerleave", onLeave);
    }
    size(); frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize); window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("scroll", redraw);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [quiet]);
  return <canvas className="particles" ref={canvasRef} aria-hidden="true" />;
}
