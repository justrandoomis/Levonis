/**
 * ENTERING A COMPETITION (rewards spec §3.7): the entry sheet, and the one-tap
 * ConfirmDialog for a competition that asks for nothing.
 *
 * - EntrySheet: submission 'text' | 'photo' | 'photo_text'. The Sheet v2,
 *   dragged by its grabber, one height (the body scrolls between a header
 *   and a footer that stay), a centred window from `sm`. While an answer or a
 *   photo is held it is `dirty`, so Overlay's own «متابعة التحرير / تجاهل
 *   وإغلاق» guards a dismiss. THE SHEET IS THE INFORMED CONFIRMATION: the
 *   send button names the cost, the notes say it is the customer's own work,
 *   one entry, shown publicly if it wins (15.3, 15.8) and, for a paid one,
 *   that the points come back in full if the competition is cancelled or the
 *   entry not accepted (15.6, 15.7). No second dialog.
 * - EntryConfirm: submission 'none'. The controlled ConfirmDialog: the
 *   question, the consequence, the verb; busy and the refusal stay inside it,
 *   and a gate that says no once read again turns «شارك» off, as it does the
 *   sheet's send (below), so it is never pressed into the same refusal again.
 *
 * CompetitionScreen holds `open` for both, so they unmount with the page on
 * Back. Both POST `/api/rewards/program/competitions/:id/enter` — the sheet
 * with `{ answer?: answer.trim(), media_key?: photo.key }`, the dialog `{}`.
 *
 * THE PHOTO is uploaded the moment it is picked (POST /api/uploads, purpose
 * 'post', through `uploadFile`: the house resize for its purpose, and a
 * deadline sized for the body), and the entry names its key; the server
 * checks the photo is the entrant's own. A refusal says why in words — an
 * iPhone's HEIC, a file too large, too many tries — and the typed answer is
 * never touched.
 *
 * SEND checks on press, never by silently disabling: what is missing is said
 * at its field and focus goes to the first one. Then:
 * - SUCCESS: dirty cleared, closed, «سُجّلت مشاركتك…» toasted, `onEntered()`
 *   (the screen awaits the frame's refresh and moves focus to «مشاركتك»).
 * - A REFUSAL THAT CHANGES THE GATE (already entered, not enough points,
 *   full, not eligible, closed, not open yet) — or a 404, the competition
 *   gone — says the shipped sentence and reads the page again; when the new
 *   gate is not `can_enter`, send turns off and the sentence stays as the
 *   reason. A gate that turns while the sheet is open (it closed under the
 *   customer's thumb) gives the same reason, from the gate itself.
 * - Too many tries, the programme not installed, anything else: in words.
 *
 * Every opening is a fresh entry: what a dismissed sheet held was discarded
 * by the customer's own «تجاهل وإغلاق». The refusal sentences of other doors
 * (`refusalText`) are a chunk of their own, fetched on the first refusal that
 * needs one, as every lazy screen does.
 */
import { useLayoutEffect, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ImagePlus } from 'lucide-react';
import type { Language } from '../../translations';
import { api, ApiError, uploadFile } from '../../lib/api';
import { formatFigure } from '../../lib/localeNumber';
import { toast } from '../../lib/toastStore';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Field, Textarea, focusFirstInvalid } from '../ui/Field';
import Note from '../ui/Note';
import SafeImage from '../ui/SafeImage';
import { Sheet } from '../ui/Sheet';
import Spinner from '../ui/Spinner';
import { pointsForm, type CopyKey } from './copy';
import { isolateLatin } from './model';
import type { Competition, GateBlock } from './types';
import { useRewardsT } from './useT';

export interface EntrySheetProps {
  open: boolean;
  /** Close the sheet (the screen sets `open` false); also called after a success. */
  onClose: () => void;
  /** The competition as the detail reads it now (`detail.data.competition`): its `gate` re-read after a refusal decides whether send stays enabled. */
  competition: Competition;
  /** The balance the fee sentence names, `{balance}` in sheet.fee: `detail.data.point_balance`. */
  pointBalance: number;
  /** Read the detail again (`detail.reload`) after a refusal that changes the gate. */
  reload: () => Promise<void>;
  /** The entry was recorded and the sheet has closed and toasted; the screen refreshes and moves focus. */
  onEntered: () => void | Promise<void>;
}

export interface EntryConfirmProps {
  open: boolean;
  /** Close the dialog (the screen sets `open` false); also called after a success. */
  onClose: () => void;
  /** The competition as the detail reads it now; its title and `entry_points` fill the dialog. */
  competition: Competition;
  /** Read the detail again (`detail.reload`) after a refusal that changes the gate. */
  reload: () => Promise<void>;
  /** The entry was recorded and the dialog has closed and toasted; the screen refreshes and moves focus. */
  onEntered: () => void | Promise<void>;
}

/** The competition's own price to enter, as the server charges it; 0 when free. A fact of the competition, never a decision. */
export function entryFee(c: Pick<Competition, 'entry_mode' | 'entry_points'>): number {
  return c.entry_mode === 'points' && c.entry_points > 0 ? c.entry_points : 0;
}

/** worker MAX_ANSWER_CHARS: the most an answer may hold. */
const MAX_ANSWER = 1000;

function enterPath(id: string): string {
  return `/api/rewards/program/competitions/${encodeURIComponent(id)}/enter`;
}

type RewardsT = ReturnType<typeof useRewardsT>['t'];

/** The refusals that mean the competition changed under the window: the shipped sentence, and the page reads it again. */
const REGATE: Readonly<Record<string, CopyKey>> = {
  COMPETITION_ALREADY_ENTERED: 'err.alreadyEntered',
  INSUFFICIENT_POINTS: 'err.points',
  COMPETITION_FULL: 'err.full',
  COMPETITION_NOT_ELIGIBLE: 'err.notEligible',
  COMPETITION_CLOSED: 'err.notOpen',
  COMPETITION_NOT_OPEN: 'err.notOpen',
};

/** Why send stays off when the gate, read again, says no and no refusal is on screen to say it. */
const GATE_REASON: Readonly<Record<GateBlock, CopyKey>> = {
  entered: 'err.alreadyEntered',
  upcoming: 'err.notOpen',
  closed: 'err.notOpen',
  not_eligible: 'err.notEligible',
  full: 'err.full',
  insufficient_points: 'err.points',
};

/** A sentence from the refusal table every door shares, loaded on first use (its own chunk); `fallback` when it has none or cannot load. */
async function sharedRefusal(code: string | undefined, lang: Language, fallback: string): Promise<string> {
  if (!code) return fallback;
  try {
    const { refusalLang, refusalText } = await import('../../lib/refusalStrings');
    return refusalText(code, refusalLang(lang), fallback) || fallback;
  } catch {
    return fallback;
  }
}

type Refusal =
  | { to: 'answer'; text: string }
  | { to: 'photo'; text: string }
  | { to: 'alert'; text: string; regate: boolean };

/** What an entry's refusal reads as, and where it goes. */
async function entryRefusal(e: unknown, t: RewardsT, lang: Language): Promise<Refusal> {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === 'COMPETITION_ANSWER_REQUIRED') return { to: 'answer', text: t('err.answerRequired') };
  if (code === 'COMPETITION_PHOTO_INVALID') return { to: 'photo', text: t('err.photoInvalid') };
  const gated = code ? REGATE[code] : undefined;
  if (gated) return { to: 'alert', text: t(gated), regate: true };
  if (code === 'RATE_LIMITED') return { to: 'alert', text: t('tooMany'), regate: false };
  if (code === 'REWARDS_NOT_INSTALLED') return { to: 'alert', text: t('sheet.notInstalled'), regate: false };
  // A 404: the competition is gone (cancelled, unpublished). The page's read then shows its NotFound.
  const gone = e instanceof ApiError && e.status === 404;
  return { to: 'alert', text: await sharedRefusal(code, lang, t('err.generic')), regate: gone };
}

/** What a failed photo upload reads as. */
async function uploadRefusal(e: unknown, t: RewardsT, lang: Language): Promise<string> {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === 'IMAGE_HEIC_UNSUPPORTED') return t('sheet.heic');
  if (code === 'UPLOAD_TOO_LARGE') return sharedRefusal(code, lang, t('sheet.uploadFailed'));
  if (code === 'RATE_LIMITED') return t('tooMany');
  return t('sheet.uploadFailed');
}

// ------------------------------------------------------------ the entry sheet

export function EntrySheet({ open, onClose, competition: c, pointBalance, reload, onEntered }: EntrySheetProps) {
  const { t, count, tri, lang, dir } = useRewardsT();
  const wantsText = c.submission === 'text' || c.submission === 'photo_text';
  const wantsPhoto = c.submission === 'photo' || c.submission === 'photo_text';
  const fee = entryFee(c);
  const gate = c.gate;
  /** The server's gate, read again, says this customer cannot enter now. */
  const gateNo = !!gate && gate.can_enter !== true;
  const rules = tri(c.description);

  const [answer, setAnswer] = useState('');
  const [photo, setPhoto] = useState<{ key: string; url: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  /** What the upload is doing, for a screen reader (the error itself is also the field's). */
  const [uploadNote, setUploadNote] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  /** Sent: nothing is left to lose, so a dismiss asks nothing. */
  const [sent, setSent] = useState(false);
  /** A focus move asked for by the last render: the first invalid field, or the photo's control after it changed. */
  const [focusAsk, setFocusAsk] = useState<{ to: 'invalid' | 'photo'; n: number } | null>(null);

  /** Bumped on every opening: an upload or a refusal from an earlier opening lands nowhere. */
  const epoch = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** The photo's control, whichever is drawn: «اختر صورة», or «تغيير الصورة» once there is one. */
  const photoControl = useRef<HTMLButtonElement | null>(null);

  // EVERY OPENING IS A FRESH ENTRY (before paint, so nothing old flashes).
  useLayoutEffect(() => {
    if (!open) return;
    epoch.current += 1;
    setAnswer('');
    setPhoto(null);
    setUploading(false);
    setSending(false);
    setPhotoError(null);
    setAnswerError(null);
    setAlert(null);
    setUploadNote('');
    setRulesOpen(false);
    setSent(false);
    setFocusAsk(null);
  }, [open]);

  useEffect(() => {
    if (!focusAsk) return;
    if (focusAsk.to === 'invalid') {
      focusFirstInvalid(bodyRef.current);
      return;
    }
    // The control that had focus was replaced (picked, removed): its successor takes it —
    // unless the customer has already moved on (typing the answer while the photo went up).
    const now = document.activeElement;
    if (!now || now === document.body) photoControl.current?.focus();
  }, [focusAsk]);

  const ask = (to: 'invalid' | 'photo') => setFocusAsk((f) => ({ to, n: (f?.n ?? 0) + 1 }));

  const pickPhoto = () => {
    if (uploading) return;
    fileRef.current?.click();
  };

  const onPicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared, so picking the same file again (after a refusal) is a change too.
    e.target.value = '';
    if (!file) return;
    const at = epoch.current;
    setUploading(true);
    setPhotoError(null);
    setUploadNote(t('sheet.uploading'));
    try {
      const res = await uploadFile(file, 'post');
      if (at !== epoch.current) return;
      setPhoto({ key: res.key, url: res.url });
      setUploadNote('');
      ask('photo');
    } catch (err) {
      if (at !== epoch.current) return;
      const text = await uploadRefusal(err, t, lang);
      if (at !== epoch.current) return;
      setPhotoError(text);
      setUploadNote(text);
    } finally {
      if (at === epoch.current) setUploading(false);
    }
  };

  const removePhoto = () => {
    setPhoto(null);
    setPhotoError(null);
    ask('photo');
  };

  const send = async () => {
    if (sending || uploading) return;
    setAlert(null);
    const needPhoto = wantsPhoto && !photo;
    const needAnswer = wantsText && !answer.trim();
    if (needPhoto) setPhotoError(t('sheet.needPhoto'));
    if (needAnswer) setAnswerError(t('sheet.needAnswer'));
    if (needPhoto || needAnswer) {
      ask('invalid');
      return;
    }
    const at = epoch.current;
    setSending(true);
    try {
      await api.post(enterPath(c.id), {
        ...(wantsText ? { answer: answer.trim() } : {}),
        ...(wantsPhoto && photo ? { media_key: photo.key } : {}),
      });
    } catch (err) {
      const refusal = await entryRefusal(err, t, lang);
      if (at !== epoch.current) return;
      setSending(false);
      if (refusal.to === 'answer') {
        setAnswerError(refusal.text);
        ask('invalid');
      } else if (refusal.to === 'photo') {
        // The server would not take that photo (gone, or not this account's): pick it again.
        setPhoto(null);
        setPhotoError(refusal.text);
        ask('invalid');
      } else {
        setAlert(refusal.text);
        if (refusal.regate) void reload();
      }
      return;
    }
    // Recorded — even if the sheet was dismissed while it went.
    if (at === epoch.current) {
      setSending(false);
      setSent(true);
    }
    onClose();
    toast.success(t('sheet.done'));
    await onEntered();
  };

  const gateKey: CopyKey | undefined = gate?.blocked_by ? GATE_REASON[gate.blocked_by] : undefined;
  const reason = alert ?? (gateNo && gateKey ? t(gateKey) : null);
  const photoDescribedBy = photoError ? 'entry-photo-error' : 'entry-photo-hint';
  const RulesChevron = rulesOpen ? ChevronDown : dir === 'rtl' ? ChevronLeft : ChevronRight;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dragHandle
      labelledBy="entry-title"
      testId="competition-entry"
      dirty={!sent && (!!answer.trim() || !!photo)}
      // One height on a phone: never taller than the screen, so the body scrolls and the footer stays.
      panelClassName="max-h-[calc(100dvh-3.5rem)] sm:max-w-[460px] sm:w-[92vw]"
      header={
        <div>
          <h2 id="entry-title" className="px-4 pt-1 text-center text-[16px] font-extrabold text-text-primary">
            {t('sheet.title')}
          </h2>
          <p dir="auto" className="truncate px-4 pb-2 text-center text-[13px] text-text-muted">
            {isolateLatin(tri(c.title))}
          </p>
        </div>
      }
      footer={
        <div className="space-y-2">
          {reason && (
            <p role="alert" className="lv-alert lv-alert-danger text-[13px] leading-relaxed text-text-primary">
              {reason}
            </p>
          )}
          <Button
            variant="primary"
            block
            loading={sending || uploading}
            loadingLabel={uploading ? t('sheet.waitUpload') : t('sheet.sending')}
            disabled={gateNo}
            onClick={send}
            data-competition-send
          >
            {fee > 0 ? t('sheet.sendFee', { points: count(pointsForm('sheet.sendFee'), fee) }) : t('sheet.send')}
          </Button>
        </div>
      }
    >
      <div ref={bodyRef} className="space-y-4 px-4 py-2">
        {rules && (
          <div className="space-y-2">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={rulesOpen}
              aria-controls="entry-rules"
              icon={<RulesChevron className="w-4 h-4" aria-hidden="true" />}
              onClick={() => setRulesOpen((v) => !v)}
            >
              {t('sheet.rules')}
            </Button>
            <div id="entry-rules" hidden={!rulesOpen} className="lv-well rounded-lg p-3">
              <p dir="auto" className="whitespace-pre-line text-[13.5px] leading-6 text-text-secondary">
                {rules}
              </p>
            </div>
          </div>
        )}

        {wantsPhoto && (
          <Field id="entry-photo" label={t('sheet.photo')} hint={t('sheet.pickHint')} error={photoError}>
            {photo ? (
              <div className="flex items-center gap-3">
                <SafeImage src={photo.url} alt="" aspect="square" sizes="96px" className="size-24 shrink-0 rounded-lg" bgClassName="bg-surface" />
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Button
                    ref={photoControl}
                    id="entry-photo"
                    variant="secondary"
                    size="sm"
                    loading={uploading}
                    loadingLabel={t('sheet.uploading')}
                    aria-invalid={photoError ? true : undefined}
                    aria-describedby={photoDescribedBy}
                    onClick={pickPhoto}
                  >
                    {t('sheet.change')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={uploading} onClick={removePhoto}>
                    {t('sheet.remove')}
                  </Button>
                </div>
              </div>
            ) : (
              // Busy, not disabled, while the photo goes up: a disabled button would drop the focus it holds.
              <button
                type="button"
                ref={photoControl}
                id="entry-photo"
                aria-invalid={photoError ? true : undefined}
                aria-describedby={photoDescribedBy}
                aria-disabled={uploading || undefined}
                aria-busy={uploading || undefined}
                onClick={pickPhoto}
                className="lv-choice flex w-full flex-col items-center justify-center gap-2 py-6 text-[13px] font-semibold"
              >
                {uploading ? (
                  <>
                    <Spinner size="sm" delayMs={0} decorative />
                    {t('sheet.uploading')}
                  </>
                ) : (
                  <>
                    <ImagePlus className="w-6 h-6" aria-hidden="true" />
                    {t('sheet.pick')}
                  </>
                )}
              </button>
            )}
            <span role="status" aria-live="polite" className="sr-only">
              {uploadNote}
            </span>
          </Field>
        )}
        {wantsPhoto && (
          <input
            type="file"
            ref={fileRef}
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void onPicked(e)}
          />
        )}

        {wantsText && (
          <Field
            id="entry-answer"
            label={t('sheet.answer')}
            hint={t('sheet.counter', { n: formatFigure(answer.length, lang), max: formatFigure(MAX_ANSWER, lang) })}
            error={answerError}
          >
            <Textarea
              rows={4}
              dir="auto"
              maxLength={MAX_ANSWER}
              value={answer}
              onChange={(e) => {
                setAnswer(e.target.value);
                if (answerError) setAnswerError(null);
              }}
            />
          </Field>
        )}

        <Note tone="zinc" compact animate={false}>
          {t('sheet.ownWork')}
        </Note>
        <p className="text-[12px] leading-5 text-text-muted">{t('sheet.once')}</p>
        <p className="text-[12px] leading-5 text-text-muted">{t('sheet.public')}</p>
        {fee > 0 && (
          <p className="text-[13px] leading-6 text-text-secondary">
            {t('sheet.fee', { points: count(pointsForm('sheet.fee'), fee), balance: count('points', pointBalance) })}
          </p>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------ the one-tap confirm

export function EntryConfirm({ open, onClose, competition: c, reload, onEntered }: EntryConfirmProps) {
  const { t, tx, count, tri, lang } = useRewardsT();
  const fee = entryFee(c);
  const [error, setError] = useState<string | null>(null);
  // As the sheet's send: once the gate, read again, says no, «شارك» is off and the refusal (else the gate) says why.
  const gateNo = !!c.gate && c.gate.can_enter !== true;
  const gateKey: CopyKey | undefined = c.gate?.blocked_by ? GATE_REASON[c.gate.blocked_by] : undefined;
  const reason = error ?? (gateNo && gateKey ? t(gateKey) : null);

  // Every opening asks afresh.
  useLayoutEffect(() => {
    if (open) setError(null);
  }, [open]);

  const confirm = async () => {
    setError(null);
    try {
      await api.post(enterPath(c.id), {});
    } catch (err) {
      const refusal = await entryRefusal(err, t, lang);
      setError(refusal.text);
      if (refusal.to === 'alert' && refusal.regate) void reload();
      return;
    }
    onClose();
    toast.success(t('sheet.done'));
    await onEntered();
  };

  return (
    <ConfirmDialog
      open={open}
      title={tx('confirm.title', { title: <bdi>{isolateLatin(tri(c.title))}</bdi> })}
      consequence={fee > 0 ? t('confirm.fee', { points: count(pointsForm('confirm.fee'), fee) }) : t('confirm.free')}
      confirmLabel={fee > 0 ? t('cta.enterFee', { points: count(pointsForm('cta.enterFee'), fee) }) : t('confirm.go')}
      cancelLabel={t('cancel')}
      onConfirm={confirm}
      onCancel={onClose}
      error={reason}
      confirmDisabled={gateNo}
      testId="competition-confirm"
    />
  );
}
