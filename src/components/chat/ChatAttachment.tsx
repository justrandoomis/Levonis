/**
 * ONE ATTACHMENT, DRAWN BY WHAT IT IS.
 *
 * `GET /api/chats/:id/messages` returns each message's real kind — `image`,
 * `video`, `audio` or `file` (worker/routes/chats.ts `chatMessagePublic`) — and
 * this is the one place both chat screens turn that into markup, so a voice
 * note the customer sends from /chats is the same playable thing in the admin's
 * order panel and back.
 *
 *  image  a picture that opens full size on tap (a serial number or a damaged
 *         corner cannot be read off a bubble-sized thumbnail)
 *  video  the platform's player, `playsInline` so iOS does not hijack the screen
 *  audio  the platform's player — play, scrub, speed — which every reader
 *         already knows how to use
 *  file   a named link that opens the document in a new tab
 *
 * `referrerPolicy="no-referrer"` everywhere, as the image bubble always had:
 * the file URL is on this origin, and nothing about the conversation needs to
 * travel in a Referer header.
 */
import { FileText } from 'lucide-react';

export type ChatAttachmentKind = 'image' | 'video' | 'audio' | 'file';

export function isAttachmentKind(kind: unknown): kind is ChatAttachmentKind {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'file';
}

/** What a picked or recorded file will be once the server has sniffed it —
 *  for the optimistic bubble only; the server's answer replaces it. */
export function attachmentKindOfFile(file: { type?: string; name?: string }): ChatAttachmentKind {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * WHY AN ATTACHMENT DID NOT GO, in the words that explain it. The server's
 * refusal (`ApiError`) and the browser-side size check (`prepareUploadImage`:
 * «الملف 12.0 MB — الحد 10.0 MB / file exceeds the limit») both name the
 * problem; only a network failure (`TypeError: Failed to fetch`) or a
 * messageless error falls back to the generic sentence.
 */
export function attachmentErrorText(err: unknown, fallback: string): string {
  if (err instanceof Error && !(err instanceof TypeError) && err.message) return err.message;
  return fallback;
}

/** What the file picker offers. The server admits exactly these by magic
 *  bytes (worker/routes/uploads.ts `sniffChat`); the list only saves a person
 *  from picking something that would be refused. */
export const CHAT_FILE_ACCEPT = 'image/*,video/mp4,video/webm,audio/*,application/pdf,.pdf,.m4a,.mp3,.ogg,.webm';

export default function ChatAttachment({
  kind,
  url,
  loc,
  className = '',
}: {
  kind: ChatAttachmentKind;
  url: string;
  loc: (ar: string, en: string, ckb?: string) => string;
  className?: string;
}) {
  if (kind === 'audio') {
    return (
      <audio
        controls
        preload="metadata"
        src={url}
        data-chat-audio
        className={`block w-64 max-w-full ${className}`}
        aria-label={loc('رسالة صوتية', 'Voice message')}
      />
    );
  }
  if (kind === 'video') {
    return (
      <video
        controls
        playsInline
        preload="metadata"
        src={url}
        data-chat-video
        className={`block max-w-full max-h-[300px] rounded-lg ${className}`}
      />
    );
  }
  if (kind === 'file') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        data-chat-file
        className={`inline-flex min-h-11 items-center gap-2 underline underline-offset-2 ${className}`}
      >
        <FileText className="h-4 w-4 shrink-0" aria-hidden />
        {loc('فتح الملف المرفق', 'Open the attached file')}
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" data-chat-image>
      <img
        src={url}
        alt={loc('صورة مرفقة', 'Attached image')}
        className={`block rounded-lg max-w-full ${className}`}
        referrerPolicy="no-referrer"
      />
    </a>
  );
}
