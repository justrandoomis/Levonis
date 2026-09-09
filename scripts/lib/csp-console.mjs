/**
 * Classify a browser console line as a Content-Security-Policy report.
 *
 * The live CSP check watches Chromium's console while it opens the public
 * pages, and one violation fails the run. That is only sound if the policy
 * being violated is OURS and is ENFORCED:
 *
 *   - an enforced violation means the browser actually blocked something a
 *     visitor needed, which is exactly what the check exists to catch;
 *   - a report-only report blocks nothing by construction, and the ones this
 *     site sees belong to a framed third party — the Google sign-in iframe
 *     carries a report-only `frame-ancestors 'self'`, which any embedding
 *     origin "violates" by framing it. This site serves one enforced policy
 *     and no report-only policy at all (worker/lib/securityPolicy.ts), so a
 *     report-only line is never ours to answer for.
 *
 * Report-only lines are still returned — as 'report-only', for the caller to
 * print — so nothing is silently dropped.
 *
 * @returns {'violation'|'report-only'|null}
 */
export function classifyCspConsoleLine(text) {
  if (typeof text !== 'string') return null;
  if (!/Content Security Policy|Refused to (load|execute|apply|connect|frame|display)/i.test(text)) return null;
  return /\[Report Only\]/i.test(text) ? 'report-only' : 'violation';
}
