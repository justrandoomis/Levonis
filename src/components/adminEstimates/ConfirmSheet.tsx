/**
 * «تأكيد السعر» — REMOVING THE LABEL (docs/SMART_PRICING.md §4.9; owner
 * decision D2).
 *
 * `POST /estimates/products/:id/confirm {version, accept_flags, combo_keys?}`:
 * the whole product (the label is removed — trigger T2 lets it go only after
 * the confirmation on real measures) or chosen SKUs (made firm, the label
 * staying for the others). Every open SOFT flag of the options confirmed must
 * be accepted by name; a targeted SKU still priced from a type-default weight
 * or box refuses the call (PRICE_ESTIMATE_DEFAULT_MEASURES), and no flag can
 * override that. The sheet asks the same of the options it confirms before
 * anything is sent (`confirmGate`), and the server's refusal stays the
 * backstop: open flags the server names (the catalogue's today) are added to
 * the list to accept, for the options they were named for (`withNamed`).
 * Used by the Estimated list and by the product form's banner.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Switch';
import { Segmented } from '../ui/Segmented';
import { ApiError } from '../../lib/api';
import { confirmEstimate, fetchProductLinks, type EstimateFlagEntry, type EstimateLine, type StoredEstimate } from './api';
import { ActNote, SheetFrame, useAct, useUiLang } from './parts';
import { COMMON, CONFIRM, flagClass, flagText, say, type UiLang } from './strings';
import { nameIn } from './format';

export type LabelMap = ReadonlyMap<string, { ar: string; en: string; ckb: string }>;

/** The SKU names of one product (read from its links once its details open); the combo key when unknown. */
export function useSkuLabels(productId: string, open: boolean): LabelMap {
  const [labels, setLabels] = useState<LabelMap>(new Map());
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    fetchProductLinks(productId, { signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (!ac.signal.aborted) setLabels(new Map((a.products[0]?.skus ?? []).map((s) => [s.combo_key, s.labels] as const)));
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [productId, open]);
  return labels;
}

export const lineName = (l: Pick<EstimateLine, 'combo_key'>, labels: LabelMap, lang: UiLang) =>
  l.combo_key === '' ? say(COMMON.wholeProduct, lang) : nameIn(labels.get(l.combo_key), lang, l.combo_key);

/** A line's default-measure codes (EST_DEFAULT_WEIGHT / EST_DEFAULT_BOX). */
const hardCodesOf = (l: Pick<EstimateLine, 'flags'>) => l.flags.filter((f) => flagClass(f) === 'hard');
const lineDefaulted = (l: Pick<EstimateLine, 'measure_source' | 'flags'>) => l.measure_source === 'type_default' || hardCodesOf(l).length > 0;

/**
 * What the sheet asks before it sends (§4.9), for the options it confirms (`chosen`; null is the whole
 * product), scoped as the server scopes them:
 *   - `hard`: one of them is priced from a type-default measure. Read from the lines, which every compute
 *     rewrites (the stored soft and hard flags are the applied estimate's, so real measures entered since
 *     then show only there); from the stored flags when there is no line. Real measures that wait on the
 *     refresh's apply never hold it: the server's refusal says to apply it first (`waiting_on_apply`);
 *   - `soft`: the soft flags that touch them (a flag naming no SKU is the product's) — the published
 *     estimate's, and the catalogue's words the latest compute's lines carry, which the server reads again —
 *     and the codes the server named in a PRICE_ESTIMATE_FLAGS_OPEN refusal (`named`: a bare code is the
 *     product's; an entry touches the options it was named for).
 */
export function confirmGate(
  estimate: Pick<StoredEstimate, 'flags' | 'lines'>,
  chosen: ReadonlySet<string> | null,
  named: Iterable<string | EstimateFlagEntry> = []
): { hard: boolean; soft: string[] } {
  const touches = (keys: readonly string[] | undefined) => !chosen || !keys?.length || keys.some((k) => chosen.has(k));
  const hard = estimate.lines.length
    ? estimate.lines.some((l) => (!chosen || chosen.has(l.combo_key)) && lineDefaulted(l))
    : estimate.flags.some((f) => flagClass(f.code) === 'hard' && touches(f.combo_keys));
  const asked = [...named].map((n) => (typeof n === 'string' ? { code: n } : n));
  const soft = [...new Set([...estimate.flags, ...asked].filter((f) => flagClass(f.code) === 'soft' && touches(f.combo_keys)).map((f) => f.code))];
  return { hard, soft };
}

/** The soft codes a PRICE_ESTIMATE_FLAGS_OPEN refusal names (codes only); none for any other answer. */
export function openFlagsOf(e: unknown): string[] {
  if (!(e instanceof ApiError) || e.code !== 'PRICE_ESTIMATE_FLAGS_OPEN') return [];
  const flags = e.details?.flags;
  return Array.isArray(flags) ? flags.filter((f): f is string => typeof f === 'string' && flagClass(f) === 'soft') : [];
}

/**
 * The codes a refusal named, kept for the options it was sent for (`sent`; null for the whole product, whose
 * codes touch every option): the server judged only those SKUs, so a code returns whenever the owner ticks one
 * of them again, and never asks of options it was not named for.
 */
export function withNamed(prev: readonly EstimateFlagEntry[], codes: readonly string[], sent: readonly string[] | null): EstimateFlagEntry[] {
  const out = new Map(prev.map((f) => [f.code, f] as const));
  for (const code of codes) {
    const was = out.get(code);
    if (!sent?.length || (was && !was.combo_keys?.length)) out.set(code, { code });
    else out.set(code, { code, combo_keys: [...new Set([...(was?.combo_keys ?? []), ...sent])].sort() });
  }
  return [...out.values()];
}

/**
 * «تأكيد السعر» (§4.9): the whole product, or chosen SKUs made firm. Every open
 * soft flag of what is confirmed is accepted by name; a default measure on any
 * of it refuses the call (owner decision D2), and the sheet says so before it
 * is sent.
 */
export default function ConfirmSheet({ estimate, onClose, onDone }: { estimate: StoredEstimate | null; onClose: () => void; onDone: () => void }) {
  const { lang, dir } = useUiLang();
  const act = useAct(lang);
  const [scope, setScope] = useState<'whole' | 'some'>('whole');
  const [skus, setSkus] = useState<ReadonlySet<string>>(new Set());
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [named, setNamed] = useState<readonly EstimateFlagEntry[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const labels = useSkuLabels(estimate?.product_id ?? '', !!estimate);
  useEffect(() => {
    setScope('whole');
    setSkus(new Set());
    setAccepted(new Set());
    setNamed([]);
    setHint(null);
    act.setMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimate]);
  const combos = useMemo(() => [...new Set((estimate?.lines ?? []).map((l) => l.combo_key))], [estimate]);
  if (!estimate) return null;
  const { hard, soft } = confirmGate(estimate, scope === 'some' ? skus : null, named);
  const hardOf = (c: string) => [...new Set(estimate.lines.filter((l) => l.combo_key === c).flatMap(hardCodesOf))];

  const submit = async () => {
    if (scope === 'some' && !skus.size) {
      setHint(say(CONFIRM.pickSkus, lang));
      return;
    }
    if (soft.some((f) => !accepted.has(f))) {
      setHint(say(CONFIRM.acceptAllFirst, lang));
      return;
    }
    setHint(null);
    const sent = scope === 'some' ? [...skus] : null;
    await act.run(
      'confirm',
      () =>
        confirmEstimate(estimate.product_id, {
          version: estimate.version,
          accept_flags: soft.filter((f) => accepted.has(f)),
          ...(sent ? { combo_keys: sent } : {}),
        }).catch((e: unknown) => {
          // The server's own list (the catalogue's today included): each one becomes a box to tick, for the options sent.
          const more = openFlagsOf(e);
          if (more.length) setNamed((s) => withNamed(s, more, sent));
          throw e;
        }),
      (a) => {
        onDone();
        return { tone: 'success', text: a.confirmed === 'whole' ? say(CONFIRM.doneWhole, lang) : say(CONFIRM.doneSkus, lang, { n: a.firm.length }) };
      }
    );
  };

  return (
    <SheetFrame
      open={!!estimate}
      onClose={onClose}
      title={say(CONFIRM.title, lang, { name: estimate.name || estimate.product_id })}
      lang={lang}
      dir={dir}
      testId="estimate-confirm-sheet"
      footer={
        <Button variant="primary" loading={act.busy === 'confirm'} disabled={hard} onClick={submit} data-estimate-confirm-submit>
          {say(CONFIRM.submit, lang)}
        </Button>
      }
    >
      <p className="text-[13px] leading-relaxed text-text-secondary">{say(CONFIRM.intro, lang)}</p>
      {hard ? (
        <p role="alert" className="lv-alert lv-alert-warning text-[13px] leading-relaxed text-text-primary" data-confirm-hard>
          {say(CONFIRM.hardOpen, lang)}
        </p>
      ) : null}
      {combos.length > 1 ? (
        <Segmented
          group="estimate-confirm-scope"
          label={say(CONFIRM.scopeLabel, lang)}
          value={scope}
          onChange={(v) => setScope(v === 'some' ? 'some' : 'whole')}
          size="sm"
          items={[
            { id: 'whole', label: say(CONFIRM.whole, lang) },
            { id: 'some', label: say(CONFIRM.some, lang) },
          ]}
        />
      ) : null}
      {scope === 'some' ? (
        <ul className="space-y-1" data-confirm-skus>
          {combos.map((c) => {
            const defaults = hardOf(c);
            return (
              <li key={c || '_'}>
                <Checkbox
                  checked={skus.has(c)}
                  onChange={(v) =>
                    setSkus((s) => {
                      const next = new Set(s);
                      if (v) next.add(c);
                      else next.delete(c);
                      return next;
                    })
                  }
                  label={
                    <span dir="auto">
                      {lineName({ combo_key: c }, labels, lang)}
                      {defaults.length ? (
                        <span className="ms-1 text-[12px] text-warning" data-confirm-sku-hard={c}>
                          ({defaults.map((f) => flagText(f, lang)).join(' · ')})
                        </span>
                      ) : null}
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : null}
      {soft.length ? (
        <div className="space-y-2" data-confirm-soft>
          <p className="text-[13px] font-semibold text-text-primary">{say(CONFIRM.acceptTitle, lang)}</p>
          {soft.map((f) => (
            <Checkbox
              key={f}
              checked={accepted.has(f)}
              onChange={(v) =>
                setAccepted((s) => {
                  const next = new Set(s);
                  if (v) next.add(f);
                  else next.delete(f);
                  return next;
                })
              }
              label={say(CONFIRM.accept, lang, { flag: flagText(f, lang) })}
            />
          ))}
        </div>
      ) : null}
      {hint ? <p className="text-[12px] text-danger">{hint}</p> : null}
      <ActNote message={act.message} />
    </SheetFrame>
  );
}
