/**
 * The one JSON helper the pricing engine needs. A copy of `safeParse` from
 * `worker/lib/types.ts` (the core keeps its own): the pure package may not
 * import the core, and the resolver only ever needs "parse or fall back".
 */
export function safeParse<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
