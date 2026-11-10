/**
 * REWARDS POLICY v8 AND FAQ v8 AS A CUSTOMER READS THEM, NOT AS THEY ARE WRITTEN (the lead's L6 and L7,
 * then M1 and M2, 2026-11-10; DECISIONS row 303).
 *
 * worker/lib/policies/render.ts withholds every line that still names an unknown `{{TOKEN}}`, and
 * then every line of the same document that cites, by article number, an article so withheld.
 * Article 7.6 states the base value of review points as {{REVIEW_BASE_POINTS}}: the owner's setting,
 * with no value in worker/lib/policies/facts.ts, so 7.6 is withheld, exactly as on live. Round 3
 * reworded 7.8 for R4 to cite «المادتين 7.5 و7.6» / "articles 7.5 and 7.6", and the render pass took
 * the whole of 7.8 with it, heading and all: R4's sentence and L2's never reached a customer, the
 * archive or the consent hash, while every test that read the SOURCE module stayed green. 7.8 now
 * cites article 7.5 alone, and 7.6 stays withheld until the owner gives the value.
 *
 * WHOLE ARTICLES WERE NOT ENOUGH (M1). Round 4 made one bullet of 7.3 cite 7.6 and refreshed the
 * hashes: the page lost that bullet, and the forty-megabyte limit in it, while every policy test
 * stayed green, because 7.3 kept its heading and three lines and the guard compared headings only.
 * So the guard compares LINES now: the source through the real facts and render passes, line by line
 * against what the route serves, and the lines it drops must be exactly the list below, in reading
 * order. Counted from the code, rewards v8 drops 8 lines in each language: the headings of 1.2, 7.6,
 * 13.6 and 16.6 and, under each, the one line that still names an unknown. Round 4 counted 9 because
 * it compared the raw source: the governing-law line of 16.5 is not withheld. facts.ts fills both of
 * its tokens and the line is published filled, which this file holds too. FAQ v8 takes the same road
 * through ./index.ts, so its 14 withheld lines (seven questions and their answers) are pinned the
 * same way.
 *
 * WHAT FAQ 12.11 DID NOT SAY (M2). «لماذا حصلت على نقاط مراجعة ولم أحصل على هدية؟» Since R4 there is
 * one more answer: a sound printer review whose gift the Store refused is granted the normal review
 * points at the refusal, once (rewards 7.8). 12.11 now says so in one sentence, and its reference
 * routes to 7.8 too.
 *
 * So this file reads what GET /api/policies/rewards and GET /api/policies/faq serve (the real route,
 * the real facts and render passes, the published corpus) and holds, in ar, en and ckb:
 *   - 7.8 is published and carries R4's sentence and L2's;
 *   - 8.5, 8.16 (with L1's sentence), 14.4, 14.6 and 14.10 are published whole;
 *   - the withheld articles of rewards v8 are exactly 1.2, 7.6, 13.6 and 16.6, and its withheld LINES
 *     are exactly their headings and their four unknowns: a rewording that cites a withheld article,
 *     in a whole article or in one line of one, fails here, loudly, the day it is written;
 *   - faq 12.11 carries R4's sentence whole, and faq v8 withholds exactly its seven unknowns.
 *
 * Run: node --import tsx --test tests/rewardsPolicyPublished.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, freshDb, get, json, pending, row, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { policiesRoutes } from '../worker/routes/policies';
import { POLICY_DOCUMENTS, POLICY_SOURCE_DOCUMENTS } from '../worker/lib/policies';
import { publishedPolicyBody } from '../worker/lib/policies/render';
import { fillPolicyFacts } from '../worker/lib/policies/facts';
import { POLICY_LANGS, type PolicyDocument, type PolicyLang, type PolicyText } from '../worker/lib/policies/types';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';

const LEDGER = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'policyHashes.json'), 'utf8')) as Record<string, string>;

/** Live serves rewards 7 and faq 7; version 8 of each is the unpublished one the rulings of 2026-11-09 change in place. */
const VERSION = 8;
const DOCS = ['rewards', 'faq'] as const;
type DocKey = (typeof DOCS)[number];
/** What rewards v8 withholds, as live withholds it: the unknowns (1.2, 7.6, 13.6, 16.6) and nothing that cites them. */
const WITHHELD = ['1.2', '7.6', '13.6', '16.6'];
/** The articles the rulings of 2026-11-09 and the lead's calls write into, beside 7.8. */
const PUBLISHED_WHOLE = ['8.5', '8.16', '14.4', '14.6', '14.10'];

/**
 * THE LINES A CUSTOMER NEVER READS, counted from the code (M1), in reading order and the same in all
 * three languages. A line is named by the article it stands in and by why it goes: `7.6 ###` is the
 * heading of 7.6, and `7.6 {{REVIEW_BASE_POINTS}}` is the line of 7.6 that still names that unknown
 * once facts.ts has filled what it can. A line withheld only because it cites a withheld article names
 * no unknown, so it shows as `7.3 cites a withheld article: <the line>`, and no list here holds one.
 */
const WITHHELD_LINES: Readonly<Record<DocKey, readonly string[]>> = {
  rewards: [
    '1.2 ###',
    '1.2 {{LEVONIS_LEGAL_NAME}} {{LEVONIS_REGISTRATION_NO}} {{LEVONIS_ADDRESS}}',
    '7.6 ###',
    '7.6 {{REVIEW_BASE_POINTS}}',
    '13.6 ###',
    '13.6 {{ACCOUNT_APPEAL_DAYS}}',
    '16.6 ###',
    '16.6 {{LEVONIS_SUPPORT_HOURS}}',
  ],
  faq: [
    '2.6 ###',
    '2.6 {{ACCOUNT_CLOSURE_PROCESSING_DAYS}}',
    '3.5 ###',
    '3.5 {{ADDRESS_CHANGE_DEADLINE_HOURS}}',
    '4.3 ###',
    '4.3 {{DAMAGE_REPORT_WINDOW_HOURS}}',
    '10.1 ###',
    '10.1 {{LEVONIS_SUPPORT_HOURS}}',
    '10.4 ###',
    '10.4 {{LEVONIS_COMPLAINTS_CONTACT}} {{DISPUTE_RESPONSE_DAYS}}',
    '12.2 ###',
    '12.2 {{DOOR_INSPECTION_MINUTES}}',
    '12.3 ###',
    '12.3 {{DAMAGE_REPORT_WINDOW_HOURS}}',
  ],
};
/**
 * The source lines that name an unknown and still reach the page, because facts.ts has a value for
 * every unknown they name. Rewards 16.5 is the governing-law line round 4 counted as a ninth withheld one.
 */
const FILLED_LINES: Readonly<Record<DocKey, readonly string[]>> = {
  rewards: ['16.5 {{GOVERNING_LAW_JURISDICTION}} {{COMPETENT_COURT}}'],
  faq: ['2.5 {{LEVONIS_SUPPORT_CONTACT}}'],
};

const SOURCE = Object.fromEntries(DOCS.map((key) => [key, POLICY_SOURCE_DOCUMENTS.find((d) => d.key === key)!])) as Record<DocKey, PolicyDocument>;
const PUBLISHED = Object.fromEntries(DOCS.map((key) => [key, POLICY_DOCUMENTS.find((d) => d.key === key)!])) as Record<DocKey, PolicyDocument>;

/** 7.8, R4: a refused printer review earns the review points any valid manual review earns, once. */
const R4: PolicyText = {
  ar: 'فإن رفض المتجر هديتها مُنحت عند الرفض نقاط المراجعة التي تُمنح لأي مراجعة يدوية صحيحة وفق المادة 7.5، مرة واحدة لا تتكرر.',
  en: 'If the Store refuses its gift, it is granted, at the refusal, the review points any valid manual review is granted under article 7.5, once only.',
  ckb: 'ئەگەر فرۆشگا دیارییەکەی ڕەت بکاتەوە، لە کاتی ڕەتکردنەوەکەدا ئەو خاڵانەی پێداچوونەوەی پێ دەبەخشرێت کە بە هەر پێداچوونەوەیەکی دەستیی دروست دەبەخشرێت بەپێی ماددەی 7.5، تەنها یەک جار.',
};
/** 7.8, L2: approved after a refusal, the review keeps those points and also gets its code. */
const L2: PolicyText = {
  ar: 'وإن وافق المتجر على هديتها بعد رفضها بقيت لها تلك النقاط وأخذت كودها أيضاً، فلا يُسترد منها شيء ولا تُدفع النقاط مرة ثانية.',
  en: 'If the Store approves its gift after refusing it, the review keeps those points and also receives its code: nothing is taken back, and the points are not paid a second time.',
  ckb: 'ئەگەر فرۆشگا دوای ڕەتکردنەوەکە دیارییەکەی پەسەند بکات، ئەو خاڵانە بۆ پێداچوونەوەکە دەمێننەوە و کۆدەکەشی وەردەگرێت: هیچیان لێ وەرناگیرێتەوە و دوو جار نادرێن.',
};
/** R4 as round 3 wrote it, citing 7.6 beside 7.5: the sentence that took 7.8 off the page. */
const R4_ROUND_3: PolicyText = {
  ar: 'فإن رفض المتجر هديتها مُنحت عند الرفض نقاط المراجعة التي تُمنح لأي مراجعة يدوية صحيحة وفق المادتين 7.5 و7.6، مرة واحدة لا تتكرر.',
  en: 'If the Store refuses its gift, it is granted, at the refusal, the review points any valid manual review is granted under articles 7.5 and 7.6, once only.',
  ckb: 'ئەگەر فرۆشگا دیارییەکەی ڕەت بکاتەوە، لە کاتی ڕەتکردنەوەکەدا ئەو خاڵانەی پێداچوونەوەی پێ دەبەخشرێت کە بە هەر پێداچوونەوەیەکی دەستیی دروست دەبەخشرێت بەپێی ماددەکانی 7.5 و 7.6، تەنها یەک جار.',
};
/** The video bullet of 7.3 as written, and as round 4 reworded it to cite the withheld 7.6 (never published: it proves the guard). */
const VIDEO_LIMIT: PolicyText = {
  ar: '- الفيديو لا يتجاوز أربعين ميغابايت.',
  en: '- A video may not exceed forty megabytes.',
  ckb: '- ڤیدیۆ لە چل مێگابایت تێناپەڕێت.',
};
const VIDEO_LIMIT_CITING_7_6: PolicyText = {
  ar: '- الفيديو لا يتجاوز أربعين ميغابايت، ومراجعة الفيديو تأخذ نقاط المراجعة وفق المادة 7.6.',
  en: '- A video may not exceed forty megabytes; a video review earns the review points of article 7.6.',
  ckb: '- ڤیدیۆ لە چل مێگابایت تێناپەڕێت؛ پێداچوونەوەی ڤیدیۆ خاڵی پێداچوونەوە وەردەگرێت بەپێی ماددەی 7.6.',
};
/** The rulings' own words in the other articles, as a customer must read them. */
const WORDS: Readonly<Record<string, PolicyText>> = {
  // R1: an approved reward is not withdrawn, save for abuse and for a printer that goes back to the Store.
  '8.5': {
    ar: 'وفي الطابعة التي تعود إلى المتجر وفق المادة 8.16',
    en: 'for a printer that goes back to the Store under article 8.16',
    ckb: 'بەپێی ماددەی 8.16',
  },
  // R1, then L1: an ordered gift goes with its own order, cancelled before delivery.
  '8.16': {
    ar: 'فإن أُلغي الطلب الذي طُلبت فيه هذه الهدية قبل تسليمها أُلغيت الهدية معه، ولا يمكن طلبها مرة أخرى.',
    en: 'If the order holding such a gift is cancelled before the gift is delivered, the gift is cancelled with it and cannot be ordered again.',
    ckb: 'ئەگەر ئەو داواکارییەی ئەم دیارییەی تێدا داوا کراوە پێش گەیاندنی هەڵبوەشێنرێتەوە، دیارییەکەش لەگەڵیدا هەڵدەوەشێنرێتەوە و ناتوانرێت دووبارە داوا بکرێتەوە.',
  },
  // R3: 100,000 and above.
  '14.4': {
    ar: '5,000 د.ع للطلبات من 100,000 د.ع فأكثر.',
    en: '5,000 IQD on orders of 100,000 IQD or more.',
    ckb: '5,000 دینار بۆ داواکارییەکانی 100,000 دینار و زیاتر.',
  },
  // R2: the points of a withdrawn coupon come back once.
  '14.10': {
    ar: 'وإذا سحب المتجر كوبوناً استُبدل بالنقاط قبل أن يُستعمل وقبل انتهاء صلاحيته عادت نقاطه إلى صاحبه مرة واحدة',
    en: 'If the Store withdraws a coupon exchanged for points before it is used and before it expires, its points return to its holder once',
    ckb: 'خاڵەکانی یەک جار بۆ خاوەنەکەی دەگەڕێنەوە',
  },
};
const R1_VOID: PolicyText = {
  ar: 'بطل كود مراجعتها',
  en: "the review's code becomes void",
  ckb: 'کۆدی پێداچوونەوەکەی بەتاڵ دەبێتەوە',
};

/** faq 12.11, M2: R4 in the FAQ's own words, right after the approval that issues the code. */
const FAQ_R4: PolicyText = {
  ar: 'وإن رفض المتجر هدية مراجعة الطابعة السليمة مُنحت المراجعة عند الرفض نقاط المراجعة المعتادة، مرة واحدة.',
  en: 'If the Store refuses the gift of a sound printer review, the review is granted the normal review points at the refusal, once.',
  ckb: 'ئەگەر فرۆشگا دیاریی پێداچوونەوەی دروستی چاپکەر ڕەت بکاتەوە، لە کاتی ڕەتکردنەوەکەدا خاڵە ئاساییەکانی پێداچوونەوە بە پێداچوونەوەکە دەبەخشرێن، تەنها یەک جار.',
};
/** What 12.11 says just before it. */
const FAQ_APPROVAL: PolicyText = {
  ar: 'وبالقبول يصدر كود الهدية.',
  en: 'and approval issues the gift code.',
  ckb: 'و بە پەسەندکردن کۆدی دیاری دەردەچێت.',
};
/** And just after it: the reference, with 7.8 beside 7.5, 8.2 and 8.3. */
const FAQ_REFERENCE: PolicyText = {
  ar: 'المرجع: وثيقة النقاط والمراجعات، المواد 7.5 و7.8 و8.2 و8.3.',
  en: 'Reference: the Points and Reviews document, articles 7.5, 7.8, 8.2 and 8.3.',
  ckb: 'سەرچاوە: بەڵگەنامەی خاڵ و پێداچوونەوە، ماددەکانی 7.5 و 7.8 و 8.2 و 8.3.',
};

/** `### 7.8 …` → `7.8`, for every article heading of a body, in reading order. */
const articles = (body: string): string[] =>
  body.split('\n').filter((line) => line.startsWith('### ')).map((line) => line.slice(4).split(' ')[0]);

/** One article as written in a body: its heading and every line before the next heading, trimmed. */
function article(body: string, n: string): string | null {
  const lines = body.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`### ${n} `));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !lines[end].startsWith('#')) end++;
  return lines.slice(at, end).join('\n').trim();
}

/** The source articles a reader never sees. */
const withheld = (source: string, published: string): string[] => {
  const shown = new Set(articles(published));
  return articles(source).filter((n) => !shown.has(n));
};

/** The unknowns a line names, once each, in the order it names them: any `{{…}}`, as render.ts reads one. */
const unknowns = (line: string): string => [...new Set([...line.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]))].join(' ');

/**
 * The source lines a reader never sees, named as WITHHELD_LINES names them, in reading order. The render
 * pass only deletes (whole lines, then the runs of blank lines they leave), so the published lines are the
 * filled source's lines in order, less the withheld ones; `rest` is whatever published line that walk does
 * not reach, which is a line the source never had, and must be nothing.
 */
function withheldLines(source: string, published: string, lang: PolicyLang): { lines: string[]; rest: string[] } {
  const shown = published.split('\n').filter((line) => line.trim());
  const lines: string[] = [];
  let at = 0;
  let where = '';
  for (const line of fillPolicyFacts(source, lang).split('\n')) {
    if (line.startsWith('#')) where = line.replace(/^#+ /, '').split(' ')[0];
    if (!line.trim()) continue;
    if (at < shown.length && shown[at] === line) {
      at++;
      continue;
    }
    const heading = /^#+ /.exec(line);
    lines.push(heading ? `${where} ${heading[0].trim()}` : unknowns(line) ? `${where} ${unknowns(line)}` : `${where} cites a withheld article: ${line}`);
  }
  return { lines, rest: shown.slice(at) };
}

/** The source lines that name an unknown and reach the page all the same, filled by facts.ts. */
function filledLines(source: string, published: string, lang: PolicyLang): string[] {
  const shown = new Set(published.split('\n'));
  const out: string[] = [];
  let where = '';
  for (const line of source.split('\n')) {
    if (line.startsWith('#')) where = line.replace(/^#+ /, '').split(' ')[0];
    if (unknowns(line) && shown.has(fillPolicyFacts(line, lang))) out.push(`${where} ${unknowns(line)}`);
  }
  return out;
}

/** The road a body takes to the customer: the owner's facts filled in, then every clause that still names an unknown withheld. */
const publish = (body: string, lang: PolicyLang): string => publishedPolicyBody(fillPolicyFacts(body, lang));

/** One value per language, for comparing all three at once. */
const perLang = <T>(value: (lang: PolicyLang) => T): Record<PolicyLang, T> =>
  Object.fromEntries(POLICY_LANGS.map((lang) => [lang, value(lang)])) as Record<PolicyLang, T>;

/** GET /api/policies/rewards and /faq in each language, through the real router, with the archive the read mirrors (read once). */
let once: ReturnType<typeof readServed> | null = null;
const served = () => (once ??= readServed());
async function readServed() {
  const raw = freshDb();
  resetPolicyCorpusMemo();
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/policies', policiesRoutes));
  const out = {} as Record<DocKey, Record<PolicyLang, Record<string, any>>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const key of DOCS) {
    out[key] = {} as (typeof out)[DocKey];
    for (const lang of POLICY_LANGS) {
      const res = await json(await get(app, `/api/policies/${key}?lang=${lang}`));
      assert.equal(res.success, true, `${key}/${lang}: ${JSON.stringify(res)}`);
      out[key][lang] = res.policy;
    }
  }
  await Promise.all(pending.splice(0));
  resetPolicyCorpusMemo();
  return { raw, policy: out };
}

test('GET /api/policies/rewards and /api/policies/faq serve version 8 in ar, en and ckb: the source through the real facts and render passes, archived and hashed as the ledger holds it', async () => {
  const { raw, policy } = await served();
  for (const key of DOCS) {
    assert.equal(SOURCE[key].version, VERSION, `${key}: the unpublished version 8, not a ninth`);
    for (const lang of POLICY_LANGS) {
      const p = policy[key][lang];
      assert.equal(p.version, VERSION, `${key}/${lang}`);
      assert.equal(p.lang, lang, `${key}: ${lang} fell back to another language`);
      assert.equal(p.status, 'published', `${key}/${lang}`);
      assert.equal(p.body, PUBLISHED[key].body[lang], `${key}/${lang}: the route serves the published corpus`);
      assert.equal(p.body, publish(SOURCE[key].body[lang], lang), `${key}/${lang}: the published corpus is the source through facts.ts and render.ts`);
      assert.equal(p.hash, LEDGER[`${key}@${VERSION}:${lang}`], `${key}/${lang}: the hash a consent names is the ledgered one`);
      const archived = row<{ body: string; hash: string }>(raw, 'SELECT body, hash FROM policy_documents WHERE key = ? AND version = ? AND lang = ?', key, VERSION, lang);
      assert.ok(archived, `${key}/${lang}: the read mirrors version 8 into the archive`);
      assert.equal(archived.body, p.body, `${key}/${lang}: the archive holds the bytes a customer reads`);
      assert.equal(archived.hash, p.hash, `${key}/${lang}`);
    }
  }
});

test('7.8 is published in ar, en and ckb, and carries R4’s sentence and then L2’s', async () => {
  const { policy } = await served();
  const chapter7 = perLang((lang) => articles(String(policy.rewards[lang].body)).filter((n) => n.startsWith('7.')).join(' '));
  assert.deepEqual(
    POLICY_LANGS.filter((lang) => !article(String(policy.rewards[lang].body), '7.8')),
    [],
    `article 7.8 is withheld from the published policy in these languages; chapter 7 reads ${JSON.stringify(chapter7)}`
  );
  for (const lang of POLICY_LANGS) {
    const a = article(String(policy.rewards[lang].body), '7.8')!;
    assert.equal(a, article(fillPolicyFacts(SOURCE.rewards.body[lang], lang), '7.8'), `${lang}: 7.8 reaches the customer whole`);
    const r4 = a.indexOf(R4[lang]);
    const l2 = a.indexOf(L2[lang]);
    assert.ok(r4 >= 0, `${lang}: R4's sentence is not in the published 7.8`);
    assert.ok(l2 > r4, `${lang}: L2's sentence does not follow R4's in the published 7.8`);
  }
});

test('8.5, 8.16 with L1’s sentence, 14.4, 14.6 and 14.10 are published whole in ar, en and ckb, with the rulings’ words', async () => {
  const { policy } = await served();
  for (const lang of POLICY_LANGS) {
    const body = String(policy.rewards[lang].body);
    const source = fillPolicyFacts(SOURCE.rewards.body[lang], lang);
    for (const n of PUBLISHED_WHOLE) {
      const a = article(body, n);
      assert.ok(a, `${lang}: article ${n} is withheld from the published policy`);
      assert.equal(a, article(source, n), `${lang}: a line of ${n} is withheld`);
      if (WORDS[n]) assert.ok(a.includes(WORDS[n][lang]), `${lang}: ${n} lost the ruling's words «${WORDS[n][lang]}»`);
    }
    assert.ok(article(body, '8.16')!.includes(R1_VOID[lang]), `${lang}: 8.16 lost R1`);
  }
});

test('the withheld articles of rewards v8 are exactly 1.2, 7.6, 13.6 and 16.6 in ar, en and ckb: a rewording that cites a withheld article fails here', async () => {
  const { policy } = await served();
  assert.deepEqual(
    perLang((lang) => withheld(SOURCE.rewards.body[lang], String(policy.rewards[lang].body))),
    perLang(() => WITHHELD),
    "rewards v8 withholds other articles than live does: a line that cites a withheld article (7.6 states {{REVIEW_BASE_POINTS}}, the owner's setting) goes with it, heading and all"
  );
});

test('the withheld LINES of rewards v8 and faq v8 are exactly the headings and the unknowns above, in ar, en and ckb: one line that cites a withheld article fails here too', async () => {
  const { policy } = await served();
  for (const key of DOCS) {
    const walk = perLang((lang) => withheldLines(SOURCE[key].body[lang], String(policy[key][lang].body), lang));
    assert.deepEqual(
      perLang((lang) => walk[lang].rest),
      perLang(() => []),
      `${key}: the published text holds lines its source does not have, and the render pass may only withhold`
    );
    assert.deepEqual(
      perLang((lang) => walk[lang].lines),
      perLang(() => WITHHELD_LINES[key]),
      `${key} v8 withholds other lines than these: a line that cites a withheld article goes on its own, while its article stays on the page`
    );
    assert.deepEqual(
      perLang((lang) => filledLines(SOURCE[key].body[lang], String(policy[key][lang].body), lang)),
      perLang(() => FILLED_LINES[key]),
      `${key}: these lines name only what facts.ts states, and are published filled`
    );
  }
});

test('the guard is armed: round 3’s 7.8, citing 7.5 and 7.6, is withheld whole by the same passes', () => {
  for (const lang of POLICY_LANGS) {
    const round3 = SOURCE.rewards.body[lang].replace(R4[lang], R4_ROUND_3[lang]);
    assert.ok(round3.includes(R4_ROUND_3[lang]), `${lang}: round 3's sentence is not where R4's is`);
    const shown = publish(round3, lang);
    assert.equal(article(shown, '7.8'), null, `${lang}: a 7.8 that cites the withheld 7.6 is published`);
    assert.ok(!shown.includes(L2[lang]), `${lang}: L2's sentence outlived its article`);
    assert.deepEqual(withheld(round3, shown), ['1.2', '7.6', '7.8', '13.6', '16.6'], lang);
  }
});

test('the line guard is armed: round 4’s 7.3 bullet, citing the withheld 7.6, goes alone, so the articles look untouched and the lines do not', () => {
  for (const lang of POLICY_LANGS) {
    const source = SOURCE.rewards.body[lang];
    assert.equal(source.split(VIDEO_LIMIT[lang]).length, 2, `${lang}: 7.3's video bullet is not where round 4 found it`);
    const mutated = source.replace(VIDEO_LIMIT[lang], VIDEO_LIMIT_CITING_7_6[lang]);
    const shown = publish(mutated, lang);
    assert.ok(!shown.includes(VIDEO_LIMIT_CITING_7_6[lang]), `${lang}: the bullet that cites 7.6 is published`);
    assert.ok(article(shown, '7.3'), `${lang}: 7.3 went whole, so the article-level guard would have seen it`);
    assert.deepEqual(withheld(mutated, shown), WITHHELD, `${lang}: the articles alone look as they were`);
    const { lines, rest } = withheldLines(mutated, shown, lang);
    assert.deepEqual(rest, [], lang);
    assert.deepEqual(
      lines,
      [...WITHHELD_LINES.rewards.slice(0, 2), `7.3 cites a withheld article: ${VIDEO_LIMIT_CITING_7_6[lang]}`, ...WITHHELD_LINES.rewards.slice(2)],
      `${lang}: the line walk names the bullet, in its place`
    );
  }
});

test('faq 12.11 carries R4’s sentence whole in ar, en and ckb, after the approval and before a reference that routes to rewards 7.5, 7.8, 8.2 and 8.3, all four on the page', async () => {
  const { policy } = await served();
  for (const lang of POLICY_LANGS) {
    const a = article(String(policy.faq[lang].body), '12.11');
    assert.ok(a, `${lang}: faq 12.11 is withheld from the published FAQ`);
    assert.equal(a, article(fillPolicyFacts(SOURCE.faq.body[lang], lang), '12.11'), `${lang}: 12.11 reaches the customer whole`);
    assert.equal(a.split(FAQ_R4[lang]).length, 2, `${lang}: R4's sentence is not in the published 12.11, once`);
    assert.ok(
      a.endsWith(`${FAQ_APPROVAL[lang]} ${FAQ_R4[lang]} ${FAQ_REFERENCE[lang]}`),
      `${lang}: 12.11 does not end with the approval, then R4's sentence, then the reference`
    );
    const cited = [...FAQ_REFERENCE[lang].matchAll(/\d+\.\d+/g)].map((m) => m[0]);
    assert.deepEqual(cited, ['7.5', '7.8', '8.2', '8.3'], lang);
    for (const n of cited) assert.ok(article(String(policy.rewards[lang].body), n), `${lang}: 12.11 routes to rewards ${n}, which is not on the page`);
  }
});

test('the article the team’s refusal dialog cites is on the page in every language', () => {
  const queue = readFileSync(join(ROOT, 'src', 'components', 'AdminReviews.tsx'), 'utf8');
  const lines = [...queue.matchAll(/rejectRewardPoints: '([^']*)'/g)].map((m) => m[1]);
  assert.equal(lines.length, 3, 'one sentence per language');
  const cited = new Set(lines.flatMap((line) => [...line.matchAll(/(?:المادة|article|ماددەی) (\d+\.\d+)/g)].map((m) => m[1])));
  assert.deepEqual([...cited], ['7.8']);
  const missing = POLICY_LANGS.flatMap((lang) => [...cited].filter((n) => !article(PUBLISHED.rewards.body[lang], n)).map((n) => `${lang} ${n}`));
  assert.deepEqual(missing, [], 'the refusal dialog sends the team to an article that is not on the page');
});
