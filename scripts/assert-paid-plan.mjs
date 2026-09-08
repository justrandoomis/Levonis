#!/usr/bin/env node
/**
 * The hard precondition of the whole programme (`02-MIGRATION-PLAN.md` §13.1
 * D1): the account must be on **Workers Paid** before anything is created.
 *
 * This is not a courtesy check. The design needs the paid limits at several
 * points — the subrequest and D1-statement caps per invocation for the outbox
 * pump and the Admin BFF, CPU time for PBKDF2 under a service binding, the D1
 * database count (≥9 new databases by Phase 2, ~23 at the end), and ~40k cron
 * invocations a day from per-minute triggers. **There is no Free-plan fallback
 * for this architecture**, so a workflow that created a dark stack on a Free
 * account would be building something that cannot ever go live.
 *
 * THREE KINDS OF EVIDENCE, in descending order of strength. The script prints
 * WHICH one it used, because "checked" and "assumed" are different claims:
 *
 *  1. the Workers subscription on the account's billing profile, read
 *     read-only through the API;
 *  2. circumstantial — more than the Free plan's ten D1 databases exist
 *     (`wrangler d1 list`), which cannot be true on Free;
 *  3. the owner's explicit confirmation, passed as `--confirmed` by a workflow
 *     input the owner typed. That is a statement by a person, and the script
 *     labels it as one.
 *
 * With none of the three it EXITS NON-ZERO and creates nothing.
 *
 *   node scripts/assert-paid-plan.mjs [--confirmed] [--json]
 */
import { execFileSync } from 'node:child_process';

const has = (flag) => process.argv.includes(flag);
const verdict = { paid: false, evidence: null, detail: '' };

// ------------------------------------------------------- 1. the subscription
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (token && account) {
  for (const path of [`accounts/${account}/workers/subscription`, `accounts/${account}/subscriptions`]) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const body = await res.json();
      const text = JSON.stringify(body?.result ?? {});
      // The plan name is what is being read; no identifier is printed.
      if (/workers[_ -]?paid|workers_bundled|"paid"|Workers Paid/i.test(text)) {
        verdict.paid = true;
        verdict.evidence = 'subscription';
        verdict.detail = 'the account carries a paid Workers subscription';
        break;
      }
      if (/workers[_ -]?free|"free"/i.test(text)) {
        verdict.paid = false;
        verdict.evidence = 'subscription';
        verdict.detail = 'the account subscription reports the FREE Workers plan';
        break;
      }
    } catch {
      /* an unreadable endpoint is not evidence either way */
    }
  }
}

// ---------------------------------------------------- 2. the D1 count (proxy)
if (!verdict.evidence) {
  try {
    const out = execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const list = JSON.parse(out);
    if (Array.isArray(list) && list.length > 10) {
      verdict.paid = true;
      verdict.evidence = 'd1-count';
      verdict.detail = `${list.length} D1 databases exist, which the Free plan's limit of 10 does not allow`;
    } else if (Array.isArray(list)) {
      verdict.detail = `${list.length} D1 databases — consistent with either plan, so it proves nothing`;
    }
  } catch {
    verdict.detail = 'wrangler could not list D1 databases (no credentials in this environment)';
  }
}

// -------------------------------------------------- 3. the owner's statement
if (!verdict.paid && has('--confirmed')) {
  verdict.paid = true;
  verdict.evidence = 'owner-confirmed';
  verdict.detail = 'the owner confirmed the Workers Paid plan in the workflow input; nothing was read from the account';
}

if (has('--json')) console.log(JSON.stringify(verdict));

if (!verdict.paid) {
  console.error(
    'assert-paid-plan: the Workers Paid plan is NOT confirmed, so nothing will be created.\n' +
      `  What was found: ${verdict.detail || 'no evidence at all'}\n` +
      '  Either confirm the plan badge in the Cloudflare dashboard and re-run with the\n' +
      '  "paid plan confirmed" workflow input, or upgrade the account. There is no\n' +
      '  Free-plan fallback for this architecture (02-MIGRATION-PLAN.md §13.1 D1).'
  );
  process.exit(1);
}
console.log(`assert-paid-plan: Workers Paid — evidence: ${verdict.evidence} (${verdict.detail})`);
