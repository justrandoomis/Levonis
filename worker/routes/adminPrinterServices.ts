/**
 * «خدمات الطابعات والباقات» — the owner's price list for the printer
 * services (owner brief 2026-11-17; DECISIONS row 339).
 *
 *   GET    /api/admin/printer-services            draft, published, issues, printers to map
 *   PUT    /api/admin/printer-services/draft      save the draft   { draft, base_revision } (owner)
 *   POST   /api/admin/printer-services/publish    publish the draft { base_revision }   (owner)
 *   POST   /api/admin/printer-services/unpublish  switch the feature off               (owner)
 *
 * Saving the draft, publishing and switching off are the owner's
 * (OWNER_ONLY_ACTS; owner ruling: staff may only view the list). A used or refurbished
 * listing cannot be mapped: it keeps the warranty its listing states.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound } from '../lib/http';
import { requireMoneyAuthority } from '../lib/moneyAuthority';
import { purgeCatalogueAfterWrite } from '../lib/edgePolicy';
import { configIssues, publishIssues, type PrinterServicesConfig } from '@levonis/pricing/printerServices';
import {
  kitCatalogIssues,
  loadPrinterServices,
  orderServiceTasks,
  printerCatalogForMapping,
  publishDraft,
  saveDraft,
  unpublish,
} from '../lib/printerServices';

export const adminPrinterServiceRoutes = new Hono<AppContext>();
adminPrinterServiceRoutes.use('*', requireAdmin);
// A publish changes what every printer page quotes.
adminPrinterServiceRoutes.use('*', purgeCatalogueAfterWrite);

const revisionOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw badRequest('base_revision must be a whole number', 'PRINTER_SERVICES_INVALID');
  return v;
};

adminPrinterServiceRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const [{ state }, printers] = await Promise.all([loadPrinterServices(db), printerCatalogForMapping(db)]);
  return c.json({
    success: true,
    ...state,
    draft_issues: configIssues(state.draft),
    publish_issues: [...publishIssues(state.draft), ...(await kitCatalogIssues(db, state.draft))],
    printers,
  });
});

adminPrinterServiceRoutes.put('/draft', requireMoneyAuthority('printer_services'), async (c) => {
  const body = await c.req.json<{ draft?: unknown; base_revision?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const draft = (body as { draft?: unknown }).draft;
  if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
    const products = (draft as Partial<PrinterServicesConfig>).products;
    if (products && typeof products === 'object') {
      const printers = await printerCatalogForMapping(c.env.DB);
      const known = new Set(printers.map((p) => p.id));
      const notPrinters = Object.keys(products).filter((id) => !known.has(id));
      if (notPrinters.length) {
        throw badRequest('Only a product filed under a printer section can take the printer services.', 'PRINTER_SERVICES_NOT_PRINTER', { product_ids: notPrinters });
      }
      const mappedUsed = printers.filter((p) => p.is_used && Object.hasOwn(products, p.id)).map((p) => p.id);
      if (mappedUsed.length) {
        throw badRequest('A used or refurbished listing keeps its own warranty and cannot take the printer services.', 'PRINTER_SERVICES_USED_UNIT', { product_ids: mappedUsed });
      }
    }
  }
  const state = await saveDraft(c.env.DB, c.get('user')!.id, draft, revisionOf((body as { base_revision?: unknown }).base_revision));
  return c.json({ success: true, ...state, draft_issues: [], publish_issues: [...publishIssues(state.draft), ...(await kitCatalogIssues(c.env.DB, state.draft))] });
});

adminPrinterServiceRoutes.post('/publish', requireMoneyAuthority('printer_services_publish'), async (c) => {
  const body = await c.req.json<{ base_revision?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const state = await publishDraft(c.env.DB, c.get('user')!.id, revisionOf((body as { base_revision?: unknown }).base_revision), new Date().toISOString());
  return c.json({ success: true, ...state, draft_issues: [], publish_issues: [] });
});

adminPrinterServiceRoutes.post('/unpublish', requireMoneyAuthority('printer_services_publish'), async (c) => {
  const state = await unpublish(c.env.DB, c.get('user')!.id);
  return c.json({ success: true, ...state, draft_issues: configIssues(state.draft), publish_issues: publishIssues(state.draft) });
});

/**
 * THE WAREHOUSE'S TASKS (0234): a staff member marks the packing, the
 * inspection or the Academy arrangement done, once, with a note (required for
 * the inspection: what was checked and found; for Academy: the agreed time).
 *
 *   POST /api/admin/order-service-tasks/:id/done   { result_note }
 */
export const adminOrderServiceTaskRoutes = new Hono<AppContext>();
/** An order in one of these states has no warehouse work left: its tasks cannot be completed. */
const ENDED_ORDER: ReadonlySet<string> = new Set(['cancelled', 'returned', 'refunded']);
adminOrderServiceTaskRoutes.use('*', requireAdmin);

adminOrderServiceTaskRoutes.post('/:id/done', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ result_note?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const raw = (body as { result_note?: unknown }).result_note;
  const note = typeof raw === 'string' ? raw.trim().slice(0, 1000) : '';
  const task = await c.env.DB.prepare(
    `SELECT t.id, t.order_id, t.kind, t.status, o.status AS order_status
       FROM order_service_tasks t LEFT JOIN orders o ON o.id = t.order_id WHERE t.id = ?`
  ).bind(id).first<{ id: string; order_id: string; kind: string; status: string; order_status: string | null }>();
  if (!task) throw notFound('Task not found');
  if (task.status !== 'open') throw conflict('This task is already closed.', 'ORDER_SERVICE_TASK_CLOSED');
  if (task.order_status === null || ENDED_ORDER.has(task.order_status)) {
    throw conflict('This order was cancelled or returned; its service tasks cannot be completed.', 'ORDER_SERVICE_TASK_ORDER_ENDED');
  }
  if ((task.kind === 'inspection' || task.kind === 'academy') && note.length < 3) {
    throw badRequest(task.kind === 'inspection' ? 'Write what was checked and found.' : 'Write the agreed time and how the session is held.', 'ORDER_SERVICE_TASK_NOTE_REQUIRED');
  }
  const actor = c.get('user')!.id;
  const nowIso = new Date().toISOString();
  const ended = [...ENDED_ORDER];
  const [res] = await c.env.DB.batch([
    // Guarded on the order too: a cancel landing between the read and this write wins.
    c.env.DB.prepare(
      `UPDATE order_service_tasks SET status = 'done', result_note = ?, done_by = ?, done_at = ?
        WHERE id = ? AND status = 'open'
          AND EXISTS (SELECT 1 FROM orders o WHERE o.id = order_service_tasks.order_id AND o.status NOT IN (${ended.map(() => '?').join(',')}))`
    ).bind(note || null, actor, nowIso, id, ...ended),
    // The audit row only when THIS request closed the task: a lost race writes none.
    c.env.DB.prepare(
      `INSERT INTO audit_log (actor_id, action, target, detail)
       SELECT ?, 'order_service_task.done', ?, ?
        WHERE changes() = 1
          AND EXISTS (SELECT 1 FROM order_service_tasks WHERE id = ? AND status = 'done' AND done_by = ? AND done_at = ?)`
    ).bind(actor, task.order_id, JSON.stringify({ task_id: id, kind: task.kind }), id, actor, nowIso),
  ]);
  if (!res?.meta?.changes) throw conflict('This task or its order changed while you were editing — reload.', 'ORDER_SERVICE_TASK_CLOSED');
  return c.json({ success: true, tasks: await orderServiceTasks(c.env.DB, task.order_id) });
});
