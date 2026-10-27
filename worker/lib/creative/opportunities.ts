/**
 * «شنو أنشر اليوم؟» — THE EVIDENCE, COMPUTED WITHOUT A MODEL (spec §10).
 *
 * Every opportunity is a fact the studio can show the owner with or without
 * AI, and the ideas Claude proposes may only cite these (aiContracts
 * `validateIdeas` refuses an idea whose evidence id is not in this list, and an
 * arrival or back-in-stock idea whose evidence is not for that product):
 *
 *   offer            a live PUBLIC offer on a visible product (the card's own offer block)
 *   arrival          a product first listed AFTER the baseline pass of the catalogue watch
 *   back_in_stock    a documented transition unavailable → available between two syncs
 *   coverage_gap     a category with listed products and no studio design in 30 days
 *   service_claim    an approved service claim, current
 *   owner_priority   the owner's own priority words from the settings
 *   education_topic  a few teaching subjects the shop's catalogue supports
 *   history          the latest approved designs, so ideas vary instead of repeating
 *
 * THE FIRST SYNC IS A BASELINE (spec §10: «أول استيراد للكتالوج هو baseline»).
 * `syncCatalogWatch` walks the visible catalogue in bounded pages. Until one
 * whole pass has completed, it only RECORDS what each card says and announces
 * nothing — so the first day is never "everything arrived today". After that,
 * a product it has never seen is an arrival, and only a product whose last
 * recorded state was 'unavailable' and is now 'available' is back in stock (a
 * changed description or picture is neither).
 */
import type { Evidence } from '../../../packages/creativeDoc/src/aiContracts';
import type { OpportunityDto } from '../../../packages/creativeDoc/src/api';
import type { Localized } from '../../../packages/creativeDoc/src/snapshot';
import { newId } from '../crypto';
import { optimisticSellable, optimisticVisible, runListed } from '../listing';
import { jsonObject, nowIso } from './db';
import { cardStates, visibleIdsAfter } from './store';

/** One sync call's page: bounded so a single request stays far inside D1's statement budget. */
export const WATCH_PAGE = 40;
const DAY_MS = 86_400_000;

export interface SyncReport {
  processed: number;
  baseline: boolean;
  baseline_complete: boolean;
  pass_complete: boolean;
  arrivals: number;
  back_in_stock: number;
}

interface WatchRow {
  product_id: string;
  availability: string;
}

/**
 * One bounded step of the catalogue watch. Safe to call repeatedly (the owner
 * presses «تحديث», or a later cron); each call continues from the cursor.
 */
export async function syncCatalogWatch(db: D1Database, nowMs = Date.now(), page = WATCH_PAGE): Promise<SyncReport> {
  await db.prepare(`INSERT OR IGNORE INTO creative_watch_state (id) VALUES ('catalog')`).run();
  const state = (await db.prepare(`SELECT cursor, baseline_complete, passes FROM creative_watch_state WHERE id = 'catalog'`).first<{ cursor: string; baseline_complete: number; passes: number }>())!;
  const baseline = state.baseline_complete !== 1;
  const ids = await visibleIdsAfter(db, state.cursor, page);
  const now = nowIso(nowMs);
  const report: SyncReport = { processed: 0, baseline, baseline_complete: !baseline, pass_complete: false, arrivals: 0, back_in_stock: 0 };
  const statements: D1PreparedStatement[] = [];
  if (ids.length) {
    const [cards, known] = await Promise.all([
      cardStates(db, ids),
      db.prepare('SELECT product_id, availability FROM creative_catalog_watch WHERE product_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<WatchRow>(),
    ]);
    const before = new Map((known.results ?? []).map((r) => [r.product_id, r.availability]));
    for (const id of ids) {
      const card = cards.get(id);
      if (!card) continue;
      report.processed += 1;
      const prev = before.get(id);
      if (prev === undefined) {
        statements.push(
          db
            .prepare(
              `INSERT INTO creative_catalog_watch (product_id, availability, price_status, display_price_iqd, first_seen_at, last_seen_at, baseline)
               VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(product_id) DO NOTHING`
            )
            .bind(id, card.availability, card.price_status, card.display_price_iqd, now, now, baseline ? 1 : 0)
        );
        if (!baseline) {
          report.arrivals += 1;
          statements.push(
            db
              .prepare('INSERT INTO creative_events (id, product_id, kind, detected_at, evidence_json) VALUES (?, ?, ?, ?, ?)')
              .bind(newId('cevt'), id, 'arrival', now, JSON.stringify({ first_seen_at: now, availability: card.availability }))
          );
        }
        continue;
      }
      if (!baseline && prev === 'unavailable' && card.availability === 'available') {
        report.back_in_stock += 1;
        statements.push(
          db
            .prepare('INSERT INTO creative_events (id, product_id, kind, detected_at, evidence_json) VALUES (?, ?, ?, ?, ?)')
            .bind(newId('cevt'), id, 'back_in_stock', now, JSON.stringify({ from: prev, to: card.availability, seen_at: now }))
        );
      }
      statements.push(
        db
          .prepare('UPDATE creative_catalog_watch SET availability = ?, price_status = ?, display_price_iqd = ?, last_seen_at = ? WHERE product_id = ?')
          .bind(card.availability, card.price_status, card.display_price_iqd, now, id)
      );
    }
  }
  const passComplete = ids.length < page;
  report.pass_complete = passComplete;
  if (passComplete && baseline) report.baseline_complete = true;
  statements.push(
    db
      .prepare(
        `UPDATE creative_watch_state
            SET cursor = ?, last_sync_at = ?, passes = passes + ?,
                baseline_complete = CASE WHEN ? = 1 THEN 1 ELSE baseline_complete END,
                baseline_completed_at = CASE WHEN ? = 1 AND baseline_complete = 0 THEN ? ELSE baseline_completed_at END
          WHERE id = 'catalog'`
      )
      .bind(passComplete ? '' : ids[ids.length - 1], now, passComplete ? 1 : 0, passComplete ? 1 : 0, passComplete ? 1 : 0, now)
  );
  await db.batch(statements);
  return report;
}

/** The owner's education subjects: what a 3D-printing shop can teach without inventing a fact. */
export const EDUCATION_TOPICS: ReadonlyArray<{ key: string; label: Localized }> = [
  { key: 'first_print', label: { ar: 'أول طباعة ثلاثية الأبعاد: من الملف إلى القطعة', en: 'Your first 3D print: from file to part', ckb: 'یەکەم چاپی سێ ڕەهەندی: لە فایلەوە بۆ پارچە' } },
  { key: 'filament_choice', label: { ar: 'كيف تختار الفلامنت المناسب', en: 'Choosing the right filament', ckb: 'چۆن فیلامێنتی گونجاو هەڵدەبژێریت' } },
  { key: 'filament_storage', label: { ar: 'حفظ الفلامنت من الرطوبة', en: 'Keeping filament dry', ckb: 'پاراستنی فیلامێنت لە شێ' } },
  { key: 'printer_care', label: { ar: 'العناية الدورية بالطابعة', en: 'Routine printer care', ckb: 'چاودێریی بەردەوامی چاپکەر' } },
];

const OWNER_PRIORITY_LABEL: Localized = { ar: 'أولوية حددها المالك', en: 'An owner priority', ckb: 'پێشینەیەک کە خاوەن دیاریی کردووە' };
const HISTORY_LABEL: Localized = { ar: 'تصميم معتمد مؤخراً', en: 'A recently approved design', ckb: 'دیزاینێکی ئەم دواییە پەسەندکراو' };

export interface OpportunityBundle {
  opportunities: OpportunityDto[];
  /** The same items as aiContracts evidence (id, kind, ref) — what an idea may cite. */
  evidence: Evidence[];
  /** Product ids an idea may target. */
  productIds: string[];
  categories: Array<{ id: string; name: Localized }>;
}

interface ClaimLite {
  id: string;
  title: Localized;
  version: number;
  approved_at: string | null;
}

/** Every opportunity the studio can prove right now. Never throws on a missing studio table (deploy-ahead: empty). */
export async function collectOpportunities(
  db: D1Database,
  input: { priorities: readonly string[]; claims: readonly ClaimLite[] },
  nowMs = Date.now()
): Promise<OpportunityBundle> {
  const out: OpportunityDto[] = [];
  const productIds = new Set<string>();
  const now = nowIso(nowMs);

  // Live public offers: the windows say which products; the card says whether a guest really gets the offer price.
  const windows = await db
    .prepare(
      `SELECT subject_id FROM offer_windows
        WHERE subject_type = 'product' AND active = 1 AND required_tiers = '[]' AND offer_price_mode <> ''
          AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)
        ORDER BY updated_at DESC LIMIT 12`
    )
    .bind(now, now)
    .all<{ subject_id: string }>()
    .catch(() => ({ results: [] as Array<{ subject_id: string }> }));
  const offerIds = (windows.results ?? []).map((r) => r.subject_id);
  const offerCards = await cardStates(db, offerIds);
  for (const id of offerIds) {
    const c = offerCards.get(id);
    if (!c || !c.offer) continue;
    productIds.add(id);
    out.push({ id: `offer:${id}`, kind: 'offer', ref: id, label: c.name, detail: 'live_public_offer', detected_at: null });
  }

  // Arrivals and back-in-stock: the watch's documented events of the last 14 days.
  const events = await db
    .prepare(`SELECT id, product_id, kind, detected_at FROM creative_events WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 24`)
    .bind(nowIso(nowMs - 14 * DAY_MS))
    .all<{ id: string; product_id: string | null; kind: 'arrival' | 'back_in_stock'; detected_at: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; product_id: string | null; kind: 'arrival' | 'back_in_stock'; detected_at: string }> }));
  const eventRows = (events.results ?? []).filter((e) => e.product_id);
  const eventCards = await cardStates(db, [...new Set(eventRows.map((e) => e.product_id!))]);
  const seenEvent = new Set<string>();
  for (const e of eventRows) {
    const c = eventCards.get(e.product_id!);
    // Still listed, and (for back in stock) still available — an event that no longer holds is not evidence today.
    if (!c || (e.kind === 'back_in_stock' && c.availability !== 'available')) continue;
    const key = `${e.kind}:${e.product_id}`;
    if (seenEvent.has(key)) continue;
    seenEvent.add(key);
    productIds.add(e.product_id!);
    out.push({ id: `${e.kind}:${e.product_id}`, kind: e.kind, ref: e.product_id!, label: c.name, detail: e.kind, detected_at: e.detected_at });
  }

  // Coverage gaps: top categories with listed products and no studio design touching them in 30 days.
  const categories: Array<{ id: string; name: Localized }> = [];
  const catRows = await runListed(
    db,
    `SELECT c.id, c.name_ar, c.name_en, c.name_ckb, COUNT(products.id) AS n
       FROM catalogs c JOIN products ON products.category_id = c.id
      WHERE c.active = 1 AND ${optimisticVisible(db)} AND (products.composition = '' OR ${optimisticSellable(db)})
      GROUP BY c.id ORDER BY n DESC LIMIT 12`,
    (q) => db.prepare(q).all<{ id: string; name_ar: string; name_en: string; name_ckb: string; n: number }>()
  ).catch(() => ({ results: [] as Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; n: number }> }));
  const covered = await db
    .prepare(
      `SELECT DISTINCT p.category_id AS id FROM creative_documents d JOIN products p ON p.id = d.product_id
        WHERE d.updated_at >= ? AND d.archived_at IS NULL AND p.category_id IS NOT NULL`
    )
    .bind(nowIso(nowMs - 30 * DAY_MS))
    .all<{ id: string }>()
    .catch(() => ({ results: [] as Array<{ id: string }> }));
  const coveredIds = new Set((covered.results ?? []).map((r) => r.id));
  for (const c of catRows.results ?? []) {
    const name = { ar: c.name_ar ?? '', en: c.name_en ?? '', ckb: c.name_ckb ?? '' };
    categories.push({ id: c.id, name });
    if (coveredIds.has(c.id) || out.filter((o) => o.kind === 'coverage_gap').length >= 4) continue;
    out.push({ id: `coverage_gap:${c.id}`, kind: 'coverage_gap', ref: c.id, label: name, detail: 'no_design_30_days', detected_at: null });
  }

  for (const claim of input.claims.slice(0, 8)) {
    out.push({ id: `service_claim:${claim.id}`, kind: 'service_claim', ref: claim.id, label: claim.title, detail: `version_${claim.version}`, detected_at: claim.approved_at });
  }
  // The owner's own words travel in `detail` as typed; the label is the studio's, in three languages.
  input.priorities.slice(0, 6).forEach((p, i) => {
    out.push({ id: `owner_priority:${i + 1}`, kind: 'owner_priority', ref: '', label: OWNER_PRIORITY_LABEL, detail: p, detected_at: null });
  });
  for (const t of EDUCATION_TOPICS) out.push({ id: `education_topic:${t.key}`, kind: 'education_topic', ref: t.key, label: t.label, detail: t.key, detected_at: null });

  // History: the latest approved designs (what was said recently), so ideas vary.
  const history = await db
    .prepare(`SELECT id, title, product_id, updated_at, content_json FROM creative_documents WHERE approved_version IS NOT NULL ORDER BY updated_at DESC LIMIT 3`)
    .all<{ id: string; title: string; product_id: string | null; updated_at: string; content_json: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; title: string; product_id: string | null; updated_at: string; content_json: string }> }));
  for (const h of history.results ?? []) {
    const objective = String(jsonObject(h.content_json).objective ?? '');
    out.push({ id: `history:${h.id}`, kind: 'history', ref: h.product_id ?? '', label: HISTORY_LABEL, detail: [objective, h.title].filter(Boolean).join(' · ').slice(0, 200), detected_at: h.updated_at });
  }

  const evidence: Evidence[] = out.map((o) => ({ id: o.id, kind: o.kind, ref: o.ref }));
  return { opportunities: out, evidence, productIds: [...productIds], categories };
}
