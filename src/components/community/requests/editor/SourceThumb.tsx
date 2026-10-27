/**
 * THE LEADING SQUARE OF A SOURCE (plan P1-06, acceptance 13; Community V3 R4):
 * a picture is the picture — from its device preview (`blob:`) while it is
 * on its way, from its authorised route as a sized copy (`?w=`) once stored —
 * and a model, a document, a link or a written reference is its glyph. Never
 * an id, never a key.
 */
import { Box, FileText, Link2, Quote } from 'lucide-react';
import { RequestThumb } from '../RequestFileThumbs';

export type ThumbKind = 'model' | 'image' | 'document' | 'link' | 'text';

export function SourceThumb({ kind, url, preview, size = 44, alt = '' }: { kind: ThumbKind; url?: string | null; preview?: string | null; size?: number; alt?: string }) {
  if (preview) {
    return (
      <img
        src={preview}
        alt={alt}
        data-editor-thumb="pending"
        width={size}
        height={size}
        className="shrink-0 rounded-md bg-surface-raised object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  if (url && kind === 'image') {
    return (
      <span data-editor-thumb="stored" className="shrink-0">
        <RequestThumb url={url} size={size} alt={alt} />
      </span>
    );
  }
  const Icon = kind === 'model' ? Box : kind === 'link' ? Link2 : kind === 'text' ? Quote : FileText;
  return (
    <span
      aria-hidden="true"
      data-editor-thumb="glyph"
      className="flex shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-muted"
      style={{ width: size, height: size }}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

/**
 * A long file name cut in the MIDDLE, so the end that says what it is
 * («….stl», «….step») stays on screen at 360 px.
 */
export function middleTruncate(name: string, max = 28): string {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  const dot = s.lastIndexOf('.');
  const tail = dot > 0 && s.length - dot <= 8 ? s.slice(dot - 4) : s.slice(-8);
  const head = s.slice(0, Math.max(1, max - tail.length - 1));
  return `${head}…${tail}`;
}

/** A link as a reader recognises it: its host and the start of its path. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.host.replace(/^www\./, '')}${path ? middleTruncate(path, 24) : ''}`;
  } catch {
    return middleTruncate(url, 40);
  }
}
