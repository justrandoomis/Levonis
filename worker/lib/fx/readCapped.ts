/**
 * A RESPONSE BODY, READ WITH A SIZE CAP AND THE RUN'S DEADLINE (FX programme
 * plan §6, critique F5).
 *
 * `fetchWithBudget`'s timeout covers the HEADERS only and never aborts, so a
 * provider that answers at once and then trickles its body would hold the
 * invocation. The scheduler's single `AbortSignal` (12 seconds for connect,
 * body and retry together) is passed here as well: the body is read through
 * `getReader()`, refused before reading when `content-length` is over the cap,
 * and the reader is cancelled on overflow (`TOO_LARGE`) or abort (`TIMEOUT`).
 * The answer is a code, never a message.
 */

export type ReadCappedResult = { ok: true; text: string } | { ok: false; code: 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK' };

export async function readCapped(res: Response, maxBytes: number, signal?: AbortSignal): Promise<ReadCappedResult> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* the body is abandoned either way */
    }
    return { ok: false, code: 'TOO_LARGE' };
  }
  if (!res.body) return { ok: true, text: '' };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for (;;) {
      if (aborted) return { ok: false, code: 'TIMEOUT' };
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        return { ok: false, code: aborted || signal?.aborted ? 'TIMEOUT' : 'NETWORK' };
      }
      if (aborted || signal?.aborted) return { ok: false, code: 'TIMEOUT' };
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: 'TOO_LARGE' };
      }
      chunks.push(step.value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}
