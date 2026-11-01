/**
 * THE ESTIMATE READ ON THE RETURN AND TRADE-IN DOORS, ROUND 2 (docs/SMART_PRICING.md §6.9;
 * migration 0218; review items r2-paidnet-log and r2-tradein-ckb).
 *
 *   LOG       estimate records that cannot be read are logged with how many orders
 *             were asked for and the first five ids — never a figure or a customer's
 *             data — so a refusal on the refund, trade-in or claim door can be traced.
 *   TRADE-IN  the trade-in screens say an estimate refusal their doors answer in the
 *             contract's words in the reader's language: 503 PRICE_ESTIMATES_READ_FAILED from the real
 *             eligible door reads in ar, en and ckb, never the server's "ar / en".
 *             Every other refusal reads exactly as before.
 *
 * Run: node --import tsx --test tests/orderEstimatePolish.test.ts
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { asD1, get, json, stubApp } from './fixtures/app';
import { tradeInRoutes } from '../worker/routes/tradeIn';
import { estimateFactsOf } from '../worker/lib/paidNet';
import { CUSTOMER, restoreFetch, seed } from './sv2_tradein_fixture';
import { ApiError, failureText } from '../src/lib/api';
import { apiRefusal } from '../src/lib/refusalStrings';
import { LanguageProvider } from '../src/LanguageContext';
import { ESTIMATE_REFUSAL_COPY, tradeInRefusalText, useErrText } from '../src/components/tradeIn/parts';
import { copyText } from '../src/components/tradeIn/copy';
import { ESTIMATE_REFUSALS, type EstimateLang } from '../packages/contracts/src/priceEstimates';

test.after(restoreFetch);

const LANGS: readonly EstimateLang[] = ['ar', 'en', 'ckb'];
const READ_FAILED = ESTIMATE_REFUSALS.PRICE_ESTIMATES_READ_FAILED;
const LOCKED = 'D1_ERROR: database is locked';
const UNREADABLE = 'paid net: estimate records unreadable';

/** A database whose estimate records cannot be read (`message`); every other read is the real one. */
function refusingEstimates(inner: D1Database, message = LOCKED): D1Database {
  const refuse = async () => {
    throw new Error(message);
  };
  return {
    prepare: (sql: string) =>
      sql.includes('order_price_estimates')
        ? { bind: () => ({ all: refuse, first: refuse, run: refuse, raw: refuse }), all: refuse, first: refuse, run: refuse, raw: refuse }
        : inner.prepare(sql),
    batch: (s: D1PreparedStatement[]) => inner.batch(s),
    exec: (q: string) => inner.exec(q),
  } as unknown as D1Database;
}

/** The arguments of every unreadable-records log line `run` writes. */
async function unreadableLogs(run: () => Promise<unknown>): Promise<unknown[][]> {
  const error = mock.method(console, 'error', () => undefined);
  try {
    await run();
    return error.mock.calls.map((c) => c.arguments).filter((a) => a[0] === UNREADABLE);
  } finally {
    error.mock.restore();
  }
}

/** The 503 the real eligible door answers when the estimate records cannot be read. */
async function eligibleRefusal(): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = refusingEstimates(asD1(seed()));
  const res = await get(stubApp(db, CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes)), '/api/trade-in/eligible');
  return { status: res.status, body: (await json(res)) as Record<string, unknown> };
}

/** The error the client throws for that answer (src/lib/api.ts `request`). */
const clientError = (status: number, body: Record<string, unknown>) =>
  new ApiError(status, String(body.error ?? ''), body.code as string | undefined, body.details as Record<string, unknown> | undefined, body);

// =========================================================================
//  LOG
// =========================================================================

test('LOG: unreadable estimate records name how many orders were asked for and the first five ids — never a figure', async () => {
  const ids = ['ORD-1', 'ORD-2', 'ORD-3', 'ORD-4', 'ORD-5', 'ORD-6', 'ORD-7'];
  const nothingElse = {} as D1Database;
  let got: unknown;
  const logs = await unreadableLogs(async () => {
    got = await estimateFactsOf(refusingEstimates(nothingElse), [...ids, 'ORD-1', '']);
  });
  assert.equal(got, 'unreadable');
  // Seven distinct orders (the repeat and the empty id are not asked for), the first five named, and the reason.
  assert.deepEqual(logs, [[UNREADABLE, 7, ids.slice(0, 5), LOCKED]]);
  // A database without 0218 has no records: nothing to log, nothing refused.
  let none: unknown;
  const missing = await unreadableLogs(async () => {
    none = await estimateFactsOf(refusingEstimates(nothingElse, 'D1_ERROR: no such table: order_price_estimates: SQLITE_ERROR'), ids);
  });
  assert.ok(none instanceof Map && none.size === 0);
  assert.deepEqual(missing, []);
});

test('LOG: the trade-in door’s refusal is traceable to the customer’s order, and the line carries no amount or customer data', async () => {
  let refusal: { status: number; body: Record<string, unknown> } | undefined;
  const logs = await unreadableLogs(async () => {
    refusal = await eligibleRefusal();
  });
  assert.equal(refusal!.status, 503);
  assert.equal(refusal!.body.code, 'PRICE_ESTIMATES_READ_FAILED');
  // Sara's one delivered order (850,000 IQD, sara@x.co): its id only.
  assert.deepEqual(logs, [[UNREADABLE, 1, ['ORD-OLD'], LOCKED]]);
  const line = JSON.stringify(logs);
  for (const never of ['850000', '850,000', 'sara', 'سارة', 'cust']) assert.equal(line.includes(never), false, never);
});

// =========================================================================
//  TRADE-IN
// =========================================================================

test('TRADE-IN: PRICE_ESTIMATES_READ_FAILED from the real eligible door reads in the contract’s words, in ar, en and ckb', async () => {
  const { status, body } = await eligibleRefusal();
  assert.equal(status, 503);
  const e = clientError(status, body);
  // What the server sends is "ar / en": the old chain handed exactly that to a Sorani reader.
  assert.equal(e.message, `${READ_FAILED.ar} / ${READ_FAILED.en}`);
  assert.equal(apiRefusal(e, 'ckb') || failureText(e, 'x'), e.message, 'the shop’s table has no entry for it');
  for (const lang of LANGS) assert.equal(tradeInRefusalText(e, lang, copyText('genericError', lang)), READ_FAILED[lang], lang);
  const ckb = tradeInRefusalText(e, 'ckb', 'x');
  assert.notEqual(ckb, READ_FAILED.ar);
  assert.equal(ckb.includes(READ_FAILED.ar) || ckb.includes(READ_FAILED.en), false, 'no Arabic or English in the Sorani reading');
});

// The language provider reads `levo_lang` from localStorage when it mounts.
let LANG: EstimateLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};

/** What the screens' `useErrText()` says for `e`, rendered in `lang`. */
function screenSays(e: unknown, lang: EstimateLang, fallback?: string): string {
  LANG = lang;
  const Probe = () => createElement('p', null, useErrText()(e, fallback));
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(Probe) }))
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

test('TRADE-IN: the screens’ useErrText says every estimate refusal their doors answer in the reader’s language', async () => {
  const { status, body } = await eligibleRefusal();
  const e = clientError(status, body);
  for (const lang of LANGS) assert.equal(screenSays(e, lang), READ_FAILED[lang], `${lang}: the eligible list's refusal`);
  // Round 3: the screens carry a copy of the refusals their doors answer (tests/tradeInEstimateRefusal.test.ts),
  // never the whole contract; any other code of it reaches no trade-in screen and reads as before.
  for (const [code, words] of Object.entries(ESTIMATE_REFUSALS)) {
    const err = new ApiError(words.status, `${words.ar} / ${words.en}`, code);
    const copied = code in ESTIMATE_REFUSAL_COPY;
    for (const lang of LANGS) assert.equal(screenSays(err, lang), copied ? words[lang] : apiRefusal(err, lang) || failureText(err, 'x'), `${code}.${lang}`);
  }
});

test('TRADE-IN: every other refusal reads exactly as before — the shop’s table, then the server’s sentence, then the fallback', () => {
  const before = (e: unknown, lang: EstimateLang, fallback: string) => apiRefusal(e, lang) || failureText(e, fallback);
  const cases: unknown[] = [
    new ApiError(409, 'server words', 'TRADE_IN_DRAFT_LIMIT'),
    new ApiError(409, 'server words', 'TRADE_IN_NOT_ELIGIBLE'),
    new ApiError(409, 'a sentence the table does not own', 'SOME_OTHER_CODE'),
    new ApiError(500, '', 'SOME_OTHER_CODE'),
    new ApiError(0, 'cancelled', 'ABORTED'),
    new ApiError(0, 'network', 'NETWORK'),
    new Error('plain'),
    'PRICE_APPROVAL_PENDING',
    null,
  ];
  for (const e of cases) {
    for (const lang of LANGS) {
      const fallback = copyText('genericError', lang);
      assert.equal(tradeInRefusalText(e, lang, fallback), before(e, lang, fallback), `${String((e as { code?: unknown })?.code ?? e)}.${lang}`);
      assert.equal(screenSays(e, lang), before(e, lang, fallback), `the screen: ${String((e as { code?: unknown })?.code ?? e)}.${lang}`);
    }
  }
  // A fallback the screen names still stands for a refusal without words.
  assert.equal(screenSays(new ApiError(0, 'x', 'ABORTED'), 'en', 'Could not load'), before(new ApiError(0, 'x', 'ABORTED'), 'en', 'Could not load'));
  // The table's own sentence for a trade-in code is never replaced.
  assert.equal(tradeInRefusalText(new ApiError(409, 'server words', 'TRADE_IN_DRAFT_LIMIT'), 'ckb', 'x'), apiRefusal({ code: 'TRADE_IN_DRAFT_LIMIT' }, 'ckb'));
});
