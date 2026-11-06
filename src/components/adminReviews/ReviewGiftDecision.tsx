/**
 * THE ADMIN'S SIDE OF THE CODE (owner, 2026-11-05; DECISIONS row 301): the number
 * the admin confirms, what it opens, and the code to hand over.
 *
 *   ScoreField   1..100, prefilled with the system's score; a live line «يفتح
 *                المستويات 1، 2» from the one rule both sides use
 *                (packages/contracts/src/giftScore.ts), the score's real parts,
 *                and what an opened level holds today (switched off, empty, sold
 *                out). All of them empty: no approval (the server refuses too).
 *   CodePanel    after approval: the code with a copy button, a ready message in
 *                the customer's language (copy only: nothing is sent), whether it
 *                was used, and a new code while it was not.
 *
 * The server decides; this draws its answer. No cost, no figure of its own.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { copyText } from '../../lib/copyText';
import { formatFigure } from '../../lib/localeNumber';
import { formatDate } from '../orders/format';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Field } from '../ui/Field';
import { NumberInput } from '../ui/NumberInput';
import { GIFT_SCORE_MAX, GIFT_SCORE_MIN, GIFT_SCORE_PARTS, clampGiftScore, giftLevelsForScore } from '../../../packages/contracts/src/giftScore';
import { formatGiftCode, readySentence, reviewGiftText, type ReviewGiftKey } from './reviewGiftStrings';

type Lang = 'ar' | 'en' | 'ckb';

/** What one level offers today (GET /api/reviews/admin/queue `gift_levels`). */
export interface LevelOffer {
  level: number;
  active: boolean;
  items: number;
  sellable: number;
}

export interface QualityParts {
  score: number;
  textQuality: number;
  imageCount: number;
  imageQuality: number;
  videoPresent: boolean;
  videoQuality: number;
  reasons: string[];
}

const SEP: Readonly<Record<Lang, string>> = { ar: '، ', en: ', ', ckb: '، ' };

/** A level the customer will find nothing in, and the words for it. */
function levelWarnings(offer: readonly LevelOffer[], opened: readonly number[]): Array<{ level: number; key: ReviewGiftKey }> {
  return opened.flatMap((level): Array<{ level: number; key: ReviewGiftKey }> => {
    const o = offer.find((x) => x.level === level);
    if (!o) return [];
    if (!o.active) return [{ level, key: 'warnOff' }];
    if (o.items === 0) return [{ level, key: 'warnEmpty' }];
    if (o.sellable === 0) return [{ level, key: 'warnSold' }];
    return [];
  });
}

/** Whether a score may be approved at all: at least one opened level holds a gift that can be ordered. */
export function canApproveScore(score: number, offer: readonly LevelOffer[]): boolean {
  if (offer.length === 0) return true;
  return giftLevelsForScore(score).some((level) => {
    const o = offer.find((x) => x.level === level);
    return !!o && o.active && o.sellable > 0;
  });
}

/** The draft as a score, or null while what is typed is not one. */
export function draftScore(value: string): number | null {
  const n = Number(value.trim());
  return value.trim() !== '' && Number.isInteger(n) && n >= GIFT_SCORE_MIN && n <= GIFT_SCORE_MAX ? n : null;
}

/** The system's own figure as the field starts: its score, clamped to what can be confirmed. */
export const initialDraft = (systemScore: number | null | undefined): string =>
  typeof systemScore === 'number' ? String(clampGiftScore(systemScore)) : '';

export function ScoreField({
  lang,
  value,
  onChange,
  quality,
  offer,
  onOpenLevels,
}: {
  lang: Lang;
  value: string;
  onChange: (v: string) => void;
  quality: QualityParts | null;
  offer: readonly LevelOffer[];
  onOpenLevels?: () => void;
}) {
  const t = (key: ReviewGiftKey, vars?: Record<string, string | number>) => reviewGiftText(lang, key, vars);
  const score = draftScore(value);
  const scale = { from: formatFigure(GIFT_SCORE_MIN, lang), to: formatFigure(GIFT_SCORE_MAX, lang) };
  const opened = score === null ? [] : giftLevelsForScore(score);
  const warnings = levelWarnings(offer, opened);
  const list = opened.map((n) => formatFigure(n, lang)).join(SEP[lang]);
  const blocked = score !== null && !canApproveScore(score, offer);
  const hasStory = !!quality?.reasons?.includes('supporting_evidence');
  const parts: Array<[ReviewGiftKey, number, number]> = quality
    ? [
        ['partText', quality.textQuality, GIFT_SCORE_PARTS.text],
        ['partImages', quality.imageQuality, GIFT_SCORE_PARTS.images],
        ['partVideo', quality.videoQuality, GIFT_SCORE_PARTS.video],
        ['partStory', hasStory ? GIFT_SCORE_PARTS.story : 0, GIFT_SCORE_PARTS.story],
        ['partStars', GIFT_SCORE_PARTS.stars, GIFT_SCORE_PARTS.stars],
      ]
    : [];
  return (
    <div className="space-y-2" data-review-score-field>
      {/* The shop's own field: an Arabic or Kurdish keyboard's digits are digits here. Its error is ours, in all three languages. */}
      <Field label={t('scoreLabel', scale)} error={score === null ? t('scoreInvalid', scale) : undefined}>
        <NumberInput
          value={score}
          onValueChange={(n, ok) => onChange(ok && n !== null ? String(n) : '')}
          decimals={0}
          min={GIFT_SCORE_MIN}
          max={GIFT_SCORE_MAX}
          className="block w-28 px-3 text-[16px] font-black"
          data-review-final-score
        />
      </Field>
      {quality && (
        <p className="text-[11.5px] text-text-muted">
          {t('systemScore', { n: formatFigure(quality.score, lang) })} · {t('scoreHint')}
        </p>
      )}
      {score !== null && (
        <p className="text-[13px] font-bold text-text-primary" data-review-opens>
          {t(opened.length === 1 ? 'opensOne' : 'opensMany', { list })}
        </p>
      )}
      {parts.length > 0 && (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-text-secondary sm:grid-cols-5" data-review-parts>
          {parts.map(([key, got, max]) => (
            <li key={key} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0">{t(key)}</span>
              <bdi dir="ltr" className="font-bold tabular-nums text-text-primary">
                {formatFigure(got, lang)}/{formatFigure(max, lang)}
              </bdi>
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && !blocked && (
        <ul className="space-y-1" data-review-warnings>
          {warnings.map((w) => (
            <li key={w.level} className="text-[12px] font-medium text-warning">
              {t(w.key, { n: formatFigure(w.level, lang) })}
            </li>
          ))}
        </ul>
      )}
      {blocked && (
        <div className="lv-alert lv-alert-warning space-y-2 text-[12px] font-medium text-text-primary" data-review-all-empty>
          <p>{t('allEmpty')}</p>
          {onOpenLevels && (
            <button type="button" onClick={onOpenLevels} className="lv-button lv-button-secondary lv-button-sm">
              {t('openLevels')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The copy button's tick for two seconds, or the honest failure beside what is on screen to copy by hand. */
function CopyButton({ lang, text, label, testId }: { lang: Lang; text: string; label: string; testId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    const ok = await copyText(text);
    if (timer.current !== null) clearTimeout(timer.current);
    setState(ok ? 'copied' : 'failed');
    if (ok) timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        icon={state === 'copied' ? <Check className="w-4 h-4 text-success" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
        onClick={() => void copy()}
        data-review-copy={testId}
      >
        {state === 'copied' ? reviewGiftText(lang, 'copied') : label}
      </Button>
      <span role="status" aria-live="polite" className={state === 'failed' ? 'text-[12px] text-warning' : 'sr-only'}>
        {state === 'failed' ? reviewGiftText(lang, 'copyFailed') : ''}
      </span>
    </span>
  );
}

/** A refusal in the admin's language. The sentences load on the first one, as on the screens that already use them. */
async function refusalSentence(err: unknown, lang: Lang): Promise<string> {
  const fallback = reviewGiftText(lang, 'regenerateFailed');
  if (!(err instanceof ApiError) || !err.code) return fallback;
  try {
    const table = await import('../../lib/refusalStrings');
    return table.apiRefusal(err, lang, fallback) || fallback;
  } catch {
    return fallback;
  }
}

export interface CodeRow {
  review_id: string;
  customer: { name?: string; username?: string | null; lang?: string };
  product: { name: string | null; name_ar: string | null; name_ckb?: string | null };
  final_score: number | null;
  levels: number[];
  code: string | null;
  code_redeemed_at: string | null;
}

export function CodePanel({ lang, row, onChanged }: { lang: Lang; row: CodeRow; onChanged: () => void }) {
  const t = (key: ReviewGiftKey, vars?: Record<string, string | number>) => reviewGiftText(lang, key, vars);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const customerLang = row.customer.lang === 'en' || row.customer.lang === 'ckb' ? row.customer.lang : 'ar';
  const printer =
    customerLang === 'ckb'
      ? row.product.name_ckb || row.product.name || row.product.name_ar || ''
      : customerLang === 'en'
        ? row.product.name || row.product.name_ar || ''
        : row.product.name_ar || row.product.name || '';
  const sentence = useMemo(
    () =>
      row.code
        ? readySentence(customerLang, {
            name: row.customer.name || row.customer.username || '',
            printer,
            code: row.code,
            origin: typeof window === 'undefined' ? '' : window.location.origin,
          })
        : '',
    [customerLang, row.code, row.customer.name, row.customer.username, printer]
  );
  const list = row.levels.map((n) => formatFigure(n, lang)).join(SEP[lang]);

  const regenerate = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/reviews/admin/${encodeURIComponent(row.review_id)}/code/regenerate`, {});
      setConfirming(false);
      onChanged();
    } catch (e) {
      setConfirming(false);
      setError(await refusalSentence(e, lang));
    } finally {
      setBusy(false);
    }
  };

  if (!row.code) return <p className="text-[12px] text-text-muted">{t('oldPath')}</p>;
  return (
    <div className="space-y-3" data-review-code-panel>
      {row.final_score !== null && (
        <p className="text-[13px] text-text-secondary">
          <b className="text-text-primary">{t('finalLine', { score: formatFigure(row.final_score, lang), max: formatFigure(GIFT_SCORE_MAX, lang) })}</b>
          {' · '}
          {t(row.levels.length === 1 ? 'opensOne' : 'opensMany', { list })}
        </p>
      )}
      <div className="space-y-2">
        <p className="text-[11px] font-bold text-text-muted">{t('codeTitle')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code dir="ltr" className="lv-well select-all rounded-md px-3 py-2 text-[16px] font-black tracking-wider text-text-primary" data-review-code>
            {formatGiftCode(row.code)}
          </code>
          <CopyButton lang={lang} text={formatGiftCode(row.code)} label={t('copyCode')} testId="code" />
        </div>
        <p className="text-[12px] font-medium text-text-secondary" data-review-code-state={row.code_redeemed_at ? 'redeemed' : 'waiting'}>
          {row.code_redeemed_at ? t('stateRedeemed', { date: formatDate(row.code_redeemed_at, lang) }) : t('stateWaiting')}
        </p>
      </div>
      {!row.code_redeemed_at && (
        <>
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold text-text-muted">{t('sentenceTitle')}</p>
            <p dir={customerLang === 'en' ? 'ltr' : 'rtl'} className="lv-well rounded-md px-3 py-2 text-[12.5px] leading-6 text-text-primary select-all" data-review-sentence>
              {sentence}
            </p>
            <p className="text-[11.5px] text-text-muted">{t('sentenceHint')}</p>
            <CopyButton lang={lang} text={sentence} label={t('copySentence')} testId="sentence" />
          </div>
          <Button size="sm" variant="ghost" icon={<RefreshCw className="w-4 h-4" aria-hidden="true" />} disabled={busy} onClick={() => setConfirming(true)} data-review-regenerate>
            {t('regenerate')}
          </Button>
        </>
      )}
      {error && <p role="alert" className="lv-alert lv-alert-danger text-[12px] text-text-primary">{error}</p>}
      <ConfirmDialog
        open={confirming}
        title={t('regenerateTitle')}
        consequence={t('regenerateBody')}
        confirmLabel={t('regenerateGo')}
        cancelLabel={t('cancel')}
        destructive
        busy={busy}
        onConfirm={regenerate}
        onCancel={() => setConfirming(false)}
        testId="review-code-regenerate"
      />
    </div>
  );
}
