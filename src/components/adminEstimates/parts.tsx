/**
 * The shared pieces of «التسعير التقديري»: the reader's language, a refusal
 * said by code, the act runner, the copy button, the supplier link row, the
 * flag list and the pager. Presentation only — the words come from
 * strings.ts, every figure and every link from the server.
 *
 * A SUPPLIER LINK (docs/SMART_PRICING.md §3.9) opens in a new tab with
 * `rel="noopener noreferrer"`, so no admin address reaches the store; it is
 * drawn only when the server's link is one of the builder's three https
 * origins (`safeSupplierHref`), else its id is shown as text. A Tmall item id
 * and an option id each carry a copy button.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, ExternalLink, Info, ShieldAlert, X } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useLanguage } from '../../LanguageContext';
import { useOptionalAuth } from '../../AuthContext';
import { ApiError, isAborted } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { copyText } from '../../lib/copyText';
import { ErrorState } from '../ui/AsyncStates';
import { StatusChip, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import OwnerCostVerifyCard from '../auth/OwnerCostVerifyCard';
import { estimateRefusalText } from '../../../packages/contracts/src/priceEstimates';
import { PRICING_FIELD_LABELS, isPricingFieldName } from '../../../packages/contracts/src/pricingFieldLabels';
import { linkStore, safeSupplierHref, workspaceHref, type EstimateFlagEntry, type LinkSku, type SupplierLink } from './api';
import {
  COMMON,
  CONFIDENCE_LABELS,
  CONFIRM,
  FLAG_CLASS_LABELS,
  FLAG_SKUS,
  LINK_STATE_LABELS,
  LINKS,
  OWNER_REFUSALS,
  SOURCE_LABELS,
  flagClass,
  flagText,
  reasonText,
  say,
  uiLang,
  type UiLang,
} from './strings';
import { dayOf, moneyText, nameIn, optionsLine } from './format';

/** The reader's language as the workspace's key, and the page direction. */
export function useUiLang(): { lang: UiLang; dir: 'rtl' | 'ltr' } {
  const { lang, dir } = useLanguage();
  return { lang: uiLang(lang), dir: dir === 'ltr' ? 'ltr' : 'rtl' };
}

// ---------------------------------------------------------------- refusals

/** The refusal's code: an ApiError's, or a per-product outcome's `{ code }` (an apply's). */
export const errorCode = (e: unknown): string => {
  if (e instanceof ApiError) return e.code ?? '';
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
};

/** A database without 0218 (503) — or, before the owner routers are mounted, a 404 of a list read. */
export function isNotInstalled(e: unknown, listRead = false): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === 'PRICE_ESTIMATES_NOT_INSTALLED') return true;
  return listRead && e.status === 404;
}

/** A refusal in the owner's language, by code: the estimate contract, the owner-only sentences, then the shared table. */
export function refusalText(e: unknown, lang: UiLang, fallback: string = say(COMMON.actionFailed, lang)): string {
  const code = errorCode(e);
  if (code === 'REAUTH_REQUIRED') return say(COMMON.reauth, lang);
  if (code === 'PRICING_CHANGED') return say(COMMON.changed, lang);
  if (code === 'PRICE_ESTIMATES_NOT_INSTALLED') return say(COMMON.notInstalled, lang);
  // §4.9: the real measures are entered and wait on the refresh's apply, which is the cure.
  if (code === 'PRICE_ESTIMATE_DEFAULT_MEASURES' && e instanceof ApiError && e.details?.waiting_on_apply === true) return say(CONFIRM.applyFirst, lang);
  const own = OWNER_REFUSALS[code];
  if (own) return say(own, lang);
  const estimate = estimateRefusalText(code, lang);
  if (estimate) return estimate;
  return apiRefusal(e, lang, fallback);
}

/** «سجّل الدخول مجددًا»: this session ends, and the sign-in page comes back to the workspace. */
export function useSignInAgain(): () => Promise<void> {
  const auth = useOptionalAuth();
  return useCallback(async () => {
    try {
      await auth?.logout();
    } finally {
      window.location.assign(`/auth?next=${encodeURIComponent(workspaceHref('types'))}`);
    }
  }, [auth]);
}

/** A load failure: the verification card, the calm «not installed» notice, a refusal by code, or a retry. */
export function Failure({ error, lang, onRetry, listRead = true }: { error: unknown; lang: UiLang; onRetry?: () => void; listRead?: boolean }) {
  if (error instanceof ApiError && error.code === 'OWNER_EMAIL_UNVERIFIED') return <OwnerCostVerifyCard />;
  if (isNotInstalled(error, listRead)) {
    return (
      <div role="status" data-estimates-not-installed className="lv-alert lv-alert-info flex items-start gap-3">
        <Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-info" />
        <p className="text-[14px] leading-relaxed text-text-primary">{say(COMMON.notInstalled, lang)}</p>
      </div>
    );
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
    return (
      <div role="alert" data-estimates-refusal={error.code ?? error.status} className="lv-alert lv-alert-danger flex items-start gap-3">
        <ShieldAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
        <p className="text-[14px] leading-relaxed text-text-primary">{refusalText(error, lang, say(COMMON.loadFailed, lang))}</p>
      </div>
    );
  }
  return <ErrorState error={error} onRetry={onRetry} compact />;
}

// ---------------------------------------------------------------- one act at a time

export interface ActMessage {
  tone: 'success' | 'warning' | 'danger';
  text: string;
  /** The act needs a fresh sign-in: the message offers it. */
  reauth?: boolean;
}

/**
 * ONE OWNER ACT AT A TIME, ANSWERED WHERE IT WAS ASKED. A refusal is said
 * beside the control that sent it; a stale screen (409 PRICING_CHANGED)
 * reloads itself through `onStale`.
 */
export function useAct(lang: UiLang, onStale?: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<ActMessage | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async <T,>(key: string, act: () => Promise<T>, done?: (answer: T) => ActMessage | null): Promise<T | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setBusy(key);
      setMessage(null);
      try {
        const answer = await act();
        if (alive.current) setMessage(done ? done(answer) : { tone: 'success', text: say(COMMON.saved, lang) });
        return answer;
      } catch (e) {
        if (isAborted(e)) return null;
        const code = errorCode(e);
        if (code === 'PRICING_CHANGED') onStale?.();
        if (alive.current) setMessage({ tone: 'danger', text: refusalText(e, lang), reauth: code === 'REAUTH_REQUIRED' });
        return null;
      } finally {
        inFlight.current = false;
        if (alive.current) setBusy(null);
      }
    },
    [lang, onStale]
  );
  return { busy, message, setMessage, run };
}

/** The answer to an act, beside it; a fresh sign-in is one press away. */
export function ActNote({ message, lang }: { message: ActMessage | null; lang: UiLang }) {
  const signInAgain = useSignInAgain();
  if (!message) return null;
  const Icon = message.tone === 'success' ? CheckCircle2 : message.tone === 'warning' ? AlertTriangle : ShieldAlert;
  const color = message.tone === 'success' ? 'text-success' : message.tone === 'warning' ? 'text-warning' : 'text-danger';
  return (
    <div
      role={message.tone === 'success' ? 'status' : 'alert'}
      data-estimates-message={message.tone}
      className={`flex items-start gap-2 text-[13px] leading-relaxed ${message.tone === 'success' ? 'text-text-secondary' : `lv-alert lv-alert-${message.tone} text-text-primary`}`}
    >
      <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
      <div className="min-w-0 space-y-2">
        <p className="break-words">{message.text}</p>
        {message.reauth ? (
          <Button size="sm" variant="secondary" onClick={signInAgain} data-estimates-reauth>
            {say(COMMON.signInAgain, lang)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- small pieces

/** An LTR island for an id, a figure or a date, so it never reorders in an Arabic or Sorani row. */
export function Ltr({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={`tabular-nums ${className}`}>
      {children}
    </bdi>
  );
}

const STATE_TONE: Readonly<Record<SupplierLink['state'], Tone>> = { auto: 'info', confirmed: 'success', suggested: 'warning', rejected: 'neutral', manual: 'accent' };

export function LinkStateChip({ state, lang }: { state: SupplierLink['state']; lang: UiLang }) {
  return (
    <StatusChip tone={STATE_TONE[state]} className="shrink-0">
      {say(LINK_STATE_LABELS[state], lang)}
    </StatusChip>
  );
}

export function SourceChip({ source, lang }: { source: keyof typeof SOURCE_LABELS; lang: UiLang }) {
  return (
    <span data-supplier-source={source} className="inline-flex shrink-0 items-center rounded-full bg-surface-raised px-2.5 py-1 text-[12px] font-bold text-text-primary">
      {say(SOURCE_LABELS[source], lang)}
    </span>
  );
}

/**
 * «نسخ»: copies exactly the id and nothing around it. A copy that did not
 * happen never shows a tick: the reader is told to select the id instead.
 */
export function CopyButton({ value, what, lang }: { value: string; what: string; lang: UiLang }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2400);
  };
  const label = say(LINKS.copyWhat, lang, { what });
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        title={label}
        data-copy-id={value}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {state === 'copied' ? <Check aria-hidden="true" className="h-4 w-4 text-success" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
      </button>
      <span aria-live="polite" className={`text-[11px] ${state === 'failed' ? 'text-danger' : 'text-text-muted'}`}>
        {state === 'copied' ? say(LINKS.copied, lang) : state === 'failed' ? say(LINKS.copyFailed, lang) : ''}
      </span>
    </span>
  );
}

/**
 * A supplier page in a new tab — only the builder's https origins; anything
 * else draws nothing (its id is shown beside it as text).
 */
export function SupplierAnchor({ href, label, lang, className = '' }: { href: string | null | undefined; label: string; lang: UiLang; className?: string }) {
  const safe = safeSupplierHref(href);
  if (!safe) return null;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      data-supplier-link={safe}
      className={`inline-flex min-h-11 items-center gap-1.5 px-1 text-[13px] font-bold text-text-primary underline underline-offset-2 ${className}`}
    >
      <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span>{label}</span>
      <span className="sr-only">{say(LINKS.newTab, lang)}</span>
    </a>
  );
}

/** The words of an item link: «افتح في Tmall», «… في المتجر الأوروبي», «… في المتجر الأمريكي». */
export function openItemText(source: SupplierLink['source'], lang: UiLang): string {
  const store = linkStore(source);
  return say(store === 'bambu_eu' ? LINKS.openEu : store === 'bambu_us' ? LINKS.openUs : LINKS.openTmall, lang);
}

/**
 * ONE SUPPLIER FACT OF ONE SKU (§3.9): the source and the match state, the
 * item's title (Chinese and English on Tmall), the Tmall item id or store
 * handle with a copy button and the item link, the supplier option it is
 * matched to with its id, copy button and the link that opens that exact
 * option, the captured price with its currency, label and date — or, when
 * the key left the newest capture, the links alone — and the act buttons.
 */
export function SupplierLinkRow({ link, lang, actions }: { link: SupplierLink; lang: UiLang; actions?: React.ReactNode }) {
  const store = linkStore(link.source);
  const itemUrl = safeSupplierHref(link.item_url);
  const skuUrl = safeSupplierHref(link.sku_url);
  const options = optionsLine(link.options);
  const optionsEn = optionsLine(link.options_en);
  const idLabel = say(link.source === 'tmall_cn' ? LINKS.tmallId : LINKS.storeHandle, lang);
  const confidence = link.match_confidence && link.match_confidence in CONFIDENCE_LABELS ? CONFIDENCE_LABELS[link.match_confidence as keyof typeof CONFIDENCE_LABELS] : null;
  return (
    <li data-supplier-row={`${link.source}:${link.item_key ?? ''}:${link.sku_key ?? ''}`} data-link-state={link.state} className="min-w-0 space-y-1.5 border-t border-border-subtle/60 py-2.5 first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SourceChip source={link.source} lang={lang} />
        <LinkStateChip state={link.state} lang={lang} />
        {confidence ? <span className="text-[12px] text-text-muted">{say(LINKS.confidence, lang, { level: say(confidence, lang) })}</span> : null}
        {link.units_per_offer > 1 ? <span className="text-[12px] font-semibold text-warning">{say(LINKS.unitsDivided, lang, { n: link.units_per_offer })}</span> : null}
      </div>
      {link.title || link.name_en ? (
        <div className="min-w-0">
          {link.title ? (
            <p dir="auto" className="break-words text-[13px] font-semibold leading-snug text-text-primary">
              {link.title}
            </p>
          ) : null}
          {link.name_en && link.name_en !== link.title ? (
            <p dir="ltr" className="break-words text-start text-[12px] leading-snug text-text-secondary">
              {link.name_en}
            </p>
          ) : null}
        </div>
      ) : null}
      {store && link.item_key ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-text-secondary">
            {idLabel}: <Ltr className="break-all font-mono text-text-primary">{link.item_key}</Ltr>
            <CopyButton value={link.item_key} what={idLabel} lang={lang} />
          </span>
          {itemUrl ? <SupplierAnchor href={itemUrl} label={openItemText(link.source, lang)} lang={lang} /> : <span className="text-[12px] text-text-muted">{say(LINKS.noLink, lang)}</span>}
        </div>
      ) : null}
      {store && link.sku_key ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-text-secondary">
            {say(LINKS.skuId, lang)}: <Ltr className="break-all font-mono text-text-primary">{link.sku_key}</Ltr>
            <CopyButton value={link.sku_key} what={say(LINKS.skuId, lang)} lang={lang} />
          </span>
          {skuUrl ? <SupplierAnchor href={skuUrl} label={say(LINKS.openOption, lang)} lang={lang} /> : null}
        </div>
      ) : null}
      {options || optionsEn ? (
        <p className="min-w-0 break-words text-[12px] leading-relaxed text-text-secondary">
          {say(LINKS.supplierOption, lang)}: <span dir="auto">{options}</span>
          {optionsEn && optionsEn !== options ? (
            <>
              {' · '}
              <span dir="ltr">{optionsEn}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {link.codes.length ? (
        <p className="min-w-0 break-words text-[12px] text-text-muted">
          {say(LINKS.codes, lang)}: <Ltr className="font-mono">{link.codes.join(' · ')}</Ltr>
        </p>
      ) : null}
      {link.missing ? (
        <p className="flex items-start gap-1.5 text-[12px] font-semibold text-warning" data-link-missing>
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {say(LINKS.missing, lang)}
        </p>
      ) : link.price ? (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]" data-link-price>
          <Ltr className="font-bold text-text-primary">{moneyText(link.price, link.currency)}</Ltr>
          {link.price_label ? (
            <span dir="auto" className="text-[12px] text-text-muted">
              {link.price_label}
            </span>
          ) : null}
          {link.captured_on ? (
            <span className="text-[12px] text-text-muted">
              {say(link.state === 'manual' ? LINKS.entered : LINKS.captured, lang, { date: dayOf(link.captured_on) })}
            </span>
          ) : null}
          {link.quantity === 0 ? <span className="text-[12px] font-semibold text-warning">{say(LINKS.outOfStock, lang)}</span> : null}
        </p>
      ) : null}
      {link.note ? (
        <p dir="auto" className="break-words text-[12px] text-text-muted">
          {say(LINKS.note, lang, { note: link.note })}
        </p>
      ) : null}
      {link.match_reasons.length ? <p className="break-words text-[11px] text-text-muted">{link.match_reasons.map((r) => reasonText(r, lang)).join(' · ')}</p> : null}
      {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
    </li>
  );
}

/** A Levonis SKU's name in the reader's language («المنتج نفسه» for the product itself). */
export function skuName(sku: Pick<LinkSku, 'combo_key' | 'labels'>, lang: UiLang): string {
  return sku.combo_key === '' ? say(COMMON.wholeProduct, lang) : nameIn(sku.labels, lang, sku.combo_key);
}

// ---------------------------------------------------------------- flags

const CLASS_TONE: Readonly<Record<'blocking' | 'hard' | 'soft' | 'info', Tone>> = { blocking: 'danger', hard: 'warning', soft: 'info', info: 'neutral' };

/**
 * A flag's field names in the pricing screens' own words (pricingFieldLabels.ts): the estimator's minimum profit
 * (`minimum_profit`) reads as their `target_profit_iqd`, whole ("Minimum target profit (above current replacement
 * cost)"); a name with no label is left out, and each name is said once.
 */
export function flagFieldNames(fields: readonly string[] | undefined, lang: UiLang): string[] {
  const names: string[] = [];
  for (const field of fields ?? []) {
    const key = field === 'minimum_profit' ? 'target_profit_iqd' : field;
    if (isPricingFieldName(key)) names.push(PRICING_FIELD_LABELS[key][lang]);
  }
  return [...new Set(names)];
}

/** The estimator's flags, each in the owner's words with its class (§4.6) and the fields it names; codes, names and counts only, never a value. */
export function FlagList({ flags, lang, only }: { flags: readonly EstimateFlagEntry[]; lang: UiLang; only?: ReadonlyArray<'blocking' | 'hard' | 'soft' | 'info'> }) {
  const shown = flags.filter((f) => !only || only.includes(flagClass(f.code)));
  if (!shown.length) return null;
  return (
    <ul className="space-y-1" data-estimate-flags>
      {shown.map((f) => {
        const cls = flagClass(f.code);
        const n = f.combo_keys?.length ?? f.count ?? 0;
        const names = flagFieldNames(f.fields, lang);
        return (
          <li key={f.code} data-flag-code={f.code} data-flag-class={cls} className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] leading-relaxed text-text-secondary">
            <StatusChip tone={CLASS_TONE[cls]} className="shrink-0">
              {say(FLAG_CLASS_LABELS[cls], lang)}
            </StatusChip>
            <span className="min-w-0 break-words">
              {flagText(f.code, lang)}
              {names.length ? (
                <span className="ms-1 text-text-muted" data-flag-fields>
                  {`(${names.join(' · ')})`}
                </span>
              ) : null}
              {n > 0 ? <span className="ms-1 text-text-muted">{say(FLAG_SKUS, lang, { n })}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- a sheet

/** The workspace's sheet: a title and a close button that take the drag, the body scrolling under them, an action bar. */
export function SheetFrame({
  open,
  onClose,
  title,
  lang,
  dir,
  footer,
  children,
  dirty = false,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  lang: UiLang;
  dir: 'rtl' | 'ltr';
  footer?: React.ReactNode;
  children: React.ReactNode;
  dirty?: boolean;
  testId?: string;
}) {
  const titleId = useId();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      dirty={dirty}
      panelClassName="sm:max-w-[620px] sm:w-[92vw]"
      testId={testId}
      header={
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-2 pb-2 pt-1" dir={dir}>
          <h2 id={titleId} className="min-w-0 break-words px-2 text-[16px] font-extrabold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={say(COMMON.close, lang)}
            className="grid size-11 shrink-0 place-items-center rounded-full text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
      }
      footer={footer ? <div className="flex flex-col gap-2 px-4 pb-3 pt-2 sm:flex-row-reverse sm:flex-wrap" dir={dir}>{footer}</div> : null}
    >
      <div className="space-y-4 px-4 pb-4 pt-3" dir={dir}>
        {children}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- the pager

/**
 * A cursor pager: the server answers the next cursor; the previous pages'
 * cursors are kept here so «السابقة» goes back without a second kind of request.
 */
interface PagesState {
  key: string;
  stack: string[];
  cursor: string | null;
}

export function useCursorPages(resetKey: string) {
  const [state, setState] = useState<PagesState>({ key: resetKey, stack: [], cursor: null });
  // A new filter or search starts at its first page at once — never one render on the old cursor.
  const current: PagesState = state.key === resetKey ? state : { key: resetKey, stack: [], cursor: null };
  const next = useCallback(
    (nextCursor: string | null) => {
      if (!nextCursor) return;
      setState((s) => {
        const base = s.key === resetKey ? s : { key: resetKey, stack: [], cursor: null };
        return { key: resetKey, stack: [...base.stack, base.cursor ?? ''], cursor: nextCursor };
      });
    },
    [resetKey]
  );
  const prev = useCallback(() => {
    setState((s) => {
      if (s.key !== resetKey || !s.stack.length) return s;
      const back = s.stack[s.stack.length - 1]!;
      return { key: resetKey, stack: s.stack.slice(0, -1), cursor: back === '' ? null : back };
    });
  }, [resetKey]);
  const { cursor, stack } = current;
  return useMemo(() => ({ cursor, page: stack.length + 1, hasPrev: stack.length > 0, next, prev }), [cursor, stack.length, next, prev]);
}

export function Pager({ lang, page, hasPrev, nextCursor, onPrev, onNext }: { lang: UiLang; page: number; hasPrev: boolean; nextCursor: string | null; onPrev: () => void; onNext: () => void }) {
  if (!hasPrev && !nextCursor) return null;
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 pt-2" data-estimates-pager aria-label={say(COMMON.pageOf, lang, { n: page })}>
      <Button size="sm" variant="secondary" onClick={onPrev} disabled={!hasPrev} icon={<ChevronRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />}>
        {say(COMMON.prevPage, lang)}
      </Button>
      <span className="text-[12px] text-text-muted">{say(COMMON.pageOf, lang, { n: page })}</span>
      <Button size="sm" variant="secondary" onClick={onNext} disabled={!nextCursor} iconEnd={<ChevronLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />}>
        {say(COMMON.nextPage, lang)}
      </Button>
    </nav>
  );
}
