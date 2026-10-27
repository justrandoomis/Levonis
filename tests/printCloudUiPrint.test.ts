/**
 * LEVONIS PRINT CLOUD — THE PRINT SECTION OF THE CUSTOMER APP
 * (src/cloud/pages/print, src/cloud/strings/print.ts).
 *
 * Fast and build-free. What it holds:
 *
 *   - the pure rules every print screen speaks through (model.ts): a file's
 *     and an import's status in words — a saved LINK is never a downloaded
 *     file — the fourteen job states in plain words, what the customer may do
 *     in each (mirroring the server's own transitions), the projection's
 *     display rules (no estimate → «awaiting estimate», never a zero; where
 *     an estimate came from; what is short and where to buy it) and the
 *     printer's reading (stale is stale, never live);
 *   - that every refusal reason, import log code, mesh warning and job event
 *     the SERVER can send has words here, read from the server's own source;
 *   - the section's words in three languages, Sorani never the Arabic;
 *   - source rules: no price, duration or weight typed into a screen or a
 *     sentence; the upload is the multipart door with field `file`; the
 *     confirmation sends one Idempotency-Key made when its sheet opens; every
 *     screen is a lazy chunk.
 *
 * Run: node --import tsx --test tests/printCloudUiPrint.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { SUPPORTED_EXTENSIONS } from '../worker/lib/printCloud/files';
import { CUSTOMER_CANCELLABLE as SERVER_CANCELLABLE, JOB_STATUSES as SERVER_JOB_STATUSES, TRANSITIONS } from '../worker/lib/printCloud/jobs';
import { formatFigure } from '../src/lib/localeNumber';
import { tx } from '../src/cloud/text';
import { JOB_STATUSES } from '../src/cloud/types';
import type { JobEstimate, JobProjection, JobStatus, JobTelemetry } from '../src/cloud/types';
import * as words from '../src/cloud/strings/print';
import * as M from '../src/cloud/pages/print/model';

const LANGS = ['ar', 'en', 'ckb'] as const;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const PRINT_DIR = 'src/cloud/pages/print';
const PRINT_FILES = readdirSync(join(ROOT, PRINT_DIR))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `${PRINT_DIR}/${f}`)
  .sort();
const SECTION_FILES = [...PRINT_FILES, 'src/cloud/strings/print.ts'];
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (source: ts.SourceFile, n: ts.Node) => `${source.fileName}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`;

// ============================================================ files and imports

test('the formats offered are exactly the server’s, and the extension check is only a courtesy', () => {
  assert.deepEqual([...M.ACCEPTED_EXTENSIONS], [...SUPPORTED_EXTENSIONS]);
  assert.equal(M.fileExtension('dragon.STL'), 'stl');
  assert.equal(M.fileExtension('box.3mf'), '3mf');
  assert.equal(M.fileExtension('no-extension'), '');
  assert.equal(M.fileExtension('.hidden'), '');
  for (const ok of ['a.stl', 'b.3MF', 'c.obj']) assert.equal(M.acceptsFile(ok), true, ok);
  for (const no of ['a.step', 'b.zip', 'c.stl.exe', 'd', 'e.gltf']) assert.equal(M.acceptsFile(no), false, no);
  // The page still sends what it accepts to the server, whose bytes check is the one shown.
  assert.match(read(`${PRINT_DIR}/PrintStart.tsx`), /uploadModelFile\(file,/);
});

test('a file size is written 1024-based and floored, in three languages; no size is «—»', () => {
  assert.equal(M.formatBytes(0, 'en'), '0 B');
  assert.equal(M.formatBytes(1023, 'en'), '1,023 B');
  assert.equal(M.formatBytes(1536, 'en'), '1.5 KB');
  assert.equal(M.formatBytes(40 * 1024 * 1024, 'en'), '40 MB');
  assert.equal(M.formatBytes(40 * 1024 * 1024 - 1, 'en'), '39.9 MB', 'floored, never rounded up to the limit');
  assert.equal(M.formatBytes(12.4 * 1024 * 1024, 'en'), '12.4 MB');
  assert.equal(M.formatBytes(null, 'en'), '—');
  assert.equal(M.formatBytes(Number.NaN, 'ar'), '—');
  assert.equal(M.formatBytes(1536, 'ar'), `${formatFigure(1.5, 'ar', 1)} كيلوبايت`);
  assert.equal(M.formatBytes(1536, 'ckb'), `${formatFigure(1.5, 'ckb', 1)} کیلۆبایت`);
});

test('a file’s check: settled only when ready, rejected or failed; the refusal is said in words, an unknown one by its code', () => {
  for (const s of ['ready', 'rejected', 'failed']) assert.equal(M.fileSettled(s), true, s);
  for (const s of ['uploaded', 'processing', null, undefined]) assert.equal(M.fileSettled(s), false, String(s));
  assert.equal(M.fileTone('ready'), 'success');
  assert.equal(M.fileTone('rejected'), 'danger');
  assert.equal(M.fileTone('processing'), 'info');

  // Every reason the server's upload check can name (worker/lib/printCloud/files.ts) and every rejection
  // code its background check writes (files.ts, worker/lib/modelGeometry.ts) has words of its own.
  const files = read('worker/lib/printCloud/files.ts');
  const geometry = read('worker/lib/modelGeometry.ts');
  const codes = new Set<string>([
    ...[...files.matchAll(/'(ARCHIVE_[A-Z_]+|EMPTY_FILE|OBJECT_MISSING|PARSE_ERROR|EMPTY_MESH|ZERO_DIMENSION|NOT_MEASURABLE)'/g)].map((m) => m[1]),
    ...[...geometry.matchAll(/emptyAnalysis\(format, (?:format === 'step' \? )?'([A-Z_]+)'(?: : '([A-Z_]+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean) as string[]),
    'ZERO_VOLUME',
  ]);
  assert.ok(codes.size >= 14, [...codes].join(', '));
  for (const code of codes) {
    for (const lang of LANGS) {
      const text = M.rejectionText(code, lang);
      assert.ok(text.trim(), `${code} ${lang}`);
      assert.notEqual(text, tx(words.rejection.other, lang, { code }), `${code} has no words of its own (${lang})`);
    }
  }
  assert.equal(M.rejectionText('PARSE_FAILED: bad header', 'en'), tx(words.rejection.unreadable, 'en'));
  assert.equal(M.rejectionText('SOMETHING_NEW', 'en'), 'Reason: SOMETHING_NEW', 'a code this table does not know is shown as itself, never guessed');
});

test('every mesh warning the measurement can raise has words, with its figure written by the house formatters', () => {
  const geometry = read('worker/lib/modelGeometry.ts');
  const union = /code:\s*((?:\s*\|\s*'[A-Z_]+')+);/.exec(geometry);
  assert.ok(union, 'the ModelWarning code union is no longer where this test reads it');
  const codes = [...union[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 12, codes.join(', '));
  for (const code of codes) {
    for (const lang of LANGS) {
      const text = M.geometryWarningText({ code, severity: 'warning', detail: { parts: 3, largest_mm: 1200 } }, lang);
      assert.ok(!text.includes('{'), `${code} ${lang}: an unfilled placeholder («${text}»)`);
      assert.notEqual(text, tx(words.geometryWarning.other, lang, { code }), `${code} has no words (${lang})`);
    }
  }
  assert.equal(M.geometryWarningText({ code: 'MANY_PARTS', severity: 'info', detail: { parts: 3 } }, 'en'), 'Separate parts in the model: 3.');
  assert.equal(M.geometryWarningText({ code: 'VERY_LARGE', severity: 'warning', detail: { largest_mm: 1200 } }, 'en'), 'The model is very large — longest side: 1.2 m.');
});

test('an upload refusal carries the server’s own limit; a gateway’s bare 413 is still «too large»', () => {
  assert.deepEqual(M.uploadRefusal(413, 'FILE_TOO_LARGE', { max_bytes: 41943040 }), { code: 'FILE_TOO_LARGE', maxBytes: 41943040, reason: null, detected: null });
  assert.deepEqual(M.uploadRefusal(413, undefined, undefined), { code: 'FILE_TOO_LARGE', maxBytes: null, reason: null, detected: null });
  assert.deepEqual(M.uploadRefusal(415, 'FILE_TYPE_NOT_SUPPORTED', { reason: 'CONTENT_DOES_NOT_MATCH_EXTENSION', detected: 'stl' }), {
    code: 'FILE_TYPE_NOT_SUPPORTED',
    maxBytes: null,
    reason: 'CONTENT_DOES_NOT_MATCH_EXTENSION',
    detected: 'stl',
  });
  assert.equal(M.uploadRefusal(413, 'FILE_TOO_LARGE', { max_bytes: 'lots' }).maxBytes, null, 'no limit is invented from a bad figure');
  // No limit is written into the interface: the only figure is the server's `max_bytes`.
  for (const rel of SECTION_FILES) assert.doesNotMatch(read(rel), /max_upload_bytes|MODEL_UPLOAD_CEILING|40\s*\*\s*1024/, rel);
});

test('a saved LINK is never a downloaded file: only `file_imported` naming a file says so', () => {
  assert.deepEqual(M.importOutcome({ status: 'link_saved', file_id: null }), { settled: true, fileDownloaded: false, tone: 'warning' });
  assert.equal(M.importOutcome({ status: 'link_saved', file_id: 'pcf_x' }).fileDownloaded, false, 'not even with a stray file id');
  assert.equal(M.importOutcome({ status: 'file_imported', file_id: null }).fileDownloaded, false, 'not without the file it names');
  assert.equal(M.importOutcome({ status: 'file_imported', file_id: '' }).fileDownloaded, false);
  assert.deepEqual(M.importOutcome({ status: 'file_imported', file_id: 'pcf_1' }), { settled: true, fileDownloaded: true, tone: 'success' });
  assert.deepEqual(M.importOutcome({ status: 'pending', file_id: null }), { settled: false, fileDownloaded: false, tone: 'info' });
  for (const s of ['failed', 'rejected']) assert.deepEqual(M.importOutcome({ status: s, file_id: null }), { settled: true, fileDownloaded: false, tone: 'danger' }, s);
  // The words agree: «only the link», never «imported» or «downloaded».
  assert.match(words.importStatus.link_saved.en, /only the link/i);
  assert.doesNotMatch(words.importStatus.link_saved.en, /downloaded|imported/i);
  assert.match(words.importBody.link_saved.en, /No file was downloaded/);
  // Every status the server writes has its words.
  for (const s of ['pending', 'link_saved', 'file_imported', 'failed', 'rejected'] as const) {
    for (const lang of LANGS) assert.ok(words.importStatus[s][lang].trim() && words.importBody[s][lang].trim(), `${s} ${lang}`);
  }
});

test('every step the server logs for an import, and every reason it refuses a link, has words', () => {
  const imports = read('worker/lib/printCloud/imports.ts');
  const codes = new Set<string>();
  for (const m of imports.matchAll(/logStmt\(db, (?:importId|id), '(?:info|warning|error)', ([^{]+?), \{/g)) {
    for (const c of m[1].matchAll(/'([A-Z_]+)'/g)) codes.add(c[1]);
  }
  assert.ok(codes.size >= 10, [...codes].join(', '));
  for (const code of codes) {
    for (const lang of LANGS) assert.notEqual(M.importLogText(code, lang), tx(words.importLog.other, lang, { code }), `${code} (${lang})`);
  }
  const reasons = new Set([...imports.matchAll(/URL_NOT_ALLOWED', \{ reason: '([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(reasons.size >= 4, [...reasons].join(', '));
  for (const r of reasons) for (const lang of LANGS) assert.ok(M.urlRefusalText(r, lang), `${r} (${lang})`);
  assert.equal(M.urlRefusalText('something_else', 'en'), null, 'an unknown reason falls back to the server’s own sentence');
});

// ============================================================ the fourteen states

test('the client knows the same fourteen states as the server, each in plain words in three languages', () => {
  assert.deepEqual([...JOB_STATUSES], [...SERVER_JOB_STATUSES]);
  for (const status of JOB_STATUSES) {
    for (const lang of LANGS) {
      const { title, body } = M.jobStateText(status, lang);
      assert.ok(title.trim() && body.trim(), `${status} ${lang}`);
    }
    assert.notEqual(M.jobStateText(status, 'ckb').body, M.jobStateText(status, 'ar').body, `${status}: the Sorani is the Arabic`);
  }
  // An analysing job is waiting for an estimate, and says exactly that.
  assert.equal(M.jobStateText('analyzing', 'en').title, 'Awaiting estimate');
  assert.match(M.jobStateText('analyzing', 'en').body, /No figure is shown/);
});

test('what the customer may do in each state is what the server would accept there', () => {
  assert.deepEqual([...M.CUSTOMER_CANCELLABLE], [...SERVER_CANCELLABLE]);
  for (const status of JOB_STATUSES) {
    const a = M.jobAllows(status);
    assert.equal(a.cancel, SERVER_CANCELLABLE.includes(status), `${status}: cancel`);
    // Changing settings sends the job back to draft (jobs.ts editJob), only where the machine allows it.
    if (a.edit) assert.ok(status === 'draft' || TRANSITIONS[status].includes('draft'), `${status}: edit`);
    // Asking for an estimate: a draft goes through `uploaded` to `analyzing`.
    if (a.analyze) assert.ok(TRANSITIONS[status].includes('analyzing') || TRANSITIONS[status].includes('uploaded'), `${status}: analyze`);
    if (a.review) assert.ok(TRANSITIONS[status].includes('awaiting_confirmation') || status === 'awaiting_confirmation', `${status}: review`);
    if (a.confirm) assert.ok(TRANSITIONS[status].includes('confirmed'), `${status}: confirm`);
    // Nothing is offered on a finished job but a note after a failure.
    if (['completed', 'cancelled', 'reprint_requested'].includes(status)) {
      assert.deepEqual(Object.values(a).filter(Boolean), [], `${status}: offers something`);
    }
  }
  assert.equal(M.jobAllows('awaiting_confirmation').confirm, true);
  assert.equal(M.jobAllows('ready').confirm, false, 'a ready job is reviewed first — the review renews the window and the figures');
  assert.equal(M.jobAllows('queued').reschedule, true);
  assert.equal(M.jobAllows('confirmed').reschedule, false, 'queue.ts reschedules a queued job only');
  assert.equal(M.jobAllows('printing').askPause, true);
  assert.equal(M.jobAllows('printing').cancel, false, 'a print on the floor is ASKED to stop, never cancelled from here');
  assert.equal(M.jobAllows('failed').note, true);
  const editable = /if \(!\[([^\]]+)\]\.includes\(job\.status\)\) throw pcError\('INVALID_TRANSITION', \{ from: job\.status, to: 'draft' \}\)/.exec(read('worker/lib/printCloud/jobs.ts'));
  assert.ok(editable, 'editJob’s guard is no longer where this test reads it');
  assert.deepEqual([...M.EDITABLE].sort(), [...editable[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort());
});

test('the stages: every state on the path has one, the three off it have none, approval only when the workshop approves', () => {
  for (const status of JOB_STATUSES) {
    const step = M.jobStep(status);
    if (['failed', 'cancelled', 'reprint_requested'].includes(status)) assert.equal(step, null, status);
    else assert.ok(step && M.JOB_STEPS.includes(step), status);
  }
  assert.deepEqual(M.jobSteps(true), ['estimate', 'confirm', 'approval', 'queue', 'printing', 'done']);
  assert.deepEqual(M.jobSteps(false), ['estimate', 'confirm', 'queue', 'printing', 'done']);
  for (const s of M.JOB_STEPS) for (const lang of LANGS) assert.ok(words.stepWords[s][lang].trim(), `${s} ${lang}`);
});

test('every event the server writes on a job has a line of its own in the timeline', () => {
  const sources = readdirSync(join(ROOT, 'worker/lib/printCloud'))
    .map((f) => read(`worker/lib/printCloud/${f}`))
    .concat(read('worker/routes/printCloud.ts'), read('worker/routes/printCloudAdmin.ts'));
  const events = new Set<string>(['created', 'created_as_reprint']);
  for (const src of sources) {
    for (const m of src.matchAll(/'[a-z_]+',\s*(?:p\.)?actor,\s*'([a-z_]+)',\s*(?:p\.)?now/g)) events.add(m[1]);
    for (const m of src.matchAll(/jobEvent\([^,]+,\s*[^,]+,\s*'([a-z_]+)'/g)) events.add(m[1]);
  }
  const agent = /const EVENT_TARGET[^=]*= \{([^}]+)\}/.exec(read('worker/routes/printCloudAgent.ts'));
  assert.ok(agent, 'the agent’s events are no longer where this test reads them');
  for (const m of agent[1].matchAll(/(\w+):/g)) events.add(m[1]);
  assert.ok(events.size >= 25, [...events].join(', '));
  for (const event of events) {
    for (const lang of LANGS) {
      assert.notEqual(M.eventText({ event, detail: {} }, lang), tx(words.eventWords.other, lang, { event }), `«${event}» has no words (${lang})`);
    }
  }
  // A request is told by what was asked.
  assert.equal(M.eventText({ event: 'customer_request', detail: { action: 'pause' } }, 'en'), 'You asked to pause');
  assert.equal(M.eventText({ event: 'customer_request', detail: { action: 'note' } }, 'en'), 'You sent a note');
  assert.equal(M.eventText({ event: 'brand_new_event', detail: {} }, 'en'), 'Event: brand_new_event');
  for (const actor of ['customer', 'operator', 'admin', 'agent', 'system']) for (const lang of LANGS) assert.notEqual(M.actorText(actor, lang), actor, actor);
});

test('a queued print’s hold is the latest reschedule; the last analysis problem is the latest thing that happened', () => {
  assert.equal(M.currentHold([]), null);
  const at = '2026-11-01T09:00:00.000Z';
  assert.equal(M.currentHold([{ event: 'rescheduled', detail: { not_before: at } }]), at);
  assert.equal(M.currentHold([{ event: 'rescheduled', detail: { not_before: at } }, { event: 'rescheduled', detail: { not_before: null } }]), null, 'a cleared hold is no hold');
  assert.deepEqual(M.lastAnalysisProblem([{ event: 'analysis_requested', detail: {} }, { event: 'analysis_failed', detail: { error_code: 'SLICER_CRASH' } }]), {
    kind: 'failed',
    code: 'SLICER_CRASH',
  });
  assert.deepEqual(M.lastAnalysisProblem([{ event: 'estimate_incompatible', detail: { warnings: ['too big'] } }]), { kind: 'incompatible', warnings: ['too big'] });
  assert.equal(M.lastAnalysisProblem([{ event: 'analysis_failed', detail: {} }, { event: 'analysis_requested', detail: {} }]), null, 'a newer request supersedes it');
  assert.equal(M.lastAnalysisProblem([{ event: 'analysis_failed', detail: {} }, { event: 'edited', detail: {} }]), null);
});

test('the page asks again only while something can change without the customer', () => {
  for (const s of ['completed', 'cancelled', 'reprint_requested', 'failed', 'draft', 'uploaded', 'ready', 'awaiting_confirmation'] as JobStatus[]) {
    assert.equal(M.jobPollMs(s), null, s);
  }
  for (const s of ['analyzing', 'confirmed', 'queued', 'preparing', 'printing', 'paused'] as JobStatus[]) {
    const ms = M.jobPollMs(s);
    assert.ok(ms !== null && ms >= 5_000, `${s}: ${ms}`);
  }
});

// ============================================================ the honest projection

const estimate = (over: Partial<JobEstimate> = {}) =>
  ({
    provenance: 'slicer',
    duration_seconds: 8280,
    model_grams: 26,
    support_grams: 2,
    purge_grams: 1,
    layer_count: 230,
    color_changes: 0,
    warnings: ['bridging detected'],
    ...over,
  }) as JobEstimate;

const projection = (credits: Partial<JobProjection['credits']>, materials: JobProjection['materials'], sufficient: boolean): JobProjection => ({
  estimate: { id: 'pce_1', provenance: 'slicer', duration_seconds: 8280, layer_count: 230, model_grams: 26, support_grams: 2, purge_grams: 1, color_changes: 0, warnings: [] },
  credits: { tier_id: 'tier_std', required_seconds: 8280, available_seconds: 36000, remaining_after_seconds: 27720, sufficient: true, shortfall_seconds: 0, ...credits },
  materials,
  sufficient,
});

test('no estimate is «awaiting estimate»: no time, no grams, no shortfall, sufficiency unknown', () => {
  const d = M.projectionDisplay(null, null);
  assert.deepEqual(d, {
    source: 'none',
    durationSeconds: null,
    grams: null,
    layerCount: null,
    colourChanges: null,
    warnings: [],
    hours: null,
    materials: [],
    shortfalls: [],
    sufficient: null,
  });
  // Even a projection arriving without an estimate of known origin shows no figure.
  assert.equal(M.projectionDisplay(estimate({ provenance: 'guess' as JobEstimate['provenance'] }), null).source, 'none');
  assert.equal(M.projectionDisplay(estimate({ provenance: 'guess' as JobEstimate['provenance'] }), null).durationSeconds, null);
  assert.equal(M.estimateSource(undefined), 'none');
  // The page shows the pill «awaiting estimate» when there is none.
  assert.match(read(`${PRINT_DIR}/JobDetail.tsx`), /if \(d\.source === 'none'\) \{[\s\S]{0,900}state="awaiting_estimate"/);
});

test('an estimate says where it came from, and its grams are its own three parts', () => {
  const slicer = M.projectionDisplay(estimate(), null);
  assert.equal(slicer.source, 'slicer');
  assert.equal(slicer.durationSeconds, 8280);
  assert.deepEqual(slicer.grams, { model: 26, support: 2, purge: 1, total: 29 });
  assert.deepEqual(slicer.warnings, ['bridging detected']);
  assert.equal(slicer.hours, null, 'without the server’s projection nothing is said about the balances');
  assert.equal(slicer.sufficient, null);
  assert.equal(M.projectionDisplay(estimate({ provenance: 'operator' }), null).source, 'operator');
  for (const lang of LANGS) {
    assert.notEqual(tx(words.jobWords.sourceSlicer, lang), tx(words.jobWords.sourceOperator, lang));
  }
});

test('what confirming would reserve, what is short and by how much, are the server’s projection — shortfalls name their refusal', () => {
  const covered = M.projectionDisplay(
    estimate(),
    projection({}, [{ variant_id: 'pcv_white', kind: 'filament', required: 29, available: 650, remaining_after: 621, sufficient: true, shortfall: 0 }], true)
  );
  assert.equal(covered.sufficient, true);
  assert.deepEqual(covered.shortfalls, []);
  assert.deepEqual(covered.hours, { tierId: 'tier_std', required: 8280, available: 36000, after: 27720, shortfall: 0 });
  assert.deepEqual(covered.materials, [{ variantId: 'pcv_white', kind: 'filament', required: 29, available: 650, after: 621, shortfall: 0 }]);

  const short = M.projectionDisplay(
    estimate(),
    projection(
      { available_seconds: 3600, remaining_after_seconds: -4680, sufficient: false, shortfall_seconds: 4680 },
      [
        { variant_id: 'pcv_white', kind: 'filament', required: 29, available: 10, remaining_after: -19, sufficient: false, shortfall: 19 },
        { variant_id: 'pcv_magnet', kind: 'accessory', required: 4, available: 4, remaining_after: 0, sufficient: true, shortfall: 0 },
        { variant_id: 'pcv_ring', kind: 'accessory', required: 2, available: 0, remaining_after: -2, sufficient: false, shortfall: 2 },
      ],
      false
    )
  );
  assert.equal(short.sufficient, false);
  assert.deepEqual(short.shortfalls, [
    { kind: 'hours', code: 'INSUFFICIENT_CREDIT', id: 'tier_std', amount: 4680 },
    { kind: 'filament', code: 'INSUFFICIENT_INVENTORY', id: 'pcv_white', amount: 19 },
    { kind: 'accessory', code: 'INSUFFICIENT_INVENTORY', id: 'pcv_ring', amount: 2 },
  ]);
  // Each shortfall leads to the store page that covers it.
  assert.equal(M.shortfallLink(short.shortfalls[0]), '/store?tab=hours&tier=tier_std');
  assert.equal(M.shortfallLink(short.shortfalls[1]), '/store?tab=materials&variant=pcv_white');
  assert.equal(M.shortfallLink(short.shortfalls[2]), '/store?tab=accessories&variant=pcv_ring');
  // A server that says «not sufficient» is never overruled by the lines.
  assert.equal(M.projectionDisplay(estimate(), projection({}, [], false)).sufficient, false);
});

// ============================================================ the printer's reading

const reading = (over: Partial<JobTelemetry>): JobTelemetry => ({
  machine_state: 'printing',
  job_id: 'pcj_1',
  progress_permille: 625,
  layer: 142,
  total_layers: 230,
  remaining_seconds: 3300,
  nozzle_temp_dc: 2201,
  bed_temp_dc: 551,
  received_at: '2026-10-27T10:00:00.000Z',
  stale: false,
  live: true,
  age_seconds: 12,
  ...over,
});

test('progress only from a fresh reading about THIS print; stale is stale; no reading is «no reading»', () => {
  assert.deepEqual(M.telemetryDisplay(null), { kind: 'none' });
  assert.deepEqual(M.telemetryDisplay(undefined), { kind: 'none' });
  const live = M.telemetryDisplay(reading({}));
  assert.equal(live.kind, 'live');
  if (live.kind === 'live') {
    assert.equal(live.percent, 62, 'the printer’s own permille, floored');
    assert.deepEqual([live.layer, live.totalLayers, live.remainingSeconds, live.nozzleC, live.bedC], [142, 230, 3300, 220, 55]);
  }
  // STALE WINS, whatever else the row says: no percent, no layers.
  assert.deepEqual(M.telemetryDisplay(reading({ stale: true, live: true, age_seconds: 900 })), { kind: 'stale', receivedAt: '2026-10-27T10:00:00.000Z' });
  assert.deepEqual(M.telemetryDisplay(reading({ stale: true, live: false })), { kind: 'stale', receivedAt: '2026-10-27T10:00:00.000Z' });
  // Fresh, but about another job (or none): not this print's progress.
  assert.deepEqual(M.telemetryDisplay(reading({ live: false, job_id: 'pcj_other' })), { kind: 'elsewhere', receivedAt: '2026-10-27T10:00:00.000Z' });
  const noFigure = M.telemetryDisplay(reading({ progress_permille: null, total_layers: 0, nozzle_temp_dc: null }));
  assert.equal(noFigure.kind, 'live');
  if (noFigure.kind === 'live') assert.deepEqual([noFigure.percent, noFigure.totalLayers, noFigure.nozzleC], [null, null, null], 'no figure, no bar');
  // The page draws the live pill and the bar only from a live display.
  const page = read(`${PRINT_DIR}/JobDetail.tsx`);
  assert.match(page, /d\.kind === 'live' \? 'live' : machinePillState\(job\.telemetry\)/);
  assert.match(page, /\{d\.kind === 'live' \? \(\s*<>\s*\{d\.percent != null \? \(/);
});

// ============================================================ words

/** Every `{ ar, en, ckb }` reachable from the module's exports. */
function trisOf(value: unknown, path: string, out: Array<{ path: string; tri: Record<string, string> }>): typeof out {
  if (!value || typeof value !== 'object') return out;
  const o = value as Record<string, unknown>;
  if ('ar' in o && 'en' in o && 'ckb' in o) out.push({ path, tri: o as Record<string, string> });
  else for (const [k, v] of Object.entries(o)) trisOf(v, `${path}.${k}`, out);
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every word of the print section exists in Arabic, English and Sorani — and the Sorani is Sorani, not the Arabic', () => {
  const tris = trisOf(words, 'print', []);
  assert.ok(tris.length > 300, `only ${tris.length} strings`);
  for (const { path, tri } of tris) {
    for (const lang of LANGS) assert.ok(typeof tri[lang] === 'string' && tri[lang].trim(), `${path}: empty ${lang}`);
    assert.notEqual(tri.ckb, tri.ar, `${path}: the Sorani is a copy of the Arabic (DECISIONS row 183)`);
    assert.notEqual(tri.en, tri.ar, `${path}: the English is a copy of the Arabic`);
    assert.equal(placeholders(tri.ar), placeholders(tri.en), `${path}: the Arabic fills other {names}`);
    assert.equal(placeholders(tri.ckb), placeholders(tri.en), `${path}: the Sorani fills other {names}`);
    // Sorani is written with Kurdish letters: never Arabic yeh, kaf, ta marbuta or alef maksura.
    assert.doesNotMatch(tri.ckb, /[\u064A\u0643\u0629\u0649]/, `${path}: the Sorani carries Arabic-only letters («${tri.ckb}»)`);
    // …and the Arabic carries none of Sorani's own.
    assert.doesNotMatch(tri.ar, /[\u06D5\u0695\u06B5\u06CE\u06C6\u06A4]/, `${path}: the Arabic carries Sorani letters («${tri.ar}»)`);
    for (const lang of LANGS) {
      assert.doesNotMatch(tri[lang], /علاوة/, `${path}: the forbidden word`);
      assert.doesNotMatch(tri[lang], /ليفونيس|لیڤۆنیس|ليڤونيس|لێڤۆنیس/, `${path}: «Levonis» is written in Latin letters`);
    }
  }
});

test('the section’s own figures in the model module are written by the house formatters, in three languages', () => {
  const src = read(`${PRINT_DIR}/model.ts`);
  let units = 0;
  const source = parse(`${PRINT_DIR}/model.ts`);
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const names = n.properties.filter(ts.isPropertyAssignment).map((p) => p.name.getText(source));
      if (names.includes('ar') && names.includes('en') && names.includes('ckb')) {
        units++;
        const get = (k: string) => (n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === k) as ts.PropertyAssignment).initializer.getText(source);
        assert.notEqual(get('ckb'), get('ar'), `${lineOf(source, n)}: the Sorani is the Arabic`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  assert.ok(units >= 4, `byte units: ${units}`);
  assert.match(src, /formatFigure\(/);
});

// ============================================================ source rules

/** A figure with a money unit: «24,250 IQD», «24250 د.ع», «$12». */
const MONEY = /\d[\d,.\u066B\u066C]*\s*(?:IQD|د\.ع|دينار|دینار|USD|\$)|(?:IQD|د\.ع|\$)\s*\d/u;
/** A figure with a duration unit: «2h 18m», «45 min», «3 ساعات», «2 کاتژمێر». */
const DURATION = /\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hours?|m|mins?|minutes?|s|secs?|seconds?|ساعة|ساعات|دقيقة|دقائق|س|د|کاتژمێر|خولەک|چرکە)(?![\p{L}\p{N}])/u;
/** A figure with a weight unit: «28 g», «1.2 kg», «28 غرام», «28 گرام». */
const WEIGHT = /\d+(?:[.,]\d+)?\s*(?:g|kg|grams?|غرام|غ|كغ|گرام|کیلۆگرام)(?![\p{L}\p{N}])/u;
const NOT_WORDS = new Set(['className', 'to', 'href', 'id', 'key', 'group', 'role', 'type', 'dir', 'style', 'accept', 'inputMode', 'autoComplete', 'placeholder', 'name', 'labelledBy']);

test('no price, duration or weight is typed into a print screen or a sentence of the section', () => {
  let scanned = 0;
  for (const rel of SECTION_FILES) {
    const source = parse(rel);
    const words = rel.endsWith('strings/print.ts');
    const inJsx = (n: ts.Node): boolean => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isJsxAttribute(p)) return !NOT_WORDS.has(p.name.getText(source));
        if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return true;
      }
      return false;
    };
    const visit = (n: ts.Node) => {
      const text = ts.isJsxText(n)
        ? n.text
        : ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)
          ? n.text
          : null;
      if (text !== null) {
        scanned++;
        const where = lineOf(source, n);
        assert.doesNotMatch(text, MONEY, `${where}: a price («${text.trim()}»)`);
        if (words || inJsx(n)) {
          assert.doesNotMatch(text, DURATION, `${where}: a duration («${text.trim()}»)`);
          assert.doesNotMatch(text, WEIGHT, `${where}: a weight («${text.trim()}»)`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  assert.ok(scanned > 500, `only ${scanned} strings scanned`);
  // No price at all: the print section never shows one (the server's projection is in hours and grams).
  for (const rel of PRINT_FILES) assert.doesNotMatch(read(rel), /<Money\b|formatIqd\(|_iqd\b/, `${rel}: a price on a print screen`);
});

test('the patterns above do catch what they are for', () => {
  for (const s of ['2h 18m', '~20 min', '3 ساعات', '2 کاتژمێر']) assert.match(s, DURATION, s);
  for (const s of ['28 g', '1.2 kg', '28 غرام', '650 گرام']) assert.match(s, WEIGHT, s);
  for (const s of ['24,250 IQD', '$12']) assert.match(s, MONEY, s);
  for (const s of ['STL, 3MF or OBJ', 'h-4 w-4', 'Print Cloud', 'https://', '{n} cm³']) {
    assert.doesNotMatch(s, DURATION, s);
    assert.doesNotMatch(s, WEIGHT, s);
    assert.doesNotMatch(s, MONEY, s);
  }
});

test('the upload is the multipart door with field `file`, its progress the browser’s own count of bytes sent', () => {
  const up = read(`${PRINT_DIR}/upload.ts`);
  assert.match(up, /xhr\.open\('POST', `\$\{CLOUD_API\}\/files`\)/);
  assert.match(up, /form\.append\('file', file, file\.name\)/);
  assert.match(up, /xhr\.upload\.onprogress = \(e\) => \{\s*if \(e\.lengthComputable\) onProgress\(\{ sent: e\.loaded, total: e\.total \}\);/);
  assert.match(up, /xhr\.withCredentials = true/);
  assert.match(up, /new ApiError\(xhr\.status, message, body\.code, body\.details/, 'a refusal keeps the server’s code and details');
  // Nothing else of the section talks to the network but through the client.
  for (const rel of PRINT_FILES.filter((f) => !f.endsWith('/upload.ts'))) {
    assert.doesNotMatch(read(rel), /XMLHttpRequest|\bfetch\(/, rel);
  }
});

test('confirming sends ONE Idempotency-Key, made when its sheet opens, re-sent on retry, renewed after success', () => {
  const page = read(`${PRINT_DIR}/JobDetail.tsx`);
  assert.equal((page.match(/useIdempotencyKey\(/g) ?? []).length, 1);
  assert.match(page, /const intent = useIdempotencyKey\('job-confirm'\);/);
  assert.match(page, /useEffect\(\(\) => \{\s*if \(!open\) return;\s*intent\.renew\(\);/, 'a fresh key when the sheet opens');
  assert.match(page, /const r = await confirmJob\(job\.id, intent\.key\);\s*intent\.renew\(\);/, 'the same key on every press until it succeeds');
  assert.doesNotMatch(page, /newIdempotencyKey/, 'never a key minted at the press');
  // The sheet asks the server to review first: fresh figures and a fresh window before the money door.
  assert.match(page, /setReview\(await reviewJob\(job\.id\)\)/);
  assert.match(page, /disabled=\{!d \|\| !d\.sufficient\}/, 'confirm stays shut while anything is short');
  // A replay is said to be one.
  assert.match(page, /r\.replayed \? t\(jobWords\.replayed\) : t\(jobWords\.confirmed\)/);
  // A development payment door is never offered anywhere in the section.
  for (const rel of PRINT_FILES) assert.doesNotMatch(read(rel), /devPayOrder|dev-pay/, rel);
});

test('every print screen is a lazy chunk; the shared pieces ride with the section’s entry', () => {
  const routes = read(`${PRINT_DIR}/PrintRoutes.tsx`);
  assert.match(routes, /^export default function PrintRoutes\(\)/m);
  for (const page of ['PrintStart', 'Library', 'Projects', 'Configure', 'Jobs', 'JobDetail']) {
    assert.match(routes, new RegExp(`prefetchable\\(\\(\\) => import\\('\\./${page}'\\)\\)`), page);
    assert.doesNotMatch(routes, new RegExp(`^import .* from '\\./${page}'`, 'm'), `${page} is imported statically`);
  }
  assert.match(routes, /^export \* from '\.\/kit';$/m);
  assert.match(routes, /^export \* from '\.\/model';$/m);
  for (const path of ['/print', '/files', '/files/:id', '/files/imports/:id', '/projects', '/projects/:id', '/projects/:id/print', '/jobs', '/jobs/:id']) {
    assert.ok(routes.includes(`path="${path}"`), path);
  }
  assert.match(routes, /<Route path="\*" element=\{<CloudNotFound \/>\} \/>/);
  // Nothing of the customer's is kept on the device.
  for (const rel of PRINT_FILES) assert.doesNotMatch(read(rel), /localStorage|sessionStorage/, rel);
});
