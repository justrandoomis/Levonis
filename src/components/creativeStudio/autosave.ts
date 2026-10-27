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
 * A SAVE WHOSE ANSWER WAS LOST IS NOT A CONFLICT. When the network or the
 * deadline ate the answer (NETWORK, TIMEOUT, a code-less 5xx), the write may
 * still have landed — and the next save, fenced on the old version, would
 * then meet a 409 that blames «someone else». So the content of every such
 * save is remembered, and the first VERSION_CONFLICT after one reads the
 * server copy (`load`): if it is exactly what was sent, that version is
 * adopted as the base and the save goes on; only otherwise is it a conflict.
 *
 * AN APPLIED AI ANSWER KEEPS ITS AUTHOR. If its save fails (offline), the
 * retry still saves it with origin `ai` and its job id — until a person edits
 * on top of it, which makes the pending content theirs.
 *
 * Timers and the read-back are injectable so tests drive it without waiting
 * (tests/creativeStudioUiModel.test.ts, tests/creativeStudioUiAutosave.test.ts).
 */
import type { VersionOrigin } from '../../../packages/creativeDoc/src/api';
import { normalizeDocument } from '../../../packages/creativeDoc/src/normalize';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import { canonicalJson } from '../../../packages/creativeDoc/src/snapshot';
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
  /**
   * The server copy now (GET). Asked only on a 409 that follows a save whose
   * answer was lost, to learn whether that save landed. Without it such a
   * 409 is reported as a conflict.
   */
  load?(): Promise<{ content: unknown; version: number; updated_at?: string | null }>;
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

/** The write may have landed although no answer said so: the answer was lost, the client stopped waiting, or the server failed with no refusal of its own. */
function mayHaveLanded(e: unknown): boolean {
  const code = codeOf(e);
  if (code === 'NETWORK' || code === 'TIMEOUT') return true;
  const status = e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 0;
  return status >= 500 && !code;
}

/** The same document, whatever the key order or a normaliser's default (the server stores the normalised form). */
function sameContent(a: unknown, b: unknown): boolean {
  const norm = (x: unknown) => {
    const n = normalizeDocument(x);
    return canonicalJson(n.ok ? n.doc : x);
  };
  return norm(a) === norm(b);
}

/** At most this many lost answers are remembered (they all share one base version, so at most one of them landed). */
const MAX_UNCERTAIN = 6;

export class Autosave {
  private saved: CreativeDocument;
  private pending: CreativeDocument | null = null;
  /** Who made what is pending, when it is an AI answer whose save failed (kept until a save succeeds or a person edits on top). */
  private pendingMeta: SaveMeta | null = null;
  /** Content sent in saves whose answer was lost — any of them may be what the server now holds. */
  private uncertain: CreativeDocument[] = [];
  private lastError: unknown = null;
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

  /** The code of the last failed request ('' when it had none). */
  get lastErrorCode(): string {
    return codeOf(this.lastError);
  }

  private set(state: SaveState, error?: unknown) {
    this.state = state;
    this.deps.onState(state, error);
  }

  /** The editor’s document changed — by a person (an applied AI answer arrives through `saveAs`). */
  change(doc: CreativeDocument): void {
    // A person's edit: whatever is pending is theirs from here.
    this.pendingMeta = null;
    if (this.state === 'conflict') {
      this.pending = doc;
      return;
    }
    if (doc === this.saved && !this.inFlight && !this.uncertain.length) {
      // Back to what the server holds (an undo, a rolled-back answer): nothing is unsaved.
      this.pending = null;
      this.cancelTimer();
      this.set(this.state === 'idle' ? 'idle' : 'saved');
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
    this.pendingMeta = meta;
    let result: SaveResult | null = null;
    await this.run(meta, (r) => { result = r; });
    return result;
  }

  private run(meta?: SaveMeta, onResult?: (r: SaveResult) => void): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const sent = this.pending;
    if (!sent || this.state === 'conflict') return Promise.resolve();
    const m = meta ?? this.pendingMeta ?? MANUAL;
    this.set('saving');
    this.inFlight = this.send(sent, m).then(
      (result) => {
        this.inFlight = null;
        this.version = result.version;
        this.saved = sent;
        this.uncertain = [];
        this.lastError = null;
        onResult?.(result);
        this.deps.onSaved(sent, result);
        if (this.pending === sent) {
          this.pending = null;
          this.pendingMeta = null;
          this.set('saved');
        } else {
          // More edits arrived while this one was on its way.
          this.set('dirty');
          this.schedule();
        }
      },
      (error: unknown) => {
        this.inFlight = null;
        this.lastError = error;
        const code = codeOf(error);
        if (code === 'VERSION_CONFLICT') this.set('conflict', error);
        else if (code === 'NETWORK') this.set('offline', error);
        else this.set('failed', error);
      },
    );
    return this.inFlight;
  }

  /**
   * One save. A 409 after a save whose answer was lost first asks the server
   * what it holds: our own lost write is adopted as the base (and the newer
   * content, if any, sent on top of it); anything else is a real conflict.
   */
  private async send(sent: CreativeDocument, meta: SaveMeta): Promise<SaveResult> {
    try {
      return await this.deps.save(sent, this.version, meta);
    } catch (error) {
      if (mayHaveLanded(error)) {
        this.uncertain = [...this.uncertain, sent].slice(-MAX_UNCERTAIN);
        throw error;
      }
      if (codeOf(error) !== 'VERSION_CONFLICT' || !this.uncertain.length || !this.deps.load) throw error;
      let server: { content: unknown; version: number; updated_at?: string | null };
      try {
        server = await this.deps.load();
      } catch (readError) {
        // Still cannot tell: say why (offline keeps the work and the doubt), never a conflict by guess.
        throw mayHaveLanded(readError) ? readError : error;
      }
      const landed = this.uncertain.find((c) => sameContent(c, server.content));
      if (!landed) throw error;
      const adopted: SaveResult = { version: server.version, updated_at: server.updated_at ?? null };
      this.uncertain = [];
      this.version = server.version;
      this.saved = landed;
      if (landed === sent || sameContent(sent, landed)) return adopted;
      // The newer content goes on top of our own landed write (a lost answer here is remembered the same way).
      this.deps.onSaved(landed, adopted);
      return await this.send(sent, meta);
    }
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
    this.pendingMeta = null;
    this.uncertain = [];
    this.set('saved');
  }

  dispose(): void {
    this.cancelTimer();
  }
}
