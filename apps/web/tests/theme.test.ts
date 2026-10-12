import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const declarations = (block: string) => Object.fromEntries(
  [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
);
const tokens = {
  ...declarations(css.match(/:root\s*\{([^}]+)\}/)![1]),
  ...declarations(css.match(/\.shell--start, \.shell--dark\s*\{([^}]+)\}/)![1]),
};
function color(name: string): number[] {
  const value = tokens[name];
  if (value.startsWith("var(")) return color(value.slice(4, -1));
  expect(value).toMatch(/^#[\da-f]{6}$/i);
  return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
}
function luminance(rgb: number[]): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(foreground: number[], background: number[]): number {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const surfaces = ["--bg", "--card", "--surface-hover", "--good-bg", "--bad-bg", "--warn-bg"];
const textColors = ["--ink", "--ink-2", "--ink-3", "--accent", "--accent-hover", "--good-ink", "--bad-ink", "--warn-ink"];
it.each(textColors)("keeps %s text AA on every dark surface", (foreground) => {
  for (const background of surfaces) {
    expect(contrast(color(foreground), color(background)), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
});
it.each(["--accent", "--accent-hover", "--good", "--bad"])("keeps dark labels AA on %s fills", (background) => {
  expect(contrast(color("--on-accent"), color(background))).toBeGreaterThanOrEqual(4.5);
});
it.each(["--control-line", "--focus", "--good", "--bad", "--bad-ink"])("keeps %s UI boundaries at least 3:1", (foreground) => {
  for (const background of surfaces) expect(contrast(color(foreground), color(background))).toBeGreaterThanOrEqual(3);
});
it("keeps chart gradients distinguishable even at their least opaque stop", () => {
  for (const [foreground, opacity] of [["--chart-ink", 0.7], ["--chart-bad", 0.72]] as const) {
    for (const background of ["--chart-surface", "--chart-band"]) {
      const bg = color(background);
      const blended = color(foreground).map((channel, i) => channel * opacity + bg[i] * (1 - opacity));
      expect(contrast(blended, bg)).toBeGreaterThanOrEqual(3);
    }
  }
});
it("reports the main contrast pairs from the actual stylesheet tokens", () => {
  const pairs = [
    ["Primary / canvas", "--ink", "--bg"], ["Primary / card", "--ink", "--card"],
    ["Secondary / canvas", "--ink-2", "--bg"], ["Secondary / card", "--ink-2", "--card"],
    ["Secondary / hover", "--ink-2", "--surface-hover"],
    ["Accent / card", "--accent", "--card"], ["Accent / selected", "--accent", "--surface-hover"],
    ["Button / accent", "--on-accent", "--accent"], ["Button / accent hover", "--on-accent", "--accent-hover"],
    ["Success / card", "--good-ink", "--card"], ["Success / notice", "--good-ink", "--good-bg"],
    ["Danger / card", "--bad-ink", "--card"], ["Danger / hover or notice", "--bad-ink", "--bad-bg"],
    ["Control border / hover", "--control-line", "--surface-hover"],
  ];
  console.table(pairs.map(([pair, fg, bg]) => ({ pair, contrast: contrast(color(fg), color(bg)).toFixed(2) + ":1" })));
});
