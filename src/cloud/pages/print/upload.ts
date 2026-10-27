/**
 * POST /files WITH A REAL PROGRESS FIGURE.
 *
 * `uploadFile` (src/cloud/api.ts) posts through the house client, which is
 * `fetch` — and fetch reports nothing while a body is being sent. A 30 MB
 * model on Iraqi mobile data is minutes of silence. This is the same door
 * (multipart, field `file`, the session cookie) through `XMLHttpRequest`,
 * whose `upload.onprogress` counts the bytes actually sent — the house's own
 * way for a photo of a trade-in (src/components/tradeIn/photoUpload.ts).
 *
 * The figure is the browser's count of bytes SENT, never a guess: no
 * `lengthComputable`, no bar. A refusal becomes the house `ApiError` with the
 * server's code and `details` (its three-language `messages`, `max_bytes`,
 * `reason`), so `cloudErrorText` words it as everywhere else; a dropped line,
 * a deadline and a cancel are the house client's own errors and sentences.
 */
import { ApiError } from '../../../lib/api';
import { requestErrorText } from '../../../lib/requestErrorText';
import { CLOUD_API } from '../../api';
import type { FileUploaded } from '../../types';

export interface UploadProgress {
  sent: number;
  total: number;
}

export interface UploadHandle {
  done: Promise<FileUploaded>;
  /** Stops the transfer; `done` rejects with the house `ABORTED` error. */
  abort: () => void;
}

/** Long enough for a large model on a slow line; a dead line still ends. */
const UPLOAD_DEADLINE_MS = 10 * 60 * 1000;

export function uploadModelFile(file: File, onProgress: (p: UploadProgress) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  let aborted = false;
  const done = new Promise<FileUploaded>((resolve, reject) => {
    xhr.open('POST', `${CLOUD_API}/files`);
    xhr.withCredentials = true;
    xhr.timeout = UPLOAD_DEADLINE_MS;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress({ sent: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      let body: { success?: boolean; data?: FileUploaded; error?: string; code?: string; details?: Record<string, unknown> } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.success !== false && body.data?.file_id) {
        resolve(body.data);
        return;
      }
      const message = (xhr.status >= 500 && !body.code ? '' : body.error) || requestErrorText('server', xhr.status);
      reject(new ApiError(xhr.status, message, body.code, body.details, body as Record<string, unknown>));
    };
    xhr.onerror = () => reject(new ApiError(0, requestErrorText('network'), 'NETWORK'));
    xhr.ontimeout = () => reject(new ApiError(0, requestErrorText('timeout'), 'TIMEOUT'));
    xhr.onabort = () => reject(new ApiError(0, requestErrorText('cancelled'), aborted ? 'ABORTED' : 'NETWORK'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
  return {
    done,
    abort: () => {
      aborted = true;
      xhr.abort();
    },
  };
}
