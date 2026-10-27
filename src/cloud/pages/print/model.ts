/**
 * THE PRINT SECTION'S RULES, AS PURE FUNCTIONS — what a screen may say about
 * a file, an import, an estimate, a job and a printer's reading, decided once
 * here from the server's own fields (tests/printCloudUiPrint.test.ts holds
 * every one of them):
 *
 *   - an import claims a downloaded file ONLY when the server says
 *     `file_imported` and names the file — `link_saved` is «only the link»;
 *   - no estimate is «awaiting estimate», never a zero, and an estimate says
 *     where it came from (the workshop's slicer, or an operator reading one);
 *   - what confirming reserves, what is short and how short, come from the
 *     projection the server computed — nothing is added up here;
 *   - progress exists only in a reading that is fresh AND about this job; a
 *     stale one is stale, a silent printer is «no reading», never «live»;
 *   - what a customer may do in each of the fourteen states mirrors the
 *     server's own transitions (worker/lib/printCloud/jobs.ts), so a screen
 *     never offers a door the server would refuse.
 *
 * Nothing here converts a figure that is sent back, and nothing reads a
 * clock it is not given.
 */
import type { Tone } from '../../../components/ui/Badge';
import { formatFigure } from '../../../lib/localeNumber';
import type { Language } from '../../../translations';
import { formatQuantity, permillePercent, unitWord } from '../../format';
import { jobStatus as jobStatusWords } from '../../strings/common';
import {
  actorWords,
  eventWords,
  failureReason,
  failureWords,
  geometryWarning,
  importLog,
  jobExplain,
  jobWords,
  plateIssue,
  printerReason,
  rejection,
  upload,
} from '../../strings/print';
import { tx } from '../../text';
import type {
  FileStatus,
  ImportStatus,
  JobEstimate,
  JobEvent,
  JobProjection,
  JobStatus,
  JobTelemetry,
  MachineState,
  ModelWarning,
  PrinterRecommendations,
  QueueBasis,
} from '../../types';

// ------------------------------------------------------------------ files

/** The formats the server takes (worker/lib/printCloud/files.ts SUPPORTED_EXTENSIONS). */
export const ACCEPTED_EXTENSIONS = ['stl', '3mf', 'obj'] as const;

/** `model.STL` → `stl`; '' when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * A first look before a byte is sent: the extension the server will accept.
 * Only a courtesy — the server proves the format from the bytes and its
 * answer is the one shown.
 */
export function acceptsFile(name: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

const BYTE_UNITS: Record<'B' | 'KB' | 'MB' | 'GB', { ar: string; en: string; ckb: string }> = {
  B: { ar: 'بايت', en: 'B', ckb: 'بایت' },
  KB: { ar: 'كيلوبايت', en: 'KB', ckb: 'کیلۆبایت' },
  MB: { ar: 'ميغابايت', en: 'MB', ckb: 'مێگابایت' },
  GB: { ar: 'غيغابايت', en: 'GB', ckb: 'گیگابایت' },
};

/** A file size as a reader sees it (1024-based, one decimal, floored); `null` → «—». Display only. */
export function formatBytes(bytes: number | null | undefined, lang: Language): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  const order = ['B', 'KB', 'MB', 'GB'] as const;
  let i = 0;
  while (i < order.length - 1 && bytes >= 1024 ** (i + 1)) i++;
  // Multiply first (format.ts `hoursFigure`): the floor never loses a tenth to a binary rounding error.
  const value = i === 0 ? Math.floor(bytes) : Math.floor((bytes * 10) / 1024 ** i) / 10;
  return `${formatFigure(value, lang, i === 0 ? 0 : 1)} ${BYTE_UNITS[order[i]][lang]}`;
}

/** A file whose check has finished either way: nothing more to wait for. */
export function fileSettled(status: FileStatus | string | null | undefined): boolean {
  return status === 'ready' || status === 'rejected' || status === 'failed';
}

export function fileTone(status: FileStatus | string | null | undefined): Tone {
  if (status === 'ready') return 'success';
  if (status === 'rejected' || status === 'failed') return 'danger';
  return 'info';
}

/**
 * Why the server refused a file, in words: the upload's own reasons
 * (`FILE_REJECTED.reason`), the background check's `rejection_code`, or —
 * for a code this table does not know — the code itself, never a guess.
 */
export function rejectionText(code: string | null | undefined, lang: Language): string {
  const c = (code ?? '').trim();
  if (!c) return tx(rejection.other, lang, { code: '—' });
  if (c in rejection && c !== 'other') return tx(rejection[c as keyof typeof rejection], lang);
  if (c === 'NO_GEOMETRY' || c === 'EMPTY_MESH') return tx(rejection.noShape, lang);
  if (c === 'ZERO_VOLUME' || c === 'ZERO_DIMENSION') return tx(rejection.zeroSize, lang);
  if (c === 'PARSE_ERROR' || c.startsWith('PARSE_FAILED')) return tx(rejection.unreadable, lang);
  if (c === 'NOT_MEASURABLE' || c === 'STEP_NEEDS_CAD_KERNEL' || c === 'UNKNOWN_FORMAT') return tx(rejection.notMeasurable, lang);
  return tx(rejection.other, lang, { code: c.slice(0, 60) });
}

/** A mesh warning in words, with the figure it carries written by the house formatters. */
export function geometryWarningText(w: ModelWarning, lang: Language): string {
  const code = w.code as keyof typeof geometryWarning;
  if (code === 'MANY_PARTS') {
    const parts = Number(w.detail?.parts);
    return tx(geometryWarning.MANY_PARTS, lang, { parts: Number.isFinite(parts) ? formatFigure(parts, lang) : '—' });
  }
  if (code === 'VERY_LARGE' || code === 'VERY_SMALL') {
    // A part under 5 mm is written to the hundredth: whole millimetres would floor it to «0 mm».
    const mm = Number(w.detail?.largest_mm);
    const size = !Number.isFinite(mm) ? '—' : code === 'VERY_SMALL' ? `${formatFigure(mm, lang, 2)} ${unitWord('mm', lang)}` : formatQuantity(mm, 'mm', lang);
    return tx(geometryWarning[code], lang, { size });
  }
  if (code in geometryWarning && code !== 'other') return tx(geometryWarning[code], lang);
  return tx(geometryWarning.other, lang, { code: String(w.code).slice(0, 60) });
}

/** The refusal of an upload, with the detail the server attached. */
export interface UploadRefusal {
  code: string | null;
  /** The server's own limit when it named one (`FILE_TOO_LARGE.max_bytes`). */
  maxBytes: number | null;
  /** A reason the server named (`FILE_REJECTED.reason`, `FILE_TYPE_NOT_SUPPORTED.reason`). */
  reason: string | null;
  /** What the bytes were read as, when the content did not match the extension. */
  detected: string | null;
}

export function uploadRefusal(status: number, code: string | null | undefined, details: Record<string, unknown> | undefined): UploadRefusal {
  const max = Number(details?.max_bytes);
  return {
    // A gateway's own 413 carries no code; it is still «too large».
    code: code || (status === 413 ? 'FILE_TOO_LARGE' : null),
    maxBytes: Number.isFinite(max) && max > 0 ? max : null,
    reason: typeof details?.reason === 'string' ? details.reason : null,
    detected: typeof details?.detected === 'string' ? details.detected : null,
  };
}

// ------------------------------------------------------------------ imports

export interface ImportOutcome {
  /** Nothing more will happen to it: stop asking. */
  settled: boolean;
  /** TRUE ONLY when the server downloaded a file and names it. */
  fileDownloaded: boolean;
  tone: Tone;
}

/**
 * What an import may be said to have done. `link_saved` — even with every
 * scrap of metadata — downloaded NOTHING; only `file_imported` with a file id
 * did (worker/lib/printCloud/imports.ts rule 4).
 */
export function importOutcome(imp: { status: ImportStatus | string; file_id?: string | null }): ImportOutcome {
  const fileDownloaded = imp.status === 'file_imported' && typeof imp.file_id === 'string' && imp.file_id.length > 0;
  const settled = imp.status !== 'pending';
  const tone: Tone = fileDownloaded ? 'success' : imp.status === 'pending' ? 'info' : imp.status === 'link_saved' ? 'warning' : 'danger';
  return { settled, fileDownloaded, tone };
}

export function importLogText(code: string, lang: Language): string {
  if (code in importLog && code !== 'other') return tx(importLog[code as keyof typeof importLog], lang);
  return tx(importLog.other, lang, { code: code.slice(0, 60) });
}

/** Why a link was refused (`URL_NOT_ALLOWED.reason`), or null for a reason this table does not know. */
export function urlRefusalText(reason: string | null | undefined, lang: Language): string | null {
  if (reason === 'https_required' || reason === 'provider_not_supported' || reason === 'invalid_or_private_address' || reason === 'too_long') {
    return tx(upload[reason], lang);
  }
  return null;
}

// ------------------------------------------------------------------ jobs: what may be done

/** worker/lib/printCloud/jobs.ts CUSTOMER_CANCELLABLE. */
export const CUSTOMER_CANCELLABLE: readonly JobStatus[] = ['draft', 'uploaded', 'analyzing', 'ready', 'awaiting_confirmation', 'confirmed', 'queued'];
/** jobs.ts `editJob`: only before anything is reserved. */
export const EDITABLE: readonly JobStatus[] = ['draft', 'uploaded', 'ready', 'awaiting_confirmation'];
/** jobs.ts `requestAnalysis`: a draft whose files are ready, or an uploaded job. */
export const ANALYZABLE: readonly JobStatus[] = ['draft', 'uploaded'];
/** jobs.ts `reviewJob`: ready, or a renewal of a window. */
export const REVIEWABLE: readonly JobStatus[] = ['ready', 'awaiting_confirmation'];
/** States where the workshop is working the job: a pause or stop may be ASKED for (recorded, never executed). */
export const ON_THE_FLOOR: readonly JobStatus[] = ['preparing', 'printing', 'paused'];

export interface JobAllows {
  analyze: boolean;
  review: boolean;
  confirm: boolean;
  edit: boolean;
  cancel: boolean;
  reschedule: boolean;
  askPause: boolean;
  askStop: boolean;
  note: boolean;
}

export function jobAllows(status: JobStatus): JobAllows {
  return {
    analyze: ANALYZABLE.includes(status),
    review: REVIEWABLE.includes(status),
    confirm: status === 'awaiting_confirmation',
    edit: EDITABLE.includes(status),
    cancel: CUSTOMER_CANCELLABLE.includes(status),
    // queue.ts `reschedule`: a queued job only.
    reschedule: status === 'queued',
    askPause: status === 'preparing' || status === 'printing',
    askStop: ON_THE_FLOOR.includes(status),
    note: ON_THE_FLOOR.includes(status) || status === 'confirmed' || status === 'queued' || status === 'failed',
  };
}

// ------------------------------------------------------------------ jobs: where it is

/** The stages a customer sees; `approval` only when the workshop approves jobs. */
export const JOB_STEPS = ['estimate', 'confirm', 'approval', 'queue', 'printing', 'done'] as const;
export type JobStep = (typeof JOB_STEPS)[number];

/** The stage a state belongs to; null for the states off the path (failed, cancelled, reprint requested). */
export function jobStep(status: JobStatus): JobStep | null {
  switch (status) {
    case 'draft':
    case 'uploaded':
    case 'analyzing':
      return 'estimate';
    case 'ready':
    case 'awaiting_confirmation':
      return 'confirm';
    case 'confirmed':
      return 'approval';
    case 'queued':
      return 'queue';
    case 'preparing':
    case 'printing':
    case 'paused':
      return 'printing';
    case 'completed':
      return 'done';
    default:
      return null;
  }
}

export function jobSteps(needsApproval: boolean): JobStep[] {
  return JOB_STEPS.filter((s) => s !== 'approval' || needsApproval);
}

/** The words for a state: its name (the pill's) and what it means, in a sentence. */
export function jobStateText(status: JobStatus, lang: Language): { title: string; body: string } {
  const pill = status === 'analyzing' ? jobStatusWords.awaiting_estimate : jobStatusWords[status];
  return { title: tx(pill, lang), body: tx(jobExplain[status], lang) };
}

/** A timeline line: the event, a customer request by its action, else the event's own name. */
export function eventText(e: Pick<JobEvent, 'event' | 'detail'>, lang: Language): string {
  if (e.event === 'customer_request') {
    const action = e.detail?.action;
    if (action === 'pause') return tx(eventWords.request_pause, lang);
    if (action === 'cancel') return tx(eventWords.request_cancel, lang);
    if (action === 'note') return tx(eventWords.request_note, lang);
  }
  if (e.event in eventWords && e.event !== 'other' && !e.event.startsWith('request_')) return tx(eventWords[e.event as keyof typeof eventWords], lang);
  return tx(eventWords.other, lang, { event: e.event.slice(0, 40) });
}

export function actorText(actor: string, lang: Language): string {
  return actor in actorWords ? tx(actorWords[actor as keyof typeof actorWords], lang) : actor;
}

/** The hold a queued job carries: the latest `rescheduled` event's `not_before` (null: none). */
export function currentHold(events: Array<Pick<JobEvent, 'event' | 'detail'>>): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'rescheduled') {
      const nb = events[i].detail?.not_before;
      return typeof nb === 'string' && nb ? nb : null;
    }
  }
  return null;
}

/** Why the last analysis came back without an estimate, if that is the latest thing that happened to it. */
export function lastAnalysisProblem(events: Array<Pick<JobEvent, 'event' | 'detail'>>): { kind: 'failed'; code: string } | { kind: 'incompatible'; warnings: string[] } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'analysis_failed') return { kind: 'failed', code: String(e.detail?.error_code ?? '') };
    if (e.event === 'estimate_incompatible') {
      const w = e.detail?.warnings;
      return { kind: 'incompatible', warnings: Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [] };
    }
    if (e.event === 'analysis_requested' || e.event === 'estimate_recorded' || e.event === 'edited') return null;
  }
  return null;
}

export function failurePartyText(responsible: string, lang: Language): string {
  return responsible in failureWords ? tx(failureWords[responsible as keyof typeof failureWords], lang) : responsible;
}

/**
 * Why a print failed, in words: the operator records a short code
 * (`adhesion`, `nozzle_clog`… — the admin form's own suggestions); a code this
 * table does not know is still a sentence in the reader's language around it.
 */
const FAILURE_ALIAS: Record<string, keyof typeof failureReason> = { clog: 'nozzle_clog', power: 'power_loss', runout: 'filament_runout', warp: 'warping' };

export function failureReasonText(code: string | null | undefined, lang: Language): string {
  const raw = (code ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const c = FAILURE_ALIAS[raw] ?? raw;
  if (c && c in failureReason && c !== 'other') return tx(failureReason[c as keyof typeof failureReason], lang);
  return tx(failureReason.other, lang, { code: (code ?? '').trim().slice(0, 60) || '—' });
}

export function failurePolicyText(policy: string | null | undefined, lang: Language): string | null {
  if (policy === 'no_charge' || policy === 'charge_printed' || policy === 'manual_review') return tx(failureWords[policy], lang);
  return null;
}

export function queueBasisText(basis: QueueBasis | string, lang: Language): string | null {
  if (basis === 'no_compatible_printer' || basis === 'waiting_for_dependency' || basis === 'dependency_cannot_complete') return tx(jobWords[basis], lang);
  return null;
}

export function printerReasonText(code: string, lang: Language): string {
  if (code in printerReason && code !== 'other') return tx(printerReason[code as keyof typeof printerReason], lang);
  return tx(printerReason.other, lang, { code: code.slice(0, 40) });
}

export type PrinterBadge = 'bestQuality' | 'shortestQueue' | 'mostCredit' | 'lowestCost';

/**
 * The server's picks a printer model may wear — only those its own figures
 * back. A model's cost exists only with a measured estimate for it, and the
 * server's «lowest cost» sort cannot order models without one, so «lowest
 * cost» needs at least two compatible models, every one of them measured;
 * without an estimate for this job no price was compared at all. «Most hours
 * held» needs hours actually held in its class. (The server names a model
 * for every pick even when nothing was compared.)
 */
export function printerBadges(recs: Pick<PrinterRecommendations, 'models' | 'best'>, id: string): PrinterBadge[] {
  const m = recs.models.find((x) => x.printer_model_id === id);
  if (!m || !m.compatible) return [];
  const compatible = recs.models.filter((x) => x.compatible);
  const compared = compatible.length >= 2 && compatible.every((x) => x.credit.estimated_seconds != null);
  const out: PrinterBadge[] = [];
  if (recs.best.best_quality === id) out.push('bestQuality');
  if (recs.best.shortest_queue === id) out.push('shortestQueue');
  if (recs.best.most_credit_available === id && m.credit.available_seconds > 0) out.push('mostCredit');
  if (recs.best.lowest_cost === id && compared) out.push('lowestCost');
  return out;
}

export function plateIssueText(code: string, lang: Language): string {
  if (code in plateIssue && code !== 'other') return tx(plateIssue[code as keyof typeof plateIssue], lang);
  return tx(plateIssue.other, lang, { code: code.slice(0, 40) });
}

// ------------------------------------------------------------------ estimate and projection

export type EstimateSource = 'slicer' | 'operator' | 'none';

/** Where an estimate came from — `none` is «awaiting estimate», never a figure. */
export function estimateSource(e: { provenance?: string | null } | null | undefined): EstimateSource {
  if (!e) return 'none';
  if (e.provenance === 'slicer') return 'slicer';
  if (e.provenance === 'operator') return 'operator';
  // An estimate of an unknown origin is not shown as the slicer's.
  return 'none';
}

export interface Grams {
  model: number;
  support: number;
  purge: number;
  total: number;
}

export interface ShortLine {
  kind: 'hours' | 'filament' | 'accessory';
  /** The refusal confirming would meet: `INSUFFICIENT_CREDIT` for hours, `INSUFFICIENT_INVENTORY` for a material. */
  code: 'INSUFFICIENT_CREDIT' | 'INSUFFICIENT_INVENTORY';
  /** Hours: the job's class; a material: its variant. */
  id: string;
  /** Seconds for hours; the variant's base unit for a material. */
  amount: number;
}

export interface ProjectionDisplay {
  source: EstimateSource;
  /** null: awaiting estimate. */
  durationSeconds: number | null;
  grams: Grams | null;
  layerCount: number | null;
  colourChanges: number | null;
  warnings: string[];
  /** What confirming would hold, as the server projected it; null when there is no projection. */
  hours: { tierId: string; required: number; available: number; after: number; shortfall: number } | null;
  materials: Array<{ variantId: string; kind: 'filament' | 'accessory'; required: number; available: number; after: number; shortfall: number }>;
  shortfalls: ShortLine[];
  /** null: not known (no projection); false: confirming would be refused for a shortfall. */
  sufficient: boolean | null;
}

/**
 * Everything the estimate card and the confirmation say, from the job's own
 * estimate and the server's projection. With no estimate it is «awaiting
 * estimate»: no time, no grams, no shortfall, and `sufficient` unknown.
 */
export function projectionDisplay(
  estimate: Pick<JobEstimate, 'provenance' | 'duration_seconds' | 'model_grams' | 'support_grams' | 'purge_grams' | 'layer_count' | 'color_changes' | 'warnings'> | null | undefined,
  projection: JobProjection | null | undefined
): ProjectionDisplay {
  const source = estimateSource(estimate ?? projection?.estimate ?? null);
  const e = source === 'none' ? null : (estimate ?? projection?.estimate ?? null);
  const grams = e
    ? {
        model: e.model_grams,
        support: e.support_grams,
        purge: e.purge_grams,
        total: e.model_grams + e.support_grams + e.purge_grams,
      }
    : null;
  const p = e ? (projection ?? null) : null;
  const hours = p
    ? {
        tierId: p.credits.tier_id,
        required: p.credits.required_seconds,
        available: p.credits.available_seconds,
        after: p.credits.remaining_after_seconds,
        shortfall: p.credits.shortfall_seconds,
      }
    : null;
  const materials = p
    ? p.materials.map((m) => ({ variantId: m.variant_id, kind: m.kind, required: m.required, available: m.available, after: m.remaining_after, shortfall: m.shortfall }))
    : [];
  const shortfalls: ShortLine[] = [];
  if (hours && hours.shortfall > 0) shortfalls.push({ kind: 'hours', code: 'INSUFFICIENT_CREDIT', id: hours.tierId, amount: hours.shortfall });
  for (const m of materials) {
    if (m.shortfall > 0) shortfalls.push({ kind: m.kind === 'accessory' ? 'accessory' : 'filament', code: 'INSUFFICIENT_INVENTORY', id: m.variantId, amount: m.shortfall });
  }
  return {
    source,
    durationSeconds: e ? e.duration_seconds : null,
    grams,
    layerCount: e?.layer_count ?? null,
    colourChanges: e ? e.color_changes : null,
    warnings: e ? (Array.isArray(e.warnings) ? e.warnings.filter((w): w is string => typeof w === 'string') : []) : [],
    hours,
    materials,
    shortfalls,
    // The server's own verdict; recomputed from the lines only to agree with it.
    sufficient: p ? p.sufficient && shortfalls.length === 0 : null,
  };
}

/**
 * Where a shortfall is bought: hours on the catalogue's tab for the job's
 * class (`?tab=hours&tier=`); a material on that very variant's page
 * (`/store/variant/:id`, which opens with `?qty=` — the shortfall, in the
 * variant's base unit — moved to the nearest quantity the store sells).
 */
export function shortfallLink(s: ShortLine): string {
  const id = encodeURIComponent(s.id);
  if (s.kind === 'hours') return `/store?tab=hours&tier=${id}`;
  const qty = Number.isInteger(s.amount) && s.amount > 0 ? `?qty=${s.amount}` : '';
  return `/store/variant/${id}${qty}`;
}

// ------------------------------------------------------------------ the printer's reading

export type TelemetryDisplay =
  | { kind: 'none' }
  | { kind: 'stale'; receivedAt: string }
  | { kind: 'elsewhere'; receivedAt: string }
  | {
      kind: 'live';
      receivedAt: string;
      machineState: MachineState;
      /** 0–100 from the printer's own permille, or null: no bar. */
      percent: number | null;
      layer: number | null;
      totalLayers: number | null;
      remainingSeconds: number | null;
      nozzleC: number | null;
      bedC: number | null;
    };

/** Tenths of a degree (the agent's unit) as whole degrees, or null. */
export function degreesC(deci: number | null | undefined): number | null {
  if (deci == null || !Number.isFinite(deci)) return null;
  return Math.round(deci / 10);
}

/**
 * What a printer's last reading may be shown as. STALE WINS: a reading past
 * the window is stale whatever else it says, and has no progress. A fresh
 * reading about another job (or none) is not this print's progress. Only a
 * fresh reading about THIS job is live — and even then a bar needs the
 * printer's own figure.
 */
export function telemetryDisplay(t: JobTelemetry | null | undefined): TelemetryDisplay {
  if (!t) return { kind: 'none' };
  if (t.stale) return { kind: 'stale', receivedAt: t.received_at };
  if (!t.live) return { kind: 'elsewhere', receivedAt: t.received_at };
  return {
    kind: 'live',
    receivedAt: t.received_at,
    machineState: t.machine_state,
    percent: permillePercent(t.progress_permille),
    layer: t.layer ?? null,
    totalLayers: t.total_layers && t.total_layers > 0 ? t.total_layers : null,
    remainingSeconds: t.remaining_seconds ?? null,
    nozzleC: degreesC(t.nozzle_temp_dc),
    bedC: degreesC(t.bed_temp_dc),
  };
}

// ------------------------------------------------------------------ asking again

/**
 * How often a job's page asks the server again, by state (ms), or null: not
 * at all. Only while something can change without the customer: the estimate
 * arriving, the workshop approving, the queue moving, a print running.
 */
export function jobPollMs(status: JobStatus): number | null {
  if (status === 'analyzing' || status === 'preparing' || status === 'printing' || status === 'paused') return 10_000;
  if (status === 'confirmed' || status === 'queued') return 30_000;
  return null;
}
