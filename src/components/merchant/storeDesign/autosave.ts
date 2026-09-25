/**
 * AUTOSAVE FOR THE STORE DRAFT — debounced, one save in flight, fenced on the
 * draft version, and honest about every way a save can fail.
 *
 * Framework-free so tests/storeDesignEditor.test.ts can drive it with fake
 * timers and a fake server; the editor hook (useLayoutEditor.ts) owns one.
 *
 *   - Every change hands the saver the NORMALISED layout (`validateLayout`'s
 *     `result.layout`) and whether it has a fatal issue. What is sent is that
 *     normalised layout, never the editor's working copy.
 *   - A layout with a fatal issue is NOT saved (status `blocked`): the
 *     inspector shows the field, and the last good draft stays on the server.
 *   - `delay` after the last change, the latest layout is PUT with the
 *     version it was based on. Changes made while a save is in flight are
 *     saved right after it, with the version that save returned.
 *   - 409 DRAFT_CHANGED (another tab or device saved first) stops autosaving
 *     (status `conflict`) until the merchant chooses: reload theirs, or keep
 *     mine (`keepMine(version)` saves this layout over the newer draft).
 *   - Any other failure is status `error`; the next change or `flush()`
 *     tries again. Nothing is ever retried in a loop behind the merchant.
 */
import type { LayoutIssue } from '../../../../packages/storeLayout/src/normalize';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict' | 'blocked';

export interface SaverState {
  status: SaveStatus;
  /** The draft version the next save is fenced on (0 = no draft row yet). */
  version: number;
  /** Issues the server reported for the last save (refs it removed, …). */
  issues: LayoutIssue[];
  /** On `conflict`: the version the server now has, when it said. */
  conflictVersion: number | null;
  /** On `error`: the refusal code, when there was one. */
  errorCode: string | null;
}

export interface SaveAnswer {
  version: number;
  layout: StoreLayout;
  issues: LayoutIssue[];
}

export interface SaverDeps {
  save: (layout: StoreLayout, version: number) => Promise<SaveAnswer>;
  /** Called on every state change. */
  onState: (s: SaverState) => void;
  /** The server's answer, with what was sent — for the editor to adopt what it cleaned. */
  onSaved?: (answer: SaveAnswer, sentJson: string) => void;
  delay?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Latest {
  layout: StoreLayout;
  json: string;
  fatal: boolean;
}

function codeOf(e: unknown): { code: string | null; details: Record<string, unknown> } {
  const o = (e ?? {}) as { code?: unknown; details?: unknown; body?: unknown };
  const details = (o.details && typeof o.details === 'object' ? o.details : o.body && typeof o.body === 'object' ? o.body : {}) as Record<string, unknown>;
  return { code: typeof o.code === 'string' ? o.code : null, details };
}

export class DraftSaver {
  private deps: Required<Omit<SaverDeps, 'onSaved'>> & Pick<SaverDeps, 'onSaved'>;
  private state: SaverState;
  private savedJson: string;
  private latest: Latest | null = null;
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  private disposed = false;

  constructor(deps: SaverDeps, initial: { version: number; layout: StoreLayout }) {
    this.deps = {
      delay: 900,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
    this.savedJson = JSON.stringify(initial.layout);
    this.state = { status: 'saved', version: initial.version, issues: [], conflictVersion: null, errorCode: null };
  }

  get snapshot(): SaverState {
    return this.state;
  }

  /** Whether what the editor holds is not yet on the server. */
  get unsaved(): boolean {
    return !!this.latest && this.latest.json !== this.savedJson;
  }

  private set(patch: Partial<SaverState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.deps.onState(this.state);
  }

  private cancelTimer() {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms = this.deps.delay) {
    this.cancelTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  /** The editor changed: `layout` is the normalised layout, `fatal` whether the gate refuses it. */
  update(layout: StoreLayout, fatal: boolean) {
    const json = JSON.stringify(layout);
    this.latest = { layout, json, fatal };
    if (this.state.status === 'conflict') return;
    if (fatal) {
      this.cancelTimer();
      this.set({ status: 'blocked' });
      return;
    }
    if (json === this.savedJson) {
      this.cancelTimer();
      if (!this.inflight) this.set({ status: 'saved', errorCode: null });
      return;
    }
    if (!this.inflight) this.set({ status: 'pending', errorCode: null });
    this.schedule();
  }

  private async run(): Promise<void> {
    if (this.inflight) return this.inflight;
    const job = this.latest;
    if (!job || job.fatal || job.json === this.savedJson || this.state.status === 'conflict') return;
    this.set({ status: 'saving' });
    this.inflight = (async () => {
      try {
        const answer = await this.deps.save(job.layout, this.state.version);
        this.savedJson = job.json;
        this.set({ version: answer.version, issues: answer.issues ?? [], errorCode: null });
        this.deps.onSaved?.(answer, job.json);
      } catch (e) {
        const { code, details } = codeOf(e);
        if (code === 'DRAFT_CHANGED') {
          const v = details.version;
          this.set({ status: 'conflict', conflictVersion: typeof v === 'number' ? v : null });
        } else if (code === 'LAYOUT_REJECTED') {
          const issues = Array.isArray(details.issues) ? (details.issues as LayoutIssue[]) : [];
          this.set({ status: 'blocked', issues, errorCode: code });
        } else {
          this.set({ status: 'error', errorCode: code });
        }
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
    if (this.state.status === 'saving') {
      // Saved. Anything typed meanwhile goes next, on the new version.
      const next = this.latest;
      if (next && next.json !== this.savedJson && !next.fatal) {
        this.set({ status: 'pending' });
        this.schedule(0);
      } else {
        this.set({ status: next?.fatal ? 'blocked' : 'saved' });
      }
    }
  }

  /**
   * Save now and wait (before publishing, restoring, leaving). True when the
   * server holds exactly what the editor holds.
   */
  async flush(): Promise<boolean> {
    this.cancelTimer();
    for (let i = 0; i < 4; i++) {
      this.cancelTimer();
      if (this.inflight) await this.inflight;
      const st = this.state.status;
      if (st === 'conflict' || st === 'blocked') return false;
      if (!this.unsaved) {
        if (st === 'pending') this.set({ status: 'saved' });
        return true;
      }
      await this.run();
      const after = this.state.status;
      if (after === 'error' || after === 'conflict' || after === 'blocked') return false;
    }
    return !this.unsaved;
  }

  /** «Keep mine»: save this layout over the newer draft, fenced on the version it now has. */
  keepMine(version: number) {
    this.set({ status: 'pending', version, conflictVersion: null, errorCode: null });
    return this.flush();
  }

  /** The server's draft is now the baseline (after a reload, a publish or a restore). */
  adopt(version: number, layout: StoreLayout) {
    this.cancelTimer();
    this.savedJson = JSON.stringify(layout);
    this.latest = { layout, json: this.savedJson, fatal: false };
    this.set({ status: 'saved', version, issues: [], conflictVersion: null, errorCode: null });
  }

  dispose() {
    this.cancelTimer();
    this.disposed = true;
  }
}
