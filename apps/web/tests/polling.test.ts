import { afterEach, expect, it, vi } from "vitest";
import { startDashboardPolling } from "../src/polling";

afterEach(() => vi.useRealTimers());

function fixture(hidden = false) {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { hidden });
  const state = vi.fn(async () => {}), activity = vi.fn(async () => {}), onError = vi.fn();
  const poller = startDashboardPolling({ state, activity, onError, visibility });
  const show = (hidden: boolean) => { visibility.hidden = hidden; visibility.dispatchEvent(new Event("visibilitychange")); };
  return { state, activity, onError, poller, show };
}

it("polls state at 10s and activity at 20s: 15 idle RPC requests per minute", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.state.mockClear(); f.activity.mockClear();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.state).toHaveBeenCalledTimes(6);
  expect(f.activity).toHaveBeenCalledTimes(3);
  expect(f.state.mock.calls.length * 2 + f.activity.mock.calls.length).toBe(15);
  f.poller.stop();
});

it("starts no polls while hidden, resumes immediately, and removes listeners on stop", async () => {
  const f = fixture(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.state).not.toHaveBeenCalled(); expect(f.activity).not.toHaveBeenCalled();
  f.show(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state).toHaveBeenCalledTimes(1); expect(f.activity).toHaveBeenCalledTimes(1);
  f.show(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.state).toHaveBeenCalledTimes(1); expect(f.activity).toHaveBeenCalledTimes(1);
  await f.poller.refresh();
  expect(f.state).toHaveBeenCalledTimes(1);
  f.poller.stop(); f.show(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.state).toHaveBeenCalledTimes(1);
});

it("queues a confirmed-action refresh after an in-flight poll without overlap", async () => {
  const f = fixture(true);
  let finish!: () => void;
  f.state.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  f.show(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.state).toHaveBeenCalledTimes(1); expect(f.activity).not.toHaveBeenCalled();
  const refreshed = f.poller.refresh();
  finish(); await refreshed;
  expect(f.state).toHaveBeenCalledTimes(2);
  expect(f.activity).toHaveBeenCalledTimes(2);
  f.poller.stop();
});

it("does not start activity if the tab becomes hidden during state loading", async () => {
  const f = fixture(true);
  let finish!: () => void;
  f.state.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  f.show(false); f.show(true); finish();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.activity).not.toHaveBeenCalled();
  f.poller.stop();
});

it("continues polling after failures", async () => {
  const f = fixture(true);
  f.state.mockRejectedValueOnce(new Error("429"));
  f.show(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.onError).toHaveBeenCalledTimes(1);
  expect(f.state).toHaveBeenCalledTimes(2);
  f.poller.stop();
});

it("drops a late failure after the owner's poller stops", async () => {
  const f = fixture(true);
  let reject!: (error: unknown) => void;
  f.state.mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; }));
  f.show(false);
  f.poller.stop();
  reject(new Error("Wallet disconnected"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.activity).not.toHaveBeenCalled();
  expect(f.state).toHaveBeenCalledTimes(1);
});
