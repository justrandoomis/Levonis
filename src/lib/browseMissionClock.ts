/**
 * THE BROWSE MISSION'S CLOCK, WITHOUT REACT (owner, 2026-11-05: «make sure for
 * اجمع النقاط is work espissaly تصفّح المنتجات»; DECISIONS row 300).
 *
 * WHY THE MISSION COULD NEVER FINISH. The clock is mounted only in the main shell
 * (src/App.tsx) and /points is a full-screen route. Pressing the mission fired
 * `levo_mission_start` with no listener on the page, then `navigate('/')` mounted
 * the clock, whose first read saw `progress_seconds: 0` and stayed hidden. No
 * ping was ever sent, so the seconds stayed 0, for ever.
 *
 * THE FIX is one fact from the server: `missions.browse.started`, the open ticket.
 * The clock shows when the ticket is open, whatever is mounted when, so it also
 * survives a reload or a new tab. The server still decides every second and every
 * point: this file only asks, displays and says what it was told.
 *
 * It lives apart from the component so the whole path — mount, pings, award — runs
 * against the real routes in tests/browseMission.test.ts, on a mocked clock, with
 * nothing of it simulated. It imports nothing, so it adds no weight to the chunk.
 */

export const PING_INTERVAL_MS = 15_000;
export const IDLE_LIMIT_MS = 30_000;

export interface BrowseView {
  claimed: boolean;
  /** The owner's switch for the mission. Absent on a server older than this file reads as on. */
  available?: boolean;
  required_seconds: number;
  progress_seconds: number;
  /** Today's ticket is open. Absent on a server older than this file. */
  started?: boolean;
}

export interface BrowsePing {
  done: boolean;
  seconds: number;
  awarded?: boolean;
  points?: number;
  base_points?: number;
  multiplier_x100?: number;
  reason?: string;
}

export interface ClockState {
  visible: boolean;
  seconds: number;
  required: number;
  paused: boolean;
}

export const CLOCK_HIDDEN: ClockState = { visible: false, seconds: 0, required: 180, paused: false };

/**
 * IS THERE A MISSION RUNNING? A mission already paid or switched off shows
 * nothing. Otherwise: just started here, the ticket open, or seconds on record.
 */
export function clockShows(view: BrowseView, justStarted: boolean): boolean {
  if (view.claimed || view.available === false) return false;
  return justStarted || view.started === true || view.progress_seconds > 0;
}

/**
 * A failure worth another try: no answer at all, the server's own trouble, or
 * too many requests. Anything else is the server saying the mission is over for
 * now (no session, a new day, the mission switched off), so the clock hides
 * rather than pretends. Duck-typed, so this file needs no import of the client.
 */
export function isPassingFailure(error: unknown): boolean {
  const e = (error ?? {}) as { status?: unknown; code?: unknown };
  if (e.code === 'TASK_DISABLED') return false;
  const status = typeof e.status === 'number' ? e.status : 0;
  return status === 0 || status === 429 || status >= 500;
}

export interface ClockDeps {
  /** GET /api/rewards → `missions.browse`. */
  read: () => Promise<BrowseView>;
  /** POST /api/rewards/browse/ping. */
  ping: () => Promise<BrowsePing>;
  /** `document.hidden`: time on a hidden tab is not browsing. */
  isHidden: () => boolean;
  onChange: (state: ClockState) => void;
  /** The server paid: its figures, to say out loud. Called once. */
  onAward: (reply: BrowsePing) => void;
}

export interface BrowseClock {
  /** Read the mission from the server. `justStarted`: the mission was pressed on this very page. */
  sync: (justStarted?: boolean) => Promise<void>;
  /** The customer did something: the clock is not idle. */
  activity: () => void;
  /** One ping now, if one is due (the interval calls this). */
  ping: () => Promise<void>;
  stop: () => void;
}

/** How many times a failed first read is tried again, one ping apart: phones on mobile data. */
const READ_RETRIES = 4;

export function createBrowseClock(deps: ClockDeps): BrowseClock {
  let state = CLOCK_HIDDEN;
  let stopped = false;
  let finished = false;
  let pinging = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (patch: Partial<ClockState>) => {
    state = { ...state, ...patch };
    if (!stopped) deps.onChange(state);
  };

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pingTimer = tickTimer = idleTimer = retryTimer = null;
  };

  const hide = () => {
    clearTimers();
    set({ visible: false, paused: false });
  };

  const activity = () => {
    if (!state.visible) return;
    if (state.paused) set({ paused: false });
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => set({ paused: true }), IDLE_LIMIT_MS);
  };

  const ping = async () => {
    if (!state.visible || state.paused || finished || pinging || deps.isHidden()) return;
    pinging = true;
    try {
      const reply = await deps.ping();
      if (stopped) return;
      set({ seconds: reply.seconds });
      if (reply.done) {
        finished = true;
        hide();
        if (reply.awarded) deps.onAward(reply);
      }
    } catch (error) {
      if (!stopped && !isPassingFailure(error)) hide();
    } finally {
      pinging = false;
    }
  };

  /** Display only, between pings; the server re-syncs it on every one. */
  const tick = () => {
    if (state.paused || deps.isHidden()) return;
    set({ seconds: Math.min(state.seconds + 1, state.required) });
  };

  const sync = async (justStarted = false, attempt = 0): Promise<void> => {
    try {
      const view = await deps.read();
      if (stopped) return;
      if (!clockShows(view, justStarted)) {
        hide();
        return;
      }
      finished = false;
      set({ visible: true, seconds: view.progress_seconds, required: view.required_seconds });
      if (!pingTimer) {
        pingTimer = setInterval(() => void ping(), PING_INTERVAL_MS);
        tickTimer = setInterval(tick, 1000);
      }
      activity();
    } catch (error) {
      if (stopped || !isPassingFailure(error) || attempt >= READ_RETRIES) return;
      retryTimer = setTimeout(() => void sync(justStarted, attempt + 1), PING_INTERVAL_MS);
    }
  };

  return {
    sync: (justStarted) => sync(justStarted),
    activity,
    ping,
    stop: () => {
      stopped = true;
      clearTimers();
    },
  };
}

/** mm:ss of what is left. Never negative, and the server's clock decides the end. */
export function clockText(state: Pick<ClockState, 'seconds' | 'required'>): string {
  const left = Math.max(0, state.required - state.seconds);
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

type Loc = (ar: string, en: string, ckb: string) => string;

/**
 * What the customer is told when the server has paid: its own figure, and the
 * multiplier that produced it when a subscription paid more. A sentence on the
 * screen they are on, never a dialog and never a move away from the product.
 */
export function browseAwardText(reply: BrowsePing, loc: Loc): string {
  const points = reply.points ?? 0;
  const gain = `+${points} ${loc('نقطة', 'pts', 'خاڵ')}`;
  const multiplier = reply.multiplier_x100 ?? 100;
  const shown = multiplier > 100 ? `${gain} (${reply.base_points} × ${multiplier / 100})` : gain;
  return loc(`أنهيت مهمة التصفّح · ${shown}`, `Browse mission done · ${shown}`, `ئەرکی گەڕانەکەت تەواو کرد · ${shown}`);
}
