/**
 * «بصمة صوتية» — A VOICE NOTE, RECORDED IN THE BROWSER.
 *
 * One hook for both chat screens (the admin's order panel and the customer's
 * /chats page), so the two cannot disagree about what a voice note IS: the same
 * container choice, the same file name, the same answer to "the microphone was
 * refused".
 *
 * THE CONTAINER IS CHOSEN FOR THE LISTENER, NOT ONLY FOR THE RECORDER. Safari
 * (the owner's iPad, DECISIONS row 56) records MP4/AAC and plays WebM Opus
 * unreliably; Chrome and Firefox record WebM/Ogg Opus and play MP4/AAC fine.
 * So MP4 with AAC is taken whenever the browser can record it — it is the one
 * format every participant's browser plays — and WebM/Ogg only where it cannot.
 * `worker/routes/uploads.ts` (`sniffChat`) admits all of them by magic bytes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Most-playable first. See the header. */
export const RECORDER_MIME_PREFERENCE = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

/** The first container this browser can record, or '' to let it choose. */
export function pickRecorderMime(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of RECORDER_MIME_PREFERENCE) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      /* a browser that throws on the question cannot record that type */
    }
  }
  return '';
}

/** `audio/mp4;codecs=…` → `audio/mp4`, the type the upload is labelled with. */
export function baseMime(mime: string): string {
  return (mime.split(';')[0] || '').trim().toLowerCase() || 'audio/webm';
}

/** A file name whose extension matches the bytes — the server ignores it, a
 *  person saving the file does not. */
export function voiceFileName(mime: string, now = Date.now()): string {
  const base = baseMime(mime);
  const ext = base === 'audio/mp4' ? 'm4a' : base === 'audio/ogg' ? 'ogg' : base === 'audio/mpeg' ? 'mp3' : 'webm';
  return `voice-${now}.${ext}`;
}

/** «١:٠٥» / «1:05» — minutes and seconds of the recording in progress. */
export function formatElapsed(seconds: number, latinDigits = true): string {
  const s = Math.max(0, Math.floor(seconds));
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  // Arabic and Sorani read Arabic-Indic digits, as every count on both chat
  // screens does; only English keeps 0-9.
  return latinDigits ? text : text.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

export type VoiceRecorderError = 'denied' | 'failed' | null;

export interface VoiceRecorder {
  /** False where there is no MediaRecorder or no microphone API at all — the
   *  screen then draws NO microphone rather than one that fails on tap. */
  supported: boolean;
  recording: boolean;
  /** Whole seconds since the recording started. */
  elapsed: number;
  error: VoiceRecorderError;
  start: () => Promise<boolean>;
  /** Stops and hands back the recording (null when it was empty). */
  stop: () => Promise<File | null>;
  /** Stops and throws the recording away. */
  cancel: () => void;
}

function recorderSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function useVoiceRecorder(): VoiceRecorder {
  const [supported] = useState(recorderSupported);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<VoiceRecorderError>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const discardRef = useRef(false);
  const settleRef = useRef<((file: File | null) => void) | null>(null);

  /** The microphone light goes OFF the moment we are done — a tab that keeps
   *  the red dot after "send" reads as a tab still listening. */
  const release = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    setElapsed(0);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (!supported || recorderRef.current) return false;
    setError(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const type = baseMime(rec.mimeType || mime);
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        const file = discardRef.current || blob.size === 0 ? null : new File([blob], voiceFileName(type), { type });
        release();
        settleRef.current?.(file);
        settleRef.current = null;
      };
      recorderRef.current = rec;
      streamRef.current = stream;
      rec.start();
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
      setRecording(true);
      return true;
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
      release();
      return false;
    }
  }, [supported, release]);

  const stop = useCallback(
    () =>
      new Promise<File | null>((resolve) => {
        const rec = recorderRef.current;
        if (!rec || rec.state === 'inactive') {
          resolve(null);
          return;
        }
        settleRef.current = resolve;
        rec.stop();
      }),
    []
  );

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    discardRef.current = true;
    if (rec.state !== 'inactive') rec.stop();
    else release();
  }, [release]);

  // Leaving the screen mid-recording discards it and frees the microphone.
  useEffect(
    () => () => {
      discardRef.current = true;
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') rec.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    []
  );

  return { supported, recording, elapsed, error, start, stop, cancel };
}
