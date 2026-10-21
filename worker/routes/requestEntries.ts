/**
 * THE REQUEST EDITOR'S ENTRY DOOR (plan P1-06, docs/DECISIONS.md row 268).
 *
 *   POST /api/marketplace/print/requests        a new DRAFT, born empty
 *
 * The editor at /requests/new creates its draft on the customer's first act
 * (the first keystroke, a file picked, a link added), so every upload has a
 * request to live on and a reload resumes the same draft. The older create
 * door (`POST /api/marketplace/requests`) asks a title of 4 characters and a
 * description of 10 before anything exists; this one asks nothing — the
 * minimums are the publish door's (REQUEST_TITLE_REQUIRED,
 * REQUEST_DESCRIPTION_REQUIRED).
 *
 * The draft is BORN VERSION 3: the request row, then its print row and a
 * model of one part in «لست متأكدًا» and «أي لون» through the draft save
 * itself (`saveDraft`), so the draft is never read as a legacy text request
 * and the editor reads it like every other draft. A seed that fails takes the
 * empty row with it.
 *
 * Behind the gate (Q1, row 262: no allow-list) like every door that starts
 * something in the community, and on the main site only: a store subdomain
 * carries the visitor's session cookie, and nothing a store page does needs
 * to create a request.
 *
 * Nobody but the customer sees a draft: not the board, not a merchant, not
 * the matcher. The entries from a project, a product and a store page
 * (P1-06 part 2) take this same door with an `entry`.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, requireAuth, requireMainHost } from '../lib/http';
import { requireCommunityOpen } from '../lib/communityGate';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { DRAFT_TTL_DAYS } from '../lib/requestRevisions';
import { saveDraft } from './printRequests';

export const requestEntryRoutes = new Hono<AppContext>();

/** The model a new draft is born with: one part, the process and the material open, any colour. */
export const SEED_MODEL_BODY = {
  schema_version: 3,
  quantity: 1,
  quality: 'standard',
  parts: [{ process: 'unsure', quantity: 1, materials: [{ material_id: 'unsure', colors: [{ mode: 'any' }] }] }],
} as const;

const ENTRY_KINDS = ['blank'] as const;

requestEntryRoutes.post('/requests', requireMainHost, requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'print-entry', 20, 3600);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
  const entry = body && typeof body === 'object' && body.entry && typeof body.entry === 'object' ? (body.entry as Record<string, unknown>) : {};
  const kind = entry.kind === undefined ? 'blank' : String(entry.kind);
  if (!(ENTRY_KINDS as readonly string[]).includes(kind)) throw badRequest('That is not a way to start a request');

  const id = newId('req');
  const ts = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO community_requests
       (id, customer_id, title, description, status, state, visibility, created_at, expires_at, updated_at, customer_notes)
     VALUES (?, ?, '', '', 'closed', 'draft', 'public', ?, ?, ?, '')`
  )
    .bind(id, user.id, ts, new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000).toISOString(), ts)
    .run();
  let draft;
  try {
    draft = await saveDraft(c.env, user.id, id, { ...SEED_MODEL_BODY });
  } catch (e) {
    // An empty row with no print row and no model is nobody's draft.
    await c.env.DB.prepare(`DELETE FROM community_requests WHERE id = ? AND customer_id = ? AND state = 'draft'`)
      .bind(id, user.id)
      .run()
      .catch(() => undefined);
    throw e;
  }
  await audit(c.env.DB, user.id, 'print.request_entry', id, { kind });
  return c.json({ success: true, request_id: id, replayed: false, draft }, 201);
});
