/**
 * «صيغ الأرقام التسلسلية» — THE OWNER'S SERIAL FORMATS BY BRAND AND PRODUCT
 * (owner decision 2, 2026-10-09; migration 0181; DECISIONS row 195). A view
 * beside the serial inventory in «الضمانات والأجهزة».
 *
 * The owner: the shop sells Bambu Lab and Snapmaker, and Creality, Anycubic
 * and ELEGOO too; the Bambu shape alone never refuses a serial, each brand
 * has its rules, and a brand's validator is added later without a rebuild.
 * So here the owner:
 *   - edits one card per rule (a brand's, or one product's): the mode (off /
 *     warn / refuse), the characters, the lengths, the known prefixes and
 *     their models, the box-number shape and the model check — the restricted
 *     format of packages/catalog/src/serialRules.ts, never a pattern;
 *   - tries serials against the card AS TYPED (the very evaluator the server
 *     runs, here, before saving), and sees the impact on the inventory's own
 *     serials of that brand (`/dry-run`);
 *   - binds a seed rule to its brand when the migration found none;
 *   - sees the products that need a serial but have no brand — judged by the
 *     generic rule — with a link to each product's editor.
 * Saving sends the version the card was read at; a rule someone changed in
 * between is reloaded, never overwritten. Every other admin reads the screen
 * and cannot change it (the server refuses them 403 OWNER_ONLY).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, ExternalLink, FlaskConical, Link2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import * as T from '../../adminProducts/theme';
import { api, ApiError } from '../../../lib/api';
import { refusalText } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { useToast } from '../../ui/Toast';
import { Segmented } from '../../ui/Segmented';
import ProductPicker from '../../adminProducts/form/ProductPicker';
import { classifyCode, normalizeSerial, serialProblem } from '../../../../packages/catalog/src/deviceSerials';
import {
  GENERIC_RULE,
  evaluateSerial,
  parseSerialRule,
  specAsRule,
  type SerialPosition,
  type SerialPrefix,
  type SerialRule,
  type SerialRuleSpec,
} from '../../../../packages/catalog/src/serialRules';
import { formatNoteTexts } from '../../adminOrders/serials/formatNotes';
import { ruleFieldName, serialRulesStrings, type SerialRulesStrings } from './serialRulesStrings';

const BASE = '/api/admin/serial-rules';

interface StoredRule extends SerialRule {
  active: boolean;
  bound: boolean;
  product_name: string | null;
  product_name_ar: string | null;
  updated_at: string;
}

interface Brand {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  active: boolean;
  serialized_products: number;
}

interface Overview {
  installed: boolean;
  can_edit: boolean;
  rules: StoredRule[];
  brands: Brand[];
  unbranded: Array<{ id: string; slug: string; name: string; name_ar: string | null; status: string }>;
}

/** The form of one card: the spec, with the list fields as the owner types them. */
interface Draft {
  label: string;
  mode: SerialRuleSpec['mode'];
  charset: SerialRuleSpec['charset'];
  min_len: string;
  max_len: string;
  lengths: string;
  prefixes: Array<{ p: string; m: string; a: string }>;
  prefix_policy: SerialRuleSpec['prefix_policy'];
  positions: SerialPosition[];
  box_sn_shape: SerialRuleSpec['box_sn_shape'];
  family_check: boolean;
  source_note: string;
}

const toDraft = (r: SerialRuleSpec): Draft => ({
  label: r.label,
  mode: r.mode,
  charset: r.charset,
  min_len: String(r.min_len),
  max_len: String(r.max_len),
  lengths: r.lengths.join(', '),
  prefixes: r.prefixes.map((p) => ({ p: p.p, m: p.m, a: (p.a ?? []).join(', ') })),
  prefix_policy: r.prefix_policy,
  positions: r.positions,
  box_sn_shape: r.box_sn_shape,
  family_check: r.family_check,
  source_note: r.source_note,
});

const splitList = (text: string) =>
  text
    .split(/[,،\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The draft as the wire body — the server parses it again, strictly. */
function draftBody(d: Draft): Record<string, unknown> {
  return {
    label: d.label,
    mode: d.mode,
    charset: d.charset,
    min_len: d.min_len.trim() === '' ? undefined : Number(d.min_len),
    max_len: d.max_len.trim() === '' ? undefined : Number(d.max_len),
    lengths: splitList(d.lengths).map(Number),
    prefixes: d.prefixes
      .filter((p) => p.p.trim() || p.m.trim())
      .map((p): SerialPrefix => {
        const a = splitList(p.a);
        return a.length ? { p: p.p, m: p.m, a } : { p: p.p, m: p.m };
      }),
    prefix_policy: d.prefix_policy,
    positions: d.positions,
    box_sn_shape: d.box_sn_shape,
    family_check: d.family_check,
    source_note: d.source_note,
  };
}

/** A refusal in the reader's language: the code's sentence, with the field it names. */
function refusalOf(e: unknown, s: SerialRulesStrings, lang: string): string {
  if (!(e instanceof ApiError)) return s.loadFailed;
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  const text = refusalText(e.code, l, e.message || s.loadFailed);
  const field = (e.details as { field?: unknown } | undefined)?.field;
  return text.replace('{field}', typeof field === 'string' ? ruleFieldName(field, s) : '');
}

const brandName = (b: Pick<Brand, 'name_ar' | 'name_en' | 'name_ckb'> | undefined, lang: string) =>
  !b ? '' : lang === 'en' ? b.name_en || b.name_ar : lang === 'ckb' ? b.name_ckb || b.name_ar || b.name_en : b.name_ar || b.name_en;

export default function SerialRulesTab() {
  const { lang, dir } = useLanguage();
  const s = serialRulesStrings(lang);
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<Overview>(BASE));
      setErr(null);
    } catch (e) {
      setErr(refusalOf(e, s, lang));
    } finally {
      setLoading(false);
    }
  }, [s, lang]);

  useEffect(() => {
    void load();
  }, [load]);

  const brands = useMemo(() => data?.brands ?? [], [data]);
  const brandById = useMemo(() => new Map(brands.map((b) => [b.id, b] as const)), [brands]);
  const canEdit = !!data?.installed && !!data?.can_edit;

  if (loading && !data) return <div className={`${T.surface} p-8 text-center text-[13px] text-[var(--ap-text-3)]`}>{s.loading}</div>;
  if (!data) {
    return (
      <div className={`${T.surface} p-6 text-center space-y-3`} role="alert">
        <p className="text-[13px] text-[var(--ap-danger)]">{err ?? s.loadFailed}</p>
        <button type="button" className={`${T.btnSecondary} min-h-[44px]`} onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {s.retry}
        </button>
      </div>
    );
  }

  const ruleForBrand = (id: string) => data.rules.find((r) => r.active && r.scope === 'brand' && r.brand_id === id) ?? null;

  return (
    <div className="space-y-4" dir={dir} data-serial-rules>
      <header className="space-y-1.5">
        <h2 className="text-[17px] font-bold text-[var(--ap-text-1)]">{s.tabTitle}</h2>
        <p className="text-[13px] leading-relaxed text-[var(--ap-text-2)] max-w-[72ch]">{s.intro}</p>
        {!data.installed && (
          <p className="rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] px-3 py-2 text-[12.5px] text-[var(--ap-warning)]" role="status" data-serial-rules-not-installed>
            {s.notInstalled}
          </p>
        )}
        {data.installed && !data.can_edit && (
          <p className="text-[12.5px] text-[var(--ap-text-3)]" data-serial-rules-readonly>
            {s.readOnly}
          </p>
        )}
      </header>

      {data.rules.map((r) => (
        <RuleCard key={r.id} rule={r} brands={brands} brandById={brandById} canEdit={canEdit} s={s} onChanged={load} toast={toast} />
      ))}

      <section className={`${T.surface} p-4 space-y-1.5`} data-serial-rules-generic>
        <h3 className="text-[14px] font-bold text-[var(--ap-text-1)]">{s.genericTitle}</h3>
        <p className="text-[12.5px] text-[var(--ap-text-2)]">{s.genericBody}</p>
      </section>

      {canEdit && <NewRule brands={brands} s={s} onCreated={load} toast={toast} />}

      <section className={`${T.surface} p-4 space-y-2`} data-serial-rules-brands>
        <h3 className="text-[14px] font-bold text-[var(--ap-text-1)]">{s.brandsTitle}</h3>
        <ul className="divide-y divide-[var(--ap-hairline)]">
          {brands.map((b) => {
            const rule = ruleForBrand(b.id);
            return (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
                <span className="text-[var(--ap-text-1)]">{s.brandLine(brandName(b, lang), b.serialized_products)}</span>
                <span className="text-[var(--ap-text-3)]">{rule ? s.ruleOf(rule.label || brandName(b, lang)) : s.noRule}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={`${T.surface} p-4 space-y-2`} data-serial-rules-unbranded>
        <h3 className="text-[14px] font-bold text-[var(--ap-text-1)]">{s.unbrandedTitle}</h3>
        <p className="text-[12.5px] text-[var(--ap-text-2)]">{s.unbrandedHint}</p>
        {data.unbranded.length === 0 ? (
          <p className="text-[12.5px] text-[var(--ap-success)]">{s.unbrandedNone}</p>
        ) : (
          <ul className="divide-y divide-[var(--ap-hairline)]">
            {data.unbranded.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-unbranded-product={p.id}>
                <span className="min-w-0 text-[13px] text-[var(--ap-text-1)]" dir="auto">
                  {(lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name) || p.id}
                </span>
                <a className={`${T.btnSecondary} min-h-[40px]`} href={`/admin?tab=products&edit=${encodeURIComponent(p.id)}`}>
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  {s.openEditor}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Toast = ReturnType<typeof useToast>;

function RuleCard({
  rule,
  brands,
  brandById,
  canEdit,
  s,
  onChanged,
  toast,
}: {
  rule: StoredRule;
  brands: Brand[];
  brandById: Map<string, Brand>;
  canEdit: boolean;
  s: SerialRulesStrings;
  onChanged: () => Promise<void> | void;
  toast: Toast;
}) {
  const { lang } = useLanguage();
  const [draft, setDraft] = useState<Draft>(() => toDraft(rule));
  const [busy, setBusy] = useState<'save' | 'deactivate' | 'impact' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bindTo, setBindTo] = useState('');
  const [tryText, setTryText] = useState('');
  const [impact, setImpact] = useState<string | null>(null);
  // A reload (after a save, or someone else's) re-reads the card at its new version.
  useEffect(() => setDraft(toDraft(rule)), [rule]);

  const editable = canEdit && rule.active;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const title =
    rule.scope === 'product'
      ? `${s.scopes.product} · ${(lang === 'en' ? rule.product_name || rule.product_name_ar : rule.product_name_ar || rule.product_name) || rule.product_id}`
      : `${s.scopes.brand} · ${rule.brand_id ? brandName(brandById.get(rule.brand_id), lang) || rule.label : rule.label}`;

  /** The draft as the evaluator takes it — the screen's verdicts are the server's own function. */
  const parsed = useMemo(() => parseSerialRule(draftBody(draft)), [draft]);
  const invalidField = parsed.ok ? null : (parsed as { field: string }).field;
  const verdicts = useMemo(() => {
    const lines = tryText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 50);
    if (!parsed.ok) return [];
    const r = specAsRule((parsed as { spec: SerialRuleSpec }).spec, rule.id, rule.version);
    return lines.map((text) => {
      const hard = serialProblem(text) ?? (classifyCode({ text }, { boxShape: 'none' }).kind === 'ean' ? 'SERIAL_LOOKS_LIKE_EAN' : null);
      if (hard) return { text, kind: 'notSerial' as const, notes: [] as string[], family: null as string | null };
      const v = evaluateSerial(normalizeSerial(text), r);
      return {
        text,
        kind: v.refuse.length ? ('refuse' as const) : v.warnings.length ? ('warn' as const) : ('ok' as const),
        notes: formatNoteTexts([...v.refuse, ...v.warnings], lang),
        family: v.family?.m ?? null,
      };
    });
  }, [tryText, parsed, rule.id, rule.version, lang]);

  const save = async (extra: Record<string, unknown> = {}) => {
    if (busy) return;
    setBusy('save');
    setErr(null);
    try {
      await api.put(`${BASE}/${encodeURIComponent(rule.id)}`, { ...draftBody(draft), ...extra, expected_version: rule.version });
      toast.success(s.saved);
      await onChanged();
    } catch (e) {
      setErr(refusalOf(e, s, lang));
      // Someone changed it first: show their version, never overwrite it.
      if (e instanceof ApiError && e.code === 'SERIAL_RULE_CHANGED') await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const deactivate = async () => {
    if (busy || !window.confirm(s.confirmDeactivate)) return;
    setBusy('deactivate');
    setErr(null);
    try {
      await api.post(`${BASE}/${encodeURIComponent(rule.id)}/deactivate`, { expected_version: rule.version });
      toast.success(s.deactivated);
      await onChanged();
    } catch (e) {
      setErr(refusalOf(e, s, lang));
      if (e instanceof ApiError && e.code === 'SERIAL_RULE_CHANGED') await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const runImpact = async () => {
    if (busy) return;
    setBusy('impact');
    setErr(null);
    try {
      const res = await api.post<{ impact: { checked: number; ok: number; warn: number; refuse: number; capped: boolean } | null }>(`${BASE}/dry-run`, {
        rule: draftBody(draft),
        ...(rule.scope === 'product' ? { product_id: rule.product_id } : { brand_id: rule.brand_id }),
      });
      const i = res.impact;
      setImpact(!i || i.checked === 0 ? s.impactNone : `${s.impactLine(i.checked, i.ok, i.warn, i.refuse)}${i.capped ? ` ${s.impactCapped}` : ''}`);
    } catch (e) {
      setErr(refusalOf(e, s, lang));
    } finally {
      setBusy(null);
    }
  };

  const field = 'block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]';
  return (
    <section className={`${T.surface} p-4 space-y-3 ${rule.active ? '' : 'opacity-70'}`} data-serial-rule={rule.id} data-serial-rule-mode={rule.mode}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold text-[var(--ap-text-1)]" dir="auto">
          {title}
        </h3>
        <span className="text-[11.5px] text-[var(--ap-text-3)]">
          {rule.active ? s.version(rule.version) : s.inactive}
        </span>
      </div>

      {rule.scope === 'brand' && !rule.brand_id && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] p-2.5" data-serial-rule-unbound>
          <span className="text-[12.5px] text-[var(--ap-warning)]">{s.unbound}</span>
          {editable && (
            <>
              <select className={`${T.select} min-h-[40px]`} value={bindTo} onChange={(e) => setBindTo(e.target.value)} aria-label={s.chooseBrand}>
                <option value="">{s.chooseBrand}</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {brandName(b, lang)}
                  </option>
                ))}
              </select>
              <button type="button" className={`${T.btnSecondary} min-h-[40px]`} disabled={!bindTo || !!busy} onClick={() => void save({ brand_id: bindTo })}>
                <Link2 className="h-4 w-4" aria-hidden />
                {s.bind}
              </button>
            </>
          )}
        </div>
      )}

      <fieldset disabled={!editable} className="space-y-3 min-w-0">
        <div>
          <span className={field}>{s.mode}</span>
          <Segmented
            group={`serial-rule-mode-${rule.id}`}
            label={s.mode}
            value={draft.mode}
            onChange={(id) => set({ mode: id as Draft['mode'] })}
            dataAttr="data-serial-rule-mode-choice"
            items={(['off', 'warn', 'enforce'] as const).map((m) => ({ id: m, label: s.modes[m], disabled: !editable }))}
          />
          <p className="mt-1 text-[11.5px] text-[var(--ap-text-3)]">{s.modeHints[draft.mode]}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className={field}>{s.label}</span>
            <input className={`${T.input} w-full min-h-[44px]`} value={draft.label} maxLength={60} onChange={(e) => set({ label: e.target.value })} dir="auto" />
          </label>
          <label className="block min-w-0">
            <span className={field}>{s.charset}</span>
            <select className={`${T.select} w-full min-h-[44px]`} value={draft.charset} onChange={(e) => set({ charset: e.target.value as Draft['charset'] })}>
              {(['ALNUM', 'DIGITS', 'HEX'] as const).map((c) => (
                <option key={c} value={c}>
                  {s.charsets[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className={field}>{s.minLen}</span>
            <input className={`${T.input} w-full min-h-[44px]`} inputMode="numeric" dir="ltr" value={draft.min_len} onChange={(e) => set({ min_len: e.target.value })} />
          </label>
          <label className="block min-w-0">
            <span className={field}>{s.maxLen}</span>
            <input className={`${T.input} w-full min-h-[44px]`} inputMode="numeric" dir="ltr" value={draft.max_len} onChange={(e) => set({ max_len: e.target.value })} />
          </label>
          <label className="block min-w-0 sm:col-span-2">
            <span className={field}>{s.lengths}</span>
            <input className={`${T.input} w-full min-h-[44px]`} dir="ltr" value={draft.lengths} onChange={(e) => set({ lengths: e.target.value })} placeholder="15, 18" />
            <span className="block mt-1 text-[11.5px] text-[var(--ap-text-3)]">{s.lengthsHint}</span>
          </label>
        </div>

        <div className="space-y-2">
          <span className={field}>{s.prefixes}</span>
          {draft.prefixes.map((p, i) => (
            <div key={i} className="grid gap-2 grid-cols-[minmax(0,5rem)_minmax(0,1fr)] sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center">
              <input
                className={`${T.input} min-h-[40px] font-mono`}
                dir="ltr"
                aria-label={s.prefixCol}
                placeholder={s.prefixCol}
                maxLength={6}
                value={p.p}
                onChange={(e) => set({ prefixes: draft.prefixes.map((x, j) => (j === i ? { ...x, p: e.target.value.toUpperCase() } : x)) })}
              />
              <input
                className={`${T.input} min-h-[40px]`}
                dir="auto"
                aria-label={s.modelCol}
                placeholder={s.modelCol}
                maxLength={40}
                value={p.m}
                onChange={(e) => set({ prefixes: draft.prefixes.map((x, j) => (j === i ? { ...x, m: e.target.value } : x)) })}
              />
              <input
                className={`${T.input} min-h-[40px] col-span-2 sm:col-span-1`}
                dir="auto"
                aria-label={s.aliasesCol}
                placeholder={s.aliasesCol}
                value={p.a}
                onChange={(e) => set({ prefixes: draft.prefixes.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)) })}
              />
              <button
                type="button"
                className={`${T.btnIconGhost} h-10 w-10`}
                aria-label={s.removePrefix(p.p || String(i + 1))}
                onClick={() => set({ prefixes: draft.prefixes.filter((_, j) => j !== i) })}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
          <button type="button" className={`${T.btnGhost} min-h-[40px]`} onClick={() => set({ prefixes: [...draft.prefixes, { p: '', m: '', a: '' }] })}>
            <Plus className="h-4 w-4" aria-hidden />
            {s.addPrefix}
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className={field}>{s.prefixPolicy}</span>
            <select className={`${T.select} w-full min-h-[44px]`} value={draft.prefix_policy} onChange={(e) => set({ prefix_policy: e.target.value as Draft['prefix_policy'] })}>
              <option value="hint">{s.prefixPolicies.hint}</option>
              <option value="known_only">{s.prefixPolicies.known_only}</option>
            </select>
          </label>
          <label className="block min-w-0">
            <span className={field}>{s.boxShape}</span>
            <select className={`${T.select} w-full min-h-[44px]`} value={draft.box_sn_shape} onChange={(e) => set({ box_sn_shape: e.target.value as Draft['box_sn_shape'] })}>
              <option value="none">{s.boxShapes.none}</option>
              <option value="bambu">{s.boxShapes.bambu}</option>
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2.5 min-h-[44px]">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={draft.family_check} onChange={(e) => set({ family_check: e.target.checked })} />
          <span>
            <span className="block text-[13px] font-medium text-[var(--ap-text-1)]">{s.familyCheck}</span>
            <span className="block text-[11.5px] text-[var(--ap-text-3)]">{s.familyHint}</span>
          </span>
        </label>
        {draft.positions.length > 0 && <p className="text-[11.5px] text-[var(--ap-text-3)]">{s.positionsKept(draft.positions.length)}</p>}
        <label className="block min-w-0">
          <span className={field}>{s.sourceNote}</span>
          <input className={`${T.input} w-full min-h-[44px]`} value={draft.source_note} maxLength={300} onChange={(e) => set({ source_note: e.target.value })} dir="auto" />
        </label>
      </fieldset>

      {invalidField !== null && (
        <p className="text-[12px] text-[var(--ap-danger)]" role="status">
          {refusalText('SERIAL_RULE_INVALID', (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb').replace('{field}', ruleFieldName(invalidField, s))}
        </p>
      )}
      {err && (
        <p className="text-[12.5px] font-semibold text-[var(--ap-danger)]" role="alert">
          {err}
        </p>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${T.btnPrimary} min-h-[44px]`} disabled={!!busy || !parsed.ok} onClick={() => void save()} data-serial-rule-save>
            <Save className="h-4 w-4" aria-hidden />
            {busy === 'save' ? s.saving : s.save}
          </button>
          <button type="button" className={`${T.btnSecondary} min-h-[44px]`} disabled={!!busy || !parsed.ok} onClick={() => void runImpact()} data-serial-rule-impact>
            <FlaskConical className="h-4 w-4" aria-hidden />
            {s.impactRun}
          </button>
          <button type="button" className={`${T.btnGhost} min-h-[44px] text-[var(--ap-danger)]`} disabled={!!busy} onClick={() => void deactivate()}>
            <Ban className="h-4 w-4" aria-hidden />
            {s.deactivate}
          </button>
        </div>
      )}
      {impact && (
        <p className="text-[12.5px] text-[var(--ap-text-2)]" role="status" data-serial-rule-impact-result>
          <span className="font-semibold">{s.impactTitle}:</span> {impact}
        </p>
      )}

      <details className="rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-3">
        <summary className="cursor-pointer text-[13px] font-semibold text-[var(--ap-text-1)] min-h-[32px]">{s.testTitle}</summary>
        <p className="mt-1.5 text-[11.5px] text-[var(--ap-text-3)]">{s.testHint}</p>
        <textarea
          className={`${T.input} mt-2 w-full min-h-[96px] py-2 font-mono`}
          dir="ltr"
          value={tryText}
          onChange={(e) => setTryText(e.target.value)}
          aria-label={s.testTitle}
          spellCheck={false}
          data-serial-rule-try
        />
        {verdicts.length > 0 && (
          <ul className="mt-2 space-y-1.5" aria-live="polite">
            {verdicts.map((v, i) => (
              <li key={`${v.text}-${i}`} className="text-[12px]" data-serial-rule-verdict={v.kind}>
                <span className="font-mono text-[var(--ap-text-1)]" dir="ltr">
                  {v.text}
                </span>{' '}
                <span
                  className={
                    v.kind === 'ok' ? 'text-[var(--ap-success)]' : v.kind === 'warn' ? 'text-[var(--ap-warning)]' : 'text-[var(--ap-danger)]'
                  }
                >
                  — {s.verdicts[v.kind]}
                </span>
                {v.family && <span className="text-[var(--ap-text-3)]"> · {s.familyOf(v.family)}</span>}
                {v.notes.length > 0 && <span className="block text-[11.5px] text-[var(--ap-text-3)]">{v.notes.join(' ')}</span>}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

function NewRule({ brands, s, onCreated, toast }: { brands: Brand[]; s: SerialRulesStrings; onCreated: () => Promise<void> | void; toast: Toast }) {
  const { lang } = useLanguage();
  const [scope, setScope] = useState<'brand' | 'product'>('brand');
  const [brandId, setBrandId] = useState('');
  const [productId, setProductId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    // A new rule starts as the generic one — letters and digits, 6–40, `warn` —
    // and the owner tightens it on its card.
    const brand = brands.find((b) => b.id === brandId);
    const base = { ...GENERIC_RULE, label: scope === 'brand' ? (brand?.name_en || brand?.name_ar || '').slice(0, 60) : '' };
    const body: Record<string, unknown> = {
      scope,
      ...(scope === 'brand' ? { brand_id: brandId } : { product_id: productId }),
      label: base.label,
      mode: base.mode,
      charset: base.charset,
      min_len: base.min_len,
      max_len: base.max_len,
      box_sn_shape: base.box_sn_shape,
      family_check: base.family_check,
    };
    try {
      await api.post(BASE, body);
      toast.success(s.created);
      setBrandId('');
      setProductId('');
      await onCreated();
    } catch (e) {
      setErr(refusalOf(e, s, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${T.surface} p-4 space-y-3`} data-serial-rules-new>
      <h3 className="text-[14px] font-bold text-[var(--ap-text-1)]">{s.newRule}</h3>
      <Segmented
        group="serial-rule-new-scope"
        label={s.newRule}
        value={scope}
        onChange={(id) => setScope(id as 'brand' | 'product')}
        items={[
          { id: 'brand', label: s.forBrand },
          { id: 'product', label: s.forProduct },
        ]}
      />
      {scope === 'brand' ? (
        <select className={`${T.select} w-full min-h-[44px]`} value={brandId} onChange={(e) => setBrandId(e.target.value)} aria-label={s.chooseBrand}>
          <option value="">{s.chooseBrand}</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {brandName(b, lang)}
            </option>
          ))}
        </select>
      ) : (
        <ProductPicker value={productId} onChange={(id) => setProductId(id)} ariaLabel={s.forProduct} />
      )}
      {err && (
        <p className="text-[12.5px] font-semibold text-[var(--ap-danger)]" role="alert">
          {err}
        </p>
      )}
      <button
        type="button"
        className={`${T.btnPrimary} min-h-[44px]`}
        disabled={busy || (scope === 'brand' ? !brandId : !productId)}
        onClick={() => void create()}
        data-serial-rule-create
      >
        <Plus className="h-4 w-4" aria-hidden />
        {s.create}
      </button>
    </section>
  );
}
