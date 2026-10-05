/** Explicitly approved repair of an EMPTY live owner binding, never an owner transfer.
 * Preview is the default. No user row, financial record, code or secret is written.
 * All unrelated bindings are inherited from the running worker.
 */
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type Binding = { name: string; type: string; text?: string; id?: string; [key: string]: unknown };
type OwnerCandidate = { id: string; username: string; email: string; email_verified_at: string | null; role: string; admin_scope: string | null };
const ownerKey = 'INITIAL_ADMIN_EMAIL';

export function ownerRestorationPlan(bindings: Binding[], candidates: OwnerCandidate[], username: string, confirmation: string) {
  if (!/^[a-z0-9._-]{3,64}$/.test(username) || confirmation !== `SET-OWNER:${username}`) throw new Error('Explicit confirmation of the exact account is required');
  if (candidates.length !== 1) throw new Error('The account must resolve uniquely');
  const target = candidates[0];
  if (target.username.toLowerCase() !== username || target.role !== 'admin' || ![null, '', 'full'].includes(target.admin_scope)) throw new Error('The selected account must already be an unrestricted administrator');
  if (!target.email_verified_at || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email)) throw new Error('The administrator must have a verified email');
  if (new Set(bindings.map(b => b.name)).size !== bindings.length) throw new Error('Duplicate binding names');
  const current = bindings.find(b => b.name === ownerKey), email = target.email.trim().toLowerCase();
  if (current && current.type !== 'plain_text') throw new Error('Owner binding is not readable plain text; refusing to overwrite it');
  if (current?.text?.trim() && current.text.trim().toLowerCase() !== email) throw new Error('An owner is already configured; this repair cannot transfer ownership');
  return { changed: current?.text?.trim().toLowerCase() !== email, email, bindings: [
    ...bindings.filter(b => b.name !== ownerKey).map(b => ({ name: b.name, type: 'inherit' as const })),
    { name: ownerKey, type: 'plain_text' as const, text: email },
  ] };
}

async function main() {
  const username = (process.env.OWNER_USERNAME ?? '').trim().toLowerCase(), apply = process.env.OWNER_MODE === 'apply';
  if (!['preview', 'apply'].includes(process.env.OWNER_MODE ?? 'preview')) throw new Error('Invalid mode');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('Cloudflare credentials are required');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`, path = '/workers/scripts/levonis-staging/settings';
  const request = async (suffix: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(base + suffix, { ...init, headers });
    const body = await response.json() as { success: boolean; result: unknown };
    if (!response.ok || !body.success) throw new Error(`Cloudflare operation failed (${response.status}); no response values printed`);
    return body.result;
  };
  const before = await request(path) as { bindings: Binding[] };
  const database = before.bindings.find(b => b.name === 'DB' && b.type === 'd1')?.id;
  if (!database) throw new Error('Live DB binding is missing');
  const readAccount = async () => await request(`/d1/database/${database}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    sql: 'SELECT id,username,email,email_verified_at,role,admin_scope FROM users WHERE lower(username)=? LIMIT 2', params: [username],
  }) }) as { success: boolean; results: OwnerCandidate[] }[];
  const result = await readAccount();
  if (!result[0]?.success) throw new Error('Read-only account lookup failed');
  const plan = ownerRestorationPlan(before.bindings, result[0].results, username, apply ? process.env.OWNER_CONFIRMATION ?? '' : `SET-OWNER:${username}`);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', eligible_existing_admin: true, change_required: plan.changed, unrelated_bindings_preserved: before.bindings.filter(b => b.name !== ownerKey).length }));
  if (!apply || !plan.changed) return;
  // Do not replay a stale binding list after an unrelated configuration update.
  const latest = await request(path) as { bindings: Binding[] };
  if (!isDeepStrictEqual(before.bindings, latest.bindings)) throw new Error('Live bindings changed; run a new preview');
  const latestAccount = await readAccount();
  // D1 query metadata (duration, rows read, etc.) may differ for an unchanged row.
  if (!latestAccount[0]?.success || !isDeepStrictEqual(result[0].results, latestAccount[0].results)) throw new Error('Administrator identity changed; run a new preview');
  const form = new FormData();
  form.set('settings', new Blob([JSON.stringify({ bindings: plan.bindings })], { type: 'application/json' }));
  await request(path, { method: 'PATCH', body: form });
  const after = await request(path) as { bindings: Binding[] };
  if (after.bindings.find(b => b.name === ownerKey)?.text?.trim().toLowerCase() !== plan.email) throw new Error('Owner update needs verification; do not repeat automatically');
  const other = (bindings: Binding[]) => bindings.filter(b => b.name !== ownerKey).sort((a,b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(other(before.bindings), other(after.bindings))) throw new Error('Unrelated bindings changed; review before continuing');
  console.log('Owner binding restored and all unrelated bindings verified unchanged. No financial records were modified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e instanceof Error ? e.message : 'Owner repair failed'); process.exitCode = 1; });
}
