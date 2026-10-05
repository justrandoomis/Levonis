export type StaffReconciliation = {
  staff_id: string; revision: number; state: 'pending' | 'running' | 'complete' | 'failed';
  cursor: string; processed_orders: number; adjusted_orders: number; error?: string | null; updated_at: string;
};
export type ReconciliationActivity = { busy: boolean; error?: string; retrying?: boolean };
type Entry = { job: StaffReconciliation; next: number; failures: number; blocked: boolean; readFirst: boolean; retryFailed: boolean };
type Options = {
  advance: (job: StaffReconciliation) => Promise<StaffReconciliation>;
  read: (staffId: string) => Promise<StaffReconciliation>;
  refresh: (final: boolean) => Promise<unknown>;
  onJob: (job: StaffReconciliation) => void;
  onActivity: (staffId: string, activity: ReconciliationActivity) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
};

const runnable = (entry: Entry) => !entry.blocked && entry.job.state !== 'complete' && (entry.job.state === 'pending' || entry.job.state === 'running' || entry.retryFailed);
const progressed = (before: StaffReconciliation, after: StaffReconciliation) => after.revision !== before.revision || after.cursor !== before.cursor || after.processed_orders !== before.processed_orders || after.state !== before.state;
const older = (next: StaffReconciliation, current: StaffReconciliation) => next.revision < current.revision || next.revision === current.revision && (next.processed_orders < current.processed_orders || next.processed_orders === current.processed_orders && (Date.parse(next.updated_at) < Date.parse(current.updated_at) || current.state === 'complete' && next.state !== 'complete'));

/** One page at a time. A lost POST response is read back before another write. */
export function createStaffReconciliationRunner(options: Options) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
  const entries = new Map<string, Entry>();
  let enabled = false, active = false, cancelTimer: (() => void) | undefined, lastRefresh = 0, pagesSinceRefresh = 0;

  function accept(job: StaffReconciliation) {
    const previous = entries.get(job.staff_id);
    if (previous && older(job, previous.job)) return previous;
    const changed = !previous || progressed(previous.job, job);
    const newRevision = previous && job.revision > previous.job.revision;
    const entry: Entry = previous ?? { job, next: now(), failures: 0, blocked: false, readFirst: false, retryFailed: false };
    entry.job = job;
    if (newRevision) entry.next = now();
    if (changed) { entry.failures = 0; entry.blocked = false; }
    entries.set(job.staff_id, entry);
    return entry;
  }
  function publish(job: StaffReconciliation) {
    const entry = accept(job);
    if (enabled) options.onJob(entry.job);
    return entry;
  }
  function queue() {
    cancelTimer?.(); cancelTimer = undefined;
    if (!enabled || active) return;
    const next = [...entries.values()].filter(runnable).sort((a, b) => a.next - b.next)[0];
    if (next) cancelTimer = schedule(() => { cancelTimer = undefined; void tick(); }, Math.max(0, next.next - now()));
  }
  async function refresh(final: boolean) {
    if (!enabled || !final && pagesSinceRefresh < 5 && now() - lastRefresh < 5000) return;
    await options.refresh(final);
    lastRefresh = now(); pagesSinceRefresh = 0;
  }
  async function tick() {
    if (!enabled || active) return;
    let entry = [...entries.values()].filter(runnable).sort((a, b) => a.next - b.next)[0];
    if (!entry || entry.next > now()) { queue(); return; }
    const staffId = entry.job.staff_id;
    active = true;
    options.onActivity(staffId, { busy: true });
    try {
      if (entry.readFirst) {
        const current = await options.read(staffId);
        if (!enabled) return;
        entry = publish(current); entry.readFirst = false;
      }
      if (entry.job.state === 'complete' || entry.job.state === 'failed' && !entry.retryFailed) {
        entry.retryFailed = false;
        await refresh(true);
        if (enabled) options.onActivity(staffId, { busy: false, error: entry.job.error || undefined });
        return;
      }
      const previous = entry.job;
      const result = await options.advance(previous);
      if (!enabled) return;
      entry = publish(result); entry.retryFailed = false; entry.failures = 0;
      // Another administrator may have changed the revision during this page.
      // accept() keeps that newer revision and discards the older response.
      entry.next = now() + (progressed(previous, entry.job) ? 1200 : 5000);
      pagesSinceRefresh += 1;
      await refresh(entry.job.state === 'complete' || entry.job.state === 'failed');
      if (enabled) options.onActivity(staffId, { busy: false, error: entry.job.state === 'failed' ? entry.job.error || undefined : undefined });
    } catch (error) {
      if (!enabled) return;
      const previous = entry.job;
      let verified = false;
      try {
        entry = publish(await options.read(staffId));
        if (!enabled) return;
        verified = true; entry.readFirst = false;
      } catch { entry.readFirst = true; }
      if (!enabled) return;
      entry.retryFailed = false;
      if (verified && entry.job.state === 'complete') {
        await refresh(true).catch(() => undefined);
        if (enabled) options.onActivity(staffId, { busy: false });
      } else if (verified && entry.job.state === 'failed') {
        await refresh(true).catch(() => undefined);
        if (enabled) options.onActivity(staffId, { busy: false, error: entry.job.error || String(error) });
      } else {
        entry.failures = verified && progressed(previous, entry.job) ? 0 : entry.failures + 1;
        entry.blocked = entry.failures >= 3;
        // A timed-out request can still be running on the server. Even a GET
        // with the same cursor is not proof that its write has stopped.
        entry.next = now() + Math.min(30000, 5000 * 2 ** Math.max(0, entry.failures - 1));
        if (verified) await refresh(false).catch(() => undefined);
        if (enabled) options.onActivity(staffId, { busy: false, error: error instanceof Error ? error.message : String(error), retrying: !entry.blocked });
      }
    } finally {
      active = false;
      queue();
    }
  }
  return {
    start() { enabled = true; queue(); },
    stop() { enabled = false; cancelTimer?.(); cancelTimer = undefined; },
    sync(jobs: readonly StaffReconciliation[]) { for (const job of jobs) accept(job); queue(); },
    retry(job: StaffReconciliation) {
      const entry = accept(job);
      entry.blocked = false; entry.failures = 0; entry.retryFailed = true; entry.readFirst = true; entry.next = now();
      queue();
    },
  };
}
