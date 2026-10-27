/**
 * A PROVIDER ANSWER, READ WITH A SIZE CAP AND THE ATTEMPT'S DEADLINE.
 *
 * Why the studio has its own and does not import `worker/lib/fx/readCapped.ts`
 * (which does the same job for the rate providers): the FX module is a money
 * boundary. `tests/pricingCurrencyRoles.test.ts` lists every file allowed to
 * import from `worker/lib/fx/`, so that nothing outside the cron, the pricing
 * workspace and the named rate readers can reach a rate — and an advert
 * studio is none of those. Fifty lines of stream reading are cheaper than a
 * hole in that list.
 *
 * Same rules as the FX reader: a declared `content-length` over the cap is
 * refused before a byte is read; the body is read through `getReader()` and
 * cancelled the moment it passes the cap or the attempt's `AbortSignal`
 * fires (a provider that answers at once and then trickles its body would
 * otherwise hold the invocation); every failure is a CODE, never a message.
 */

export type ReadBodyResult = { ok: true; text: string } | { ok: false; code: 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK' };

export async function readBodyCapped(res: Response, maxBytes: number, signal?: AbortSignal): Promise<ReadBodyResult> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, code: 'TOO_LARGE' };
  }
  if (!res.body) return { ok: true, text: '' };
  const reader = res.body.getReader();
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
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
