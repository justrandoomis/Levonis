/**
 * الأقسام — the tree. Main sections with their sub-sections underneath,
 * each with the template family it declares or inherits, its product count
 * and its state. Add a main section, add a sub-section under one, edit,
 * deactivate/activate, delete (the server deactivates instead when products
 * or sub-sections still use it, and says so).
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Power, CornerDownRight, Printer, Image as ImageIcon, Upload, RefreshCw, Truck, GalleryHorizontal, ArrowUp, ArrowDown, Moon, Sun, Monitor, Smartphone, Lock, ScanLine } from 'lucide-react';
import { SectionDeliveryDialog, deliveryRuleSummary } from './SectionDeliveryDialog';
import * as T from '../adminProducts/theme';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { Segmented } from '../ui/Segmented';
import { serialStrings } from '../adminOrders/serials/strings';
import { Modal } from '../adminProducts/ui';
import {
  bannerSet,
  cardSet,
  pickPictureOrigin,
  type PictureOrigin,
  type PictureScreen,
  type PictureTheme,
} from '../../lib/catalog/sectionPictures';
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

/** Mirrors worker/routes/adminTaxonomy.ts CATALOG_DESCRIPTION_MAX. */
const DESCRIPTION_MAX = 280;
const DESC_CLASS = `${T.input} w-full h-auto min-h-[64px] py-2 leading-relaxed resize-y`;

/**
 * Which picture a dialog edits (worker CATALOG_PICTURES): the home tile's
 * card, or the banner — each a set of four, dark and light, a large screen
 * and a phone (`PICTURE_SLOTS` below).
 */
type PictureKind = 'image' | 'banner';

interface EditState {
  node: CatalogNode | null;
  parentId: string | null;
}

export function SectionsTab({ catalogs, reload, notify }: Props) {
  const { loc, isEn, lang } = useLoc();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [del, setDel] = useState<CatalogNode | null>(null);
  const [picture, setPicture] = useState<{ node: CatalogNode; kind: PictureKind } | null>(null);
  const [deliveryFor, setDeliveryFor] = useState<CatalogNode | null>(null);
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

  /**
   * THE ORDER THE SHOP SHOWS (owner, 2026-09-26: «الطابعة رقم واحد ملحقات
   * الطابعة رقم اثنين مواد الطباعه رقم ثلاثة»). Up / down move a section one
   * place among its siblings — main sections among main sections, a
   * sub-section under its own parent — and the whole level is saved at once
   * (worker POST /catalogs/order). Buttons, not a drag: they work the same
   * with a finger on the owner's iPad, a mouse and a keyboard.
   */
  const siblingsOf = (c: CatalogNode) => (!c.parent_id || !byId.has(c.parent_id) ? roots : childrenOf(c.parent_id));
  const move = async (c: CatalogNode, delta: -1 | 1) => {
    const level = siblingsOf(c).map((x) => x.id);
    const from = level.indexOf(c.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= level.length) return;
    [level[from], level[to]] = [level[to], level[from]];
    setBusyId(c.id);
    try {
      await api.post('/api/admin/taxonomy/catalogs/order', { parent_id: !c.parent_id || !byId.has(c.parent_id) ? null : c.parent_id, ids: level });
      await reload();
      // OWNER: Sorani to be written by hand.
      notify('ok', loc(`«${nameOf(c, lang)}» الآن رقم ${to + 1}.`, `"${nameOf(c, lang)}" is now number ${to + 1}.`));
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
          {/* THE PICTURE SITS BESIDE THE NAME, NOT IN A COLUMN OF ITS OWN.
              It is an attribute of the section the way its name is, and a
              seventh column on a table that is already six wide would push the
              actions off a laptop screen. A DARK plate, because the home page
              is dark: a preview on white would hide exactly the mistake — an
              image exported on a white matte — that this screen exists to let
              the owner catch. */}
          <span className="w-9 h-9 shrink-0 rounded-lg bg-black border border-[var(--ap-border)] grid place-items-center overflow-hidden">
            {c.image_url ? (
              <img src={c.image_url} alt="" width={36} height={36} loading="lazy" decoding="async" className="w-full h-full object-cover" />
            ) : (
              <ImageIcon className="w-4 h-4 text-[var(--ap-text-3)]" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <div className={`truncate ${depth ? 'text-[var(--ap-text-1)]' : 'font-semibold text-[var(--ap-text-1)]'}`}>
              {nameOf(c, lang)}
              {c.is_printer_catalog && (
                <Printer className="inline w-3.5 h-3.5 ms-1.5 text-[var(--ap-text-3)] align-[-2px]" aria-label={loc('قسم طابعات', 'Printer section')} />
              )}
              {(c.serial_policy === 'required' || c.serial_policy === 'off') && (
                <span className="ms-1.5 align-[1px]" data-tax-serial-policy={c.serial_policy}>
                  <Badge tone={c.serial_policy === 'required' ? 'accent' : 'neutral'}>
                    <ScanLine className="inline w-3 h-3 me-1 align-[-2px]" aria-hidden />
                    {c.serial_policy === 'required' ? serialStrings(lang).sectionBadgeRequired : serialStrings(lang).sectionBadgeOff}
                  </Badge>
                </span>
              )}
            </div>
            <div className="text-[11.5px] text-[var(--ap-text-3)] truncate">
              <span className="tabular-nums" data-tax-position>{`#${siblingsOf(c).findIndex((x) => x.id === c.id) + 1}`}</span>
              {altNames(c, lang) ? ` · ${altNames(c, lang)}` : ''}
            </div>
            {deliveryRuleSummary(c.delivery_rules, loc) && (
              <div className="text-[11.5px] text-[var(--ap-accent)] truncate" data-tax-delivery-summary>
                <Truck className="inline w-3.5 h-3.5 me-1 align-[-2px]" aria-hidden />
                {deliveryRuleSummary(c.delivery_rules, loc)}
              </div>
            )}
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
          {(() => {
            const level = siblingsOf(c);
            const at = level.findIndex((x) => x.id === c.id);
            // OWNER: Sorani to be written by hand (both labels).
            return (
              <>
                <button
                  type="button"
                  className={T.btnIcon}
                  onClick={() => void move(c, -1)}
                  disabled={at <= 0 || busyId === c.id}
                  aria-label={loc(`تقديم «${nameOf(c, lang)}» مكانًا واحدًا`, `Move "${nameOf(c, lang)}" up one place`)}
                  title={loc('تقديم (يظهر قبل)', 'Move up (shown earlier)')}
                  data-tax-action="move-up"
                >
                  <ArrowUp className="w-4 h-4" aria-hidden />
                </button>
                <button
                  type="button"
                  className={T.btnIcon}
                  onClick={() => void move(c, 1)}
                  disabled={at < 0 || at >= level.length - 1 || busyId === c.id}
                  aria-label={loc(`تأخير «${nameOf(c, lang)}» مكانًا واحدًا`, `Move "${nameOf(c, lang)}" down one place`)}
                  title={loc('تأخير (يظهر بعد)', 'Move down (shown later)')}
                  data-tax-action="move-down"
                >
                  <ArrowDown className="w-4 h-4" aria-hidden />
                </button>
              </>
            );
          })()}
          {depth === 0 && (
            <button type="button" className={T.btnIcon} onClick={() => setEdit({ node: null, parentId: c.id })} aria-label={loc('إضافة قسم فرعي', 'Add sub-section', 'بەشی لاوەکی زیادبکە')} title={loc('إضافة قسم فرعي', 'Add sub-section', 'بەشی لاوەکی زیادبکە')} data-tax-action="add-sub">
              <Plus className="w-4 h-4" aria-hidden />
            </button>
          )}
          <button type="button" className={T.btnIcon} onClick={() => setEdit({ node: c, parentId: c.parent_id })} aria-label={loc('تعديل', 'Edit')} title={loc('تعديل', 'Edit')} data-tax-action="edit">
            <Pencil className="w-4 h-4" aria-hidden />
          </button>
          <button
            type="button"
            className={T.btnIcon}
            onClick={() => setPicture({ node: c, kind: 'image' })}
            aria-label={loc('صورة القسم', 'Section image', 'وێنەی بەش')}
            title={loc('صورة القسم في الواجهة الرئيسية', 'The section’s picture on the home page')}
            data-tax-action="image"
          >
            <ImageIcon className="w-4 h-4" aria-hidden />
          </button>
          {/* OWNER: Sorani to be written by hand. */}
          <button
            type="button"
            className={T.btnIcon}
            onClick={() => setPicture({ node: c, kind: 'banner' })}
            aria-label={loc('صور بانر القسم (فاتح وداكن)', 'Section banner pictures (light and dark)')}
            title={loc('صورة البانر للثيم الفاتح وللثيم الداكن: شريط القسم في «كل الفئات» وأعلى صفحته', 'The banner picture for the light and the dark theme: the section’s row in «All categories» and the top of its page')}
            data-tax-action="banner"
          >
            <GalleryHorizontal className="w-4 h-4" aria-hidden />
          </button>
          <button
            type="button"
            className={T.btnIcon}
            onClick={() => setDeliveryFor(c)}
            aria-label={loc('قاعدة توصيل القسم', 'Section delivery rule')}
            title={loc('رسم توصيل موحّد لكل القسم حسب العدد', 'One quantity-based delivery fee for the whole section')}
            data-tax-action="delivery"
          >
            <Truck className="w-4 h-4" aria-hidden />
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
          'القسم الرئيسي يحدد القالب (أجهزة أو مواد)، والأقسام الفرعية ترثه. القالب يقرر حقول المواصفات في نموذج المنتج وأعمدة ملف الاستيراد. سهما الترتيب يقرران ترتيب الأقسام في «كل الفئات» وترتيب الأقسام الفرعية داخل صفحة قسمها.',
          'The main section declares the template family (devices or materials) and sub-sections inherit it. The family decides the spec fields in the product form and the columns of the import file. The order arrows decide the order of the sections in «All categories» and of the sub-sections on their section’s page.'
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

      {deliveryFor && (
        <SectionDeliveryDialog
          node={deliveryFor}
          onClose={() => {
            setDeliveryFor(null);
            restoreFocus();
          }}
          onSaved={async () => {
            const name = nameOf(deliveryFor, lang);
            setDeliveryFor(null);
            restoreFocus();
            await reload();
            notify('ok', loc(`حُفظت قاعدة توصيل «${name}».`, `Delivery rule for "${name}" saved.`));
          }}
        />
      )}

      {picture && (
        <SectionImageDialog
          node={picture.node}
          kind={picture.kind}
          onClose={() => {
            setPicture(null);
            restoreFocus();
          }}
          onChanged={async (removed) => {
            await reload();
            notify(
              'ok',
              removed
                ? loc(`أُزيلت صورة «${nameOf(picture.node, lang)}».`, `The picture on "${nameOf(picture.node, lang)}" was removed.`)
                : loc(`حُفظت صورة «${nameOf(picture.node, lang)}».`, `The picture on "${nameOf(picture.node, lang)}" was saved.`)
            );
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
  // §29 (0177): the section's serial policy and the printer flag are the
  // owner's; everyone else sees both with a lock (the server refuses them).
  const { user } = useAuth();
  const owner = !!user?.is_owner;
  const ss = serialStrings(lang);
  const policyInstalled = node ? node.serial_policy !== undefined : roots.some((r) => r.serial_policy !== undefined);
  const policy0 = node?.serial_policy ?? 'inherit';
  const [serialPolicy, setSerialPolicy] = useState<'inherit' | 'required' | 'off'>(policy0);
  // The category page's description (0136). Written by hand in each language;
  // an empty one is simply not shown — the page never invents a line.
  const [descAr, setDescAr] = useState(node?.description_ar ?? '');
  const [descEn, setDescEn] = useState(node?.description_en ?? '');
  const [descCkb, setDescCkb] = useState(node?.description_ckb ?? '');

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
    serialPolicy !== policy0 ||
    active !== (node?.active ?? true) ||
    descAr !== (node?.description_ar ?? '') ||
    descEn !== (node?.description_en ?? '') ||
    descCkb !== (node?.description_ckb ?? '');

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
          description_ar: descAr.trim(),
          description_en: descEn.trim(),
          description_ckb: descCkb.trim(),
        };
        if (slug.trim()) body.slug = slug.trim();
        const res = await api.post<{ created: boolean; catalog: { id: string; name_ar: string; name_en: string } }>('/api/admin/taxonomy/catalogs', body);
        // The serial policy has its own owner-only door, applied right after
        // the section exists (a new one has no id before this).
        if (owner && policyInstalled && serialPolicy !== policy0 && res.catalog?.id) {
          await api.put(`/api/admin/taxonomy/catalogs/${encodeURIComponent(res.catalog.id)}/serial-policy`, { policy: serialPolicy });
        }
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
          <Check
            id="sec-printer"
            label={loc('قسم طابعات', 'Printer section', 'بەشی چاپکەرەکان')}
            hint={owner ? loc('يُستخدم في صفحات الطابعات والملحقات', 'Used by the printers and accessories pages', 'لە پەڕەکانی چاپکەر و پاشکۆکاندا بەکاردێت') : ss.policyOwnerOnly}
            checked={printer}
            onChange={setPrinter}
            disabled={!owner}
          />
          <Check id="sec-active" label={loc('مفعّل', 'Active')} hint={loc('القسم المعطّل لا يظهر في النموذج ولا في القالب', 'An inactive section is offered neither by the form nor by the template')} checked={active} onChange={setActiveState} />
        </div>
        {policyInstalled && (
          <div className="sm:col-span-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] p-3 space-y-2" data-tax-serial-policy-editor>
            <div className="flex items-start justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ap-text-1)]">
                <ScanLine className="h-4 w-4 text-[var(--ap-text-3)]" aria-hidden />
                {ss.sectionPolicyTitle}
              </p>
              {!owner && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-[var(--ap-text-3)]">
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                  {ss.policyOwnerOnly}
                </span>
              )}
            </div>
            <p className="text-[11.5px] leading-relaxed text-[var(--ap-text-3)]">{ss.sectionPolicyHint}</p>
            {owner ? (
              <Segmented
                group="section-serial-policy"
                label={ss.sectionPolicyTitle}
                value={serialPolicy}
                onChange={(id) => setSerialPolicy(id as 'inherit' | 'required' | 'off')}
                size="sm"
                dataAttr="data-tax-serial-policy-choice"
                items={[
                  { id: 'inherit', label: ss.policyInherit },
                  { id: 'required', label: ss.policyRequired },
                  { id: 'off', label: ss.policyOff },
                ]}
              />
            ) : (
              <p className="text-[13px] text-[var(--ap-text-1)]">
                {serialPolicy === 'required' ? ss.policyRequired : serialPolicy === 'off' ? ss.policyOff : ss.policyInherit}
              </p>
            )}
            {printer && serialPolicy === 'off' && <p className="text-[11.5px] text-[var(--ap-warning)]">{ss.printerNeverOff}</p>}
          </div>
        )}
        {/* OWNER: Sorani to be written by hand (the labels below carry ar/en only). */}
        <div className="sm:col-span-2 grid gap-3.5" data-tax-descriptions>
          <FieldRow
            id="sec-desc-ar"
            label={loc('الوصف بالعربية', 'Arabic description')}
            hint={loc(
              `سطر أو سطران تحت اسم القسم في صفحته وفي «كل الفئات». اتركه فارغًا ليُخفى. حتى ${DESCRIPTION_MAX} حرفًا.`,
              `One or two lines under the section's name on its page and in «All categories». Leave empty to hide it. Up to ${DESCRIPTION_MAX} characters.`
            )}
          >
            <textarea id="sec-desc-ar" className={DESC_CLASS} rows={2} maxLength={DESCRIPTION_MAX} value={descAr} onChange={(e) => setDescAr(e.target.value)} dir="rtl" />
          </FieldRow>
          <FieldRow id="sec-desc-en" label={loc('الوصف بالإنجليزية', 'English description')} ltr>
            <textarea id="sec-desc-en" className={DESC_CLASS} rows={2} maxLength={DESCRIPTION_MAX} value={descEn} onChange={(e) => setDescEn(e.target.value)} />
          </FieldRow>
          <FieldRow id="sec-desc-ckb" label={loc('الوصف بالكردية', 'Kurdish description')} hint={loc('يُكتب يدويًا، ولا يُترجم آليًا.', 'Written by hand, never machine-translated.')}>
            <textarea id="sec-desc-ckb" className={DESC_CLASS} rows={2} maxLength={DESCRIPTION_MAX} value={descCkb} onChange={(e) => setDescCkb(e.target.value)} dir="rtl" />
          </FieldRow>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * THE WORKER'S EIGHT PICTURE SLOTS (worker/routes/adminTaxonomy.ts
 * CATALOG_PICTURES): a section's CARD and its BANNER, each dark and light,
 * each for a large screen and for a phone (owner, 2026-09-28: «أربع صور اثنين
 * وضع داكن لقياسين اثنين وضع فاتح لقياسين»).
 */
type PictureSegment =
  | 'image'
  | 'image-mobile'
  | 'image-light'
  | 'image-light-mobile'
  | 'hero-image'
  | 'hero-mobile-image'
  | 'hero-light-image'
  | 'hero-light-mobile-image';
type PictureField =
  | 'image_url'
  | 'mobile_image_url'
  | 'light_image_url'
  | 'light_mobile_image_url'
  | 'hero_image_url'
  | 'hero_mobile_image_url'
  | 'hero_light_image_url'
  | 'hero_light_mobile_image_url';

interface PictureSlotSpec {
  theme: PictureTheme;
  screen: PictureScreen;
  segment: PictureSegment;
  field: PictureField;
}

const PICTURE_SLOTS: Record<PictureKind, readonly PictureSlotSpec[]> = {
  image: [
    { theme: 'dark', screen: 'large', segment: 'image', field: 'image_url' },
    { theme: 'dark', screen: 'phone', segment: 'image-mobile', field: 'mobile_image_url' },
    { theme: 'light', screen: 'large', segment: 'image-light', field: 'light_image_url' },
    { theme: 'light', screen: 'phone', segment: 'image-light-mobile', field: 'light_mobile_image_url' },
  ],
  banner: [
    { theme: 'dark', screen: 'large', segment: 'hero-image', field: 'hero_image_url' },
    { theme: 'dark', screen: 'phone', segment: 'hero-mobile-image', field: 'hero_mobile_image_url' },
    { theme: 'light', screen: 'large', segment: 'hero-light-image', field: 'hero_light_image_url' },
    { theme: 'light', screen: 'phone', segment: 'hero-light-mobile-image', field: 'hero_light_mobile_image_url' },
  ],
};

/** What a server older than migration 0149 can store: the large pictures it always had. */
const BEFORE_0149: ReadonlySet<PictureSegment> = new Set(['image', 'hero-image', 'hero-light-image']);

const ALL_FIELDS: readonly PictureField[] = [...PICTURE_SLOTS.image, ...PICTURE_SLOTS.banner].map((s) => s.field);

/**
 * The shape the storefront draws each picture at, so the preview crops the
 * way the shop will: the home tile is about 4:3 on a large screen and about
 * square on a phone (CategoryBento); the banner row is 8:1 from 1024 px and
 * 15:4 on a phone (CategoryRowBanners ROW_BANNER_SIZE).
 */
const PREVIEW: Record<PictureKind, Record<PictureScreen, string>> = {
  image: { large: 'h-24 max-w-full aspect-[4/3]', phone: 'h-24 max-w-full aspect-square' },
  banner: { large: 'w-full aspect-[8/1] min-h-[44px]', phone: 'w-full max-w-[320px] aspect-[15/4]' },
};

/**
 * A SECTION'S PICTURES — its card on the home page, or its banner.
 *
 * WHAT IT REPLACES. Until migration 0100 the storefront BORROWED a cover: it
 * used the first photo among the products the first screen happened to have
 * fetched, filed under that section. Nobody chose it — which of eight
 * filaments stood for «خيوط PLA» depended on the order a query returned — and
 * a section whose products were not among the thirty on screen drew its
 * monogram however good its artwork was. That fallback is still there and
 * still useful; this dialog is how the owner overrules it.
 *
 * FOUR SLOTS, ONE RULE (0149). Each picture is a set: dark and light, a large
 * screen and a phone, grouped by theme because that is how the owner exports
 * them. Every slot is optional. An empty one shows, faintly, the picture the
 * shop will draw in its place and says which it is — the storefront's own
 * resolver (src/lib/catalog/sectionPictures.ts) decides, so this preview and
 * the shop cannot disagree.
 *
 * WHY IT IS NOT PART OF THE EDIT DIALOG. That one posts JSON and saves on a
 * button; a file is multipart and there is nothing to defer — the moment a
 * WebP is picked there is exactly one sensible thing to do with it. Folding
 * the two together would mean either a create that cannot carry a picture (a
 * new section has no id to upload against yet) or a Save button that means
 * two different things. So this acts immediately and has no Save at all, which
 * is also why it uses `Modal` rather than the taxonomy `Dialog`.
 */
function SectionImageDialog({
  node,
  kind = 'image',
  onClose,
  onChanged,
}: {
  node: CatalogNode;
  /** `image` = the home tile's card; `banner` = the banner/hero (0136 + 0142 + 0149). */
  kind?: PictureKind;
  onClose: () => void;
  /** `removed` distinguishes a cleared picture from a newly uploaded one. */
  onChanged: (removed: boolean) => Promise<void>;
}) {
  const { loc, lang } = useLoc();
  const [err, setErr] = useState('');
  // A count, not a flag: two slots can upload at once, and the first to
  // finish must not re-enable «إغلاق» while the second is still sending.
  const [busyCount, setBusyCount] = useState(0);
  // The dialog owns what it is SHOWING: `node` is a snapshot from the table,
  // and the table only re-reads after the parent's reload resolves. Held here
  // rather than in each slot, because an empty slot previews what the others
  // hold.
  const [urls, setUrls] = useState<Record<PictureField, string>>(
    () => Object.fromEntries(ALL_FIELDS.map((f) => [f, node[f] || ''])) as Record<PictureField, string>
  );
  const banner = kind === 'banner';
  const name = nameOf(node, lang);
  const variants = node.picture_variants !== false;
  const slots = PICTURE_SLOTS[kind].filter((s) => variants || BEFORE_0149.has(s.segment));
  // The banner falls back to the card's set, the card to nothing (then a product photo).
  const sets = banner ? [bannerSet(urls), cardSet(urls)] : [cardSet(urls)];
  const onBusy = useCallback((b: boolean) => setBusyCount((n) => Math.max(0, n + (b ? 1 : -1))), []);

  return (
    <Modal
      // OWNER: Sorani to be written by hand (the titles and every loc() below without a third argument).
      titleAr={banner ? `صور بانر «${name}»` : `صور بطاقة «${name}»`}
      titleEn={banner ? `Banner pictures for "${name}"` : `Card pictures for "${name}"`}
      onClose={onClose}
      footer={
        <div className={`${T.AP} flex items-center justify-end gap-2`} data-tax-dialog="section-image">
          {err && (
            <span className="me-auto text-[12px] text-[var(--ap-danger)] break-words min-w-0" role="alert">
              {err}
            </span>
          )}
          <button type="button" className={T.btnSecondary} onClick={onClose} disabled={busyCount > 0}>
            {loc('إغلاق', 'Close', 'داخستن')}
          </button>
        </div>
      }
    >
      <div className={`${T.AP} grid gap-3.5`} data-tax-dialog-body={banner ? 'section-banner' : 'section-image'}>
        <p className="text-[12px] text-[var(--ap-text-3)] leading-relaxed">
          {banner
            ? loc(
                'تملأ هذه الصور شريط القسم في «كل الفئات» وفي صفحة القسم الأعلى منه، وتظهر كبيرة أعلى صفحة القسم نفسه. الاسم والعدد والزر يُكتبان فوق الجهة اليمنى من الصورة على تظليل داكن، فاترك تلك الجهة هادئة. لكل وضع صورتان: للشاشات الكبيرة وللجوال. كل خانة اختيارية — الفارغة تعرض أقرب صورة لها: من الوضع نفسه أولًا، ثم من الوضع الآخر، ثم صور بطاقة القسم، ثم صورة أحد منتجاته. WebP فقط، ٢ ميغابايت كحد أقصى للصورة.',
                'These pictures fill the section’s banner row in «All categories» and on its parent’s page, and are shown large at the top of the section’s own page. The name, the counts and the button are written over the reading side of the picture on a dark scrim, so keep that side calm. Each theme takes two: one for large screens and one for phones. Every slot is optional — an empty one shows the nearest picture: the same theme’s first, then the other theme’s, then the section’s card pictures, then a product photo. WebP only, 2 MB at most each.'
              )
            : loc(
                'تظهر هذه الصور على بطاقة القسم في الصفحة الرئيسية. لكل وضع صورتان: للشاشات الكبيرة وللجوال. كل خانة اختيارية — الفارغة تعرض أقرب صورة لها من الوضع نفسه أولًا، وصورة واحدة تكفي لكل الخانات. WebP فقط، ٢ ميغابايت كحد أقصى للصورة.',
                'These pictures are shown on the section’s card on the home page. Each theme takes two: one for large screens and one for phones. Every slot is optional — an empty one shows the nearest picture, the same theme’s first, so a single picture fills them all. WebP only, 2 MB at most each.'
              )}
        </p>
        {(['dark', 'light'] as const).map((theme) => {
          const own = slots.filter((s) => s.theme === theme);
          if (own.length === 0) return null;
          const Icon = theme === 'dark' ? Moon : Sun;
          const headingId = `pic-${kind}-${theme}`;
          return (
            <div key={theme} role="group" aria-labelledby={headingId} className="grid gap-3 rounded-xl border border-[var(--ap-border)] p-3" data-tax-picture-theme={theme}>
              <div id={headingId} className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ap-text-1)]">
                <Icon className="w-3.5 h-3.5 text-[var(--ap-text-3)]" aria-hidden />
                {theme === 'dark' ? loc('الوضع الداكن', 'Dark theme') : loc('الوضع الفاتح', 'Light theme')}
              </div>
              <div className={banner ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'}>
                {own.map((spec) => (
                  <PictureSlot
                    key={spec.segment}
                    node={node}
                    kind={kind}
                    spec={spec}
                    url={urls[spec.field]}
                    fallback={urls[spec.field] ? null : pickPictureOrigin(sets, spec.theme, spec.screen)}
                    onUrl={(url) => setUrls((u) => ({ ...u, [spec.field]: url }))}
                    onBusy={onBusy}
                    onError={setErr}
                    onChanged={onChanged}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {!variants ? (
          <p className="text-[12px] text-[var(--ap-text-3)] leading-relaxed" data-tax-picture-pending>
            {loc(
              'خانات الجوال (وصورة البطاقة للوضع الفاتح) تظهر بعد تطبيق تحديث قاعدة البيانات 0149 مع نشر الموقع القادم.',
              'The phone slots (and the card’s light picture) appear once database update 0149 is applied with the next site deploy.'
            )}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * ONE SLOT OF A SECTION'S PICTURE: preview, upload/replace, remove — acting
 * at once (see SectionImageDialog). The preview sits on the ground of the
 * theme the slot is for — the dark theme's near-black or the light theme's
 * cream, whatever theme the panel itself is in — so a picture exported on the
 * wrong matte shows up here, not on the shop.
 *
 * An EMPTY slot previews the picture the shop will draw in its place
 * (`fallback`, the storefront's own resolver), faded and on a dashed edge, and
 * names it — the rule made visible rather than explained.
 */
function PictureSlot({
  node,
  kind,
  spec,
  url,
  fallback,
  onUrl,
  onBusy,
  onError,
  onChanged,
}: {
  node: CatalogNode;
  kind: PictureKind;
  spec: PictureSlotSpec;
  url: string;
  /** What the shop shows while this slot is empty, or null when it would borrow a product photo. */
  fallback: PictureOrigin | null;
  onUrl: (url: string) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  onChanged: (removed: boolean) => Promise<void>;
}) {
  const { loc } = useLoc();
  const [busy, setBusyState] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const base = `/api/admin/taxonomy/catalogs/${encodeURIComponent(node.id)}/${spec.segment}`;
  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusy(b);
  };

  // OWNER: Sorani to be written by hand (every loc() in this slot without a third argument).
  const themeName = spec.theme === 'dark' ? loc('الوضع الداكن', 'Dark theme') : loc('الوضع الفاتح', 'Light theme');
  const screenName = spec.screen === 'large' ? loc('الشاشات الكبيرة', 'Large screens') : loc('الجوال', 'Phone');
  const screenHint = spec.screen === 'large' ? loc('اللوحي والحاسوب', 'tablet and computer') : loc('أقل من ٦٤٠ بكسل', 'under 640 px');
  const bestFit =
    kind === 'image'
      ? spec.screen === 'large'
        ? loc('الأنسب ٤:٣، مثل ١٢٠٠×٩٠٠.', 'Best at 4:3, e.g. 1200×900.')
        : loc('الأنسب مربعة ١:١، مثل ٨٠٠×٨٠٠.', 'Best square, 1:1, e.g. 800×800.')
      : spec.screen === 'large'
        ? loc('الأنسب عريضة جدًا ٨:١، مثل ٢٤٠٠×٣٠٠.', 'Best very wide, 8:1, e.g. 2400×300.')
        : loc('الأنسب ١٥:٤، مثل ١٢٠٠×٣٢٠.', 'Best at 15:4, e.g. 1200×320.');

  /** «فارغة — يظهر مكانها …»: the slot the shop draws instead, in words. */
  const emptyLine = (() => {
    if (!fallback) {
      return loc(
        'لا توجد صورة بعد — القسم يأخذ الآن صورة أحد منتجاته تلقائيًا.',
        'No picture yet — the section is currently borrowing a photo from one of its products.',
        'هێشتا وێنە نییە — ئێستا وێنەی یەکێک لە بەرهەمەکانی دەبات.'
      );
    }
    const fromCard = kind === 'banner' && fallback.set === 1;
    const dark = fallback.theme === 'dark';
    const large = fallback.screen === 'large';
    const ar = fromCard
      ? `صورة البطاقة ${dark ? 'للوضع الداكن' : 'للوضع الفاتح'} ${large ? 'والشاشات الكبيرة' : 'والجوال'}`
      : `صورة ${dark ? 'الوضع الداكن' : 'الوضع الفاتح'} ${large ? 'للشاشات الكبيرة' : 'للجوال'}`;
    const en = `the ${fromCard ? 'card’s ' : ''}${dark ? 'dark' : 'light'} ${large ? 'large-screen' : 'phone'} picture`;
    return loc(`فارغة — تظهر مكانها ${ar}.`, `Empty — ${en} shows here.`);
  })();

  const upload = async (file: File) => {
    setBusy(true);
    onError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('originalName', file.name);
      const res = await api.post<Partial<Record<PictureField, string>>>(base, form);
      onUrl(res[spec.field] || '');
      await onChanged(false);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : errMsg(e));
    } finally {
      setBusy(false);
      // A failed upload must not leave the same file "already chosen": the
      // input fires no change event for an identical selection, so retrying
      // the very same file would do nothing at all.
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    onError('');
    try {
      await api.delete(base);
      onUrl('');
      await onChanged(true);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = url || fallback?.file || '';
  return (
    <div className="grid gap-2 min-w-0 content-start" data-tax-picture={spec.segment} data-tax-picture-state={url ? 'own' : fallback ? 'fallback' : 'empty'}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
        {spec.screen === 'large' ? (
          <Monitor className="w-3.5 h-3.5 text-[var(--ap-text-3)]" aria-hidden />
        ) : (
          <Smartphone className="w-3.5 h-3.5 text-[var(--ap-text-3)]" aria-hidden />
        )}
        <span className="text-[12.5px] font-semibold text-[var(--ap-text-1)]">{screenName}</span>
        <span className="text-[11.5px] text-[var(--ap-text-3)]">{screenHint}</span>
      </div>
      <span
        className={`${PREVIEW[kind][spec.screen]} shrink-0 rounded-lg border grid place-items-center overflow-hidden ${
          url ? 'border-[var(--ap-border)]' : 'border-dashed border-[var(--ap-border-strong)]'
        } ${spec.theme === 'dark' ? 'lv-plate-dark' : 'lv-plate-light'}`}
      >
        {shown ? (
          <img src={shown} alt="" loading="lazy" decoding="async" className={`w-full h-full object-cover ${url ? '' : 'opacity-40'}`} />
        ) : (
          <ImageIcon className="w-5 h-5 text-[var(--ap-text-3)]" aria-hidden />
        )}
      </span>
      <p className="text-[11.5px] text-[var(--ap-text-3)] leading-relaxed">
        {url ? bestFit : `${emptyLine} ${bestFit}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* `sr-only`, NOT `hidden`. `display: none` takes a file input out of
            the focus order, and a <label> is not focusable either, so the
            whole control would be unreachable by keyboard. */}
        <label className={`${T.btnSecondary} cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ap-accent)]`}>
          {busy ? <RefreshCw className="w-4 h-4 animate-spin" aria-hidden /> : <Upload className="w-4 h-4" aria-hidden />}
          {url ? loc('استبدال', 'Replace') : loc('رفع صورة', 'Upload')}
          <input
            ref={fileRef}
            type="file"
            accept="image/webp"
            className="sr-only"
            disabled={busy}
            aria-label={`${themeName} — ${screenName}`}
            data-tax-image-input={`${node.id}:${spec.segment}`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
        {url && (
          <button
            type="button"
            className={T.btnIconDanger}
            onClick={() => void remove()}
            disabled={busy}
            aria-label={`${loc('إزالة الصورة', 'Remove image', 'وێنە لاببە')}: ${themeName} — ${screenName}`}
            title={loc('إزالة الصورة', 'Remove image', 'وێنە لاببە')}
            data-tax-image-remove={`${node.id}:${spec.segment}`}
          >
            <Trash2 className="w-4 h-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
