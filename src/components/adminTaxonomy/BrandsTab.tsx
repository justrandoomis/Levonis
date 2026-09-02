/**
 * العلامات التجارية — the brand list the product form and the import's
 * `brand` column resolve against. Add, edit, deactivate/activate, delete
 * (deactivated instead when products still carry the brand).
 */
import React, { useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Power } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import {
  Actions,
  ActiveBadge,
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
  mono,
  altNames,
  nameOf,
  setActive,
  useLoc,
  type BrandRow,
  type NoticeState,
} from './shared';

interface Props {
  brands: BrandRow[];
  reload: () => Promise<void>;
  notify: (tone: NoticeState['tone'], text: string) => void;
}

export function BrandsTab({ brands, reload, notify }: Props) {
  const { loc, lang } = useLoc();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<BrandRow | null | 'new'>(null);
  const [del, setDel] = useState<BrandRow | null>(null);
  const [busyId, setBusyId] = useState('');
  // A deleted row takes the button the dialog would restore focus to with it.
  const addRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = () => window.setTimeout(() => addRef.current?.focus(), 0);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = s ? brands.filter((b) => `${b.name_ar} ${b.name_en} ${b.name_ckb} ${b.slug}`.toLowerCase().includes(s)) : brands;
    return [...rows].sort((a, b) => (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar));
  }, [brands, q]);

  const toggle = async (b: BrandRow) => {
    setBusyId(b.id);
    try {
      await setActive('/api/admin/taxonomy/brands', b.id, !b.active);
      await reload();
      notify('ok', b.active ? loc(`عُطّلت العلامة «${nameOf(b, lang)}».`, `Brand "${nameOf(b, lang)}" deactivated.`) : loc(`فُعّلت العلامة «${nameOf(b, lang)}».`, `Brand "${nameOf(b, lang)}" activated.`));
    } catch (e) {
      notify('bad', errMsg(e));
    } finally {
      setBusyId('');
    }
  };

  return (
    <div>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={loc('بحث في العلامات…', 'Search brands…')} testId="brands" />
        <div className="ms-auto">
          <button ref={addRef} type="button" className={T.btnPrimary} onClick={() => setEdit('new')} data-tax-add="brand">
            <Plus className="w-4 h-4" aria-hidden />
            {loc('علامة جديدة', 'New brand')}
          </button>
        </div>
      </Toolbar>

      {list.length === 0 ? (
        <Empty text={brands.length === 0 ? loc('لا توجد علامات بعد.', 'No brands yet.') : loc('لا نتائج.', 'No results.')} />
      ) : (
        <Table head={[loc('العلامة', 'Brand'), 'slug', loc('المنتجات', 'Products'), loc('الحالة', 'State'), '']} minWidth={560}>
          {list.map((b) => (
            <tr key={b.id} className={`${T.tableRow} ${b.active ? '' : 'opacity-60'}`} data-tax-row={b.id} data-tax-slug={b.slug}>
              <td className={cell}>
                <div className="font-semibold text-[var(--ap-text-1)] truncate">{nameOf(b, lang)}</div>
                <div className="text-[11.5px] text-[var(--ap-text-3)] truncate">{altNames(b, lang)}</div>
              </td>
              <td className={cell}>
                <span className={mono} dir="ltr">
                  {b.slug}
                </span>
              </td>
              <td className={`${cell} tabular-nums`}>{fmtN(b.product_count)}</td>
              <td className={cell}>
                <ActiveBadge active={b.active} />
              </td>
              <td className={cell}>
                <Actions>
                  <button type="button" className={T.btnIcon} onClick={() => setEdit(b)} aria-label={loc('تعديل', 'Edit')} title={loc('تعديل', 'Edit')} data-tax-action="edit">
                    <Pencil className="w-4 h-4" aria-hidden />
                  </button>
                  <button type="button" className={T.btnIcon} onClick={() => void toggle(b)} disabled={busyId === b.id} aria-label={b.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} title={b.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} data-tax-action="toggle">
                    <Power className="w-4 h-4" aria-hidden />
                  </button>
                  <button type="button" className={T.btnIconDanger} onClick={() => setDel(b)} aria-label={loc('حذف', 'Delete')} title={loc('حذف', 'Delete')} data-tax-action="delete">
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </button>
                </Actions>
              </td>
            </tr>
          ))}
        </Table>
      )}

      {edit && (
        <BrandDialog
          brand={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={async (created, name) => {
            setEdit(null);
            await reload();
            notify('ok', created ? loc(`أُضيفت العلامة «${name}».`, `Brand "${name}" added.`) : loc(`حُفظت العلامة «${name}».`, `Brand "${name}" saved.`));
          }}
        />
      )}

      {del && (
        <Dialog
          titleAr="حذف علامة تجارية"
          titleEn="Delete brand"
          danger
          saveLabel={loc('حذف', 'Delete')}
          onClose={() => setDel(null)}
          testId="delete-brand"
          onSave={async () => {
            const res = await api.delete<{ deleted: boolean; deactivated: boolean; products?: number }>(`/api/admin/taxonomy/brands/${encodeURIComponent(del.id)}`);
            setDel(null);
            restoreFocus();
            await reload();
            if (res.deleted) notify('ok', loc(`حُذفت العلامة «${nameOf(del, lang)}» نهائيًا.`, `Brand "${nameOf(del, lang)}" deleted.`));
            else
              notify(
                'warn',
                loc(
                  `العلامة «${nameOf(del, lang)}» على ${fmtN(res.products ?? 0)} منتج فتم تعطيلها بدل حذفها.`,
                  `Brand "${nameOf(del, lang)}" is on ${fmtN(res.products ?? 0)} products, so it was deactivated instead of deleted.`
                )
              );
          }}
        >
          <p className="text-[13px] text-[var(--ap-text-1)]">{loc(`حذف «${nameOf(del, lang)}»؟`, `Delete "${nameOf(del, lang)}"?`)}</p>
          <p className="text-[12px] text-[var(--ap-text-3)]">
            {loc('تُحذف نهائيًا إن لم يكن عليها منتجات، وإلا تُعطَّل فقط.', 'Deleted for good when no product carries it; otherwise it is only deactivated.')}
          </p>
        </Dialog>
      )}
    </div>
  );
}

function BrandDialog({ brand, onClose, onSaved }: { brand: BrandRow | null; onClose: () => void; onSaved: (created: boolean, name: string) => Promise<void> }) {
  const { loc, lang } = useLoc();
  const [nameEn, setNameEn] = useState(brand?.name_en ?? '');
  const [nameAr, setNameAr] = useState(brand?.name_ar ?? '');
  const [nameCkb, setNameCkb] = useState(brand?.name_ckb ?? '');
  const [slug, setSlug] = useState(brand?.slug ?? '');
  const [active, setActiveState] = useState(brand?.active ?? true);
  const dirty =
    nameEn !== (brand?.name_en ?? '') || nameAr !== (brand?.name_ar ?? '') || nameCkb !== (brand?.name_ckb ?? '') || slug !== (brand?.slug ?? '') || active !== (brand?.active ?? true);

  return (
    <Dialog
      titleAr={brand ? 'تعديل علامة تجارية' : 'علامة تجارية جديدة'}
      titleEn={brand ? 'Edit brand' : 'New brand'}
      onClose={onClose}
      dirty={dirty}
      testId="brand"
      onSave={async () => {
        if (!nameEn.trim() && !nameAr.trim()) throw new Error(loc('اكتب اسم العلامة.', 'Type the brand name.'));
        const body: Record<string, unknown> = {
          ...(brand ? { id: brand.id } : {}),
          name_en: nameEn.trim() || nameAr.trim(),
          name_ar: nameAr.trim(),
          name_ckb: nameCkb.trim(),
          active,
        };
        if (slug.trim()) body.slug = slug.trim();
        const res = await api.post<{ created: boolean; brand: { name_ar: string; name_en: string } }>('/api/admin/taxonomy/brands', body);
        await onSaved(res.created, nameOf(res.brand, lang));
      }}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FieldRow id="brand-name-en" label={loc('الاسم بالإنجليزية', 'English name')} required ltr>
          <input id="brand-name-en" className={`${T.input} w-full`} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </FieldRow>
        <FieldRow id="brand-name-ar" label={loc('الاسم بالعربية', 'Arabic name')}>
          <input id="brand-name-ar" className={`${T.input} w-full`} value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
        </FieldRow>
        <FieldRow id="brand-name-ckb" label={loc('الاسم بالكردية', 'Kurdish name')}>
          <input id="brand-name-ckb" className={`${T.input} w-full`} value={nameCkb} onChange={(e) => setNameCkb(e.target.value)} dir="rtl" />
        </FieldRow>
        <FieldRow id="brand-slug" label="slug" hint={loc('اتركه فارغًا ليُشتق من الاسم', 'Leave empty to derive it from the name')} ltr>
          <input id="brand-slug" className={`${T.input} w-full font-mono`} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto" />
        </FieldRow>
        <div className="sm:col-span-2">
          <Check id="brand-active" label={loc('مفعّلة', 'Active')} hint={loc('العلامة المعطّلة لا تظهر في النموذج ولا يقبلها الاستيراد', 'An inactive brand is offered by neither the form nor the import')} checked={active} onChange={setActiveState} />
        </div>
      </div>
    </Dialog>
  );
}
