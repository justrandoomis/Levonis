import { useRef, useState, type ChangeEvent } from 'react';
import { Camera, Image as ImageIcon, Mic, Square, X } from 'lucide-react';
import { ApiError, uploadFile } from '../../lib/api';
import { formatElapsed, useVoiceRecorder } from '../../lib/voiceRecorder';

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
 *     with `capture` asks the phone to record instead.
 *
 * Every file goes to `/api/uploads` with purpose `assist`: private, under the
 * uploader, with the server sniffing the bytes and holding the size limits.
 * Nothing is analysed (no AI in this push); the file waits in the chat and
 * goes to the team with the ticket «تحدث مع الفريق» opens.
 */

export interface AssistAttachment {
  key: string;
  /** `/files/<key>`, as the server composed it. */
  url: string;
  kind: 'image' | 'video' | 'audio';
  mime?: string;
}

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
  },
};

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
  onAttached: (attachment: AssistAttachment) => void;
  onClose: () => void;
}) {
  const t = COPY[(lang as Lang) in COPY ? (lang as Lang) : 'ar'];
  const voice = useVoiceRecorder();
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
        onAttached({ key: up.key, url: up.url, kind: kindOf(mime), mime });
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
  const voiceError = voice.error === 'denied' ? t.micDenied : voice.error === 'failed' ? t.micFailed : '';
  const full = remaining <= 0;
  const row = 'lv-button lv-button-ghost min-h-11 w-full justify-start gap-3 px-3 text-start text-sm text-text-primary';

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
          <span className="tabular-nums text-sm text-text-secondary" dir="ltr">
            {formatElapsed(voice.elapsed, lang === 'en')}
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
