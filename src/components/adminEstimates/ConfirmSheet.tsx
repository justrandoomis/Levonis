/**
 * «تأكيد السعر» — REMOVING THE LABEL (docs/SMART_PRICING.md §4.9; owner
 * decision D2, as DECISIONS row 292 operates it).
 *
 * `POST /estimates/products/:id/confirm {version, accept_flags, combo_keys?, real_measures?}`:
 * the whole product (the label is removed — trigger T2 lets it go only after
 * the confirmation on real measures) or chosen SKUs (made firm, the label
 * staying for the others). Every open SOFT flag of the options confirmed must
 * be accepted by name; a targeted SKU still priced from a type-default weight
 * or box refuses the call (PRICE_ESTIMATE_DEFAULT_MEASURES), and no flag can
 * override that.
 *
 * The sheet reads the product again when it opens and whenever the screen
 * went stale (a 409 PRICING_CHANGED, a compute run here, a refusal on the
 * measures), and holds what the server's live gate holds (`confirm_gate`,
 * `measureHold`); an older server's answer has no gate, and then the latest
 * lines say it (`confirmGate`) while the press goes to the server, which
 * judges. Where a type default prices the options confirmed, the sheet shows
 * the values themselves with «هذه القياسات صحيحة لهذا المنتج»: ticked, the
 * confirmation states them real in the same step (row 292). Where they cannot
 * be stated (the type's CBM, a package that differs or is partial, a weight
 * lighter than the product's own, real measures waiting on the refresh's
 * apply) it says exactly why and offers the way there. The submit is never silently disabled: a press that cannot go
 * says what to do. Open flags the server names (the catalogue's today) are
 * added to the list to accept, for the options they were named for
 * (`withNamed`). Used by the Estimated list and by the product form's banner.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Switch';
import { Segmented } from '../ui/Segmented';
import { Skeleton } from '../ui/Skeleton';
import { ApiError } from '../../lib/api';
import {
  computeEstimates,
  confirmEstimate,
  fetchEstimate,
  fetchProductLinks,
  productDimensionsHref,
  productEditorHref,
  workspaceHref,
  type EstimateFlagEntry,
  type EstimateLine,
  type RealMeasures,
  type StoredEstimate,
} from './api';
import { ActNote, Failure, Ltr, SheetFrame, errorCode, useAct, useUiLang } from './parts';
import { COMMON, CONFIRM, REVIEW, WORKSPACE, flagClass, flagText, say, type UiLang } from './strings';
import { cmText, kgText, nameIn } from './format';

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
 *   - `hard`, READ FROM THE LINES — the hold of an answer with no live gate (an older server, or a gate the
 *     server could not read; `measureHold` reads the gate first): one of them is priced from a type-default
 *     measure. Read from the lines, which every compute rewrites (the stored soft and hard flags are the
 *     applied estimate's, so real measures entered since then show only there); from the stored flags when
 *     there is no line;
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

/** How the measures hold the options confirmed (§4.9 steps 0 and 1). */
export interface MeasureHold {
  /** One of them is priced from a type default. */
  hard: boolean;
  /** Read from the server's live gate; false: from the latest lines (an older server, a failed read). */
  live: boolean;
  /** The statement on offer — the values they are priced from, exactly as the server answered them — or null. */
  statement: { weight_g: number | null; box_mm: [number, number, number] | null } | null;
  /** Why nothing can be stated: the refresh's apply is the cure (`waiting`), or the gate's reason. */
  reason: 'waiting' | 'type_cbm' | 'package_differs' | 'package_partial' | 'below_net' | null;
}

/**
 * The live hold of the options confirmed (`chosen`; null is the whole product): the server's `confirm_gate` —
 * held when one of them is among its defaulted SKUs; the statement on offer when it makes every one of those
 * real; else why not (their real measures waiting on the refresh's apply, or the gate's reason). With no gate,
 * the lines (`confirmGate`).
 */
export function measureHold(estimate: Pick<StoredEstimate, 'flags' | 'lines' | 'confirm_gate'>, chosen: ReadonlySet<string> | null): MeasureHold {
  const gate = estimate.confirm_gate;
  if (!gate) return { hard: confirmGate(estimate, chosen).hard, live: false, statement: null, reason: null };
  const held = gate.defaulted.filter((k) => !chosen || chosen.has(k));
  if (!held.length) return { hard: false, live: true, statement: null, reason: null };
  const stated = gate.real_measures;
  if (stated && held.every((k) => stated.combo_keys.includes(k))) return { hard: true, live: true, statement: { weight_g: stated.weight_g, box_mm: stated.box_mm }, reason: null };
  const waiting = gate.waiting_keys ? held.every((k) => gate.waiting_keys!.includes(k)) : !chosen && gate.waiting_on_apply;
  return { hard: true, live: true, statement: null, reason: waiting ? 'waiting' : gate.blocked };
}

/** What a press says instead of sending: never a silently disabled button. */
export type ConfirmHint = 'pickSkus' | 'blocked' | 'attestFirst' | 'acceptAllFirst';

/**
 * Whether the press sends (null) or what it says: no option chosen; the live gate holds with nothing to state
 * (`blocked`, its reason), or with the statement not ticked yet; a soft flag not accepted. Held only by the lines
 * (no live gate), the press goes: the server judges.
 */
export function confirmHint(s: {
  scope: 'whole' | 'some';
  skus: ReadonlySet<string>;
  soft: readonly string[];
  accepted: ReadonlySet<string>;
  hold: MeasureHold;
  ticked: boolean;
}): ConfirmHint | null {
  if (s.scope === 'some' && !s.skus.size) return 'pickSkus';
  if (s.hold.hard && s.hold.live) {
    if (!s.hold.statement) return s.hold.reason ? 'blocked' : null;
    if (!s.ticked) return 'attestFirst';
  }
  if (s.soft.some((f) => !s.accepted.has(f))) return 'acceptAllFirst';
  return null;
}

/** What a confirmation states real: the live gate's values exactly as shown, only once ticked; nothing otherwise. */
export function statementOf(hold: MeasureHold, ticked: boolean): RealMeasures | undefined {
  if (!hold.hard || !hold.live || !hold.statement || !ticked) return undefined;
  const { weight_g, box_mm } = hold.statement;
  if (weight_g === null && !box_mm) return undefined;
  return { ...(weight_g !== null ? { weight_g } : {}), ...(box_mm ? { box_mm: [box_mm[0], box_mm[1], box_mm[2]] } : {}) };
}

/** Why the measures hold the options confirmed, in the owner's words with the cure. */
export function holdText(hold: MeasureHold, lang: UiLang): string {
  if (hold.statement) return say(CONFIRM.hardOpen, lang);
  switch (hold.reason) {
    case 'waiting':
      return say(CONFIRM.applyFirst, lang);
    case 'type_cbm':
      return say(CONFIRM.typeCbm, lang);
    case 'package_differs':
      return say(CONFIRM.packageDiffers, lang);
    case 'package_partial':
      return say(CONFIRM.packagePartial, lang);
    case 'below_net':
      return say(CONFIRM.belowNet, lang);
    default:
      return say(CONFIRM.hardLines, lang);
  }
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

/** A way to the real measures: the product form's own section (a callback), else the product's editor or the workspace (a link). */
function GoTo({ onClick, href, label, to }: { onClick?: () => void; href: string | null; label: string; to: string }) {
  if (onClick) {
    return (
      <Button size="sm" variant="secondary" onClick={onClick} data-confirm-go={to}>
        {label}
      </Button>
    );
  }
  if (!href) return null;
  return (
    <a href={href} className="lv-button lv-button-secondary lv-button-sm" data-confirm-go={to}>
      {label}
    </a>
  );
}

/**
 * The measures' part of the sheet. With a statement on offer: the values the estimate is priced from (kg and cm,
 * as the pricing form shows them, each figure an LTR island), that they are the type's, the tick bound to exactly
 * those values, and where to enter the real ones instead. Otherwise why nothing can be stated, and the way to its
 * cure: «الأبعاد والوزن» (section ٤), the cost card, «احسب من جديد», «التحديث».
 */
export function MeasuresHold({
  hold,
  lang,
  productId,
  ticked,
  onTick,
  onOpenDimensions,
  onOpenCost,
  onCompute,
  computing = false,
}: {
  hold: MeasureHold;
  lang: UiLang;
  productId: string;
  ticked: boolean;
  onTick: (next: boolean) => void;
  onOpenDimensions?: () => void;
  onOpenCost?: () => void;
  onCompute?: () => void;
  computing?: boolean;
}) {
  const dimensions = <GoTo onClick={onOpenDimensions} href={productDimensionsHref(productId)} label={say(CONFIRM.openDimensions, lang)} to="dimensions" />;
  const cost = <GoTo onClick={onOpenCost} href={productEditorHref(productId)} label={say(CONFIRM.openCost, lang)} to="cost" />;
  const refresh = <GoTo href={workspaceHref('refresh', productId)} label={say(CONFIRM.openRefresh, lang)} to="refresh" />;
  const compute = onCompute ? (
    <Button size="sm" variant="secondary" loading={computing} onClick={onCompute} data-confirm-go="compute">
      {say(REVIEW.computeAgain, lang)}
    </Button>
  ) : null;
  if (hold.statement) {
    const { weight_g, box_mm } = hold.statement;
    return (
      <div className="lv-alert lv-alert-warning space-y-3 text-[13px] leading-relaxed text-text-primary" data-confirm-hard="statement">
        <p role="alert">{holdText(hold, lang)}</p>
        <div className="space-y-1 rounded-xl bg-surface-raised p-2.5" data-confirm-measures>
          <p className="font-semibold">{say(CONFIRM.measuresTitle, lang)}</p>
          <ul className="space-y-0.5">
            {weight_g !== null ? (
              <li data-confirm-measure="weight">
                {say(CONFIRM.weight, lang)}: <Ltr className="font-bold">{kgText(weight_g)}</Ltr> {say(CONFIRM.kg, lang)}
              </li>
            ) : null}
            {box_mm ? (
              <li data-confirm-measure="box">
                {say(CONFIRM.box, lang)}: <Ltr className="font-bold">{box_mm.map(cmText).join(' × ')}</Ltr> {say(CONFIRM.cm, lang)}
              </li>
            ) : null}
          </ul>
          <p className="text-[12px] text-text-secondary">{say(CONFIRM.fromType, lang)}</p>
        </div>
        <div>
          <Checkbox checked={ticked} onChange={onTick} label={say(CONFIRM.attest, lang)} data-confirm-attest />
          <p className="text-[12px] text-text-secondary">{say(CONFIRM.attestHint, lang)}</p>
        </div>
        <div className="space-y-1.5" data-confirm-not-these>
          <p className="text-[12px] font-semibold">{say(CONFIRM.notThese, lang)}</p>
          <p className="text-[12px] text-text-secondary">{say(CONFIRM.enterInCost, lang)}</p>
          <div className="flex flex-wrap gap-2">
            {cost}
            {dimensions}
          </div>
        </div>
      </div>
    );
  }
  const ways =
    hold.reason === 'waiting' ? (
      refresh
    ) : hold.reason === 'type_cbm' ? (
      <>
        {dimensions}
        {compute}
        {refresh}
      </>
    ) : hold.reason === 'package_differs' ? (
      <>
        {compute}
        {refresh}
      </>
    ) : hold.reason === 'package_partial' ? (
      dimensions
    ) : (
      <>
        {cost}
        {dimensions}
      </>
    );
  return (
    <div className="lv-alert lv-alert-warning space-y-2 text-[13px] leading-relaxed text-text-primary" data-confirm-hard={hold.reason ?? 'lines'}>
      <p role="alert">{holdText(hold, lang)}</p>
      <div className="flex flex-wrap gap-2">{ways}</div>
    </div>
  );
}

export interface ConfirmSheetProps {
  /** The row the sheet opens on (null: closed). The sheet reads the product again itself. */
  estimate: StoredEstimate | null;
  onClose: () => void;
  /** Confirmed: the caller closes the sheet and reads its list or banner again. */
  onDone: () => void;
  /** The server's state moved under the sheet (a compute run here, a stale version): the caller's copy is stale too. */
  onStale?: () => void;
  /**
   * A statement wrote the product's package: the product form reads the product again, its unsaved edits kept. It is
   * handed the values stated, which the package holds now — the form's guard when that read fails.
   */
  onProductChanged?: (stated: RealMeasures) => void;
  /** The product form's «الأبعاد والوزن» and its cost card's weight; without them (the workspace) the sheet links the editor. */
  onOpenDimensions?: () => void;
  onOpenCost?: () => void;
}

/**
 * «تأكيد السعر» (§4.9): the whole product, or chosen SKUs made firm. Every open
 * soft flag of what is confirmed is accepted by name; a default measure on any
 * of it refuses the call (owner decision D2) unless the owner states the shown
 * values real (row 292), and the sheet says so before it is sent.
 */
export default function ConfirmSheet({ estimate, onClose, onDone, onStale, onProductChanged, onOpenDimensions, onOpenCost }: ConfirmSheetProps) {
  const { lang, dir } = useUiLang();
  const open = !!estimate;
  const productId = estimate?.product_id ?? '';
  /** The product as read now (the version the write is fenced on, the live gate); null until the read answers. */
  const [fresh, setFresh] = useState<StoredEstimate | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [reads, setReads] = useState(0);
  // A stale screen is read again, and the caller is told: its own copy is stale too.
  const stale = useCallback(() => {
    setReads((n) => n + 1);
    onStale?.();
  }, [onStale]);
  const act = useAct(lang, stale);
  const [scope, setScope] = useState<'whole' | 'some'>('whole');
  const [skus, setSkus] = useState<ReadonlySet<string>>(new Set());
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [named, setNamed] = useState<readonly EstimateFlagEntry[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  /** The statement the owner ticked, by its values: a read that shows other values leaves it unticked. */
  const [ticked, setTicked] = useState<string | null>(null);
  const labels = useSkuLabels(productId, open);
  // Everything starts over when the sheet opens, or opens on another product — never on a read of the same one.
  useEffect(() => {
    setScope('whole');
    setSkus(new Set());
    setAccepted(new Set());
    setNamed([]);
    setHint(null);
    setTicked(null);
    setFresh(null);
    setFailure(null);
    act.setMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, open]);
  useEffect(() => {
    if (!open || !productId) return;
    const ac = new AbortController();
    fetchEstimate(productId, { signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (ac.signal.aborted) return;
        setFresh(a.product);
        setFailure(null);
      })
      .catch((e) => {
        if (!ac.signal.aborted && errorCode(e) !== 'ABORTED') setFailure(e);
      });
    return () => ac.abort();
  }, [open, productId, reads]);
  const view = fresh;
  const combos = useMemo(() => [...new Set((view?.lines ?? []).map((l) => l.combo_key))], [view]);
  if (!estimate) return null;
  const now = view ?? estimate;
  const chosen = scope === 'some' ? skus : null;
  const { soft } = confirmGate(now, chosen, named);
  const hold = measureHold(now, chosen);
  const statementKey = hold.statement ? JSON.stringify(hold.statement) : null;
  const attested = statementKey !== null && ticked === statementKey;
  /** An option's default measures, beside its name: the server's when it answered a gate, else the lines'. */
  const defaultsOf = (c: string): string[] => {
    const codes = [...new Set((view?.lines ?? []).filter((l) => l.combo_key === c).flatMap(hardCodesOf))].map((f) => flagText(f, lang));
    const gate = view?.confirm_gate;
    if (!gate) return codes;
    if (!gate.defaulted.includes(c)) return [];
    return codes.length ? codes : [say(CONFIRM.skuDefault, lang)];
  };

  const compute = () =>
    act.run('compute', () => computeEstimates({ product_ids: [productId] }), () => {
      stale();
      return { tone: 'success', text: say(REVIEW.computed, lang) };
    });

  const submit = async () => {
    if (!view) return;
    const why = confirmHint({ scope, skus, soft, accepted, hold, ticked: attested });
    if (why) {
      setHint(why === 'blocked' ? holdText(hold, lang) : say(CONFIRM[why], lang));
      return;
    }
    setHint(null);
    const sent = scope === 'some' ? [...skus] : null;
    const real_measures = statementOf(hold, attested);
    await act.run(
      'confirm',
      () =>
        confirmEstimate(view.product_id, {
          version: view.version,
          accept_flags: soft.filter((f) => accepted.has(f)),
          ...(sent ? { combo_keys: sent } : {}),
          ...(real_measures ? { real_measures } : {}),
        }).catch((e: unknown) => {
          // The server's own list (the catalogue's today included): each one becomes a box to tick, for the options sent.
          const more = openFlagsOf(e);
          if (more.length) setNamed((s) => withNamed(s, more, sent));
          // Refused on the measures: read the gate again, so the sheet says what holds them now.
          if (errorCode(e) === 'PRICE_ESTIMATE_DEFAULT_MEASURES') stale();
          throw e;
        }),
      (a) => {
        onDone();
        // The statement wrote the product's package and moved its version: the product form reads it again.
        if (real_measures) onProductChanged?.(real_measures);
        const text = real_measures
          ? a.confirmed === 'whole'
            ? say(CONFIRM.doneAttested, lang)
            : say(CONFIRM.doneAttestedSkus, lang, { n: a.firm.length })
          : a.confirmed === 'whole'
            ? say(CONFIRM.doneWhole, lang)
            : say(CONFIRM.doneSkus, lang, { n: a.firm.length });
        return { tone: 'success', text };
      }
    );
  };

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      title={say(CONFIRM.title, lang, { name: now.name || now.product_id })}
      lang={lang}
      dir={dir}
      testId="estimate-confirm-sheet"
      footer={
        <Button variant="primary" loading={act.busy === 'confirm' || (!view && !failure)} disabled={!view && !!failure} onClick={submit} data-estimate-confirm-submit>
          {say(CONFIRM.submit, lang)}
        </Button>
      }
    >
      <p className="text-[13px] leading-relaxed text-text-secondary">{say(CONFIRM.intro, lang)}</p>
      {failure ? <Failure error={failure} lang={lang} onRetry={() => setReads((n) => n + 1)} listRead={false} /> : null}
      {!view ? (
        failure ? null : (
          <div className="space-y-2" aria-busy="true" data-confirm-loading>
            <span className="sr-only">{say(WORKSPACE.loading, lang)}</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )
      ) : (
        <>
          {hold.hard ? (
            <MeasuresHold
              hold={hold}
              lang={lang}
              productId={view.product_id}
              ticked={attested}
              onTick={(v) => {
                setTicked(v ? statementKey : null);
                setHint(null);
              }}
              onOpenDimensions={
                onOpenDimensions
                  ? () => {
                      onClose();
                      onOpenDimensions();
                    }
                  : undefined
              }
              onOpenCost={
                onOpenCost
                  ? () => {
                      onClose();
                      onOpenCost();
                    }
                  : undefined
              }
              onCompute={() => void compute()}
              computing={act.busy === 'compute'}
            />
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
                const defaults = defaultsOf(c);
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
                              ({defaults.join(' · ')})
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
        </>
      )}
      {hint ? (
        <p className="text-[12px] text-danger" aria-live="polite" data-confirm-hint>
          {hint}
        </p>
      ) : null}
      <ActNote message={act.message} />
    </SheetFrame>
  );
}
