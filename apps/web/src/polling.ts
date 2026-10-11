/** One scheduler serializes state/activity polls and post-transaction refreshes. */
export function startDashboardPolling(options: {
  state(): Promise<void>;
  activity(): Promise<void>;
  onError(error: unknown): void;
  visibility?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
}) {
  const visibility = options.visibility ?? document;
  let stopped = false;
  let stateDue = 0, activityDue = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;

  function schedule() {
    clearTimeout(timer);
    if (!stopped && !visibility.hidden) {
      timer = setTimeout(() => { void poll(); }, Math.max(0, Math.min(stateDue, activityDue) - Date.now()));
    }
  }

  function poll(): Promise<void> {
    if (pending) return pending;
    if (stopped || visibility.hidden) return Promise.resolve();
    clearTimeout(timer);
    pending = (async () => {
      if (Date.now() >= stateDue) {
        stateDue = Date.now() + 10_000;
        try { await options.state(); } catch (error) { options.onError(error); }
      }
      if (!stopped && !visibility.hidden && Date.now() >= activityDue) {
        activityDue = Date.now() + 20_000;
        try { await options.activity(); } catch (error) { options.onError(error); }
      }
    })().finally(() => { pending = undefined; schedule(); });
    return pending;
  }

  async function refresh(): Promise<void> {
    // A confirmation during an older poll must cause a new read after that poll.
    if (pending) await pending;
    stateDue = activityDue = 0;
    await poll();
  }

  const onVisibility = () => {
    clearTimeout(timer);
    if (!visibility.hidden) void refresh();
  };
  visibility.addEventListener("visibilitychange", onVisibility);
  void poll();
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      visibility.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
