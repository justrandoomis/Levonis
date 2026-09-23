/**
 * WHAT THE CUSTOMER IS ALLOWED TO READ — the gap between the SOURCE text of a
 * policy and the PUBLISHED text of it.
 *
 * The corpus refuses to invent. A registration number, a support line, a
 * governing law or a retention period that the code does not hold is written
 * as `{{NAMED_PLACEHOLDER}}` rather than guessed, and tests/policyCorpus.test.ts
 * calls that set what it is: a to-do list for the owner. That decision was
 * right and it is untouched here.
 *
 * What nothing prevented was the to-do list being READ BY A CUSTOMER. The
 * route served `doc.body[lang]` verbatim, there was no substitution pass
 * anywhere in worker/ or src/, and so a legal document on the public site
 * showed «يسري على هذه الشروط … قانون {{GOVERNING_LAW_JURISDICTION}}» and
 * «تختص {{COMPETENT_COURT}} بنظر النزاع» to anyone who opened the Terms. The
 * owner photographed exactly those two lines. A template token in a published
 * contract is not a cosmetic defect: it is the shop telling a customer, a bank
 * or a court that it has not decided what its own terms say.
 *
 * THE RULE THIS MODULE ENFORCES, and it has only one: a document states a fact
 * or it is silent about it. Never a token.
 *
 * So a paragraph, a bullet or a definition line that still carries an
 * unresolved placeholder is WITHHELD from the published text; an article whose
 * every line was withheld takes its heading with it; a part whose every
 * article went takes its own heading too. What survives is smaller and wholly
 * true. Nothing is reworded, nothing is summarised and no sentence is
 * synthesised — this pass only ever DELETES, which is also why it needs no new
 * Arabic and, critically, no new Kurdish: the hand-written corpus stays the
 * only author of every word a customer sees.
 *
 * WHAT IS FILLED FIRST. ./facts.ts holds the values the owner has decided
 * or the code enforces (the governing law, the court, the support page, the
 * membership delivery thresholds …), and ./index.ts substitutes them into the
 * source BEFORE this pass runs. So this pass only ever sees the tokens that
 * still have no value — and those it withholds. The values are constants, not
 * reads of `admin_settings`, because ./types.ts hashes the bytes a customer
 * accepted: a body that moved whenever an admin edited a setting could not be
 * hashed once. One text per version — the same bytes are rendered, archived,
 * hashed and accepted.
 *
 * WHY IT LIVES BELOW ./index.ts RATHER THAN IN THE ROUTE. The route is not the
 * only reader. worker/lib/policySync.ts mirrors the corpus into the archive
 * and worker/lib/policyOps.ts binds consent to an archived hash, so a pass
 * that ran only on the way out of an HTTP handler would archive one text and
 * show another, and every acceptance on record would point at bytes the
 * customer never saw. Applying it in the registry means there is no second
 * text anywhere: `POLICY_DOCUMENTS` IS the published corpus, and the raw
 * modules are reachable as `POLICY_SOURCE_DOCUMENTS` for exactly one purpose,
 * which is asserting that the to-do list still exists.
 *
 * A WITHHELD ARTICLE TAKES ITS REFERENCES WITH IT. A surviving clause used
 * to go on pointing at an article that went — terms/ar 8.3 said «ما لم ينطبق
 * استثناء المادة 8.4 أدناه» while 8.4 itself was held back, and support sent
 * the customer to «المادة 14.4», which was not on the page either. A pointer
 * to nothing is the same defect as the token in smaller print, so a line that
 * cites, by article number, an article of the SAME document that was withheld
 * is withheld too, and the sweep repeats until nothing more moves. A citation
 * that names another document («من سياسة التوصيل», 'of the Delivery Policy',
 * «ی سیاسەتی …») is left alone: that article lives elsewhere and its number
 * says nothing about this document.
 *
 * FILLING A TOKEN IS THEREFORE A PUBLICATION. Write the owner's answer into
 * ./facts.ts, bump the `version` of every document that uses the token, and
 * the withheld clause comes back on its own — with every line that cited it.
 * Nothing else has to be remembered.
 */

/** A `{{TOKEN}}` the corpus has not yet been given a value for. */
const PLACEHOLDER = /\{\{[^}]*\}\}/;

/**
 * The document grammar, as src/components/policies/PolicyProse.tsx parses it
 * and as all eighteen modules are written: `## ` parts, `### N.M ` articles,
 * `- ` bullets, paragraphs, blank lines. Nothing else occurs, so nothing else
 * is recognised.
 */
const PART = '## ';
const ARTICLE = '### ';

/**
 * Mark the headings that have nothing left under them.
 *
 * A heading owns every line from itself to the next heading at its level or
 * above. `kept` stays false for a heading whose span held only withheld lines
 * AND for one that held no content at all, so a stranded `### 18.1 القانون
 * الواجب التطبيق` with an empty body can never be published.
 */
function sweepHeadings(lines: string[], drop: boolean[], prefix: string, stops: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(prefix)) continue;
    let sawContent = false;
    let keptContent = false;
    for (let j = i + 1; j < lines.length && !stops.some((s) => lines[j].startsWith(s)); j++) {
      if (!lines[j].trim()) continue;
      sawContent = true;
      if (!drop[j]) keptContent = true;
    }
    if (!sawContent || !keptContent) drop[i] = true;
  }
}

/**
 * An article citation: the word for "article(s)" in any of the three
 * languages, then one number or a list / range of them («المادتين 3.35
 * و3.36», 'articles 3.17, 3.18 and 3.19', «ماددەکانی 2.2 تا 2.8»).
 */
const CITATION =
  /(?:\barticles?|[\u0600-\u06FF]*(?:مادة|مادتين|مادتان|مواد)|ماددەی|ماددەکانی|بڕگەی|بڕگەکانی)\s+(\d+\.\d+(?:(?:\s*[,،]\s*|\s+(?:and|to|و|تا|إلى)\s*|\s*و)\d+\.\d+)*)/giu;

/**
 * A citation that points into ANOTHER document, which is written two ways:
 * the document named right after the numbers («… من سياسة التوصيل», 'of the
 * Delivery Policy'), or right before them, as the FAQ's references are
 * ('Reference: the Delivery document, articles 3.8 and 3.9'). Only the few
 * words touching the citation are read, so a sentence that merely mentions
 * another policy elsewhere does not excuse a citation of this one.
 */
const OTHER_DOCUMENT =
  /^\S*\s*(?:of (?:the|this|that) (?!document\b)|in the (?!document\b)|from the |من (?:سياسة|وثيقة|الشروط|شروط)|في (?:سياسة|وثيقة)|ی (?:سیاسەت|بەڵگەنامە|مەرج)|لە (?:سیاسەت|بەڵگەنامە))/iu;

const NAMED_BEFORE = /(?:document|policy|terms|وثيقة|سياسة|الشروط|بەڵگەنامە|سیاسەت)[^.:،,]{0,30}[،,]\s*$/iu;

/** Article numbers this line cites within its own document. */
function citedArticles(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(CITATION)) {
    const start = match.index ?? 0;
    const after = line.slice(start + match[0].length, start + match[0].length + 40);
    const before = line.slice(Math.max(0, start - 40), start);
    if (OTHER_DOCUMENT.test(after) || NAMED_BEFORE.test(before)) continue;
    for (const n of match[1].matchAll(/\d+\.\d+/g)) out.push(n[0]);
  }
  return out;
}

/** `### 8.4 …` → `8.4`. */
function articleNumber(line: string): string | null {
  return line.startsWith(ARTICLE) ? (line.slice(ARTICLE.length).split(' ')[0] ?? null) : null;
}

/**
 * The published text of one body: the source minus every line that still
 * states an unknown, minus every line that cites an article so withheld, minus
 * the headings those lines emptied.
 *
 * Blank lines are not tracked structurally — removing a line leaves a run of
 * them behind, and collapsing runs at the end preserves the paragraph spacing
 * of everything that was NOT touched, byte for byte. A body with no
 * placeholder comes back identical to its source, which is what keeps the
 * hash of an untouched document stable across this change — nothing can
 * dangle where nothing was withheld.
 */
export function publishedPolicyBody(body: string): string {
  if (!PLACEHOLDER.test(body)) return body;
  const lines = body.split('\n');
  const drop = lines.map((line) => line.trim().length > 0 && !line.startsWith(PART) && PLACEHOLDER.test(line));
  const cites = lines.map((line) => (line.startsWith('#') ? [] : citedArticles(line)));
  for (;;) {
    sweepHeadings(lines, drop, ARTICLE, [ARTICLE, PART]);
    sweepHeadings(lines, drop, PART, [PART]);
    const withheld = new Set<string>();
    lines.forEach((line, i) => {
      const n = drop[i] ? articleNumber(line) : null;
      if (n) withheld.add(n);
    });
    let moved = false;
    cites.forEach((numbers, i) => {
      if (!drop[i] && numbers.some((n) => withheld.has(n))) {
        drop[i] = true;
        moved = true;
      }
    });
    if (!moved) break;
  }
  return lines
    .filter((_, i) => !drop[i])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
