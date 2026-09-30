/**
 * THE HASHING WORKER. A 300 MB model hashed on the main thread freezes the
 * composer for seconds on a phone; here it runs beside it, slice by slice,
 * and reports progress so the tile can name the step («التحقق من الملف…»).
 *
 * Messages in:  { id, file: Blob }
 * Messages out: { id, type: 'progress', loaded } · { id, type: 'done', hex } ·
 *               { id, type: 'error', message }
 *
 * Loaded by src/lib/uploadSession.ts through `new Worker(new URL(...))`; when
 * `Worker` is unavailable (the unit tests) the same `sha256OfBlob` runs inline.
 */
import { sha256OfBlob } from './sha256core';

export type HashWorkerMessage =
  | { id: number; type: 'progress'; loaded: number }
  | { id: number; type: 'done'; hex: string }
  | { id: number; type: 'error'; message: string };

const scope = self as unknown as { postMessage(message: HashWorkerMessage): void; addEventListener(type: 'message', fn: (e: MessageEvent) => void): void };

scope.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { id?: unknown; file?: unknown } | null;
  const id = typeof data?.id === 'number' ? data.id : 0;
  const file = data?.file;
  if (!(file instanceof Blob)) {
    scope.postMessage({ id, type: 'error', message: 'hash worker: no file' });
    return;
  }
  sha256OfBlob(file, (loaded) => scope.postMessage({ id, type: 'progress', loaded }))
    .then((hex) => scope.postMessage({ id, type: 'done', hex }))
    .catch((error: unknown) => scope.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) }));
});
