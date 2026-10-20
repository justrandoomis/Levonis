/**
 * A REQUEST'S PICTURES AS PICTURES (Community V3 R4 and R12) — never a file
 * id, never a storage key.
 *
 * A stored picture is read through its authorised route
 * (`/api/marketplace/requests/:id/files/:fileId`), which re-derives the
 * reader on every read; `?w=` asks that same route for a sized copy, so a
 * 64 px thumbnail downloads a 160 px picture rather than the phone original
 * (worker/lib/imageVariants.ts `requestImageRendition`). A picture still on
 * the device is drawn from its object URL (`blob:`), which the wizard
 * revokes when the picture leaves the list or the wizard closes.
 *
 * No strings of its own: the caller names the list.
 */
import type { ReactNode } from 'react';

/** The widths a thumbnail asks the route for (a subset of packages/contracts/src/imageSizing.ts). */
const THUMB_WIDTHS = [160, 320, 640] as const;

/** One sized copy of a stored request picture; a `blob:` or any other source is returned as it is. */
export function requestImageSrc(url: string, width: (typeof THUMB_WIDTHS)[number]): string {
  if (!url.startsWith('/api/marketplace/requests/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}w=${width}`;
}

/** The srcset of a stored request picture, so a phone with a dense screen still gets a sharp thumbnail. */
export function requestImageSrcSet(url: string): string | undefined {
  if (!url.startsWith('/api/marketplace/requests/')) return undefined;
  return THUMB_WIDTHS.map((w) => `${requestImageSrc(url, w)} ${w}w`).join(', ');
}

export interface ThumbFile {
  id: string;
  url?: string | null;
  inline?: boolean;
  file_name?: string;
}

/** Only the pictures a reader may open: inline, with a route. */
export function pictureFiles<T extends ThumbFile>(files: readonly T[]): Array<T & { url: string }> {
  return files.filter((f): f is T & { url: string } => !!f.inline && typeof f.url === 'string' && f.url.length > 0);
}

/** One square thumbnail. */
export function RequestThumb({ url, size = 64, alt = '', className = '' }: { url: string; size?: number; alt?: string; className?: string }) {
  return (
    <img
      src={requestImageSrc(url, 160)}
      srcSet={requestImageSrcSet(url)}
      sizes={`${size}px`}
      alt={alt}
      loading="lazy"
      decoding="async"
      width={size}
      height={size}
      data-request-thumb
      className={`shrink-0 rounded-md bg-surface-raised object-cover ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The pictures of a request as a row of thumbnails, each opening the picture
 * itself in a new tab. Renders nothing when there is no picture to show.
 */
export function RequestImageStrip({ files, label, size = 64, extra }: { files: readonly ThumbFile[]; label: string; size?: number; extra?: ReactNode }) {
  const pictures = pictureFiles(files);
  if (!pictures.length && !extra) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2" data-request-images>
      {pictures.map((f) => (
        <li key={f.id}>
          <a
            href={f.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            aria-label={f.file_name || label}
          >
            <RequestThumb url={f.url} size={size} />
          </a>
        </li>
      ))}
      {extra}
    </ul>
  );
}
