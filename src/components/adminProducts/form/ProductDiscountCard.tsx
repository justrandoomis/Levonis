/**
 * «تخفيض السعر» — THE PRODUCT'S SALE PRICE, IN SECTION ٣ OF THE PRODUCT FORM
 * (docs/ux/PRODUCT-DISCOUNT.md §6; the owner's request of 2026-10-16: «السعر قبل الخصم 600$ بعد الخصم 500$»).
 *
 * THE CURRENT PRICE IS THE BEFORE PRICE, AUTOMATICALLY. Nobody types a before price: the owner types
 * the price AFTER the discount — in dollars, one for the whole product or one per model — or a percent,
 * with an optional start and end, and sees «قبل ← بعد» for every model, colour and route before saving.
 *
 * ONE MODEL, ONE ROW, ONE DOOR (D1). The card reads and writes the SAME `offer_windows` row the
 * «العروض الخاصة» tab writes, through `PUT /api/admin/offers/:id` and its checks. Its own button saves
 * it; the product form's «حفظ» and dirty state are untouched, exactly as `MembershipDiscountSection`.
 * A save sends the WHOLE row as loaded — tiers, limits, `locked_preview`, the PLUS price — plus what
 * changed, with the stamp it read (`expected_updated_at`): a save over someone else's is refused.
 *
 * NO MATHS HERE. Every after price, saving and flag is the preview endpoint's (the cart's own
 * resolution of the draft), debounced 400 ms; «…» while it is in flight. The latest answer wins.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from '../../../lib/api';
import { useConfirm } from '../../ui/ConfirmDialog';
import Countdown from '../../ui/Countdown';
import { Banner, Grid, Percent, TextInput, Toggle, btnDanger, btnGhost, btnPrimary } from './formUi';
import { Chip, UsdInput, V2Field, useV2Lang } from './v2/v2Ui';
import { iqdText } from './v2/v2Model';
import { useV2 } from './v2/useV2Pricing';
import { discountStrings, type DiscountLang, type DiscountStrings } from './productDiscountStrings';

/* ------------------------------------------- the wire (productDiscountWire.ts) -- */

export { draftFrom, previewAnswerOf, saveBodyOf, usdSetOf } from './productDiscountWire';
export type { DiscountChannel, DiscountDraft, DiscountReadWire, DiscountRowWire, Issue, OfferWire, PreviewRowWire } from './productDiscountWire';
import { draftFrom, previewAnswerOf, saveBodyOf, type DiscountChannel, type DiscountDraft, type DiscountReadWire, type Issue, type Names, type OfferWire, type PreviewRowWire } from './productDiscountWire';

/* --------------------------------------------------------- the grouping -- */

export interface ShownRow {
  key: string;
  label: string;
  channel: DiscountChannel;
  model_id: string | null;
  before_iqd: number;
  before_usd: string | null;
  before_usd_exact: boolean;
  after_iqd: number | null;
  after_usd: string | null;
  percent: number | null;
  state: PreviewRowWire['state'] | null;
  owner?: PreviewRowWire['owner'];
}

const nameOf = (n: Names, lang: DiscountLang) => (lang === 'en' ? n.en || n.ar : lang === 'ckb' ? n.ckb || n.ar : n.ar || n.en) || '';

/**
 * Rows grouped by model and channel: a model whose colours share one before and one after price shows
 * ONE row, «… · كل الألوان»; otherwise each colour has its own. `preview` (when present) supplies the
 * after column; otherwise the read model's rows show their before prices alone.
 */
export function shownRows(read: DiscountReadWire, preview: PreviewRowWire[] | null, lang: DiscountLang, s: DiscountStrings): ShownRow[] {
  const source: PreviewRowWire[] = preview ?? read.rows.map((r) => ({ ...r, after_iqd: null, after_usd: null, offer_saving_percent: null, state: 'not_covered' as const }));
  const out: ShownRow[] = [];
  const groups = new Map<string, PreviewRowWire[]>();
  for (const r of source) {
    const k = `${r.model_id ?? ''}|${r.channel}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  for (const [k, rows] of groups) {
    const first = rows[0]!;
    const same = rows.every((r) => r.before_iqd === first.before_iqd && r.after_iqd === first.after_iqd && r.state === first.state);
    const model = first.model_id ? read.models.find((m) => m.model_id === first.model_id) : null;
    const colourful = rows.length > 1 || first.combo_key.includes('c:');
    const rowOf = (r: PreviewRowWire, label: string, key: string): ShownRow => ({
      key,
      label,
      channel: r.channel,
      model_id: r.model_id,
      before_iqd: r.before_iqd,
      before_usd: r.before_usd,
      before_usd_exact: r.before_usd_exact,
      after_iqd: preview ? r.after_iqd : null,
      after_usd: preview ? r.after_usd : null,
      percent: preview ? r.offer_saving_percent : null,
      state: preview ? r.state : null,
      ...(r.owner ? { owner: r.owner } : {}),
    });
    if (same && colourful && rows.length > 1) {
      const base = model ? nameOf(model.names, lang) : '';
      out.push(rowOf(first, base ? `${base} · ${s.allColours}` : s.allColours, k));
    } else {
      for (const r of rows) out.push(rowOf(r, nameOf(r.names, lang) || nameOf(model?.names ?? { ar: '', en: '', ckb: '' }, lang), `${k}|${r.combo_key}`));
    }
  }
  return out;
}

/* ------------------------------------------------------------- the view -- */

const issueText = (i: Issue, lang: DiscountLang) => (lang === 'ar' ? i.ar : lang === 'ckb' ? i.ckb : i.en) || i.message || i.code;

const iqdUnit = (lang: DiscountLang) => (lang === 'en' ? 'IQD' : 'د.ع');
const money = (n: number, lang: DiscountLang) => `${iqdText(n)} ${iqdUnit(lang)}`;

/**
 * AN AMOUNT IN A ROW: the FIGURE alone is an LTR island, the unit follows the sentence (review, bidi). `iqdText`
 * prints Latin digits, so isolating «900,000 د.ع» whole drew the unit on the opposite side from every other
 * price in Arabic and Sorani.
 */
function IqdAmount({ n, lang }: { n: number; lang: DiscountLang }) {
  return (
    <>
      <bdi dir="ltr">{iqdText(n)}</bdi> {iqdUnit(lang)}
    </>
  );
}

/** Issues said once each (the preview's and the save's can name the same code). */
const onceEach = (list: readonly Issue[]): Issue[] => {
  const seen = new Set<string>();
  return list.filter((i) => (seen.has(i.code) ? false : (seen.add(i.code), true)));
};
const pct = (n: number, lang: DiscountLang) => (lang === 'en' ? `−${n}%` : `−${n}٪`);

function usdReasonText(reason: DiscountReadWire['usd']['reason'], s: DiscountStrings): string {
  switch (reason) {
    case 'OWNER_ONLY':
      return s.usdOwnerOnly;
    case 'NOT_DIRECT':
      return s.usdNotDirect;
    case 'MIXED_PRICES':
      return s.usdMixed;
    case 'NOT_INSTALLED':
      return s.usdNotInstalled;
    case 'NOT_PUBLISHED':
      return s.notPublished;
    default:
      return '';
  }
}

/** A segmented control (a radiogroup); the pressed one is drawn as a clay well (row 207). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  data,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  label: string;
  data: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} data-discount-segment={data} className="flex min-w-0 flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`lv-hit relative inline-flex min-h-[44px] min-w-0 items-center justify-center rounded-lg border border-border-subtle px-3 text-[12.5px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              on ? 'bg-[var(--clay-well-bg)] shadow-press text-text-primary' : 'bg-surface-raised shadow-xs text-text-secondary hover:text-text-primary'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function RowChips({ row, s }: { row: ShownRow; s: DiscountStrings }) {
  const chips: ReactNode[] = [];
  if (row.state === 'not_lower' || row.state === 'not_covered') chips.push(<Chip key="no" tone="muted" data="no-sale">{s.noSale}</Chip>);
  if (row.state === 'below_floor') chips.push(<Chip key="floor" tone="danger" data="below-floor">{s.belowFloor}</Chip>);
  if (row.owner?.below_cost) chips.push(<Chip key="cost" tone="warning" data="below-cost">{s.belowCost}</Chip>);
  else if (row.owner?.below_min_profit) chips.push(<Chip key="min" tone="warning" data="below-min-profit">{s.belowMinProfit}</Chip>);
  return chips.length ? <span className="inline-flex flex-wrap gap-1">{chips}</span> : null;
}

export interface DiscountViewProps {
  lang: DiscountLang;
  productId: string | null;
  read: DiscountReadWire | null;
  offer: OfferWire | null;
  scheduleState: 'upcoming' | 'live' | 'ended' | null;
  opened: boolean;
  draft: DiscountDraft | null;
  preview: PreviewRowWire[] | null;
  previewing: boolean;
  issues: Issue[];
  warnings: Issue[];
  /**
   * THE PREVIEW'S OWN REFUSALS AND WARNINGS (review): a draft the door refuses (a typo above $100,000, an end
   * before the start, a set the scope rule refuses) is said while it is typed — not only after «حفظ».
   */
  previewIssues?: Issue[];
  previewWarnings?: Issue[];
  note: string | null;
  busy: boolean;
  drafting: boolean;
  onOpen: () => void;
  onDraft: (next: DiscountDraft) => void;
  onSave: () => void;
  onRemove: () => void;
  errorRef?: React.Ref<HTMLDivElement>;
}

/** THE CARD, pure: everything it shows is in its props (tests render it in each §6.2 state). */
export function DiscountCardView(p: DiscountViewProps) {
  const s = discountStrings(p.lang);
  const shell = (children: ReactNode, chip?: ReactNode) => (
    <section className="lv-surface mt-3 min-w-0 rounded-xl p-3" data-product-discount aria-label={s.title}>
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-[14px] font-black text-text-primary">{s.title}</h3>
        {chip}
      </div>
      {children}
    </section>
  );
  if (!p.productId) return shell(<p className="text-[12px] text-text-secondary" data-discount-state="new">{s.newProduct}</p>);
  if (!p.read) return shell(<p className="text-[12px] text-text-muted" aria-busy>{s.previewing}</p>);
  if (p.read.composition) return null;
  if (!p.read.published) return shell(<p className="text-[12px] text-text-secondary" data-discount-state="unpublished">{s.notPublished}</p>);
  if (!p.offer && !p.opened) {
    return shell(
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2" data-discount-state="none">
        <p className="text-[12px] text-text-secondary">{s.none}</p>
        <button type="button" className={`${btnGhost} lv-hit relative min-h-[44px]`} onClick={p.onOpen}>
          {s.add}
        </button>
        {p.note ? <div className="w-full"><Banner kind="ok">{p.note}</Banner></div> : null}
      </div>
    );
  }
  const d = p.draft!;
  const read = p.read;
  const usdAllowed = read.usd.available;
  const seesUsd = read.viewer === 'owner' || read.method === 'usd';
  const bothScopes = read.usd.scopes.includes('product') && read.usd.scopes.includes('model');
  const scope: DiscountDraft['scope'] = read.usd.scopes.length === 1 ? read.usd.scopes[0]! : d.scope;
  const rows = shownRows(read, p.preview, p.lang, s);
  const direct = rows.filter((r) => r.channel === 'direct_sale');
  const preorder = rows.filter((r) => r.channel !== 'direct_sale');
  const set = (patch: Partial<DiscountDraft>) => p.onDraft({ ...d, ...patch });
  const firstOfModel = new Set<string>();
  const offer = p.offer;
  const otherMode = offer && offer.offer_price_mode !== '' && offer.offer_price_mode !== 'fixed_usd' && offer.offer_price_mode !== 'discount_percent';
  const extras: string[] = [];
  if (offer && offer.required_tiers.length) extras.push(s.membersOnly(offer.required_tiers.map((t) => t.toUpperCase()).join(' · ')));
  if (offer && offer.max_per_user) extras.push(s.perCustomer(offer.max_per_user));
  if (offer && offer.max_global) extras.push(s.totalLimit(offer.max_global));

  const stateChip =
    offer && p.scheduleState ? (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {offer.suspended ? <Chip tone="warning" data="suspended">{s.suspended}</Chip> : null}
        <Chip tone={p.scheduleState === 'live' ? 'success' : p.scheduleState === 'upcoming' ? 'info' : 'muted'} data={`state-${p.scheduleState}`}>
          {s.state[p.scheduleState]}
        </Chip>
        {p.scheduleState === 'live' && offer.ends_at ? <Countdown target={offer.ends_at} kind="ends" className="text-[11px] text-text-secondary" /> : null}
      </span>
    ) : null;

  const afterCell = (r: ShownRow) => {
    if (p.previewing) return <span aria-live="polite">…</span>;
    if (r.after_iqd === null) return <span className="text-text-muted">—</span>;
    return (
      <span aria-live="polite" className="tabular-nums">
        <IqdAmount n={r.after_iqd} lang={p.lang} />
        {seesUsd && r.after_usd ? (
          <span className="ms-1 text-text-muted">
            · <bdi dir="ltr">{d.mode === 'percent' || r.channel !== 'direct_sale' ? '≈ ' : ''}${r.after_usd}</bdi>
          </span>
        ) : null}
      </span>
    );
  };
  const beforeCell = (r: ShownRow) => (
    <span className="tabular-nums">
      {seesUsd && r.before_usd ? (
        <>
          <bdi dir="ltr">{r.before_usd_exact ? '' : '≈ '}${r.before_usd}</bdi> ·{' '}
        </>
      ) : null}
      <IqdAmount n={r.before_iqd} lang={p.lang} />
    </span>
  );
  const modelInput = (r: ShownRow) => {
    if (d.mode !== 'usd' || scope !== 'model' || r.channel !== 'direct_sale' || !r.model_id || firstOfModel.has(r.model_id)) return null;
    firstOfModel.add(r.model_id);
    const modelId = r.model_id;
    return (
      <div className="mb-1 max-w-[160px]">
        <UsdInput
          value={d.usdByModel[modelId] ?? ''}
          onChange={(v) => set({ usdByModel: { ...d.usdByModel, [modelId]: v } })}
          label={`${s.colAfter} — ${r.label}`}
          placeholder="0.00"
          data={`discount-usd-${modelId}`}
        />
        {!(d.usdByModel[modelId] ?? '').trim() ? <div className="mt-0.5 text-[10px] text-text-muted">{s.emptyKeeps}</div> : null}
      </div>
    );
  };
  const table = (list: ShownRow[]) => {
    firstOfModel.clear();
    return (
      <table className="hidden w-full min-w-0 table-fixed border-collapse text-[12px] lg:table" data-discount-table>
        <thead>
          <tr className="text-start text-[11px] text-text-muted">
            <th className="w-[26%] py-1 text-start font-bold">{s.colModel}</th>
            <th className="w-[26%] py-1 text-start font-bold">{s.colBefore}</th>
            <th className="w-[32%] py-1 text-start font-bold">{s.colAfter}</th>
            <th className="w-[16%] py-1 text-start font-bold">{s.colSaving}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.key} className={`border-t border-border-subtle align-top ${r.state && r.state !== 'lowered' ? 'opacity-70' : ''}`} data-discount-row={r.state ?? 'before'}>
              <td className="py-1.5 pe-2 font-bold text-text-primary">
                <bdi>{r.label}</bdi>
              </td>
              <td className="py-1.5 pe-2 text-text-secondary">{beforeCell(r)}</td>
              <td className="py-1.5 pe-2">
                {modelInput(r)}
                {afterCell(r)}
                {r.state === 'not_lower' ? <div className="text-[10px] text-text-muted">{s.notLower}</div> : null}
              </td>
              <td className="py-1.5">
                {r.percent ? <bdi dir="ltr" className="font-black text-text-primary">{pct(r.percent, p.lang)}</bdi> : null}
                <RowChips row={r} s={s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };
  const cards = (list: ShownRow[]) => {
    firstOfModel.clear();
    return (
      <div className="space-y-2 lg:hidden" data-discount-cards>
        {list.map((r) => (
          <section key={r.key} aria-label={r.label} className={`lv-well min-w-0 rounded-lg p-2.5 text-[12px] ${r.state && r.state !== 'lowered' ? 'opacity-70' : ''}`}>
            <div className="mb-1 font-bold text-text-primary">
              <bdi>{r.label}</bdi>
            </div>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-text-secondary">
              <span className="text-text-muted">{s.colBefore}</span> {beforeCell(r)}
            </div>
            <div className="mt-1 min-w-0">
              <span className="text-text-muted">{s.colAfter}</span>
              {modelInput(r)}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {afterCell(r)}
                {r.percent ? <bdi dir="ltr" className="font-black text-text-primary">{pct(r.percent, p.lang)}</bdi> : null}
                <RowChips row={r} s={s} />
              </div>
              {r.state === 'not_lower' ? <div className="text-[10px] text-text-muted">{s.notLower}</div> : null}
            </div>
          </section>
        ))}
      </div>
    );
  };

  return shell(
    <div className="min-w-0 space-y-3" data-discount-state={offer ? `mode-${offer.offer_price_mode || 'none'}` : 'new-window'}>
      <p className="text-[12px] text-text-secondary">{s.intro}</p>
      <div ref={p.errorRef} tabIndex={-1} className="outline-none">
        {onceEach([...p.issues, ...(p.previewIssues ?? [])]).map((i, n) => (
          <Banner kind="error" key={`${i.code}-${n}`}>
            {issueText(i, p.lang)}
          </Banner>
        ))}
      </div>
      {onceEach([...p.warnings, ...(p.previewWarnings ?? [])]).map((i, n) => (
        <Banner kind="warn" key={`${i.code}-${n}`}>
          {issueText(i, p.lang)}
        </Banner>
      ))}
      {p.note ? <Banner kind="ok">{p.note}</Banner> : null}
      {offer?.suspended ? <p className="text-[12px] text-amber-200">{s.suspendedSave}</p> : null}
      {otherMode ? (
        <p className="text-[12px] text-text-secondary" data-discount-other-mode>
          {s.otherMode(offer!.offer_price_mode === 'discount_iqd' && offer!.discount_iqd ? money(offer!.discount_iqd, p.lang) : '—')}
        </p>
      ) : null}
      {p.drafting ? <p className="text-[12px] text-text-secondary" data-discount-drafting>{s.draftNote}</p> : null}

      <div className="space-y-1">
        <Segmented
          label={s.title}
          data="mode"
          value={d.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'usd', label: s.modeUsd, disabled: !usdAllowed },
            { value: 'percent', label: s.modePercent },
          ]}
        />
        {!usdAllowed ? (
          <p className="text-[11px] text-text-muted" data-discount-usd-reason={read.usd.reason ?? ''}>
            {usdReasonText(read.usd.reason, s)}
          </p>
        ) : null}
      </div>
      {d.mode === 'usd' && bothScopes ? (
        <Segmented
          label={s.scopeModel}
          data="scope"
          value={scope}
          onChange={(next) => set({ scope: next })}
          options={[
            { value: 'product', label: s.scopeProduct },
            { value: 'model', label: s.scopeModel },
          ]}
        />
      ) : null}
      {d.mode === 'usd' && scope === 'product' ? (
        <div className="max-w-[220px]">
          <V2Field label={s.usdOne}>{(id) => <UsdInput id={id} value={d.usdWhole} onChange={(v) => set({ usdWhole: v })} placeholder="0.00" data="discount-usd-whole" />}</V2Field>
        </div>
      ) : null}
      {d.mode === 'percent' ? (
        <div className="max-w-[160px]">
          <V2Field label={s.percentLabel}>{(id) => <Percent id={id} value={d.percent} onChange={(v) => set({ percent: v })} placeholder="10" />}</V2Field>
        </div>
      ) : null}

      {table(direct)}
      {cards(direct)}
      {preorder.length ? (
        <details className="group min-w-0">
          {/* `flex` on a summary suppresses its ::marker (only list-item draws one): the marker is drawn here, and
              it turns when the disclosure opens (§6.3/§6.4 «▸ الطلب المسبق (2)»). The 44 px tap stays. */}
          <summary className="lv-hit relative flex min-h-[44px] items-center gap-1.5 cursor-pointer list-none py-2 text-[12px] font-bold text-text-secondary [&::-webkit-details-marker]:hidden">
            <svg
              aria-hidden
              data-discount-preorder-marker
              viewBox="0 0 24 24"
              className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            {s.preorder(preorder.length)}
          </summary>
          {table(preorder)}
          {cards(preorder)}
        </details>
      ) : null}

      <Grid cols={2}>
        <V2Field label={s.startsAt} hint={s.tz}>
          {(id) => <TextInput id={id} type="datetime-local" value={d.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />}
        </V2Field>
        <V2Field label={s.endsAt} hint={s.tz}>
          {(id) => <TextInput id={id} type="datetime-local" value={d.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />}
        </V2Field>
      </Grid>
      <Toggle label={s.active} checked={d.active} onChange={(active) => set({ active })} />
      <p className="text-[11px] leading-relaxed text-text-muted">{d.mode === 'usd' ? s.rateNote : s.percentNote}</p>
      {extras.length ? (
        <p className="text-[11px] text-text-secondary" data-discount-extras>
          {s.otherSettings(extras.join(' · '))}
        </p>
      ) : null}
      {stateChip ? <div>{stateChip}</div> : null}

      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <button type="button" className={`${btnPrimary} lv-hit relative min-h-[44px] w-full sm:w-auto`} disabled={p.busy} onClick={p.onSave}>
          {p.busy ? s.saving : s.save}
        </button>
        {offer ? (
          <button type="button" className={`${btnDanger} lv-hit relative min-h-[44px] w-full sm:w-auto`} disabled={p.busy} onClick={p.onRemove}>
            {s.remove}
          </button>
        ) : null}
        <a className="lv-hit relative inline-flex min-h-[44px] items-center text-[12px] font-bold underline sm:ms-auto" href="/admin?tab=offers">
          {s.openOffers} ↗
        </a>
      </div>
    </div>,
    stateChip
  );
}

/* --------------------------------------------------------- the container -- */

interface ReadAnswer {
  offer: OfferWire | null;
  discount: DiscountReadWire;
  schedule_state: 'upcoming' | 'live' | 'ended' | null;
}

const issuesOf = (e: unknown): Issue[] => {
  if (e instanceof ApiError) {
    const listed = (e.details?.errors as Issue[] | undefined) ?? null;
    return listed && listed.length ? listed : [{ code: e.code ?? 'ERROR', message: e.message }];
  }
  return [{ code: 'ERROR', message: e instanceof Error ? e.message : String(e) }];
};

export default function ProductDiscountCard({ productId }: { productId: string | null }) {
  const lang = useV2Lang();
  const s = discountStrings(lang);
  const v2 = useV2();
  const writeSeq = v2?.stored?.seq?.write_seq ?? null;
  const [answer, setAnswer] = useState<ReadAnswer | null>(null);
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<DiscountDraft | null>(null);
  const [preview, setPreview] = useState<PreviewRowWire[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [warnings, setWarnings] = useState<Issue[]>([]);
  const [previewIssues, setPreviewIssues] = useState<Issue[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<Issue[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const seq = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (keepDraft = false) => {
      if (!productId) return;
      const res = await api.get<ReadAnswer>(`/api/admin/offers/${encodeURIComponent(productId)}`);
      setAnswer(res);
      if (!keepDraft) setDraft(res.offer ? draftFrom(res.offer, res.discount) : null);
    },
    [productId]
  );

  // The card reads its row on open, and again whenever the product's V2 write moves (its before prices).
  useEffect(() => {
    void load().catch((e) => setIssues(issuesOf(e)));
  }, [load, writeSeq]);

  // THE PREVIEW: the draft, debounced 400 ms; the latest answer wins (a sequence guard).
  const body = useMemo(() => (answer && draft ? saveBodyOf(answer.offer, draft) : null), [answer, draft]);
  useEffect(() => {
    if (!productId || !body || !answer?.discount.published) {
      // Nothing to preview (no draft, or the sale was removed): no answer is awaited, so nothing is «…».
      seq.current += 1;
      setPreviewing(false);
      setPreviewIssues([]);
      setPreviewWarnings([]);
      return;
    }
    const mine = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(() => {
      void api
        .post<{ rows: PreviewRowWire[]; issues: Issue[]; warnings: Issue[]; refused?: boolean }>(`/api/admin/offers/${encodeURIComponent(productId)}/preview`, body)
        .then((res) => {
          if (mine !== seq.current) return;
          const shown = previewAnswerOf(res);
          setPreview(shown.preview);
          setPreviewIssues(shown.issues);
          setPreviewWarnings(shown.warnings);
          setPreviewing(false);
        })
        .catch(() => {
          if (mine === seq.current) setPreviewing(false);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [productId, body, answer?.discount.published]);

  const save = async () => {
    if (!productId || !answer || !draft) return;
    setBusy(true);
    setIssues([]);
    setWarnings([]);
    setNote(null);
    try {
      const res = await api.put<{ offer: OfferWire | null; warnings?: Issue[]; rows?: PreviewRowWire[] }>(
        `/api/admin/offers/${encodeURIComponent(productId)}`,
        saveBodyOf(answer.offer, draft)
      );
      setWarnings(res.warnings ?? []);
      setNote(s.saved);
      if (res.rows) setPreview(res.rows);
      await load(true);
    } catch (e) {
      setIssues(issuesOf(e));
      // Someone else saved the row: reload it, keep the typed draft to re-apply.
      if (e instanceof ApiError && e.code === 'SPECIAL_OFFER_CHANGED') await load(true).catch(() => undefined);
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!productId) return;
    if (!(await confirm({ title: s.removeTitle, consequence: s.removeBody, confirmLabel: s.remove, cancelLabel: s.cancel, destructive: true }))) return;
    setBusy(true);
    try {
      await api.delete(`/api/admin/offers/${encodeURIComponent(productId)}`);
      setOpened(false);
      setPreview(null);
      setIssues([]);
      setWarnings([]);
      setPreviewIssues([]);
      setPreviewWarnings([]);
      setNote(s.removed);
      await load();
    } catch (e) {
      setIssues(issuesOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DiscountCardView
        lang={lang}
        productId={productId}
        read={answer?.discount ?? null}
        offer={answer?.offer ?? null}
        scheduleState={answer?.schedule_state ?? null}
        opened={opened}
        draft={draft}
        preview={preview}
        previewing={previewing}
        issues={issues}
        warnings={warnings}
        previewIssues={previewIssues}
        previewWarnings={previewWarnings}
        note={note}
        busy={busy}
        drafting={!!v2?.drafting}
        onOpen={() => {
          if (!answer) return;
          setOpened(true);
          setNote(null);
          setDraft(draftFrom(null, answer.discount));
        }}
        onDraft={setDraft}
        onSave={() => void save()}
        onRemove={() => void remove()}
        errorRef={errorRef}
      />
      {confirmDialog}
    </>
  );
}
