/**
 * الهاشتاقات — the managed vocabulary (migration 0041) merged with what the
 * products actually carry. Add a tag, rename it (every product that carries
 * it is rewritten), deactivate it (kept on products, no longer suggested),
 * delete it (optionally stripping it from the products), and adopt or strip
 * a tag that exists on products without a vocabulary row.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Power, Check as CheckIcon, Eraser } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import {
  Actions,
  ActiveBadge,
  Badge,
  Check,
  Dialog,
  Empty,
  FieldRow,
  SearchBox,
  Table,
  Toolbar,
  cell,
  errMsg,
  fmtN,
  setActive,
  useLoc,
  type HashtagRow,
  type NoticeState,
} from './shared';

interface Props {
  hashtags: HashtagRow[];
  reload: () => Promise<void>;
  notify: (tone: NoticeState['tone'], text: string) => void;
}

/** The same rule worker/lib/hashtags.ts applies, so the row reads as it saves. */
const cleanTag = (raw: string) =>
  raw
    .replace(/^[#\s]+/, '')
    .replace(/[|,]+/g, '-')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

export function HashtagsTab({ hashtags, reload, notify }: Props) {
  const { loc } = useLoc();
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [draftAr, setDraftAr] = useState('');
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<HashtagRow | null>(null);
  const [del, setDel] = useState<HashtagRow | null>(null);
  const [strip, setStrip] = useState<HashtagRow | null>(null);
  const [busyKey, setBusyKey] = useState('');
  // The row a dialog would hand focus back to is gone once it is deleted, so
  // focus goes to the add field instead of falling to <body>.
  const addRef = useRef<HTMLInputElement>(null);
  const restoreFocus = () => window.setTimeout(() => addRef.current?.focus(), 0);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/^#/, '');
    const rows = s ? hashtags.filter((h) => `${h.tag} ${h.name_ar}`.toLowerCase().includes(s)) : hashtags;
    return [...rows].sort((a, b) => Number(b.managed) - Number(a.managed) || a.sort - b.sort || b.product_count - a.product_count || a.tag.localeCompare(b.tag));
  }, [hashtags, q]);

  const add = async () => {
    const tag = cleanTag(draft);
    if (!tag) {
      setAddErr(loc('اكتب الوسم أولًا.', 'Type the tag first.'));
      return;
    }
    setAdding(true);
    setAddErr(null);
    try {
      const res = await api.post<{ created: boolean }>('/api/admin/taxonomy/hashtags', { tag, name_ar: draftAr.trim() });
      setDraft('');
      setDraftAr('');
      await reload();
      notify('ok', res.created ? loc(`أُضيف الوسم #${tag}.`, `Hashtag #${tag} added.`) : loc(`الوسم #${tag} موجود مسبقًا وتم تحديثه.`, `Hashtag #${tag} already existed and was updated.`));
    } catch (e) {
      setAddErr(errMsg(e));
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (h: HashtagRow) => {
    setBusyKey(h.tag);
    try {
      await setActive('/api/admin/taxonomy/hashtags', h.id, !h.active);
      await reload();
      notify('ok', h.active ? loc(`عُطّل الوسم #${h.tag} — يبقى على المنتجات ولا يُقترح بعد الآن.`, `Hashtag #${h.tag} deactivated — it stays on products and is no longer suggested.`) : loc(`فُعّل الوسم #${h.tag}.`, `Hashtag #${h.tag} activated.`));
    } catch (e) {
      notify('bad', errMsg(e));
    } finally {
      setBusyKey('');
    }
  };

  const adopt = async (h: HashtagRow) => {
    setBusyKey(h.tag);
    try {
      await api.post('/api/admin/taxonomy/hashtags', { tag: h.tag });
      await reload();
      notify('ok', loc(`اعتُمد الوسم #${h.tag} في القائمة.`, `Hashtag #${h.tag} adopted into the list.`));
    } catch (e) {
      notify('bad', errMsg(e));
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div>
      <div className={`${T.surface} p-3 mb-3`}>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
          data-tax-add-form="hashtag"
        >
          <FieldRow id="tag-new" label={loc('وسم جديد', 'New hashtag')} ltr>
            <input ref={addRef} id="tag-new" className={`${T.input} w-full sm:w-56`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="#pla" autoComplete="off" />
          </FieldRow>
          <FieldRow id="tag-new-ar" label={loc('التسمية بالعربية (اختياري)', 'Arabic label (optional)')}>
            <input id="tag-new-ar" className={`${T.input} w-full sm:w-48`} value={draftAr} onChange={(e) => setDraftAr(e.target.value)} dir="rtl" />
          </FieldRow>
          <button type="submit" className={`${T.btnPrimary} h-10`} disabled={adding} data-tax-add="hashtag">
            <Plus className="w-4 h-4" aria-hidden />
            {loc('إضافة', 'Add')}
          </button>
          {addErr && (
            <span className="text-[12px] text-[var(--ap-danger)]" role="alert">
              {addErr}
            </span>
          )}
        </form>
        <p className="mt-2 text-[12px] text-[var(--ap-text-3)]">
          {loc(
            'الوسوم هنا تُقترح في نموذج المنتج وتُدرج في قالب الاستيراد. وسم يُكتب يدويًا في النموذج أو في ملف استيراد يُضاف إلى هذه القائمة تلقائيًا.',
            'Tags here are suggested in the product form and listed in the import template. A tag typed by hand in the form or in an import file is added to this list automatically.'
          )}
        </p>
      </div>

      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={loc('بحث في الوسوم…', 'Search hashtags…')} testId="hashtags" />
      </Toolbar>

      {list.length === 0 ? (
        <Empty text={hashtags.length === 0 ? loc('لا توجد وسوم بعد.', 'No hashtags yet.') : loc('لا نتائج.', 'No results.')} />
      ) : (
        <Table head={[loc('الوسم', 'Hashtag'), loc('التسمية', 'Label'), loc('المنتجات', 'Products'), loc('الحالة', 'State'), '']} minWidth={560}>
          {list.map((h) => (
            <tr key={h.id || `raw:${h.tag}`} className={`${T.tableRow} ${h.active ? '' : 'opacity-60'}`} data-tax-row={h.id || ''} data-tax-tag={h.tag}>
              <td className={cell}>
                {/* One isolated run for hash + tag: with the # outside, an
                    Arabic tag would render it on the wrong side. */}
                <bdi className="font-mono text-[13px] text-[var(--ap-text-1)]">#{h.tag}</bdi>
              </td>
              <td className={cell}>{h.name_ar || <span className="text-[var(--ap-text-3)]">—</span>}</td>
              <td className={`${cell} tabular-nums`}>{fmtN(h.product_count)}</td>
              <td className={cell}>
                {h.managed ? (
                  <ActiveBadge active={h.active} />
                ) : (
                  <Badge tone="warn" title={loc('موجود على منتجات لكنه ليس في القائمة بعد', 'Carried by products but not in the list yet')}>
                    {loc('غير مُعتمد', 'Unlisted')}
                  </Badge>
                )}
              </td>
              <td className={cell}>
                <Actions>
                  {h.managed ? (
                    <>
                      <button type="button" className={T.btnIcon} onClick={() => setEdit(h)} aria-label={loc('تعديل / إعادة تسمية', 'Edit / rename')} title={loc('تعديل / إعادة تسمية', 'Edit / rename')} data-tax-action="edit">
                        <Pencil className="w-4 h-4" aria-hidden />
                      </button>
                      <button type="button" className={T.btnIcon} onClick={() => void toggle(h)} disabled={busyKey === h.tag} aria-label={h.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} title={h.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} data-tax-action="toggle">
                        <Power className="w-4 h-4" aria-hidden />
                      </button>
                      <button type="button" className={T.btnIconDanger} onClick={() => setDel(h)} aria-label={loc('حذف', 'Delete')} title={loc('حذف', 'Delete')} data-tax-action="delete">
                        <Trash2 className="w-4 h-4" aria-hidden />
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className={`${T.btnGhostSm}`} onClick={() => void adopt(h)} disabled={busyKey === h.tag} data-tax-action="adopt">
                        <CheckIcon className="w-3.5 h-3.5" aria-hidden />
                        {loc('اعتماد', 'Adopt')}
                      </button>
                      <button type="button" className={T.btnIconDanger} onClick={() => setStrip(h)} aria-label={loc('إزالة من المنتجات', 'Remove from products')} title={loc('إزالة من المنتجات', 'Remove from products')} data-tax-action="strip">
                        <Eraser className="w-4 h-4" aria-hidden />
                      </button>
                    </>
                  )}
                </Actions>
              </td>
            </tr>
          ))}
        </Table>
      )}

      {edit && (
        <HashtagDialog
          row={edit}
          onClose={() => setEdit(null)}
          onSaved={async (tag, productsUpdated) => {
            setEdit(null);
            await reload();
            notify(
              'ok',
              productsUpdated > 0
                ? loc(`حُفظ الوسم #${tag} وأُعيدت كتابته في ${fmtN(productsUpdated)} منتج.`, `Hashtag #${tag} saved and rewritten on ${fmtN(productsUpdated)} products.`)
                : loc(`حُفظ الوسم #${tag}.`, `Hashtag #${tag} saved.`)
            );
          }}
        />
      )}

      {del && (
        <DeleteHashtagDialog
          row={del}
          onClose={() => setDel(null)}
          onDone={async (stripped) => {
            setDel(null);
            restoreFocus();
            await reload();
            notify('ok', stripped > 0 ? loc(`حُذف الوسم #${del.tag} وأُزيل من ${fmtN(stripped)} منتج.`, `Hashtag #${del.tag} deleted and removed from ${fmtN(stripped)} products.`) : loc(`حُذف الوسم #${del.tag} من القائمة.`, `Hashtag #${del.tag} removed from the list.`));
          }}
        />
      )}

      {strip && (
        <Dialog
          titleAr="إزالة وسم من المنتجات"
          titleEn="Remove a hashtag from products"
          danger
          saveLabel={loc('إزالة', 'Remove')}
          onClose={() => setStrip(null)}
          testId="strip-hashtag"
          onSave={async () => {
            const res = await api.post<{ products_updated: number }>('/api/admin/taxonomy/hashtags/strip', { tag: strip.tag });
            setStrip(null);
            restoreFocus();
            await reload();
            notify('ok', loc(`أُزيل #${strip.tag} من ${fmtN(res.products_updated)} منتج.`, `#${strip.tag} removed from ${fmtN(res.products_updated)} products.`));
          }}
        >
          <p className="text-[13px] text-[var(--ap-text-1)]">
            {loc(`إزالة #${strip.tag} من ${fmtN(strip.product_count)} منتج؟`, `Remove #${strip.tag} from ${fmtN(strip.product_count)} products?`)}
          </p>
          <p className="text-[12px] text-[var(--ap-text-3)]">{loc('لا يمكن التراجع عن ذلك.', 'This cannot be undone.')}</p>
        </Dialog>
      )}
    </div>
  );
}

function HashtagDialog({ row, onClose, onSaved }: { row: HashtagRow; onClose: () => void; onSaved: (tag: string, productsUpdated: number) => Promise<void> }) {
  const { loc } = useLoc();
  const [tag, setTag] = useState(row.tag);
  const [nameAr, setNameAr] = useState(row.name_ar);
  const [sort, setSort] = useState(String(row.sort));
  const [active, setActiveState] = useState(row.active);
  const renamed = cleanTag(tag) !== row.tag;
  const dirty = renamed || nameAr !== row.name_ar || sort !== String(row.sort) || active !== row.active;
  return (
    <Dialog
      titleAr="تعديل وسم"
      titleEn="Edit hashtag"
      onClose={onClose}
      dirty={dirty}
      testId="hashtag"
      onSave={async () => {
        const clean = cleanTag(tag);
        if (!clean) throw new Error(loc('الوسم مطلوب.', 'The tag is required.'));
        const res = await api.post<{ products_updated: number }>('/api/admin/taxonomy/hashtags', {
          id: row.id,
          tag: clean,
          name_ar: nameAr.trim(),
          sort: Number(sort) || 0,
          active,
        });
        await onSaved(clean, res.products_updated ?? 0);
      }}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FieldRow id="tag-edit" label={loc('الوسم', 'Hashtag')} required ltr hint={renamed && row.product_count > 0 ? loc(`إعادة التسمية ستُعيد كتابة الوسم في ${fmtN(row.product_count)} منتج.`, `Renaming rewrites the tag on ${fmtN(row.product_count)} products.`) : undefined}>
          <input id="tag-edit" className={`${T.input} w-full font-mono`} value={tag} onChange={(e) => setTag(e.target.value)} />
        </FieldRow>
        <FieldRow id="tag-edit-ar" label={loc('التسمية بالعربية', 'Arabic label')}>
          <input id="tag-edit-ar" className={`${T.input} w-full`} value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
        </FieldRow>
        <FieldRow id="tag-edit-sort" label={loc('الترتيب', 'Sort')} ltr>
          <input id="tag-edit-sort" type="number" min={0} className={`${T.input} w-full`} value={sort} onChange={(e) => setSort(e.target.value)} />
        </FieldRow>
        <div className="content-end">
          <Check id="tag-edit-active" label={loc('مفعّل', 'Active')} hint={loc('المعطّل يبقى على المنتجات ولا يُقترح', 'Inactive stays on products and is not suggested')} checked={active} onChange={setActiveState} />
        </div>
      </div>
    </Dialog>
  );
}

function DeleteHashtagDialog({ row, onClose, onDone }: { row: HashtagRow; onClose: () => void; onDone: (stripped: number) => Promise<void> }) {
  const { loc } = useLoc();
  const [strip, setStrip] = useState(false);
  return (
    <Dialog
      titleAr="حذف وسم"
      titleEn="Delete hashtag"
      danger
      saveLabel={loc('حذف', 'Delete')}
      onClose={onClose}
      testId="delete-hashtag"
      onSave={async () => {
        const res = await api.delete<{ products_updated: number }>(`/api/admin/taxonomy/hashtags/${encodeURIComponent(row.id)}${strip ? '?strip=1' : ''}`);
        await onDone(res.products_updated ?? 0);
      }}
    >
      <p className="text-[13px] text-[var(--ap-text-1)]">{loc(`حذف #${row.tag} من القائمة؟`, `Delete #${row.tag} from the list?`)}</p>
      {row.product_count > 0 ? (
        <Check
          id="tag-del-strip"
          label={loc(`أزل الوسم من المنتجات أيضًا (${fmtN(row.product_count)} منتج)`, `Also remove it from the products (${fmtN(row.product_count)} products)`)}
          hint={loc(
            'بدون هذا الخيار يبقى الوسم على المنتجات ويظهر هنا كوسم غير مُعتمد — ويعود إلى القائمة تلقائيًا عند أول حفظ لأي منتج يحمله.',
            'Without this the tag stays on the products and shows here as unlisted — and rejoins the list the next time any product carrying it is saved.'
          )}
          checked={strip}
          onChange={setStrip}
        />
      ) : (
        <p className="text-[12px] text-[var(--ap-text-3)]">{loc('لا يحمله أي منتج.', 'No product carries it.')}</p>
      )}
    </Dialog>
  );
}
