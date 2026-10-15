/**
 * The React Server Components "flight" stream of a store page (spec §C,
 * source-analysis §2) — a port of scratchpad/bambu_tools/rsc.py and resolve.py.
 *
 *   1. html → every `<script>self.__next_f.push([1,"…"])</script>` → the
 *      strings concatenated (a JS array literal that is valid JSON).
 *   2. The stream (as UTF-8 BYTES) splits into rows `<hexId>:<payload>\n`:
 *        `T<hexLen>,<bytes>` — a text row of exactly hexLen bytes, no newline;
 *        `I[…]`, `HL[…]`, `E…`, `D…`, `W…` — module imports, hints, errors, debug rows;
 *        anything else — one JSON value.
 *   3. References inside values: `$<hex>` (a row), `$<hex>:a:b` (a path into
 *      it), `$L<hex>` / `$@<hex>` (a lazy row or a promise of one), `$$…` (a
 *      literal `$…`), `$undefined`, `$D<iso>`. Elements are `["$", type, key, props]`.
 *
 * Resolution here is LAZY: nothing is resolved until a reader asks for it, so
 * a path the closed read list (extract.ts) never asks for is never resolved —
 * prices, stock and promotions included. Row ids differ per page; the product
 * is always located by its shape, never by its row id.
 */

export type RowValue =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'tag'; tag: string; raw: string }
  | { kind: 'bad'; raw: string };

export interface FlightStats {
  chunks: number;
  badChunks: number;
  bytes: number;
  rows: number;
  badRows: number;
}

export interface Flight {
  rows: Map<string, RowValue>;
  stats: FlightStats;
}

const PUSH_RE = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;

/** The concatenated flight text of a page, plus how many chunks could not be read. */
export function extractFlight(html: string): { flight: string; chunks: number; badChunks: number } {
  const parts: string[] = [];
  let chunks = 0;
  let badChunks = 0;
  PUSH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PUSH_RE.exec(html))) {
    chunks++;
    let arr: unknown;
    try {
      arr = JSON.parse(m[1]);
    } catch {
      badChunks++;
      continue;
    }
    if (Array.isArray(arr) && arr[0] === 1 && typeof arr[1] === 'string') parts.push(arr[1]);
  }
  return { flight: parts.join(''), chunks, badChunks };
}

const HEX = /^[0-9a-fA-F]+$/;
const TAGS = new Set(['I', 'H', 'E', 'D', 'W', 'P', 'C']);

/** Splits the flight stream into rows, by bytes (text rows count UTF-8 bytes). */
export function splitRows(flight: string): { rows: Map<string, RowValue>; badRows: number; bytes: number } {
  const bytes = new TextEncoder().encode(flight);
  const dec = new TextDecoder('utf-8');
  const rows = new Map<string, RowValue>();
  let badRows = 0;
  let i = 0;
  const n = bytes.length;
  const indexOf = (byte: number, from: number) => {
    for (let k = from; k < n; k++) if (bytes[k] === byte) return k;
    return -1;
  };
  while (i < n) {
    const colon = indexOf(0x3a, i); // ':'
    if (colon < 0) break;
    const rid = dec.decode(bytes.subarray(i, colon));
    if (!HEX.test(rid)) {
      // Not a row start: skip to the next newline.
      const nl = indexOf(0x0a, i);
      if (nl < 0) break;
      badRows++;
      i = nl + 1;
      continue;
    }
    const j = colon + 1;
    if (bytes[j] === 0x54) {
      // 'T': a text row of an exact byte length.
      const comma = indexOf(0x2c, j);
      const len = comma < 0 ? NaN : parseInt(dec.decode(bytes.subarray(j + 1, comma)), 16);
      if (!Number.isFinite(len)) {
        badRows++;
        const nl = indexOf(0x0a, j);
        if (nl < 0) break;
        i = nl + 1;
        continue;
      }
      rows.set(rid, { kind: 'text', text: dec.decode(bytes.subarray(comma + 1, comma + 1 + len)) });
      i = comma + 1 + len;
      continue;
    }
    let nl = indexOf(0x0a, j);
    if (nl < 0) nl = n;
    const payload = dec.decode(bytes.subarray(j, nl));
    i = nl + 1;
    const first = payload[0];
    if (first && TAGS.has(first) && !/^[[{"0-9tfn-]/.test(payload)) {
      rows.set(rid, { kind: 'tag', tag: first, raw: payload.slice(1) });
      continue;
    }
    try {
      rows.set(rid, { kind: 'json', value: JSON.parse(payload) });
    } catch {
      badRows++;
      rows.set(rid, { kind: 'bad', raw: payload.slice(0, 200) });
    }
  }
  return { rows, badRows, bytes: n };
}

/** The flight rows of a page. */
export function parseFlight(html: string): Flight {
  const { flight, chunks, badChunks } = extractFlight(html);
  const { rows, badRows, bytes } = splitRows(flight);
  return { rows, stats: { chunks, badChunks, bytes, rows: rows.size, badRows } };
}

/** Every `<script type="application/ld+json">` block of a page, parsed (unparseable blocks are skipped). */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      /* a malformed block is not evidence of anything */
    }
  }
  return out;
}

const REF = /^\$([L@]?)([0-9a-fA-F]+)(?::(.+))?$/;

/** A string that is a reference to a row (not a literal, not a special form). */
export function refOf(v: unknown): { lazy: boolean; id: string; path: string[] } | null {
  if (typeof v !== 'string' || v.length < 2 || v[0] !== '$' || v[1] === '$') return null;
  const m = REF.exec(v);
  if (!m) return null;
  return { lazy: m[1] !== '', id: m[2], path: m[3] ? m[3].split(':') : [] };
}

/** The scalar meaning of an RSC special string (`$$x` → `$x`, `$undefined` → null, `$D…` → the date). */
export function scalarOf(v: string): unknown {
  if (v.startsWith('$$')) return v.slice(1);
  if (v === '$undefined') return null;
  if (v.startsWith('$D')) return v.slice(2);
  return v;
}

export class UnresolvedRef extends Error {
  constructor(public ref: string) {
    super(`unresolved flight reference ${ref}`);
  }
}

/**
 * One step of resolution: if `v` is a reference, the value it points at (one
 * row, then the path into it, each path step resolved in turn); otherwise `v`.
 * Text rows resolve to their text. A missing row resolves to null. A cycle
 * (a row reached again while it is being followed) resolves to null.
 */
export function deref(rows: Map<string, RowValue>, v: unknown, seen: Set<string> = new Set()): unknown {
  let cur = v;
  for (let guard = 0; guard < 64; guard++) {
    if (typeof cur === 'string') {
      const ref = refOf(cur);
      if (!ref) return scalarOf(cur);
      if (seen.has(cur)) return null;
      seen.add(cur);
      const row = rows.get(ref.id);
      if (!row) return null;
      let val: unknown = row.kind === 'json' ? row.value : row.kind === 'text' ? row.text : null;
      for (const step of ref.path) {
        val = deref(rows, val, seen);
        if (val === null || typeof val !== 'object') return null;
        val = Array.isArray(val) ? val[Number(step)] : (val as Record<string, unknown>)[step];
      }
      cur = val;
      continue;
    }
    return cur;
  }
  return null;
}
