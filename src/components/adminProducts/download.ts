/**
 * Authenticated attachment download that actually saves a file on iPad Safari
 * (mandate §6.1).
 *
 * WHY NOT a plain `<a href="/api/…" download>`: the endpoint is admin-gated
 * and answers errors as JSON. A bare anchor navigation cannot see the status,
 * so an expired session, a 403 or a 500 is saved to the device AS THE
 * TEMPLATE — a file full of `{"success":false,…}` that looks like a
 * successful download until the admin opens it. "A 200 containing index.html
 * is not a successful template download" cuts the same way.
 *
 * THE PATTERN USED HERE (blob + revoke-after-click):
 *  1. `fetch(..., { credentials: 'same-origin' })` — the session cookie is
 *     SameSite=Lax, so a same-origin fetch carries it exactly like a
 *     navigation would.
 *  2. Verify the response BEFORE writing anything to disk: non-2xx, an
 *     HTML body, or a JSON body are all download FAILURES with a specific
 *     message, never a saved file.
 *  3. Take the filename from `Content-Disposition` (RFC 5987 `filename*`
 *     first, then the ASCII `filename`), sanitized, with a caller fallback —
 *     the extension is forced to .txt so iOS does not save "download" with no
 *     type and refuse to open it.
 *  4. Build the Blob with an explicit `text/plain;charset=utf-8` type, click
 *     an anchor that is actually IN the document (WebKit ignores clicks on
 *     detached anchors), and revoke the object URL only LONG AFTER the click.
 *     Revoking in the same tick — the classic bug — cancels the save on
 *     Safari, which reads the blob asynchronously.
 *  5. If the browser has no `download` support at all, fall back to a direct
 *     authenticated navigation to the same URL; the server's
 *     `Content-Disposition: attachment` then does the work.
 *
 * Nothing here reports success unless the click actually happened. Whether
 * the human then picks a folder in the Files app is not observable from the
 * page, so the UI says "the download has started", never "saved".
 */

export type DownloadMethod = 'blob' | 'navigation';

export interface DownloadOutcome {
  filename: string;
  /** UTF-8 byte size of the file that was handed to the browser. */
  bytes: number;
  method: DownloadMethod;
}

export class DownloadError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'DownloadError';
  }
}

const MSG = {
  network: 'تعذّر الوصول إلى الخادم — تحقق من الاتصال ثم أعد المحاولة / network error, nothing was downloaded',
  unauthorized: 'انتهت الجلسة — سجّل الدخول كمشرف ثم أعد المحاولة / session expired, sign in as an administrator',
  forbidden: 'هذا التنزيل للمشرفين فقط / administrator access required',
  rateLimited: 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة / too many requests',
  notFile: 'الخادم أعاد صفحة بدل ملف القالب — لم يُحفظ شيء / the server returned a page, not the template file',
  empty: 'الملف الذي أعاده الخادم فارغ — لم يُحفظ شيء / the server returned an empty file',
};

/** RFC 5987 `filename*` wins over the ASCII `filename`; both are sanitized.
 *  `ext` is the extension the saved file is forced to carry — iOS refuses to
 *  open a file it cannot type, so a CSV must land as .csv and a ZIP as .zip. */
export function filenameFromDisposition(header: string | null, fallback: string, ext = 'txt'): string {
  let name = '';
  if (header) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) {
      try {
        name = decodeURIComponent(star[1].trim());
      } catch {
        name = '';
      }
    }
    if (!name) {
      const plain = /filename\s*=\s*"([^"]+)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
      if (plain) name = plain[1].trim();
    }
  }
  // Strip any path component and the characters iOS/Windows refuse in a
  // filename (control chars and \ / : * ? " < > |). Letters, digits, dots,
  // dashes and Arabic characters all survive.
  const base = (name || fallback).split(/[\\/]/).pop() ?? fallback;
  // eslint-disable-next-line no-control-regex -- stripping control characters IS the point here
  const safe = base.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '').replace(/^\.+/, '').trim() || fallback;
  return safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`;
}

function supportsDownloadAttribute(): boolean {
  try {
    return 'download' in document.createElement('a');
  } catch {
    return false;
  }
}

/** Reads a failed response's JSON `error` without ever saving it as a file. */
async function errorMessageFor(res: Response): Promise<string> {
  if (res.status === 401) return MSG.unauthorized;
  if (res.status === 403) return MSG.forbidden;
  if (res.status === 429) return MSG.rateLimited;
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    /* not JSON — fall through to the generic message */
  }
  return `تعذّر التنزيل (${res.status}) — لم يُحفظ شيء / download failed (${res.status})`;
}

/**
 * Downloads a same-origin admin attachment of ANY type — TXT, CSV or ZIP.
 *
 * The verification is identical for all three because the failure mode is:
 * an admin-gated endpoint answering an error as JSON or as the SPA shell,
 * saved to the device as though it were the file. Reading the body as bytes
 * rather than text is what lets the same code path serve a ZIP.
 */
export async function downloadAdminFile(
  path: string,
  fallbackName: string,
  opts: { accept?: string; ext?: string; type?: string } = {}
): Promise<DownloadOutcome> {
  const ext = opts.ext ?? 'txt';
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: opts.accept ?? 'text/plain' },
      cache: 'no-store',
    });
  } catch {
    throw new DownloadError(MSG.network);
  }

  if (!res.ok) throw new DownloadError(await errorMessageFor(res), res.status);

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    // A 200 that is the SPA shell or a JSON envelope is a failed download.
    throw new DownloadError(MSG.notFile, res.status);
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) throw new DownloadError(MSG.empty, res.status);
  // A text file of nothing but whitespace is empty too; a ZIP is never text.
  const isText = contentType.startsWith('text/');
  if (isText && !new TextDecoder().decode(buffer).trim()) {
    throw new DownloadError(MSG.empty, res.status);
  }

  const filename = filenameFromDisposition(res.headers.get('content-disposition'), fallbackName, ext);
  const bytes = buffer.byteLength;

  if (!supportsDownloadAttribute()) {
    // Direct authenticated navigation: the cookie is SameSite=Lax so it rides
    // along, and the server's Content-Disposition drives the save.
    window.location.href = path;
    return { filename, bytes, method: 'navigation' };
  }

  const blob = new Blob([buffer], { type: opts.type ?? 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  // WebKit ignores clicks on anchors that are not in the document.
  document.body.appendChild(a);
  a.click();

  // Revoke LATE: Safari reads the blob after the click returns, so revoking
  // now (or on the next tick) cancels the save. The anchor is removed first;
  // the URL is released a minute later, once the transfer has certainly begun.
  window.setTimeout(() => { a.remove(); }, 1_000);
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);

  return { filename, bytes, method: 'blob' };
}

/** The TXT case, unchanged for the legacy template tools. */
export function downloadAdminTextFile(path: string, fallbackName: string): Promise<DownloadOutcome> {
  return downloadAdminFile(path, fallbackName, {
    accept: 'text/plain',
    ext: 'txt',
    type: 'text/plain;charset=utf-8',
  });
}
