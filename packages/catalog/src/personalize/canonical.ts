/**
 * ONE CONFIGURATION, ONE SET OF BYTES (docs/LEVO_PROJECT_PROGRAMME.md §B.1,
 * hop 2; §0 row 4). Equal choices give equal bytes and so an equal hash —
 * `design_configs` is deduplicated by `(owner_id, hash)` and a cart line
 * merges only with an identical configuration.
 *
 *   canonicalJson  stable key order, no whitespace (JSON semantics otherwise).
 *   canonicalize   every declared control explicit (defaults filled), keys
 *                  sorted, strings NFC, spaces collapsed, crops at 1e-4.
 *   configHash     SHA-256 hex of the canonical JSON (Web Crypto — browsers,
 *                  Workers and Node 22 alike).
 *
 * `canonicalize` trusts its input to be valid for the spec (normalizeConfig
 * in config.ts validates, then canonicalises); it never throws: an id the spec
 * does not declare is left out, an absent control takes its default.
 */
import type { Area, BlueprintSpec, DesignConfig, Paint, PublicBlueprint, PublicSlot, RosterEntry, TextSpec } from './types';

export type SpecLike = BlueprintSpec | PublicBlueprint;

/** Stable JSON: object keys in code-unit order at every depth, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** UTF-8 length of a string (lone surrogates count as the 3 bytes of U+FFFD). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex of `canonicalJson(config)` — pass a canonical configuration. */
export function configHash(config: DesignConfig): Promise<string> {
  return sha256Hex(canonicalJson(config));
}

/** NFC, runs of spaces made one, spaces trimmed — U+0020 only: any other whitespace stays for the text rule to refuse. */
export const cleanLine = (s: string): string => s.normalize('NFC').replace(/ {2,}/g, ' ').replace(/^ | $/g, '');

/** An object whose keys are inserted in sorted order. */
function sorted<T>(entries: Array<[string, T]>): Record<string, T> {
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** What a spec lets the customer set, by id. */
export interface Controls {
  /** Colour ids — every region and every text area (a text's own colour). */
  paint: Map<string, Paint>;
  /** Optional regions and their default. */
  optional: Map<string, boolean>;
  texts: Map<string, TextSpec>;
  areas: Map<string, Area>;
  /** Customer-choice slots. */
  slots: Map<string, PublicSlot>;
}

export function controlsOf(spec: SpecLike): Controls {
  const c: Controls = { paint: new Map(), optional: new Map(), texts: new Map(), areas: new Map(), slots: new Map() };
  for (const r of spec.regions) {
    c.paint.set(r.id, r.paint);
    if (r.optional) c.optional.set(r.id, r.optional.on);
  }
  for (const a of spec.areas) {
    c.areas.set(a.id, a);
    if (a.kind === 'text' && a.text) {
      c.texts.set(a.id, a.text);
      c.paint.set(a.id, a.text.paint);
    }
  }
  for (const s of spec.slots) if (s.choice === 'customer') c.slots.set(s.id, s);
  return c;
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const nfc = (s: unknown): string => (typeof s === 'string' ? s.normalize('NFC') : '');

/**
 * The canonical form of a configuration for this spec. Pure and total: the
 * same choices, however they were spelled (key order, NFC or not, doubled
 * spaces, a default left implicit), give the same object and the same bytes.
 */
export function canonicalize(config: DesignConfig, spec: SpecLike): DesignConfig {
  const c = controlsOf(spec);
  const src = config as Partial<DesignConfig>;
  const areaOf = (id: string, kind: Area['kind']) => c.areas.get(id)?.kind === kind;
  const lines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map(cleanLine).filter(Boolean) : []);
  const pick = <T>(rec: Record<string, T> | undefined, kind: Area['kind'], map: (v: T) => T): Record<string, T> =>
    sorted(Object.entries(rec ?? {}).filter(([id]) => areaOf(id, kind)).map(([id, v]) => [id, map(v)]));
  const asset = <A extends { key: string; crop: number[]; mode: string }>(a: A): A =>
    ({ crop: a.crop.map(r4), key: a.key, mode: a.mode }) as unknown as A;
  const extras = spec.extras;
  const roster = (entries: RosterEntry[]): RosterEntry[] =>
    entries.map((r) => {
      const colors = sorted(Object.entries(r.colors ?? {}).filter(([id]) => c.paint.has(id)));
      const texts = sorted(Object.entries(r.texts ?? {}).filter(([id]) => c.texts.has(id)).map(([id, v]) => [id, lines(v)] as [string, string[]]));
      return { ...(Object.keys(colors).length ? { colors } : {}), n: r.n, ...(Object.keys(texts).length ? { texts } : {}) };
    });
  return {
    colors: sorted([...c.paint].map(([id, p]) => [id, src.colors?.[id] ?? p.default])),
    icon: pick(src.icon, 'icon', (v) => v),
    logo: pick(src.logo, 'logo', asset),
    nfc: extras.nfc && src.nfc ? { kind: src.nfc.kind, value: nfc(src.nfc.value) } : null,
    notes: nfc(src.notes).replace(/^[ \n]+|[ \n]+$/g, ''),
    p: String(src.p ?? ''),
    parent: src.parent ?? null,
    parts: sorted(
      [...c.optional].map(([id, on]) => {
        const chosen = src.parts?.[id];
        return [id, typeof chosen === 'boolean' ? chosen : on];
      })
    ),
    photo: pick(src.photo, 'photo', asset),
    qr: pick(src.qr, 'qr', (v) => ({ kind: v.kind, value: nfc(v.value) })),
    rev: src.rev ?? 1,
    roster: extras.roster && src.roster ? roster(src.roster) : null,
    slots: sorted(
      [...c.slots].map(([id, s]) => {
        const chosen = src.slots?.[id];
        return [id, { option: chosen && 'option' in chosen ? chosen.option ?? null : s.default ?? null }];
      })
    ),
    texts: sorted([...c.texts].map(([id, t]) => [id, { style: src.texts?.[id]?.style ?? t.default_style, value: lines(src.texts?.[id]?.value) }])),
    theme: src.theme ?? null,
    v: 1,
    variant: src.variant ?? null,
  };
}
