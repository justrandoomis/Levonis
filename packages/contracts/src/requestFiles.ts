/**
 * WHAT A PRINT REQUEST MAY CARRY — ONE TABLE FOR EVERY DOOR (Community V3
 * R5, docs/DECISIONS.md row 265).
 *
 * A file reaches a request through three doors: the browser (the wizard and
 * the request page check before a byte leaves the device), the whole-body
 * route (`POST /api/marketplace/requests/:id/files`) and the resumable
 * session (`POST /api/uploads/sessions` with `purpose: 'request'`). Each one
 * used to carry its own numbers: a 30 MB photo was refused on the request
 * page and accepted by the wizard, an AVIF went through one door and not the
 * other. Every door now reads THIS module, so the same file gets the same
 * answer wherever it is sent.
 *
 *   count      six files on a request, asked when a session opens, when it
 *              completes and where the row is written (worker/lib/
 *              requestFileRoom.ts, DECISIONS row 258);
 *   kinds      a picture, a 3D model or a PDF drawing, by extension here and
 *              by the bytes on the server (a name is a claim, not a fact);
 *   sizes      per kind, the same on every door.
 *
 * THE WHOLE-BODY DOOR HOLDS A FILE IN MEMORY, so it also has a transport
 * ceiling (`wholeBodyMaxBytes`, the platform figure of worker/routes/
 * uploads.ts `SIMPLE_UPLOAD_HARD_CAP`). It is not a limit on what a request
 * accepts: the browser sends anything larger, and every model, through the
 * resumable session (src/lib/uploadSession.ts `pickUpload`), where the
 * per-kind sizes below are the only ceiling.
 *
 * No imports, no strings: the browser bundles this file as it is.
 */

const MiB = 1024 * 1024;

/** The three kinds a request file can be. `image` is stored as kind `reference`. */
export type RequestFileKind = 'image' | 'model' | 'document';

export const REQUEST_FILE_LIMITS = {
  /** Attachments on one request, counted on every door. */
  maxFiles: 6,
  /** The largest file of each kind, on every door. */
  maxBytes: { image: 25 * MiB, model: 300 * MiB, document: 25 * MiB } as Readonly<Record<RequestFileKind, number>>,
  /** The whole-body route reads a file into memory: above this a file takes the resumable session. */
  wholeBodyMaxBytes: 40 * MiB,
} as const;

/** The extensions of each kind, lower case. `jpeg` and `stp` are spellings of `jpg` and `step`. */
export const REQUEST_FILE_EXTENSIONS: Readonly<Record<RequestFileKind, readonly string[]>> = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'],
  model: ['stl', '3mf', 'obj', 'amf', 'glb', 'gltf', 'step', 'stp'],
  document: ['pdf'],
};

/** The lower-case extension of a file name, or an empty string. */
export function requestFileExtension(name: string): string {
  const n = String(name ?? '').toLowerCase().trim();
  const dot = n.lastIndexOf('.');
  return dot > 0 && dot < n.length - 1 ? n.slice(dot + 1) : '';
}

/** What a file name says it is, or null when a request does not take that extension. */
export function requestFileKind(name: string): RequestFileKind | null {
  const ext = requestFileExtension(name);
  if (!ext) return null;
  for (const kind of ['image', 'model', 'document'] as const) {
    if (REQUEST_FILE_EXTENSIONS[kind].includes(ext)) return kind;
  }
  return null;
}

/** The ceiling for one kind, in bytes. */
export function requestFileMaxBytes(kind: RequestFileKind): number {
  return REQUEST_FILE_LIMITS.maxBytes[kind];
}

/** The `accept` attribute of a file input that takes these kinds. */
export function requestFileAccept(kinds: readonly RequestFileKind[] = ['image', 'model', 'document']): string {
  return kinds.flatMap((k) => REQUEST_FILE_EXTENSIONS[k].map((e) => `.${e}`)).join(',');
}

/**
 * Why a file cannot go on a request, in the codes the server answers with:
 * `UPLOAD_KIND_NOT_ALLOWED` (an extension a request does not take),
 * `UPLOAD_TOO_LARGE` (over its kind's ceiling) and `REQUEST_FILES_FULL` (no
 * room left). Null when it may go. The browser asks this before uploading;
 * the server asks the same table, and the bytes, again.
 */
export type RequestFileProblem =
  | { code: 'UPLOAD_KIND_NOT_ALLOWED'; extension: string }
  | { code: 'UPLOAD_TOO_LARGE'; kind: RequestFileKind; limit_bytes: number }
  | { code: 'REQUEST_FILES_FULL'; max_files: number };

export function requestFileProblem(file: { name: string; size: number }, filesAlready = 0): RequestFileProblem | null {
  if (filesAlready >= REQUEST_FILE_LIMITS.maxFiles) return { code: 'REQUEST_FILES_FULL', max_files: REQUEST_FILE_LIMITS.maxFiles };
  const kind = requestFileKind(file.name);
  if (!kind) return { code: 'UPLOAD_KIND_NOT_ALLOWED', extension: requestFileExtension(file.name) };
  const limit = requestFileMaxBytes(kind);
  if (file.size > limit) return { code: 'UPLOAD_TOO_LARGE', kind, limit_bytes: limit };
  return null;
}
