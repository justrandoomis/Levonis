import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Camera, Image as ImageIcon, Mic, ShieldCheck, Square, X } from 'lucide-react';
import { ApiError, uploadFile } from '../../lib/api';
import { formatElapsed, useVoiceRecorder } from '../../lib/voiceRecorder';
import { AI_POLICY_PATH, readAttachment, readFrames, type AiReadKind, type AiReply } from '../../lib/assistAi';
import Spinner from '../ui/Spinner';

/**
 * THE + IN THE SUPPORT ASSISTANT: a photo, a clip or a voice note
 * (support assistant v2, push A; item 5 of the owner).
 *
 * Loaded only when the + is pressed, so the assistant page itself carries
 * none of it. Three ways in:
 *
 *   - from the device: pictures, clips and audio files, several at once;
 *   - the camera: `capture="environment"`, which opens the back camera on a
 *     phone (photo or clip) and is an ordinary picker on a desktop;
 *   - the microphone: the same recorder the order chat uses
 *     (src/lib/voiceRecorder.ts); where a browser has none, an audio picker
 *     with `capture` asks the phone to record instead. Here it stops by
 *     itself after one minute (push B1 plan §5.4): the recording is kept, the
 *     sheet says why it stopped, and the customer chooses to attach it.
 *
 * Every file goes to `/api/uploads` with purpose `assist`: private, under the
 * uploader, with the server sniffing the bytes and holding the size limits.
 * The file waits in the chat and goes to the team with the ticket
 * «تحدث مع الفريق» opens.
 *
 * READING A FILE (push B1, `AssistAiRead` below, from the same chunk). Only
 * when the customer taps a read chip, and only after the consent sheet the
 * first time in a browser session: a photo or a voice note is read by its
 * owned key; a clip is turned into 2-4 frames on this device (the lazy
 * src/lib/assistMedia.ts) and only the frames are sent. Declining keeps the
 * file attached exactly as before.
 */

export interface AssistAttachment {
  key: string;
  /** `/files/<key>`, as the server composed it. */
  url: string;
  kind: 'image' | 'video' | 'audio';
  mime?: string;
}

/** A recording in the assistant stops by itself after this many seconds (plan §5.4). */
export const ASSIST_VOICE_MAX_SECONDS = 60;

type Lang = 'ar' | 'en' | 'ckb';

const COPY: Record<Lang, Record<string, string>> = {
  ar: {
    title: 'إرفاق',
    gallery: 'صورة أو فيديو أو صوت من جهازك',
    camera: 'التقاط بالكاميرا',
    voice: 'تسجيل رسالة صوتية',
    recording: 'جارٍ التسجيل',
    stopAttach: 'إيقاف وإرفاق',
    cancel: 'إلغاء',
    close: 'إغلاق',
    uploading: 'جارٍ الرفع…',
    full: 'يمكن إرفاق 6 ملفات كحد أقصى.',
    dropped: 'لم يُرفق {n} من الملفات المختارة، فالحد الأقصى 6 ملفات.',
    tooLarge: 'الملف أكبر من الحد المسموح.',
    limit: 'وصلت إلى حد المرفقات لهذا الأسبوع. يمكنك إرسال التذكرة بالملفات المرفقة الآن، وإرفاق المزيد بعد بضعة أيام.',
    kind: 'أرفق صورة أو فيديو أو رسالة صوتية فقط.',
    heic: 'صيغة HEIC غير مدعومة. اختر صورة JPEG أو أرسل لقطة شاشة.',
    failed: 'تعذر رفع الملف، حاول مرة أخرى.',
    micDenied: 'لم يُسمح باستخدام الميكروفون. فعّله من إعدادات المتصفح.',
    micFailed: 'تعذر بدء التسجيل الصوتي.',
    voiceLimit: 'التسجيل بحد أقصى دقيقة واحدة.',
    attachRecording: 'إرفاق التسجيل',
    consentTitle: 'قبل قراءة المرفق',
    consentPhoto: 'لقراءة الصورة أو لقطات المقطع نرسلها إلى خدمة ذكاء اصطناعي خارجية ({provider}). تُستخدم للقراءة فقط، ولا نحفظ نتيجتها، ولا تُستخدم لتدريب أي نموذج. يبقى المرفق نفسه محفوظًا بشكل خاص لمدة ٧ أيام ما لم تفتح تذكرة.',
    consentVoice: 'لتحويل تسجيلك إلى نص نرسله إلى خدمة تحويل الكلام لدى {provider}. لا نحفظ النص، وتراه وتعدّله قبل الإرسال.',
    consentAccept: 'موافق، اقرأه',
    consentDecline: 'لا، أرفقه فقط',
    consentPolicy: 'اقرأ بند القراءة الآلية كاملًا',
    readingBusy: 'أقرأ المرفق…',
    framesBusy: 'أستخرج لقطات من المقطع…',
    framesFailed: 'لم أستطع أخذ لقطات من هذا المقطع على جهازك. المقطع ما زال مرفقًا.',
  },
  en: {
    title: 'Attach',
    gallery: 'Photo, video or audio from your device',
    camera: 'Take with the camera',
    voice: 'Record a voice note',
    recording: 'Recording',
    stopAttach: 'Stop and attach',
    cancel: 'Cancel',
    close: 'Close',
    uploading: 'Uploading…',
    full: 'You can attach up to 6 files.',
    dropped: '{n} of the chosen files were not attached. You can attach up to 6 files.',
    tooLarge: 'The file is larger than allowed.',
    limit: 'You reached the attachment limit for this week. You can send the ticket with the files attached now, and attach more in a few days.',
    kind: 'Attach a photo, a video or a voice note only.',
    heic: 'HEIC photos are not supported. Choose a JPEG photo or send a screenshot.',
    failed: 'The file could not be uploaded. Try again.',
    micDenied: 'Microphone access was not allowed. Turn it on in the browser settings.',
    micFailed: 'The voice recording could not start.',
    voiceLimit: 'Recordings are at most one minute.',
    attachRecording: 'Attach the recording',
    consentTitle: 'Before reading the attachment',
    consentPhoto: 'To read the photo or frames from the clip we send them to an outside AI service ({provider}). They are used only to read them; we keep no copy of the result, and they are not used to train any model. The attachment itself stays private for 7 days unless you open a ticket.',
    consentVoice: 'To turn your recording into text we send it to the speech service of {provider}. We do not keep the text, and you see and edit it before it is sent.',
    consentAccept: 'OK, read it',
    consentDecline: 'No, just attach it',
    consentPolicy: 'Read the full clause on automatic reading',
    readingBusy: 'Reading the attachment…',
    framesBusy: 'Taking frames from the clip…',
    framesFailed: 'I could not take frames from this clip on your device. The clip is still attached.',
  },
  ckb: {
    title: 'هاوپێچکردن',
    gallery: 'وێنە، ڤیدیۆ یان دەنگ لە ئامێرەکەتەوە',
    camera: 'گرتن بە کامێرا',
    voice: 'تۆمارکردنی نامەی دەنگی',
    recording: 'تۆمار دەکرێت',
    stopAttach: 'ڕاگرتن و هاوپێچکردن',
    cancel: 'هەڵوەشاندنەوە',
    close: 'داخستن',
    uploading: 'خەریکی بارکردنە…',
    full: 'دەتوانیت تا ٦ فایل هاوپێچ بکەیت.',
    dropped: '{n} لە فایلە هەڵبژێردراوەکان هاوپێچ نەکران. دەتوانیت تا ٦ فایل هاوپێچ بکەیت.',
    tooLarge: 'فایلەکە لە سنووری ڕێپێدراو گەورەترە.',
    limit: 'گەیشتیتە سنووری هاوپێچەکانی ئەم هەفتەیە. دەتوانیت ئێستا تیکێتەکە لەگەڵ فایلە هاوپێچکراوەکان بنێریت، و دوای چەند ڕۆژێک فایلی زیاتر هاوپێچ بکەیت.',
    kind: 'تەنها وێنە، ڤیدیۆ یان نامەی دەنگی هاوپێچ بکە.',
    heic: 'وێنەی HEIC پشتگیری ناکرێت. وێنەیەکی JPEG هەڵبژێرە یان وێنەی شاشە بنێرە.',
    failed: 'فایلەکە بار نەکرا، دووبارە هەوڵ بدەرەوە.',
    micDenied: 'ڕێگە بە بەکارهێنانی مایکرۆفۆن نەدرا. لە ڕێکخستنەکانی وێبگەڕەکەدا چالاکی بکە.',
    micFailed: 'تۆمارکردنی دەنگ دەستی پێ نەکرد.',
    voiceLimit: 'تۆمارکردن زۆرترین یەک خولەکە.',
    attachRecording: 'تۆمارەکە هاوپێچ بکە',
    consentTitle: 'پێش خوێندنەوەی هاوپێچەکە',
    consentPhoto: 'بۆ خوێندنەوەی وێنەکە یان چەند وێنەیەک لە ڤیدیۆکە، دەیاننێرین بۆ خزمەتگوزارییەکی زیرەکی دەستکردی دەرەکی ({provider}). تەنها بۆ خوێندنەوە بەکاردێن؛ ئەنجامەکەی هەڵناگرین و بۆ ڕاهێنانی هیچ مۆدێلێک بەکارناهێنرێن. هاوپێچەکە خۆی بە تایبەتی بۆ ماوەی ٧ ڕۆژ دەمێنێتەوە، مەگەر تیکێتێک بکەیتەوە.',
    consentVoice: 'بۆ گۆڕینی تۆمارەکەت بۆ نووسین، دەینێرین بۆ خزمەتگوزاری ناسینەوەی قسەی {provider}. نووسینەکە هەڵناگرین، و پێش ناردن دەیبینیت و دەستکاری دەکەیت.',
    consentAccept: 'باشە، بیخوێنەوە',
    consentDecline: 'نەخێر، تەنها هاوپێچی بکە',
    consentPolicy: 'بەندی خوێندنەوەی خۆکار بە تەواوی بخوێنەوە',
    readingBusy: 'هاوپێچەکە دەخوێنمەوە…',
    framesBusy: 'وێنە لە کلیپەکە وەردەگرم…',
    framesFailed: 'نەمتوانی لەسەر ئامێرەکەت وێنە لەم ڤیدیۆیە وەربگرم. ڤیدیۆکە هێشتا هاوپێچ کراوە.',
  },
};

const copyFor = (lang: string) => COPY[(lang as Lang) in COPY ? (lang as Lang) : 'ar'];

/** The server names the refusal; the sentence comes from this file, in the language of the page. */
function refusalText(t: Record<string, string>, err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === 'UPLOAD_TOO_LARGE' || code === 'IMAGE_TOO_LARGE_TO_CONVERT') return t.tooLarge;
  if (code === 'ASSIST_ATTACH_LIMIT') return t.limit;
  if (code === 'ASSIST_ATTACH_KIND') return t.kind;
  if (code === 'IMAGE_HEIC_UNSUPPORTED') return t.heic;
  return t.failed;
}

const kindOf = (mime: string): AssistAttachment['kind'] =>
  mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';

export default function AssistAttach({
  lang,
  remaining,
  onAttached,
  onClose,
}: {
  lang: string;
  /** How many more files this conversation may carry (the ticket takes six). */
  remaining: number;
  /** The upload answer, and the picked file itself (a clip is read from it in this visit, never stored). */
  onAttached: (attachment: AssistAttachment, file?: File) => void;
  onClose: () => void;
}) {
  const t = copyFor(lang);
  /** A recording the one-minute cap stopped: kept until the customer attaches or drops it. */
  const [capped, setCapped] = useState<File | null>(null);
  const voice = useVoiceRecorder({ maxSeconds: ASSIST_VOICE_MAX_SECONDS, onLimit: (file) => setCapped(file) });
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (files: File[]) => {
    if (!files.length) return;
    // More picked than the ticket takes: the first ones are attached, and the sheet stays
    // open saying how many were left out, never closing on files that silently vanished.
    const dropped = Math.max(0, files.length - Math.max(0, remaining));
    if (dropped > 0) {
      setError(t.dropped.replace('{n}', String(dropped)));
      files = files.slice(0, Math.max(0, remaining));
      if (!files.length) return;
    } else {
      setError('');
    }
    setBusy(true);
    let left = remaining;
    try {
      // One after the other, so the bubbles land in the order they were picked.
      for (const file of files) {
        if (left <= 0) break;
        const up = await uploadFile(file, 'assist');
        const mime = up.mime ?? file.type ?? '';
        onAttached({ key: up.key, url: up.url, kind: kindOf(mime), mime }, file);
        left -= 1;
      }
      if (dropped === 0) onClose();
    } catch (err) {
      setError(refusalText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    void send(files);
  };

  const startVoice = async () => {
    setError('');
    setCapped(null);
    if (!voice.supported) {
      audioRef.current?.click();
      return;
    }
    await voice.start();
  };
  const stopVoice = async () => {
    const file = await voice.stop();
    if (file) await send([file]);
  };
  const attachCapped = async () => {
    const file = capped;
    setCapped(null);
    if (file) await send([file]);
  };
  const voiceError = voice.error === 'denied' ? t.micDenied : voice.error === 'failed' ? t.micFailed : '';
  const full = remaining <= 0;
  const row = 'lv-button lv-button-ghost min-h-11 w-full justify-start gap-3 px-3 text-start text-sm text-text-primary';
  const latin = lang === 'en';

  return (
    <div className="mx-auto mb-2 max-w-3xl rounded-xl border border-border-subtle bg-surface p-2 shadow-1" data-assist-attach role="group" aria-label={t.title}>
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-bold text-text-secondary">{t.title}</span>
        <button
          type="button"
          onClick={() => {
            voice.cancel();
            onClose();
          }}
          className="lv-button lv-button-ghost min-h-9 w-9 px-0"
          aria-label={t.close}
          disabled={busy}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <input ref={galleryRef} type="file" accept="image/*,video/*,audio/*" multiple className="hidden" onChange={onPick} />
      <input ref={cameraRef} type="file" accept="image/*,video/*" capture="environment" className="hidden" onChange={onPick} />
      <input ref={audioRef} type="file" accept="audio/*" capture className="hidden" onChange={onPick} />

      {voice.recording ? (
        <div className="flex items-center gap-2 px-1 py-1" aria-live="polite">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden="true" />
          <span className="text-sm font-bold text-text-primary">{t.recording}</span>
          <span className="tabular-nums text-sm text-text-secondary" dir="ltr" data-assist-voice-timer>
            {formatElapsed(voice.elapsed, latin)}
            {voice.limit !== null && <span className="text-text-muted"> / {formatElapsed(voice.limit, latin)}</span>}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={() => voice.cancel()} className="lv-button lv-button-secondary min-h-10 px-3 text-xs">
            {t.cancel}
          </button>
          <button type="button" onClick={() => void stopVoice()} className="lv-button lv-button-primary min-h-10 px-3 text-xs">
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            {t.stopAttach}
          </button>
        </div>
      ) : capped ? (
        // THE CAP STOPPED IT: said in words, the recording kept, and attaching it stays the choice of the customer.
        <div className="flex flex-wrap items-center gap-2 px-1 py-1" data-assist-voice-capped>
          <p role="status" className="min-w-0 flex-1 text-sm text-text-secondary">
            {t.voiceLimit}
          </p>
          <button type="button" onClick={() => setCapped(null)} className="lv-button lv-button-secondary min-h-10 px-3 text-xs" disabled={busy}>
            {t.cancel}
          </button>
          <button type="button" onClick={() => void attachCapped()} className="lv-button lv-button-primary min-h-10 px-3 text-xs" disabled={busy || full}>
            {t.attachRecording}
          </button>
        </div>
      ) : (
        <div className="space-y-0.5">
          <button type="button" className={row} disabled={busy || full} onClick={() => galleryRef.current?.click()}>
            <ImageIcon className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            {t.gallery}
          </button>
          <button type="button" className={row} disabled={busy || full} onClick={() => cameraRef.current?.click()}>
            <Camera className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            {t.camera}
          </button>
          <button type="button" className={row} disabled={busy || full} onClick={() => void startVoice()}>
            <Mic className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            {t.voice}
          </button>
        </div>
      )}

      {busy && <p className="px-1 pt-1 text-xs text-text-muted">{t.uploading}</p>}
      {(error || voiceError || full) && (
        <p role="alert" className="px-1 pt-1 text-xs text-danger">
          {error || voiceError || t.full}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------- reading a file (B1)

/** What the customer asked to have read: the attachment, and the clip still in memory when there is one. */
export interface AssistReadJob {
  kind: AiReadKind;
  attachment: AssistAttachment;
  file?: File;
}

/**
 * How a read ended. `reply` is drawn like any other reply; `transcript` goes
 * into the composer only; `note` is a sentence of this sheet (no server call
 * was made); `error` is a failed turn the page words itself.
 */
export type AssistReadOutcome =
  | { kind: 'reply'; reply: AiReply }
  | { kind: 'transcript'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'error' };

type Phase = 'consent' | 'frames' | 'reading';

/**
 * THE CONSENT SHEET, THEN THE READ. Mounted by the Support page when a read
 * chip is tapped. Asks first when this browser session has no yes for this
 * kind of file (photos and clips go to one company, voice notes to another),
 * names the company, and reads only after «موافق، اقرأه». A clip is turned
 * into frames here, on this device; fewer than two frames is said plainly and
 * nothing is sent. Every answer goes back to the page, which renders it:
 * nothing here is applied for the customer.
 */
export function AssistAiRead({
  lang,
  job,
  provider,
  askConsent,
  context,
  onConsent,
  onDone,
  onCancel,
}: {
  lang: string;
  job: AssistReadJob;
  /** The company the file goes to, as readiness named it. */
  provider: string;
  /** True when this browser session has not accepted this kind of read yet. */
  askConsent: boolean;
  /** The conversation context, opaque, sent back unchanged. */
  context: unknown;
  /** The answer of the sheet, for the page to remember for this session. */
  onConsent: (accepted: boolean) => void;
  onDone: (outcome: AssistReadOutcome) => void;
  onCancel: () => void;
}) {
  const t = copyFor(lang);
  const [phase, setPhase] = useState<Phase>(askConsent ? 'consent' : job.kind === 'clip' ? 'frames' : 'reading');
  const alive = useRef(true);
  const started = useRef(false);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `assist-consent-${job.kind}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async () => {
    if (started.current) return;
    started.current = true;
    const finish = (outcome: AssistReadOutcome) => {
      if (alive.current) onDone(outcome);
    };
    try {
      if (job.kind === 'clip') {
        setPhase('frames');
        const media = await import('../../lib/assistMedia');
        const frames = await media.extractFrames(job.file ?? job.attachment.url);
        if (!alive.current) return;
        if (frames.length < media.MIN_FRAMES) {
          finish({ kind: 'note', text: t.framesFailed });
          return;
        }
        setPhase('reading');
        finish(await readFrames({ key: job.attachment.key, frames, locale: lang, context }));
        return;
      }
      setPhase('reading');
      finish(await readAttachment({ kind: job.kind, key: job.attachment.key, locale: lang, context }));
    } catch (err) {
      // A body over the limit is a clip this device could not make small enough: the same sentence.
      if (job.kind === 'clip' && err instanceof ApiError && err.status === 413) finish({ kind: 'note', text: t.framesFailed });
      else finish({ kind: 'error' });
    }
  };

  useEffect(() => {
    if (askConsent) acceptRef.current?.focus();
    else void run();
    // The job is fixed for the life of this sheet: the page mounts a new one for the next read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'consent') {
    const body = (job.kind === 'voice' ? t.consentVoice : t.consentPhoto).replace('{provider}', provider);
    return (
      <div
        className="mx-auto mb-2 max-w-3xl rounded-xl border border-border-subtle bg-surface p-3 shadow-1"
        role="dialog"
        aria-labelledby={titleId}
        data-assist-consent={job.kind}
      >
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-bold text-text-primary">
          <ShieldCheck className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          {t.consentTitle}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">{body}</p>
        {/* The privacy clause (plan §12.5), in a new tab so the conversation stays where it is. */}
        <a href={AI_POLICY_PATH} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block text-xs font-bold text-gold underline" data-assist-consent-policy>
          {t.consentPolicy}
        </a>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="lv-button lv-button-secondary min-h-10 px-3 text-xs"
            onClick={() => {
              onConsent(false);
              onCancel();
            }}
          >
            {t.consentDecline}
          </button>
          <button
            ref={acceptRef}
            type="button"
            className="lv-button lv-button-primary min-h-10 px-3 text-xs"
            onClick={() => {
              onConsent(true);
              void run();
            }}
          >
            {t.consentAccept}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-1 py-1.5" role="status" aria-live="polite" data-assist-reading={phase}>
      <Spinner size="sm" delayMs={0} decorative />
      <span className="text-xs text-text-secondary">{phase === 'frames' ? t.framesBusy : t.readingBusy}</span>
    </div>
  );
}
