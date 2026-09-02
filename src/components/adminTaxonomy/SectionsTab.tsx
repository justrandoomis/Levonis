/**
 * الأقسام — the tree. Main sections with their sub-sections underneath,
 * each with the template family it declares or inherits, its product count
 * and its state. Add a main section, add a sub-section under one, edit,
 * deactivate/activate, delete (the server deactivates instead when products
 * or sub-sections still use it, and says so).
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Power, CornerDownRight, Printer } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import {
  Actions,
  ActiveBadge,
  Badge,
  Check,
  Dialog,
  Empty,
  FAMILY_LABEL,
  FieldRow,
  SearchBox,
  Table,
  Toolbar,
  cell,
  errMsg,
  fmtN,
  mono,
  altNames,
  nameOf,
  setActive,
  useLoc,
  type CatalogNode,
  type NoticeState,
  type TemplateFamily,
} from './shared';

interface Props {
  catalogs: CatalogNode[];
  reload: () => Promise<void>;
  notify: (tone: NoticeState['tone'], text: string) => void;
}

interface EditState {
  node: CatalogNode | null;
  parentId: string | null;
}

export function SectionsTab({ catalogs, reload, notify }: Props) {
  const { loc, isEn, lang } = useLoc();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [del, setDel] = useState<CatalogNode | null>(null);
  const [busyId, setBusyId] = useState('');
  // The button a dialog would restore focus to is inside the row it deletes,
  // so focus would land on <body>. It goes to the tab's own action instead.
  const addRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = () => window.setTimeout(() => addRef.current?.focus(), 0);

  const byId = useMemo(() => new Map(catalogs.map((c) => [c.id, c])), [catalogs]);
  // A ROOT is a section with no parent — or one whose parent is missing, so a
  // row can never fall out of the screen because its parent was deleted.
  const roots = useMemo(
    () => catalogs.filter((c) => !c.parent_id || !byId.has(c.parent_id)).sort((a, b) => a.sort - b.sort),
    [catalogs, byId]
  );
  const childrenOf = useCallback(
    (id: string) => catalogs.filter((c) => c.parent_id === id).sort((a, b) => a.sort - b.sort),
    [catalogs]
  );

  const matches = (c: CatalogNode) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return `${c.name_ar} ${c.name_en} ${c.name_ckb} ${c.slug}`.toLowerCase().includes(s);
  };
  const visibleRoots = roots.filter((r) => matches(r) || childrenOf(r.id).some(matches));

  const toggle = async (node: CatalogNode) => {
    setBusyId(node.id);
    try {
      await setActive('/api/admin/taxonomy/catalogs', node.id, !node.active);
      await reload();
      notify('ok', node.active ? loc(`عُطّل القسم «${nameOf(node, lang)}».`, `Section "${nameOf(node, lang)}" deactivated.`) : loc(`فُعّل القسم «${nameOf(node, lang)}».`, `Section "${nameOf(node, lang)}" activated.`));
    } catch (e) {
      notify('bad', errMsg(e));
    } finally {
      setBusyId('');
    }
  };

  const familyCell = (c: CatalogNode) => {
    if (c.template_family) return <Badge tone="accent">{isEn ? FAMILY_LABEL[c.template_family].en : FAMILY_LABEL[c.template_family].ar}</Badge>;
    if (c.effective_template_family) {
      const f = FAMILY_LABEL[c.effective_template_family];
      return <Badge tone="neutral" title={loc('موروث من القسم الرئيسي', 'Inherited from the main section')}>{loc(`موروث · ${f.ar}`, `Inherited · ${f.en}`)}</Badge>;
    }
    return <Badge tone="warn" title={loc('بلا قالب: لا يمكن تنزيل قالب استيراد لهذا القسم', 'No family: no import template can be downloaded for it')}>{loc('بلا قالب', 'No family')}</Badge>;
  };

  const row = (c: CatalogNode, depth: number) => (
    <tr key={c.id} className={`${T.tableRow} ${c.active ? '' : 'opacity-60'}`} data-tax-row={c.id} data-tax-slug={c.slug}>
      <td className={cell}>
        <div className="flex items-center gap-2 min-w-0" style={depth ? { paddingInlineStart: depth * 20 } : undefined}>
          {depth ? <CornerDownRight className="w-3.5 h-3.5 text-[var(--ap-text-3)] shrink-0" aria-hidden /> : null}
          <div className="min-w-0">
            <div className={`truncate ${depth ? 'text-[var(--ap-text-1)]' : 'font-semibold text-[var(--ap-text-1)]'}`}>
              {nameOf(c, lang)}
              {c.is_printer_catalog && (
                <Printer className="inline w-3.5 h-3.5 ms-1.5 text-[var(--ap-text-3)] align-[-2px]" aria-label={loc('قسم طابعات', 'Printer section')} />
              )}
            </div>
            <div className="text-[11.5px] text-[var(--ap-text-3)] truncate">{altNames(c, lang)}</div>
          </div>
        </div>
      </td>
      <td className={cell}>
        <span className={mono} dir="ltr">
          {c.slug}
        </span>
      </td>
      <td className={cell}>{familyCell(c)}</td>
      <td className={`${cell} tabular-nums`}>{fmtN(c.product_count)}</td>
      <td className={cell}>
        <ActiveBadge active={c.active} />
      </td>
      <td className={cell}>
        <Actions>
          {depth === 0 && (
            <button type="button" className={T.btnIcon} onClick={() => setEdit({ node: null, parentId: c.id })} aria-label={loc('إضافة قسم فرعي', 'Add sub-section', 'بەشی لاوەکی زیادبکە')} title={loc('إضافة قسم فرعي', 'Add sub-section', 'بەشی لاوەکی زیادبکە')} data-tax-action="add-sub">
              <Plus className="w-4 h-4" aria-hidden />
            </button>
          )}
          <button type="button" className={T.btnIcon} onClick={() => setEdit({ node: c, parentId: c.parent_id })} aria-label={loc('تعديل', 'Edit')} title={loc('تعديل', 'Edit')} data-tax-action="edit">
            <Pencil className="w-4 h-4" aria-hidden />
          </button>
          <button type="button" className={T.btnIcon} onClick={() => void toggle(c)} disabled={busyId === c.id} aria-label={c.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} title={c.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} data-tax-action="toggle">
            <Power className="w-4 h-4" aria-hidden />
          </button>
          <button type="button" className={T.btnIconDanger} onClick={() => setDel(c)} aria-label={loc('حذف', 'Delete')} title={loc('حذف', 'Delete')} data-tax-action="delete">
            <Trash2 className="w-4 h-4" aria-hidden />
          </button>
        </Actions>
      </td>
    </tr>
  );

  /** A section and everything under it, to whatever depth the data holds. */
  const renderBranch = (c: CatalogNode, depth: number): React.ReactNode[] => {
    const kids = childrenOf(c.id);
    const shown = q.trim() ? kids.filter((k) => matches(k) || matches(c)) : kids;
    return [row(c, depth), ...shown.flatMap((k) => renderBranch(k, depth + 1))];
  };

  return (
    <div>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={loc('بحث في الأقسام…', 'Search sections…', 'گەڕان لە بەشەکان…')} testId="sections" />
        <div className="ms-auto flex items-center gap-2">
          <button ref={addRef} type="button" className={T.btnPrimary} onClick={() => setEdit({ node: null, parentId: null })} data-tax-add="section">
            <Plus className="w-4 h-4" aria-hidden />
            {loc('قسم رئيسي جديد', 'New main section')}
          </button>
        </div>
      </Toolbar>
      <p className="mb-3 text-[12px] text-[var(--ap-text-3)]">
        {loc(
          'القسم الرئيسي يحدد القالب (أجهزة أو مواد)، والأقسام الفرعية ترثه. القالب يقرر حقول المواصفات في نموذج المنتج وأعمدة ملف الاستيراد.',
          'The main section declares the template family (devices or materials) and sub-sections inherit it. The family decides the spec fields in the product form and the columns of the import file.'
        )}
      </p>

      {visibleRoots.length === 0 ? (
        <Empty text={catalogs.length === 0 ? loc('لا توجد أقسام بعد — أضف قسمًا رئيسيًا.', 'No sections yet — add a main section.') : loc('لا نتائج.', 'No results.')} />
      ) : (
        <Table head={[loc('القسم', 'Section'), 'slug', loc('القالب', 'Template'), loc('المنتجات', 'Products'), loc('الحالة', 'State'), '']}>
          {visibleRoots.map((r) => renderBranch(r, 0))}
        </Table>
      )}

      {edit && (
        <SectionDialog
          node={edit.node}
          parentId={edit.parentId}
          roots={roots}
          childCount={edit.node ? childrenOf(edit.node.id).length : 0}
          onClose={() => setEdit(null)}
          onSaved={async (created, name) => {
            setEdit(null);
            await reload();
            notify('ok', created ? loc(`أُضيف القسم «${name}».`, `Section "${name}" added.`) : loc(`حُفظ القسم «${name}».`, `Section "${name}" saved.`));
          }}
        />
      )}

      {del && (
        <Dialog
          titleAr="حذف قسم"
          titleEn="Delete section"
          danger
          saveLabel={loc('حذف', 'Delete')}
          onClose={() => setDel(null)}
          testId="delete-section"
          onSave={async () => {
            const res = await api.delete<{ deleted: boolean; deactivated: boolean; children?: number; products?: number; placements?: number }>(
              `/api/admin/taxonomy/catalogs/${encodeURIComponent(del.id)}`
            );
            setDel(null);
            restoreFocus();
            await reload();
            if (res.deleted) notify('ok', loc(`حُذف القسم «${nameOf(del, lang)}» نهائيًا.`, `Section "${nameOf(del, lang)}" deleted.`));
            else
              notify(
                'warn',
                loc(
                  `القسم «${nameOf(del, lang)}» مستخدم (${fmtN(res.products ?? 0)} منتج، ${fmtN(res.children ?? 0)} قسم فرعي، ${fmtN(res.placements ?? 0)} موضع) فتم تعطيله بدل حذفه.`,
                  `Section "${nameOf(del, lang)}" is in use (${fmtN(res.products ?? 0)} products, ${fmtN(res.children ?? 0)} sub-sections, ${fmtN(res.placements ?? 0)} placements), so it was deactivated instead of deleted.`
                )
              );
          }}
        >
          <p className="text-[13px] text-[var(--ap-text-1)]">
            {loc(`حذف «${nameOf(del, lang)}»؟`, `Delete "${nameOf(del, lang)}"?`)}
          </p>
          <p className="text-[12px] text-[var(--ap-text-3)]">
            {loc(
              'يُحذف نهائيًا إن لم يكن عليه منتجات أو أقسام فرعية. وإلا يُعطَّل فقط حتى لا تفقد المنتجات والطلبات القديمة قسمها.',
              'Deleted for good when no products or sub-sections use it; otherwise it is deactivated so existing products and past orders keep their section.'
            )}
          </p>
        </Dialog>
      )}
    </div>
  );
}

function SectionDialog({
  node,
  parentId,
  roots,
  childCount,
  onClose,
  onSaved,
}: {
  node: CatalogNode | null;
  parentId: string | null;
  roots: CatalogNode[];
  /** How many sub-sections this section already has. */
  childCount: number;
  onClose: () => void;
  onSaved: (created: boolean, name: string) => Promise<void>;
}) {
  const { loc, lang } = useLoc();
  const [nameEn, setNameEn] = useState(node?.name_en ?? '');
  const [nameAr, setNameAr] = useState(node?.name_ar ?? '');
  const [nameCkb, setNameCkb] = useState(node?.name_ckb ?? '');
  const [slug, setSlug] = useState(node?.slug ?? '');
  const [parent, setParent] = useState<string>(parentId ?? '');
  const [family, setFamily] = useState<'' | TemplateFamily>(node?.template_family ?? '');
  const [sort, setSort] = useState(String(node?.sort ?? 0));
  const [printer, setPrinter] = useState(node?.is_printer_catalog ?? false);
  const [active, setActiveState] = useState(node?.active ?? true);

  const parentNode = parent ? roots.find((r) => r.id === parent) : undefined;
  const isSub = !!parent;
  // A section that already has sub-sections cannot itself be filed under one:
  // the product model is exactly two levels deep (category + sub_category),
  // and a third level would be a section no product could ever be put in.
  const hasChildren = childCount > 0;
  const dirty =
    nameEn !== (node?.name_en ?? '') ||
    nameAr !== (node?.name_ar ?? '') ||
    nameCkb !== (node?.name_ckb ?? '') ||
    slug !== (node?.slug ?? '') ||
    parent !== (parentId ?? '') ||
    family !== (node?.template_family ?? '') ||
    sort !== String(node?.sort ?? 0) ||
    printer !== (node?.is_printer_catalog ?? false) ||
    active !== (node?.active ?? true);

  const title = node
    ? { ar: 'تعديل قسم', en: 'Edit section' }
    : isSub
      ? { ar: `قسم فرعي جديد تحت «${parentNode ? nameOf(parentNode, lang) : ''}»`, en: `New sub-section under "${parentNode ? nameOf(parentNode, lang) : ''}"` }
      : { ar: 'قسم رئيسي جديد', en: 'New main section' };

  return (
    <Dialog
      titleAr={title.ar}
      titleEn={title.en}
      onClose={onClose}
      dirty={dirty}
      testId="section"
      onSave={async () => {
        if (!nameEn.trim()) throw new Error(loc('الاسم بالإنجليزية مطلوب.', 'The English name is required.'));
        const body: Record<string, unknown> = {
          ...(node ? { id: node.id } : {}),
          name_en: nameEn.trim(),
          name_ar: nameAr.trim(),
          name_ckb: nameCkb.trim(),
          parent_id: parent || null,
          template_family: family || null,
          sort: Number(sort) || 0,
          is_printer_catalog: printer,
          active,
        };
        if (slug.trim()) body.slug = slug.trim();
        const res = await api.post<{ created: boolean; catalog: { name_ar: string; name_en: string } }>('/api/admin/taxonomy/catalogs', body);
        await onSaved(res.created, nameOf(res.catalog, lang));
      }}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FieldRow id="sec-name-en" label={loc('الاسم بالإنجليزية', 'English name')} required ltr>
          <input id="sec-name-en" className={`${T.input} w-full`} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </FieldRow>
        <FieldRow id="sec-name-ar" label={loc('الاسم بالعربية', 'Arabic name')} hint={loc('يظهر للزبائن في الواجهة العربية', 'Shown to customers in the Arabic UI')}>
          <input id="sec-name-ar" className={`${T.input} w-full`} value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
        </FieldRow>
        <FieldRow id="sec-name-ckb" label={loc('الاسم بالكردية', 'Kurdish name')}>
          <input id="sec-name-ckb" className={`${T.input} w-full`} value={nameCkb} onChange={(e) => setNameCkb(e.target.value)} dir="rtl" />
        </FieldRow>
        <FieldRow id="sec-slug" label="slug" hint={loc('اتركه فارغًا ليُشتق من الاسم الإنجليزي', 'Leave empty to derive it from the English name')} ltr>
          <input id="sec-slug" className={`${T.input} w-full font-mono`} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto" />
        </FieldRow>
        <FieldRow
          id="sec-parent"
          label={loc('القسم الرئيسي', 'Main section')}
          hint={
            hasChildren
              ? loc(
                  `هذا القسم يحمل ${childCount} قسمًا فرعيًا، فلا يمكن جعله فرعيًا بدوره — المنتج يحمل قسمًا رئيسيًا وفرعيًا فقط. انقل الأقسام الفرعية أولًا.`,
                  `This section has ${childCount} sub-sections, so it cannot become one itself — a product carries a main and a sub-section, nothing deeper. Move its sub-sections first.`
                )
              : loc('بدون = هذا قسم رئيسي', 'None = this is a main section')
          }
        >
          <select
            id="sec-parent"
            className={`${T.select} w-full px-3`}
            value={parent}
            disabled={hasChildren}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">{loc('— قسم رئيسي —', '— main section —')}</option>
            {roots
              .filter((r) => r.id !== node?.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {nameOf(r, lang)}
                </option>
              ))}
          </select>
        </FieldRow>
        <FieldRow
          id="sec-family"
          label={loc('القالب', 'Template family')}
          hint={
            isSub
              ? loc('يرث قالب القسم الرئيسي ما لم تحدد غيره', 'Inherits the main section’s family unless set here')
              : loc('مطلوب لتنزيل قالب الاستيراد ولإظهار حقول المواصفات', 'Required for the import template and the spec fields')
          }
        >
          <select id="sec-family" className={`${T.select} w-full px-3`} value={family} onChange={(e) => setFamily(e.target.value as '' | TemplateFamily)}>
            <option value="">
              {isSub
                ? parentNode?.effective_template_family
                  ? loc(`موروث (${FAMILY_LABEL[parentNode.effective_template_family].ar})`, `Inherited (${FAMILY_LABEL[parentNode.effective_template_family].en})`)
                  : loc('موروث', 'Inherited')
                : loc('— بلا قالب —', '— none —')}
            </option>
            <option value="devices">{loc('الأجهزة · Devices', 'Devices · الأجهزة')}</option>
            <option value="materials">{loc('المواد · Materials', 'Materials · المواد')}</option>
          </select>
        </FieldRow>
        <FieldRow id="sec-sort" label={loc('الترتيب', 'Sort')} ltr>
          <input id="sec-sort" type="number" min={0} className={`${T.input} w-full`} value={sort} onChange={(e) => setSort(e.target.value)} />
        </FieldRow>
        <div className="grid gap-2.5 content-end">
          <Check id="sec-printer" label={loc('قسم طابعات', 'Printer section')} hint={loc('يُستخدم في صفحات الطابعات والملحقات', 'Used by the printers and accessories pages')} checked={printer} onChange={setPrinter} />
          <Check id="sec-active" label={loc('مفعّل', 'Active')} hint={loc('القسم المعطّل لا يظهر في النموذج ولا في القالب', 'An inactive section is offered neither by the form nor by the template')} checked={active} onChange={setActiveState} />
        </div>
      </div>
    </Dialog>
  );
}
