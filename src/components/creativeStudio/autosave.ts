/**
 * AUTOSAVE — debounced, version-fenced, honest.
 *
 * Every change schedules a save ~1.2 s later; a burst of edits is one save.
 * The PUT carries the version the editor started from (`base_version`); the
 * server writes only if nobody saved in between, and answers 409
 * VERSION_CONFLICT otherwise — then this controller STOPS and says so, and the
 * owner chooses (reload theirs, or keep mine as a new design). It never
 * retries a conflict on top of someone else’s work.
 *
 * The state it reports is the truth of the last request: `saved` only after
 * the server answered 200 for the content now on screen; `offline` when the
 * request could not reach the server (the local recovery draft holds the
 * work); `failed` for any other refusal, with a retry.
 *
 * Timers are injectable so tests drive it without waiting
 * (tests/creativeStudioUiModel.test.ts).
 */
import type { VersionOrigin } from '../../../packages/creativeDoc/src/api';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import type { SaveResult } from './client';

/** Who made the change being saved: a person’s edits (`manual`), or an AI answer the owner applied (with its job). */
export interface SaveMeta {
  origin: VersionOrigin;
  job_id: string | null;
}

const MANUAL: SaveMeta = { origin: 'manual', job_id: null };

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed' | 'offline' | 'conflict';

export interface AutosaveDeps {
  save(content: CreativeDocument, baseVersion: number, meta: SaveMeta): Promise<SaveResult>;
  onState(state: SaveState, error?: unknown): void;
  /** After a 200: the content the server now holds and its new version. */
  onSaved(content: CreativeDocument, result: SaveResult): void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function codeOf(e: unknown): string {
  return e && typeof e === 'object' && 'code' in e && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
}

export class Autosave {
  private saved: CreativeDocument;
  private pending: CreativeDocument | null = null;
  private version: number;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private state: SaveState = 'idle';
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private deps: AutosaveDeps, initial: { content: CreativeDocument; version: number }) {
    this.saved = initial.content;
    this.version = initial.version;
    this.debounceMs = deps.debounceMs ?? 1200;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get current(): SaveState {
    return this.state;
  }

  get baseVersion(): number {
    return this.version;
  }

  /** True while something on screen has not reached the server. */
  get hasUnsaved(): boolean {
    return this.pending !== null || this.state === 'saving';
  }

  private set(state: SaveState, error?: unknown) {
    this.state = state;
    this.deps.onState(state, error);
  }

  /** The editor’s document changed. */
  change(doc: CreativeDocument): void {
    if (this.state === 'conflict') {
      this.pending = doc;
      return;
    }
    if (doc === this.saved && !this.inFlight) {
      this.pending = null;
      this.cancelTimer();
      this.set(this.state === 'dirty' ? 'saved' : this.state);
      return;
    }
    this.pending = doc;
    if (this.state !== 'saving') this.set('dirty');
    this.schedule();
  }

  private cancelTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  /** Save now (leaving the page, the tab hidden, before an AI request or an export). */
  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.inFlight) await this.inFlight;
    if (this.pending && this.state !== 'conflict') await this.run();
  }

  /** Try again after `failed` or `offline`. */
  retry(): Promise<void> {
    if (this.state === 'conflict') return Promise.resolve();
    return this.flush();
  }

  /**
   * Save `content` now with its own origin (an applied AI answer keeps its
   * job id). Waits for a save already on its way; resolves with the server’s
   * answer, or null when it failed (the state says why).
   */
  async saveAs(content: CreativeDocument, meta: SaveMeta): Promise<SaveResult | null> {
    this.cancelTimer();
    if (this.inFlight) await this.inFlight;
    if (this.state === 'conflict') return null;
    this.pending = content;
    let result: SaveResult | null = null;
    await this.run(meta, (r) => { result = r; });
    return result;
  }

  private run(meta: SaveMeta = MANUAL, onResult?: (r: SaveResult) => void): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const sent = this.pending;
    if (!sent || this.state === 'conflict') return Promise.resolve();
    this.set('saving');
    this.inFlight = this.deps.save(sent, this.version, meta).then(
      (result) => {
        this.inFlight = null;
        this.version = result.version;
        this.saved = sent;
        onResult?.(result);
        this.deps.onSaved(sent, result);
        if (this.pending === sent) {
          this.pending = null;
          this.set('saved');
        } else {
          // More edits arrived while this one was on its way.
          this.set('dirty');
          this.schedule();
        }
      },
      (error: unknown) => {
        this.inFlight = null;
        const code = codeOf(error);
        if (code === 'VERSION_CONFLICT') this.set('conflict', error);
        else if (code === 'NETWORK') this.set('offline', error);
        else this.set('failed', error);
      },
    );
    return this.inFlight;
  }

  /**
   * The server copy is the base from here (a reload, an AI apply saved
   * elsewhere, a restore). Clears a conflict.
   */
  rebase(content: CreativeDocument, version: number): void {
    this.cancelTimer();
    this.saved = content;
    this.version = version;
    this.pending = null;
    this.set('saved');
  }

  dispose(): void {
    this.cancelTimer();
  }
}
