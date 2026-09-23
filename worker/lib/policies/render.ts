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
 * WHY WITHHOLDING AND NOT SUBSTITUTION. Five of the seventy tokens do have a
 * live source in `admin_settings` — the PRO and PRIME free-delivery
 * thresholds, the review base points, the two delivery-day limits. Resolving
 * those at read time was considered and rejected twice over. delivery.ts
 * already refused to quote an admin-editable figure in legal text, because the
 * figure that is seeded today is not the figure the owner will set tomorrow
 * and the document would go on promising the old one — that is the exact
 * regression the cash-on-delivery tax caused. And ./types.ts hashes the bytes
 * a customer accepted, so a body that changes whenever an admin edits a
 * setting cannot be hashed once: the accepted document and the displayed
 * document would silently diverge. Uniform withholding keeps ONE text per
 * version — the same bytes are rendered, archived, hashed and accepted.
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
 * WHAT WITHHOLDING COSTS, STATED PLAINLY. A surviving clause can still point
 * at an article that went — terms/ar 8.3 says «ما لم ينطبق استثناء المادة 8.4
 * أدناه» and 8.4 is one of the articles held back. That is a dangling
 * reference, it is a smaller defect than the template token it replaced, and
 * it is self-healing: the article returns with its value. It is NOT pinned by
 * a test, because a test that enumerated today's dangling references would
 * have to be edited every time the owner answered a question, which is the
 * opposite of what this design is for.
 *
 * FILLING A TOKEN IS THEREFORE A PUBLICATION. Write the owner's answer into
 * the module, bump that document's `version`, and the withheld clause comes
 * back on its own. Nothing else has to be remembered.
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
 * The published text of one body: the source minus every line that still
 * states an unknown, minus the headings those lines emptied.
 *
 * Blank lines are not tracked structurally — removing a line leaves a run of
 * them behind, and collapsing runs at the end preserves the paragraph spacing
 * of everything that was NOT touched, byte for byte. A body with no
 * placeholder comes back identical to its source, which is what keeps the
 * hash of an untouched document stable across this change.
 */
export function publishedPolicyBody(body: string): string {
  if (!PLACEHOLDER.test(body)) return body;
  const lines = body.split('\n');
  const drop = lines.map((line) => line.trim().length > 0 && !line.startsWith(PART) && PLACEHOLDER.test(line));
  sweepHeadings(lines, drop, ARTICLE, [ARTICLE, PART]);
  sweepHeadings(lines, drop, PART, [PART]);
  return lines
    .filter((_, i) => !drop[i])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
