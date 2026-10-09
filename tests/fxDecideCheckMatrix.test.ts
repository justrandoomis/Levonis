/**
 * EVERY DECISION FITS THE SCHEMA (FX programme plan §5.3, critique H1).
 *
 * Every (prior state × provider outcome × trigger) is run through `decide`
 * and `planFxCommit` and committed against a real 0179 database. No CHECK
 * and no trigger may ever refuse the batch: the derived status, the version
 * discipline, the bounds, the pending/MANUAL rules, the TS24 times, the
 * error-code shape and the in-step derived rates all hold for every outcome
 * the scheduler can produce. A pair leased by another run is the one
 * expected refusal — a fence miss, never a CHECK on the pair.
 *
 * Run: node --import tsx --test tests/fxDecideCheckMatrix.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asD1, freshDb } from './fixtures/app';
import { decide, type FxTrigger, type PairOutcome } from '../worker/lib/fx/decide';
import { isFenceMiss, planFxCommit } from '../worker/lib/fx/commit';
import { toStatements } from '../worker/lib/fx/write';
import { loadPairs, type FxPairId } from '../worker/lib/fx/pairs';

const NOW = new Date('2026-10-08T13:00:00.000Z');
const PUB = '2026-10-08T06:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'fx-matrix-'));
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));

const APPLIED = (pair: FxPairId, v: string) =>
  `UPDATE fx_rate_pairs SET effective_rate='${v}', effective_version=1, effective_source='review_approved', last_known_good_rate='${v}', drift_anchor_rate='${v}', drift_anchor_at='2026-10-01T00:00:00.000Z', market_rate='${v}', published_at='${PUB}', fetch_status='OK', status='OK' WHERE pair='${pair}'`;

/** The prior states, each a few statements on a fresh 0179 database. */
function states(pair: FxPairId, a: string, held: string): Record<string, string[]> {
  const pending = (reason: string, withEffective: boolean) => [
    ...(withEffective ? [APPLIED(pair, a)] : []),
    `UPDATE fx_rate_pairs SET pending_market_rate='${held}', pending_effective_rate='${held}', pending_published_at='${PUB}', pending_observed_at='2026-10-08T07:00:00.000Z', pending_reason='${reason}', pending_notified_at='2026-10-08T07:00:00.000Z', market_rate='${held}', published_at='${PUB}', fetch_status='OK', status='REVIEW_REQUIRED' WHERE pair='${pair}'`,
  ];
  return {
    none: [],
    applied: [APPLIED(pair, a)],
    pending_first: pending('FIRST_VALUE', false),
    pending_anomaly: pending('ANOMALY', true),
    pending_24h: pending('ANOMALY_24H', true),
    pending_drift: pending('DRIFT', true),
    pending_back_to_auto: pending('BACK_TO_AUTO', true),
    rejected: [APPLIED(pair, a), `UPDATE fx_rate_pairs SET rejected_rate='${held}', rejected_at='2026-10-08T12:00:00.000Z' WHERE pair='${pair}'`],
    manual: [APPLIED(pair, a), `UPDATE fx_rate_pairs SET mode='MANUAL', manual_rate='${a}', effective_source='manual' WHERE pair='${pair}'`],
    failing: [APPLIED(pair, a), `UPDATE fx_rate_pairs SET fetch_status='FAILED', status='FAILED', last_error_code='NETWORK', failing_since='2026-10-06T00:00:00.000Z' WHERE pair='${pair}'`],
    stale: [APPLIED(pair, a), `UPDATE fx_rate_pairs SET fetch_status='STALE', status='STALE', last_error_code='FX_TOO_OLD', failing_since='2026-10-08T00:00:00.000Z' WHERE pair='${pair}'`],
    pending_failing: [...pending('ANOMALY', true), `UPDATE fx_rate_pairs SET fetch_status='FAILED', last_error_code='NETWORK', failing_since='2026-10-06T00:00:00.000Z' WHERE pair='${pair}'`],
    leased_by_another: [APPLIED(pair, a), `UPDATE fx_rate_pairs SET lease_token='someone-else', lease_until='2026-10-08T13:02:00.000Z' WHERE pair='${pair}'`],
  };
}

const quote = (market: string, publishedAt: string): PairOutcome => ({
  kind: 'quote',
  market,
  buy: null,
  official: null,
  sourceUsdPerEur: null,
  sourceCnyPerEur: null,
  publishedAtMs: Date.parse(publishedAt),
});

const USD_OUTCOMES: Record<string, PairOutcome> = {
  same: quote('1660', '2026-10-08T12:00:00.000Z'),
  dead_band: quote('1664', '2026-10-08T12:00:00.000Z'),
  small_move: quote('1680', '2026-10-08T12:00:00.000Z'),
  jump: quote('1720', '2026-10-08T12:00:00.000Z'),
  drop: quote('1500', '2026-10-08T12:00:00.000Z'),
  older_publication: quote('1670', '2026-10-08T05:00:00.000Z'),
  same_publication_other_figure: quote('1675', PUB),
  out_of_bounds: quote('5000', '2026-10-08T12:00:00.000Z'),
  future: quote('1670', '2026-10-08T14:00:00.000Z'),
  too_old: quote('1670', '2026-10-01T00:00:00.000Z'),
  key_missing: { kind: 'error', code: 'KEY_MISSING' },
  key_malformed: { kind: 'error', code: 'KEY_MALFORMED' },
  network: { kind: 'error', code: 'NETWORK' },
  timeout: { kind: 'error', code: 'TIMEOUT' },
  provider_stale: { kind: 'error', code: 'STALE' },
  http: { kind: 'error', code: 'HTTP_502' },
  unit_changed: { kind: 'invalid', code: 'FX_UNIT_CHANGED' },
};

const ECB_OUTCOMES: Record<string, PairOutcome> = {
  same: quote('1.1186', '2026-10-08T00:00:00.000Z'),
  small_move: quote('1.13', '2026-10-08T00:00:00.000Z'),
  jump: quote('1.2', '2026-10-08T00:00:00.000Z'),
  older_publication: quote('1.12', '2026-10-05T00:00:00.000Z'),
  future: quote('1.12', '2026-10-09T00:00:00.000Z'),
  out_of_bounds: quote('1.7', '2026-10-08T00:00:00.000Z'),
  network: { kind: 'error', code: 'NETWORK' },
  invalid: { kind: 'invalid', code: 'FX_INVALID_SHAPE' },
};

const TRIGGERS: FxTrigger[] = ['cron', 'refresh', 'back_to_auto'];

/** One template per prior state, copied per combination (VACUUM INTO, as the role matrix does). */
function template(pair: FxPairId, sqls: string[], name: string): string {
  const raw = freshDb();
  // The USD/IQD effective rate in force, so an ECB apply writes its derived row too.
  if (pair !== 'USD_IQD') raw.exec(APPLIED('USD_IQD', '1660'));
  for (const s of sqls) raw.exec(s);
  const file = join(dir, `${name}.db`);
  raw.exec(`VACUUM INTO '${file}'`);
  raw.close();
  return file;
}

let copies = 0;
function copyOf(file: string): DatabaseSync {
  const target = join(dir, `c${++copies}.db`);
  copyFileSync(file, target);
  const raw = new DatabaseSync(target);
  raw.exec('PRAGMA foreign_keys = ON;');
  return raw;
}

async function runMatrix(pair: FxPairId, a: string, held: string, outcomes: Record<string, PairOutcome>) {
  const problems: string[] = [];
  let ran = 0;
  for (const [stateName, sqls] of Object.entries(states(pair, a, held))) {
    const file = template(pair, sqls, `${pair}-${stateName}`);
    for (const [outcomeName, outcome] of Object.entries(outcomes)) {
      for (const trigger of TRIGGERS) {
        const raw = copyOf(file);
        const db = asD1(raw);
        const leasedElsewhere = stateName === 'leased_by_another';
        // Our claim, as claimLease writes it (another run's live lease is left in place).
        if (!leasedElsewhere) raw.exec(`UPDATE fx_rate_pairs SET lease_token='ours', lease_until='2026-10-08T13:02:00.000Z', version=version+1 WHERE pair='${pair}'`);
        const all = (await loadPairs(db))!;
        const row = all.find((r) => r.pair === pair)!;
        const d = decide(row, outcome, { r24: { [pair]: null } }, { now: NOW, scheduledTime: new Date('2026-10-08T12:00:00.000Z') }, trigger);
        let n = 0;
        const plan = planFxCommit([d], [row], all, { fence: 'lease', token: 'ours', actor: null, nowIso: NOW.toISOString(), newLogId: () => `m${++n}`, trigger });
        const label = `${pair} ${stateName} × ${outcomeName} × ${trigger} → ${d.result}`;
        try {
          await db.batch(await toStatements(db, plan, null));
          ran++;
          if (leasedElsewhere) problems.push(`${label}: committed over another run's lease`);
          const after = raw.prepare(`SELECT status, fetch_status, pending_effective_rate, lease_token FROM fx_rate_pairs WHERE pair='${pair}'`).get() as Record<string, unknown>;
          if (after.lease_token !== null) problems.push(`${label}: the lease was not released`);
        } catch (e) {
          if (!(leasedElsewhere && isFenceMiss(e))) problems.push(`${label}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
        } finally {
          raw.close();
        }
      }
    }
  }
  return { problems, ran };
}

test('USD/IQD: every prior state × outcome × trigger commits without a CHECK or trigger refusal (H1)', async () => {
  const { problems, ran } = await runMatrix('USD_IQD', '1660', '1720', USD_OUTCOMES);
  assert.deepEqual(problems, []);
  assert.ok(ran >= 600, `only ${ran} combinations committed`);
});

test('EUR/USD: every prior state × outcome × trigger commits without a CHECK or trigger refusal (H1)', async () => {
  const { problems, ran } = await runMatrix('EUR_USD', '1.1186', '1.2', ECB_OUTCOMES);
  assert.deepEqual(problems, []);
  assert.ok(ran >= 280, `only ${ran} combinations committed`);
});
