#!/usr/bin/env node
/**
 * READ-ONLY, SEALED DIAGNOSIS OF ONE ORDER (workflow 61, branch diag/order-30ad only).
 *
 * Every statement below is a SELECT against the live database (levonis-db-staging). The answers are collected
 * in memory, sealed with scripts/bambu-import/seal.mjs to the one-time X25519 public key in SEAL_PUBKEY, and
 * only the .sealed file is written. The log carries row counts and scrubbed error reasons, never a row.
 *
 *   node scripts/diag/order-sealed.mjs --out <dir>
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePublicKey, sealBuffer } from '../bambu-import/seal.mjs';

const DATABASE = 'levonis-db-staging';
const NEEDLE = '30AD9ABDA5';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const O = `(SELECT id FROM orders WHERE upper(id) LIKE '%${NEEDLE}%')`;
const U = `(SELECT user_id FROM orders WHERE upper(id) LIKE '%${NEEDLE}%' LIMIT 1)`;
const T0 = `(SELECT created_at FROM orders WHERE upper(id) LIKE '%${NEEDLE}%' LIMIT 1)`;
const P = `(SELECT DISTINCT product_id FROM order_items WHERE order_id IN ${O} AND product_id IS NOT NULL)`;
const I = `(SELECT id FROM order_items WHERE order_id IN ${O})`;
const QBS = `(SELECT id FROM quick_buy_sessions WHERE order_id IN ${O})`;
const at = (shift) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${T0}, '${shift}')`;

/** [key, sql] — every one a SELECT. */
const QUERIES = [
  ['migrations_last', `SELECT id, name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5`],
  ['order', `SELECT * FROM orders WHERE upper(id) LIKE '%${NEEDLE}%' OR upper(COALESCE(community_order_id, '')) LIKE '%${NEEDLE}%'`],
  ['order_items', `SELECT * FROM order_items WHERE order_id IN ${O} ORDER BY rowid`],
  ['order_item_colours', `SELECT oi.id AS item_id, oi.color_id, pc.name_en, pc.name_ar, pc.name_ckb, pc.hex, pc.active, pc.sort, pc.sku_part
     FROM order_items oi LEFT JOIN product_colors pc ON pc.id = oi.color_id WHERE oi.order_id IN ${O}`],
  ['order_item_option_values', `SELECT oi.id AS item_id, j.key AS pos, j.value AS value_id, v.name_en, v.name_ar, v.name_ckb, v.sku_part,
       v.active, v.merged_into, v.group_id, g.name_en AS group_name, g.kind AS group_kind
     FROM order_items oi, json_each(oi.option_value_ids) j
     LEFT JOIN product_option_values v ON v.id = j.value LEFT JOIN product_option_groups g ON g.id = v.group_id
    WHERE oi.order_id IN ${O}`],
  ['order_item_option_id', `SELECT oi.id AS item_id, oi.option_id, v.name_en, v.name_ar, g.name_en AS group_name, g.kind AS group_kind
     FROM order_items oi LEFT JOIN product_option_values v ON v.id = oi.option_id LEFT JOIN product_option_groups g ON g.id = v.group_id
    WHERE oi.order_id IN ${O}`],
  ['invoices', `SELECT * FROM invoices WHERE order_id IN ${O} ORDER BY revision`],
  ['status_history', `SELECT * FROM order_status_history WHERE order_id IN ${O} ORDER BY changed_at`],
  ['price_adjustments', `SELECT * FROM order_price_adjustments WHERE order_id IN ${O} ORDER BY created_at`],
  ['inventory_ledger', `SELECT * FROM inventory_ledger WHERE order_id IN ${O} ORDER BY created_at`],
  ['inventory_allocations', `SELECT * FROM order_item_inventory_allocations WHERE order_id IN ${O} ORDER BY created_at`],
  ['item_units', `SELECT order_item_id, count(*) AS units, min(created_at) AS first_at, max(created_at) AS last_at,
       sum(delivered_at IS NOT NULL) AS delivered FROM order_item_units WHERE order_id IN ${O} GROUP BY order_item_id`],
  ['audit_order', `SELECT * FROM audit_log WHERE target IN ${O} OR target IN ${I} OR detail LIKE '%${NEEDLE}%' ORDER BY id`],
  ['audit_actor_roles', `SELECT substr(id, -6) AS id6, role FROM users WHERE id IN
     (SELECT actor_id FROM audit_log WHERE target IN ${O} OR target IN ${I} OR detail LIKE '%${NEEDLE}%')`],
  ['audit_product', `SELECT * FROM audit_log WHERE target IN ${P}
       OR target IN (SELECT id FROM product_colors WHERE product_id IN ${P})
       OR target IN (SELECT id FROM product_option_values WHERE product_id IN ${P})
       OR target IN (SELECT id FROM product_option_groups WHERE product_id IN ${P})
     ORDER BY id DESC LIMIT 300`],
  ['audit_product_detail_window', `SELECT * FROM audit_log a WHERE a.created_at >= ${at('-45 days')}
       AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id IN ${O} AND x.product_id IS NOT NULL AND a.detail LIKE '%' || x.product_id || '%')
     ORDER BY a.id DESC LIMIT 300`],
  ['audit_customer_window', `SELECT * FROM audit_log WHERE actor_id = ${U} AND created_at >= ${at('-3 days')} AND created_at <= ${at('+30 days')}
     ORDER BY id LIMIT 300`],
  ['core_outbox_order', `SELECT seq, event_id, event_type, version, aggregate_type, aggregate_id, aggregate_seq, envelope, created_at, dispatched_at
     FROM core_outbox_events WHERE aggregate_id IN ${O} OR envelope LIKE '%${NEEDLE}%' ORDER BY seq LIMIT 100`],
  ['core_audit_details_order', `SELECT * FROM core_audit_details WHERE event_id IN
     (SELECT event_id FROM core_outbox_events WHERE aggregate_id IN ${O} OR envelope LIKE '%${NEEDLE}%')`],
  ['core_outbox_customer_window', `SELECT seq, event_type, aggregate_type, aggregate_id, envelope, created_at FROM core_outbox_events
     WHERE aggregate_id = ${U} AND created_at >= ${at('-3 days')} AND created_at <= ${at('+1 days')} ORDER BY seq LIMIT 200`],
  ['outbox', `SELECT id, kind, event_key, payload, state, attempts, created_at, sent_at FROM outbox WHERE event_key LIKE '%${NEEDLE}%' ORDER BY created_at`],
  ['user_notifications', `SELECT id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, meta, event_key, read_at, created_at
     FROM user_notifications WHERE entity_id IN ${O} OR link LIKE '%${NEEDLE}%' OR event_key LIKE '%${NEEDLE}%' ORDER BY created_at`],
  ['quick_buy_session', `SELECT * FROM quick_buy_sessions WHERE order_id IN ${O}`],
  ['quick_buy_items', `SELECT * FROM quick_buy_items WHERE session_id IN ${QBS} ORDER BY created_at`],
  ['quick_buy_events', `SELECT * FROM quick_buy_events WHERE session_id IN ${QBS} OR order_id IN ${O} ORDER BY created_at`],
  ['quick_buy_actions', `SELECT key, session_id, kind, request_hash, response_json, created_at FROM quick_buy_actions WHERE session_id IN ${QBS} ORDER BY created_at`],
  ['quick_buy_customer_30d', `SELECT id, state, order_id, started_at, expires_at, submitted_at, cancelled_at, cancel_reason, created_at
     FROM quick_buy_sessions WHERE user_id = ${U} AND created_at >= ${at('-30 days')} ORDER BY created_at`],
  ['product', `SELECT * FROM products WHERE id IN ${P}`],
  ['product_option_groups', `SELECT * FROM product_option_groups WHERE product_id IN ${P} ORDER BY sort`],
  ['product_option_values', `SELECT * FROM product_option_values WHERE product_id IN ${P} ORDER BY group_id, sort`],
  ['product_colors', `SELECT * FROM product_colors WHERE product_id IN ${P} ORDER BY sort`],
  ['product_color_option_links', `SELECT * FROM product_color_option_links WHERE color_id IN (SELECT id FROM product_colors WHERE product_id IN ${P})`],
  ['product_variants', `SELECT * FROM product_variants WHERE product_id IN ${P}`],
  ['product_option_swatches', `SELECT option_value_id, published_hex, url FROM product_option_value_swatches WHERE product_id IN ${P}`],
  ['product_option_fulfillment', `SELECT * FROM product_option_fulfillment WHERE product_id IN ${P}`],
  ['product_option_source_refs', `SELECT kind, source, source_id, levonis_id, source_label, binding_rule, via_variant_id, import_run_id
     FROM product_option_source_refs WHERE product_id IN ${P}`],
  ['customer_orders_30d', `SELECT o.id, o.status, o.stage, o.order_kind, o.created_at, o.cancelled_at, oi.id AS item_id, oi.product_id,
       oi.name_snapshot, oi.option_snapshot, oi.option_id, oi.option_value_ids, oi.color_id, pc.name_en AS color_name, oi.qty, oi.sku_snapshot
     FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN product_colors pc ON pc.id = oi.color_id
    WHERE o.user_id = ${U} AND o.created_at >= ${at('-30 days')} ORDER BY o.created_at, oi.rowid`],
  ['customer_cart_now', `SELECT ci.*, pc.name_en AS color_name FROM cart_items ci LEFT JOIN product_colors pc ON pc.id = ci.color_id
    WHERE ci.user_id = ${U} ORDER BY ci.created_at`],
  ['product_cart_lines_all_users', `SELECT ci.option_id, ci.option_value_ids, ci.color_id, count(*) AS lines, sum(ci.qty) AS units,
       count(DISTINCT ci.user_id) AS users, min(ci.created_at) AS first_at, max(ci.created_at) AS last_at
     FROM cart_items ci WHERE ci.product_id IN ${P} GROUP BY 1, 2, 3 ORDER BY lines DESC`],
  ['product_order_lines_all', `SELECT oi.option_id, oi.option_value_ids, oi.color_id, oi.option_snapshot, count(*) AS lines, sum(oi.qty) AS units,
       count(DISTINCT o.user_id) AS customers, min(o.created_at) AS first_at, max(o.created_at) AS last_at
     FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id IN ${P} GROUP BY 1, 2, 3, 4 ORDER BY last_at DESC`],
  ['product_orders_detail', `SELECT substr(o.id, -6) AS order6, o.status, o.order_kind, o.created_at, substr(o.user_id, -6) AS cust6,
       oi.qty, oi.option_id, oi.option_value_ids, oi.color_id, oi.option_snapshot, oi.sku_snapshot
     FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id IN ${P} ORDER BY o.created_at DESC LIMIT 200`],
  ['multi_line_same_product_orders_60d', `SELECT substr(oi.order_id, -6) AS order6, min(o.created_at) AS created_at, count(*) AS lines,
       count(DISTINCT oi.option_value_ids || '|' || oi.color_id) AS distinct_selections, sum(oi.qty) AS units, max(oi.name_snapshot) AS product
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ${at('-60 days')} AND oi.product_id IS NOT NULL AND oi.bundle_parent_item_id IS NULL
    GROUP BY oi.order_id, oi.product_id HAVING count(*) > 1 ORDER BY created_at DESC LIMIT 40`],
  ['security_events_customer', `SELECT kind, code, actor_class, method, route, target_id, status, count, first_at, last_at, detail
     FROM security_events WHERE actor_id = ${U} AND last_at >= ${at('-3 days')} AND first_at <= ${at('+30 days')} ORDER BY first_at LIMIT 100`],
  ['rate_limits_customer', `SELECT key, window_start, count FROM rate_limits WHERE key LIKE '%' || ${U} || '%' LIMIT 50`],
];

const ID_KEYS = /(^|_)(user_id|actor_id|owner_user_id|changed_by|decided_by|proposed_by|actor_user_id|created_by|recipient)$/;
const DROP_KEYS = new Set(['address_snapshot', 'phone', 'email', 'password_hash']);

/** Ids of people shortened to their last 6 characters; addresses dropped. The whole document is sealed anyway. */
function redact(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (DROP_KEYS.has(key)) {
      out[key] = value == null ? value : '[dropped]';
      continue;
    }
    out[key] = ID_KEYS.test(key) && typeof value === 'string' && value.length > 6 ? `…${value.slice(-6)}` : value;
  }
  return out;
}

function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[masked]');
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/[0-9a-f]{32,}/gi, '[hex]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/:\/\/\S*/g, '://[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function reasonOf(result, secrets) {
  for (const stream of [result.stdout, result.stderr]) {
    const start = (stream ?? '').indexOf('{');
    if (start < 0) continue;
    try {
      const error = JSON.parse(stream.slice(start))?.error;
      const notes = Array.isArray(error?.notes) ? error.notes.map((n) => n?.text).filter((t) => typeof t === 'string') : [];
      const text = [error?.text, ...notes].filter(Boolean).join(' / ');
      if (text) return scrub(text, secrets);
    } catch {
      /* not the JSON error shape */
    }
  }
  const line = `${result.stderr ?? ''}`.split('\n').find((l) => /error/i.test(l)) ?? 'no reason given';
  return scrub(line.replace(/^.*?\[ERROR\]\s*/, ''), secrets);
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  if (outIndex < 0 || !process.argv[outIndex + 1]) {
    console.error('usage: node scripts/diag/order-sealed.mjs --out <dir>');
    return 2;
  }
  const outDir = resolve(process.argv[outIndex + 1]);
  const publicKey = String(process.env.SEAL_PUBKEY ?? '').trim();
  parsePublicKey(publicKey);
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not in this step's environment");
    return 1;
  }
  const env = { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' };
  delete env.CLOUDFLARE_ENV;
  const dir = mkdtempSync(join(tmpdir(), 'levonis-diag-'));
  const config = join(dir, 'wrangler.json');
  const secrets = [];
  const writeConfig = (uuid) => {
    const body = { name: 'levonis-diag-order', compatibility_date: '2026-08-01' };
    if (uuid) body.d1_databases = [{ binding: 'DB', database_name: DATABASE, database_id: uuid }];
    writeFileSync(config, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  };
  const wrangler = (args) => {
    const result = spawnSync('npx', ['--no-install', 'wrangler', ...args, '--config', config], {
      env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) return { ok: false, reason: `did not complete (${result.error.code ?? result.error.name})` };
    if (result.status !== 0) return { ok: false, reason: `exit ${result.status ?? result.signal}: ${reasonOf(result, secrets)}` };
    try {
      return { ok: true, value: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, reason: 'did not answer with JSON' };
    }
  };

  writeConfig(null);
  const list = wrangler(['d1', 'list', '--json']);
  if (!list.ok) {
    console.error(`d1 list failed: ${list.reason}`);
    return 1;
  }
  const found = Array.isArray(list.value) ? list.value.filter((d) => d?.name === DATABASE) : [];
  if (found.length !== 1 || !UUID_PATTERN.test(String(found[0].uuid ?? ''))) {
    console.error(`d1 list: expected one well-formed ${DATABASE}, found ${found.length}`);
    return 1;
  }
  const uuid = String(found[0].uuid);
  console.log(`::add-mask::${uuid}`);
  secrets.push(uuid);
  writeConfig(uuid);
  console.log(`${DATABASE} resolved; its id is masked`);

  const tables = {};
  const errors = {};
  const counts = {};
  for (const [key, sql] of QUERIES) {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`${key} is not a SELECT`);
    const answer = wrangler(['d1', 'execute', DATABASE, '--remote', '--json', '--yes', '--command', sql]);
    if (!answer.ok) {
      errors[key] = answer.reason;
      console.log(`${key}: ERROR ${answer.reason}`);
      continue;
    }
    const first = Array.isArray(answer.value) ? answer.value[0] : null;
    if (!first || first.success !== true || !Array.isArray(first.results)) {
      errors[key] = 'no successful result';
      console.log(`${key}: ERROR no successful result`);
      continue;
    }
    tables[key] = first.results.map(redact);
    counts[key] = first.results.length;
    console.log(`${key}: ${first.results.length} ${first.results.length === 1 ? 'row' : 'rows'}`);
  }

  const document = {
    database: DATABASE,
    needle: NEEDLE,
    taken_at: new Date().toISOString(),
    github: { run_id: process.env.GITHUB_RUN_ID ?? '', sha: process.env.GITHUB_SHA ?? '' },
    statements: Object.fromEntries(QUERIES),
    counts,
    errors,
    tables,
  };
  const clear = Buffer.from(JSON.stringify(document));
  const sealed = sealBuffer(publicKey, clear);
  clear.fill(0);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const target = join(outDir, 'order-30ad.sealed');
  writeFileSync(`${target}.partial`, sealed, { flag: 'wx', mode: 0o600 });
  renameSync(`${target}.partial`, target);
  console.log(`sealed order-30ad.sealed: ${sealed.length} bytes, sha256 ${createHash('sha256').update(sealed).digest('hex')}`);
  console.log(`queries: ${QUERIES.length}, answered: ${Object.keys(counts).length}, failed: ${Object.keys(errors).length}`);
  return 0;
}

process.exitCode = main();
