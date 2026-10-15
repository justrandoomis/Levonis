/**
 * One photograph of a trade-in, uploaded with a progress figure (XHR: fetch has no upload
 * progress, and a photo on a slow line needs one). The customer's door (`/api/trade-in/…`) and the
 * desk's intake door (`/api/admin/trade-in/…`) take the same multipart form; the server sniffs the
 * bytes, converts to WebP and files it privately (worker/routes/tradeIn.ts `storePhoto`).
 */
import { ApiError } from '../../lib/api';
import type { PhotoView } from './model';

export interface PhotoFields {
  component: 'device' | 'ams';
  /** The angle (customer) — `screen_hours`, `damage`, or a required angle; the desk sends none. */
  angle?: string;
  /** What it proves: `hours`, or a ticked fault id. */
  proves?: string;
}

export function uploadTradeInPhoto(url: string, file: File, fields: PhotoFields, onProgress: (fraction: number) => void): Promise<PhotoView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.photo) resolve(data.photo as PhotoView);
      else
        reject(
          new ApiError(
            xhr.status,
            String(data.error || 'Upload failed'),
            typeof data.code === 'string' ? data.code : undefined,
            data.details as Record<string, unknown> | undefined
          )
        );
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error', 'NETWORK'));
    const fd = new FormData();
    fd.set('file', file);
    fd.set('component', fields.component);
    if (fields.angle) fd.set('angle', fields.angle);
    if (fields.proves) fd.set('proves', fields.proves);
    fd.set('originalName', file.name.slice(0, 200));
    xhr.send(fd);
  });
}
