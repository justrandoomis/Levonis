/**
 * RECOMMENDATIONS (docs/PRINT_CLOUD.md §7.8): accessories for a project, and
 * which printer suits a job.
 *
 * ACCESSORIES are matched LEXICALLY: an administrator's rules say «a model
 * whose name, tags or description mention `keychain` wants 1 keychain ring
 * per item», or «a project of type `magnetic` wants 2 magnets per item». The
 * answer says which rule matched which word in which field, and the customer
 * accepts, edits or rejects each suggestion. Nothing here claims to know what
 * an arbitrary geometry is for.
 *
 * PRINTERS are compared on facts: does the model fit (any orientation), does
 * the model take the materials and colours, how much of the customer's
 * credit it would use (only where a measured estimate exists for that model),
 * what the customer holds in that tier, and when the queue would start it.
 * A job is never moved to another model by this: it recommends, with reasons.
 */
import { many, one, runBatch, type Stmt } from './db';
import { invalid, pcError } from './errors';
import { fitsBuildVolume } from './files';
import { creditAccountId } from './credits';
import { inventoryAccountId } from './inventory';
import { ownedProject } from './projects';
import { iso, mulDivRound, parseJson, pcId, SECONDS_PER_HOUR } from './util';

interface RuleRow {
  id: string;
  keyword: string;
  project_type: string;
  variant_id: string;
  qty_per_item: number;
  needs_pause_at_layer: number;
  note_ar: string;
  note_en: string;
  note_ckb: string;
}

export async function accessorySuggestions(db: D1Database, userId: string, projectId: string, now: Date) {
  const project = await ownedProject(db, userId, projectId);
  const models = await many<{ id: string; name: string; quantity: number; tags_json: string; import_id: string | null }>(
    db,
    'SELECT id, name, quantity, tags_json, import_id FROM pc_project_models WHERE project_id = ?',
    projectId
  );
  const imports = await many<{ id: string; metadata_json: string }>(
    db,
    'SELECT i.id, i.metadata_json FROM pc_model_imports i JOIN pc_project_models m ON m.import_id = i.id WHERE m.project_id = ?',
    projectId
  );
  const rules = await many<RuleRow>(db, 'SELECT * FROM pc_accessory_rules WHERE active = 1');
  const totalItems = models.reduce((s, m) => s + Number(m.quantity), 0) || 1;
  const fields: Array<{ field: string; text: string; items: number }> = [
    { field: 'project.name', text: String(project.name), items: totalItems },
    { field: 'project.description', text: String(project.description ?? ''), items: totalItems },
    ...models.map((m) => ({ field: `model:${m.id}.name`, text: m.name, items: Number(m.quantity) })),
    ...models.map((m) => ({ field: `model:${m.id}.tags`, text: parseJson<string[]>(m.tags_json, []).join(' '), items: Number(m.quantity) })),
    ...imports.map((i) => {
      const meta = parseJson<{ name?: string; description?: string }>(i.metadata_json, {});
      return { field: `import:${i.id}.metadata`, text: `${meta.name ?? ''} ${meta.description ?? ''}`, items: totalItems };
    }),
  ];
  const found = new Map<string, { rule: RuleRow; qty: number; matches: Array<{ by: string; word: string; field: string }> }>();
  for (const r of rules) {
    const matches: Array<{ by: string; word: string; field: string }> = [];
    let items = 0;
    if (r.project_type && r.project_type === project.project_type) {
      matches.push({ by: 'project_type', word: r.project_type, field: 'project.project_type' });
      items = Math.max(items, totalItems);
    }
    if (r.keyword) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${r.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu');
      for (const f of fields) {
        if (re.test(f.text)) {
          matches.push({ by: 'keyword', word: r.keyword, field: f.field });
          items = Math.max(items, f.items);
        }
      }
    }
    if (!matches.length) continue;
    const prev = found.get(r.variant_id);
    const qty = items * r.qty_per_item;
    if (!prev || qty > prev.qty) found.set(r.variant_id, { rule: r, qty, matches: [...(prev?.matches ?? []), ...matches] });
  }
  const out = [];
  const s: Stmt[] = [];
  for (const [variantId, f] of found) {
    const acct = await one<{ available_qty: number }>(db, 'SELECT available_qty FROM pc_inventory_accounts WHERE id = ?', inventoryAccountId(userId, variantId));
    const owned = Number(acct?.available_qty ?? 0);
    const existing = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM pc_recommendations WHERE project_id = ? AND variant_id = ?', projectId, variantId);
    const id = existing?.id ?? pcId('pcrec');
    if (!existing) {
      s.push(
        db
          .prepare(
            `INSERT INTO pc_recommendations (id, user_id, project_id, variant_id, rule_id, qty, reason_json, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', ?)`
          )
          .bind(id, userId, projectId, variantId, f.rule.id, f.qty, JSON.stringify({ matches: f.matches }), iso(now))
      );
    }
    out.push({
      recommendation_id: id,
      variant_id: variantId,
      suggested_qty: f.qty,
      owned_qty: owned,
      shortfall_qty: Math.max(0, f.qty - owned),
      status: existing?.status ?? 'suggested',
      needs_pause_at_layer: !!f.rule.needs_pause_at_layer,
      operator_note: { ar: f.rule.note_ar, en: f.rule.note_en, ckb: f.rule.note_ckb },
      reason: { method: 'lexical_rule', matches: f.matches },
    });
  }
  if (s.length) await runBatch(db, s);
  return out;
}

export async function decideRecommendation(db: D1Database, userId: string, id: string, body: Record<string, unknown>, now: Date) {
  const rec = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM pc_recommendations WHERE id = ? AND user_id = ?', id, userId);
  if (!rec) throw pcError('NOT_FOUND');
  const status = body.status;
  if (status !== 'accepted' && status !== 'rejected') throw invalid('status', 'not_allowed');
  const qty = body.qty === undefined ? null : body.qty;
  if (qty !== null && (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 1 || qty > 100000)) throw invalid('qty', 'integer_required');
  await runBatch(db, [
    db.prepare('UPDATE pc_recommendations SET status = ?, qty = COALESCE(?, qty), decided_at = ? WHERE id = ?').bind(status, qty, iso(now), id),
  ]);
}

/**
 * Compare printer models for a project or a job, with explanations. Cost is
 * stated in the customer's own credit (seconds × the tier's hourly rate) and
 * only from a MEASURED estimate for that very model.
 */
export async function printerRecommendations(db: D1Database, userId: string, p: { projectId: string; jobId?: string | null }) {
  await ownedProject(db, userId, p.projectId);
  const models = await many<{ size_x_um: number | null; size_y_um: number | null; size_z_um: number | null; material_assignments_json: string }>(
    db,
    `SELECT f.size_x_um, f.size_y_um, f.size_z_um, m.material_assignments_json FROM pc_project_models m
       LEFT JOIN pc_model_files f ON f.id = m.file_id WHERE m.project_id = ?`,
    p.projectId
  );
  const variantIds = new Set<string>();
  for (const m of models) for (const a of parseJson<Array<{ variant_id: string }>>(m.material_assignments_json, [])) variantIds.add(a.variant_id);
  const materials = new Set<string>();
  for (const id of variantIds) {
    const v = await one<{ material: string | null }>(db, 'SELECT p.material FROM pc_variants v JOIN pc_products p ON p.id = v.product_id WHERE v.id = ?', id);
    if (v?.material) materials.add(v.material.toUpperCase());
  }
  const printerModels = await many<Record<string, unknown>>(
    db,
    `SELECT m.id, m.code, m.brand, m.model_name, m.tier_id, m.build_x_mm, m.build_y_mm, m.build_z_mm, m.max_colors, m.supported_materials_json, m.quality_rank,
            t.hourly_rate_iqd,
            (SELECT COUNT(*) FROM pc_printers p WHERE p.model_id = m.id AND p.status = 'active') AS machines
       FROM pc_printer_models m JOIN pc_credit_tiers t ON t.id = m.tier_id WHERE m.active = 1`
  );
  const job = p.jobId ? await one<{ printer_model_id: string; estimate_id: string | null }>(db, 'SELECT printer_model_id, estimate_id FROM pc_print_jobs WHERE id = ? AND user_id = ?', p.jobId, userId) : null;
  const est = job?.estimate_id ? await one<{ duration_seconds: number }>(db, 'SELECT duration_seconds FROM pc_estimates WHERE id = ?', job.estimate_id) : null;
  interface ModelVerdict {
    printer_model_id: unknown;
    code: unknown;
    name: string;
    compatible: boolean;
    reasons: string[];
    credit: { tier_id: unknown; available_seconds: number; estimated_seconds: number | null; estimated_cost_iqd: number | null; basis: string; enough_credit: boolean | null };
    quality_rank: number;
    jobs_ahead_on_model: number;
  }
  const results: ModelVerdict[] = [];
  for (const m of printerModels) {
    const reasons: string[] = [];
    const fits = models.every((x) => x.size_x_um === null || fitsBuildVolume({ x: Number(x.size_x_um), y: Number(x.size_y_um), z: Number(x.size_z_um) }, { x: Number(m.build_x_mm) * 1000, y: Number(m.build_y_mm) * 1000, z: Number(m.build_z_mm) * 1000 }).any_orientation);
    if (!fits) reasons.push('model_exceeds_build_volume');
    const supported = parseJson<string[]>(String(m.supported_materials_json), []).map((x) => x.toUpperCase());
    if (supported.length && [...materials].some((x) => !supported.includes(x))) reasons.push('material_not_supported');
    if (variantIds.size > Number(m.max_colors)) reasons.push('too_many_colours');
    if (!Number(m.machines)) reasons.push('no_active_machine');
    const acct = await one<{ available_seconds: number }>(db, 'SELECT available_seconds FROM pc_credit_accounts WHERE id = ?', creditAccountId(userId, String(m.tier_id)));
    const seconds = job && est && job.printer_model_id === m.id ? Number(est.duration_seconds) : null;
    const backlog = Number((await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pc_print_jobs WHERE printer_model_id = ? AND status IN ('queued', 'preparing', 'printing', 'paused')", m.id))?.n ?? 0);
    results.push({
      printer_model_id: m.id,
      code: m.code,
      name: `${m.brand} ${m.model_name}`,
      compatible: reasons.length === 0,
      reasons,
      credit: {
        tier_id: m.tier_id,
        available_seconds: Number(acct?.available_seconds ?? 0),
        estimated_seconds: seconds,
        estimated_cost_iqd: seconds === null ? null : mulDivRound(Number(m.hourly_rate_iqd), seconds, SECONDS_PER_HOUR),
        basis: seconds === null ? 'needs_estimate_for_this_model' : 'measured_estimate',
        enough_credit: seconds === null ? null : Number(acct?.available_seconds ?? 0) >= seconds,
      },
      quality_rank: Number(m.quality_rank),
      jobs_ahead_on_model: backlog,
    });
  }
  const compatible = results.filter((r) => r.compatible);
  const pick = (cmp: (a: ModelVerdict, b: ModelVerdict) => number) => [...compatible].sort(cmp)[0]?.printer_model_id ?? null;
  return {
    models: results,
    best: {
      lowest_cost: pick((a, b) => (a.credit.estimated_cost_iqd ?? Infinity) - (b.credit.estimated_cost_iqd ?? Infinity)),
      best_quality: pick((a, b) => b.quality_rank - a.quality_rank),
      shortest_queue: pick((a, b) => a.jobs_ahead_on_model - b.jobs_ahead_on_model),
      most_credit_available: pick((a, b) => b.credit.available_seconds - a.credit.available_seconds),
    },
    note: 'Recommendations never move a job to another printer model; changing model needs a new estimate and the credits of that model.',
  };
}
