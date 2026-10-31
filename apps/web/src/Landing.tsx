import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BrandLogo } from "./BrandLogo";
import { SiteHeader } from "./SiteHeader";
import "./landing.css";

const GITHUB_URL = "https://github.com/codalexic/Aegis";
const CAP = 50; // per-trade cap used by the "Try it" demo (matches the demo vault)
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function Landing({ walletButton, status, children }: {
  walletButton(className: string): ReactNode; status?: ReactNode; children?: ReactNode;
}) {
  return <div className="landing">
    <SiteHeader actions={walletButton("site-wallet")} links={<>
      <a href="#story">How it works</a>
      <a href="#try">Try it</a>
      <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
    </>} />

    <main>
      <Hero walletButton={walletButton} status={status}>{children}</Hero>
      <Story />
      <TryIt />

      <section className="lp-final">
        <div className="lp-final-glow" aria-hidden="true" />
        <div className="lp-wrap lp-final-in">
          <h2>Trade with AI.<br /><span className="lp-grad">Sleep at night.</span></h2>
          <div className="lp-ctas">
            {walletButton("lp-btn lp-btn-pink lp-btn-lg")}
            <a className="lp-btn lp-btn-glass lp-btn-lg" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub<svg className="lp-i-out" {...STROKE} aria-hidden="true"><path d="M7 17L17 7M8 7h9v9" /></svg></a>
          </div>
        </div>
      </section>
    </main>

    <footer className="lp-foot">
      <div className="lp-wrap lp-foot-in">
        <BrandLogo height={20} />
        <span>© 2026 Aegis · Not audited yet. Test funds only.</span>
      </div>
    </footer>
  </div>;
}

const STROKE = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const Mark = ({ className }: { className?: string }) => <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
  <rect x="14" y="12" width="72" height="12" rx="6" fill="#FAFAFA" />
  <path d="M20 86 L41 50 Q50 35 59 50 L80 86" fill="none" stroke="#FF2E7E" strokeWidth="14" strokeLinejoin="round" strokeLinecap="round" />
</svg>;

function Hero({ walletButton, status, children }: { walletButton(className: string): ReactNode; status?: ReactNode; children?: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current, orb = orbRef.current, ctx = canvas?.getContext?.("2d");
    if (!canvas || !orb || !ctx) return;
    const reduced = prefersReducedMotion();
    let width = 0, height = 0, cx = 0, cy = 0, mx = 0, my = 0, frame = 0, visible = true;
    const particles = Array.from({ length: 70 }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 140 + Math.random() * 520,
      s: (0.0006 + Math.random() * 0.0016) * (Math.random() < .5 ? 1 : -1),
      z: Math.random(),
      pink: Math.random() < .55,
    }));
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas.clientWidth; height = canvas.clientHeight;
      canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const o = orb.getBoundingClientRect(), c = canvas.getBoundingClientRect();
      cx = o.left - c.left + o.width / 2; cy = o.top - c.top + o.height / 2;
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      for (const p of particles) {
        if (!reduced) p.a += p.s * 16;
        const k = 0.35 + p.z * 0.65;
        const x = cx + Math.cos(p.a) * p.r + mx * 30 * p.z;
        const y = cy + Math.sin(p.a) * p.r * 0.38 + my * 20 * p.z;
        const twinkle = 0.6 + 0.4 * Math.sin(t / 700 + p.r);
        ctx.beginPath();
        ctx.arc(x, y, 0.6 + p.z * 1.6, 0, Math.PI * 2);
        ctx.fillStyle = p.pink ? `rgba(255,70,140,${0.5 * k * twinkle})` : `rgba(255,255,255,${0.35 * k * twinkle})`;
        ctx.fill();
      }
      frame = !reduced && visible ? requestAnimationFrame(draw) : 0;
    };
    const onPointer = (event: PointerEvent) => {
      mx = event.clientX / window.innerWidth - .5; my = event.clientY / window.innerHeight - .5;
      if (!reduced) orb.style.transform = `translate(${mx * 14}px, ${my * 10}px)`;
    };
    window.addEventListener("resize", size);
    window.addEventListener("pointermove", onPointer, { passive: true });
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !frame && !reduced) frame = requestAnimationFrame(draw);
    });
    io.observe(canvas);
    size(); frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame); io.disconnect();
      window.removeEventListener("resize", size); window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  return <section className="lp-hero">
    <div className="lp-hero-aura" aria-hidden="true" />
    <canvas className="lp-hero-canvas" ref={canvasRef} aria-hidden="true" />
    <div className="lp-hero-in lp-wrap">
      {children}
      {/* Animated mark: the bar draws, the peak draws, then keeps pushing against the bar */}
      <div className="lp-hero-mark" ref={orbRef} aria-hidden="true">
        <svg viewBox="0 0 100 100">
          <g className="lp-hm-bar"><rect x="14" y="12" width="72" height="12" rx="6" fill="#FAFAFA" /></g>
          <g className="lp-hm-peak"><path d="M20 86 L41 50 Q50 35 59 50 L80 86" fill="none" stroke="#FF2E7E" strokeWidth="14" strokeLinejoin="round" strokeLinecap="round" pathLength={100} /></g>
        </svg>
      </div>
      <h1>Limits your AI <span className="lp-grad">can’t break.</span></h1>
      <p className="lp-sub">On-chain spending limits for AI trading agents.</p>
      <div className="lp-ctas">
        {walletButton("lp-btn lp-btn-pink lp-btn-lg")}
        <a className="lp-btn lp-btn-glass lp-btn-lg" href="#story">See how<svg className="lp-i-down" {...STROKE} aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg></a>
      </div>
      {status && <div className="lp-status">{status}</div>}
    </div>
  </section>;
}

const ICONS = {
  wallet: <svg {...STROKE}><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18" /></svg>,
  ai: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 2.5c.6 4.6 2.6 7.1 7.5 7.75-4.9.65-6.9 3.15-7.5 7.75-.6-4.6-2.6-7.1-7.5-7.75C8.4 9.6 10.4 7.1 11 2.5z" /><path d="M18.5 14.5c.25 1.8 1 2.75 2.75 3-1.75.25-2.5 1.2-2.75 3-.25-1.8-1-2.75-2.75-3 1.75-.25 2.5-1.2 2.75-3z" /></svg>,
  bug: <svg {...STROKE}><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /><circle cx="12" cy="8" r="4" /></svg>,
  vault: <svg {...STROKE}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="12" cy="12" r="3" /></svg>,
  ok: <svg {...STROKE} strokeWidth={3.5}><path d="M5 12l5 5 9-10" /></svg>,
  no: <svg {...STROKE} strokeWidth={3.5}><path d="M6 6l12 12M18 6L6 18" /></svg>,
};
type Tone = "" | "ok" | "no" | "warn";
type CardSpec = { icon: keyof typeof ICONS; label: string; pill: [string, Tone]; value: string; unit: string; sub: string; subTone?: Tone };
type Check = "" | "pass" | "fail";
type Scene = { state: "ok" | "no"; left: CardSpec; checks: [Check, Check, Check]; mid: string; right: CardSpec };

const SCENES: Scene[] = [
  { state: "ok",
    left: { icon: "wallet", label: "You", pill: ["Owner", ""], value: "1,000", unit: "USDC", sub: "Deposited" },
    checks: ["", "", ""], mid: "Cap 50 · Budget 100 · 1h",
    right: { icon: "vault", label: "Vault", pill: ["Locked", ""], value: "1,000", unit: "USDC", sub: "Only you can withdraw" } },
  { state: "ok",
    left: { icon: "ai", label: "AI agent", pill: ["Trade", ""], value: "20", unit: "USDC", sub: "Swap to SOL" },
    checks: ["pass", "pass", "pass"], mid: "Within the limits",
    right: { icon: "vault", label: "Result", pill: ["Executed", "ok"], value: "+0.13", unit: "SOL", sub: "Trade went through" } },
  { state: "no",
    left: { icon: "ai", label: "AI agent", pill: ["Fake news", "warn"], value: "1,000", unit: "USDC", sub: "“Buy 1,000 right now!”", subTone: "warn" },
    checks: ["fail", "", ""], mid: "Over the 50 USDC cap",
    right: { icon: "vault", label: "Result", pill: ["Blocked", "no"], value: "0", unit: "USDC", sub: "Nothing moved" } },
  { state: "no",
    left: { icon: "bug", label: "Hacked tool", pill: ["Redirect", "no"], value: "30", unit: "USDC", sub: "→ 9xF2…kLm" },
    checks: ["pass", "pass", "fail"], mid: "Wrong account",
    right: { icon: "vault", label: "Result", pill: ["Blocked", "no"], value: "1,000", unit: "USDC", sub: "Still in your vault" } },
];
const CAPTIONS: [ReactNode, string][] = [
  ["Set the limits.", "Your money, your rules, on-chain."],
  ["Your AI trades.", "Acceptable trades flow straight through."],
  [<>Tricked? <span className="lp-pink">Blocked.</span></>, "A fake headline can’t overspend."],
  [<>Hacked? <span className="lp-pink">Blocked.</span></>, "Coins can’t be sent anywhere else."],
];
const CHECK_NAMES = ["Cap", "Budget", "Account"];

function Card({ spec, className = "" }: { spec: CardSpec; className?: string }) {
  return <div className={`lp-node ${className}`}>
    <div className="lp-n-top"><span className="lp-n-ic">{ICONS[spec.icon]}</span><span className="lp-n-k">{spec.label}</span><span className={`lp-n-pill ${spec.pill[1]}`}>{spec.pill[0]}</span></div>
    <div><div className="lp-n-v">{spec.value}<small>{spec.unit}</small></div><div className={`lp-n-s ${spec.subTone ?? ""}`}>{spec.sub}</div></div>
  </div>;
}

function Story() {
  const story = useRef<HTMLElement>(null), flow = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState(0);     // follows scroll immediately (captions, dots)
  const [painted, setPainted] = useState(0); // the cards follow after a short fade
  useEffect(() => {
    const update = () => {
      const el = story.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const progress = Math.min(.999, Math.max(0, -rect.top / (rect.height - window.innerHeight)));
      setScene(Math.floor(progress * SCENES.length));
    };
    window.addEventListener("scroll", update, { passive: true }); window.addEventListener("resize", update); update();
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => {
    if (scene === painted) return;
    if (prefersReducedMotion()) { setPainted(scene); return; }
    const timer = window.setTimeout(() => setPainted(scene), 200);
    return () => window.clearTimeout(timer);
  }, [scene, painted]);
  // Restart the shared CSS cycle whenever new cards are painted.
  useLayoutEffect(() => {
    const el = flow.current;
    if (!el || prefersReducedMotion()) return;
    el.classList.remove("run"); void el.offsetWidth; el.classList.add("run");
  }, [painted]);

  const s = SCENES[painted];
  return <section className="lp-story" id="story" ref={story}>
    <div className="lp-story-sticky">
      <div className="lp-captions" aria-live="polite">
        {CAPTIONS.map(([title, line], i) => <div key={i} className={`lp-cap${i === scene ? " is-on" : ""}`}><h2>{title}</h2><p>{line}</p></div>)}
      </div>
      <div className={`lp-flow run${scene !== painted ? " fade" : ""}`} data-state={s.state} ref={flow}>
        <Card spec={s.left} />
        <div className="lp-conn c1" aria-hidden="true"><i /></div>
        <div className="lp-node mid">
          <div className="lp-n-top"><Mark className="lp-n-mark" /><span className="lp-n-k">Aegis</span></div>
          <div className="lp-checks">
            {s.checks.map((state, n) => <span key={n} className={`lp-ck ${state}`} style={{ "--n": n } as CSSProperties}>
              {state === "pass" ? ICONS.ok : state === "fail" ? ICONS.no : null}{CHECK_NAMES[n]}
            </span>)}
          </div>
          <div className="lp-n-s">{s.mid}</div>
        </div>
        <div className="lp-conn c2" aria-hidden="true"><i /></div>
        <Card spec={s.right} className="res" />
      </div>
      <div className="lp-steps" aria-hidden="true">
        <div className="lp-dots">{SCENES.map((_, i) => <i key={i} className={i === scene ? "is-on" : undefined} />)}</div>
        <span className="lp-steps-hint">Scroll<svg {...STROKE} strokeWidth={2.5}><path d="M6 9l6 6 6-6" /></svg></span>
      </div>
    </div>
    {SCENES.map((_, i) => <span key={i} className="lp-story-snap" style={{ "--i": i } as CSSProperties} aria-hidden="true" />)}
  </section>;
}

/** Terminal-style readout: whole units bright, cents dimmed ("120.00"). Built from a number only. */
function readout(amount: number) {
  const [whole, cents] = amount.toFixed(2).split(".");
  return `${whole}<span class="dec">.${cents}</span><small>USDC</small>`;
}

function TryIt() {
  const [value, setValue] = useState(40);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: Tone; shown: boolean }>({ text: "Ready when you are.", tone: "", shown: true });
  const [gateStatus, setGateStatus] = useState<{ text: string; tone: Tone }>({ text: "Ready", tone: "" });
  const amount = useRef<HTMLOutputElement>(null), chip = useRef<HTMLSpanElement>(null), gate = useRef<HTMLDivElement>(null);
  const shownAmount = useRef<number | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const el = amount.current;
    if (!el) return;
    const from = shownAmount.current;
    if (from === null || prefersReducedMotion()) { shownAmount.current = value; el.innerHTML = readout(value); return; }
    const start = performance.now(), duration = 450;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 3;
      shownAmount.current = from + (value - from) * eased;
      el.innerHTML = readout(t < 1 ? shownAmount.current : value);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  const over = value > CAP;
  const fire = async () => {
    const c = chip.current, g = gate.current, track = c?.parentElement;
    if (!c || !g || !track) return;
    if (!value) { setResult({ text: "Pick an amount first.", tone: "", shown: true }); return; }
    const reduced = prefersReducedMotion(), ms = (n: number) => (reduced ? 1 : n);
    const ok = value <= CAP;
    setBusy(true); setResult((r) => ({ ...r, shown: false }));
    c.className = "lp-t-chip"; c.innerHTML = `<i></i>${value} USDC`;
    const end = track.clientWidth - c.offsetWidth - 8;
    const at = (left: number, extra: Keyframe = {}) => ({ left: `${left}px`, opacity: 1, transform: "translateY(-50%) scale(1)", ...extra });
    await c.animate([at(0, { opacity: 0 }), at(end * .15, { offset: .2 }), at(end)],
      { duration: ms(900), easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" }).finished.catch(() => undefined);
    if (!mounted.current) return;
    g.classList.add(ok ? "ok" : "no"); c.classList.add(ok ? "ok" : "no");
    setGateStatus(ok ? { text: "Approved", tone: "ok" } : { text: "Blocked", tone: "no" });
    setResult({ text: ok ? "Goes through" : `Blocked · over the ${CAP} cap`, tone: ok ? "ok" : "no", shown: true });
    await (ok
      ? c.animate([at(end), at(end + c.offsetWidth * .7, { opacity: 0, transform: "translateY(-50%) scale(.5)" })], { duration: ms(380), easing: "cubic-bezier(.5,0,.9,.5)", fill: "forwards" })
      : c.animate([at(end), at(end - 30, { offset: .45 }), at(end - 18)], { duration: ms(520), easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" })
    ).finished.catch(() => undefined);
    await sleep(ms(1300));
    if (!mounted.current) return;
    c.animate([{ opacity: ok ? 0 : 1 }, { opacity: 0 }], { duration: ms(300), fill: "forwards" });
    g.classList.remove("ok", "no"); setGateStatus({ text: "Ready", tone: "" }); setBusy(false);
  };

  return <section className="lp-try" id="try">
    <div className="lp-wrap">
      <div className="lp-try-head">
        <h2>Try it.</h2>
        <p className="lp-sub">Pick a trade size and send it through Aegis.</p>
      </div>
      <div className="lp-glass lp-try-card">
        <div className="lp-tc-col">
          <div className="lp-tc-k"><span>Trade size</span><span className="lp-tc-cap">Cap {CAP} USDC</span></div>
          <output className={`lp-t-amount lp-num${over ? " over" : ""}`} htmlFor="lp-amount" ref={amount} />
          <div className="lp-t-range">
            <input id="lp-amount" type="range" min="0" max="200" step="5" value={value} aria-label="Trade size in USDC"
              onChange={(event) => setValue(Number(event.target.value))}
              style={{ "--p": `${(value / 200) * 100}%`, "--fill": over ? "#FF2E7E" : "#FAFAFA" } as CSSProperties} />
            <span className="lp-t-cap" style={{ left: `${(CAP / 200) * 100}%` }} aria-hidden="true" />
          </div>
          <div className="lp-t-presets" role="group" aria-label="Quick amounts">
            {[20, 50, 120, 200].map((preset) => <button key={preset} type="button" aria-pressed={value === preset} onClick={() => setValue(preset)}>{preset}</button>)}
          </div>
        </div>
        <div className="lp-tc-col lp-tc-right">
          <div className="lp-tc-k"><span>Result</span></div>
          <div className={`lp-try-lane${busy ? " is-busy" : ""}`}>
            <div className="lp-t-stop">
              <div className="lp-t-orb">{ICONS.ai}</div>
              <p><b>AI agent</b><small>Proposes {value} USDC</small></p>
            </div>
            <div className="lp-t-track"><span className="lp-t-comet" aria-hidden="true" /><span className="lp-t-chip" ref={chip} /></div>
            <div className="lp-t-stop">
              <div className="lp-t-orb is-gate" ref={gate}><Mark /></div>
              <p><b>Aegis</b><small className={gateStatus.tone}>{gateStatus.text}</small></p>
            </div>
          </div>
          <div className="lp-tc-foot">
            <p className={`lp-t-result ${result.tone}`} style={{ opacity: result.shown ? 1 : 0 }} aria-live="polite">{result.text}</p>
            <button className="lp-btn lp-btn-pink lp-t-send" type="button" disabled={busy} onClick={() => void fire()}>
              Send trade<svg className="lp-i-right" {...STROKE} aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>;
}
