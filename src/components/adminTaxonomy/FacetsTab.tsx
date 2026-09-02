/**
 * الفلاتر — facets, grouped by their `kind` (offer, material_type, …). Kind
 * is an open axis: pick an existing one or type a new one. Add, edit,
 * deactivate/activate, delete (deactivated instead when products use it).
 */
import React, { useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Power } from 'lucide-react';
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
  mono,
  altNames,
  nameOf,
  setActive,
  useLoc,
  type FacetRow,
  type NoticeState,
} from './shared';

interface Props {
  facets: FacetRow[];
  reload: () => Promise<void>;
  notify: (tone: NoticeState['tone'], text: string) => void;
}

const KIND_LABEL: Record<string, { ar: string; en: string }> = {
  offer: { ar: 'العروض', en: 'Offers' },
  material_type: { ar: 'نوع المادة', en: 'Material type' },
  processing_mode: { ar: 'طريقة المعالجة', en: 'Processing mode' },
  fdm_material: { ar: 'خامات FDM', en: 'FDM materials' },
  tag: { ar: 'وسوم', en: 'Tags' },
};

const kindLabel = (kind: string, isEn: boolean) => {
  const k = KIND_LABEL[kind];
  return k ? (isEn ? k.en : k.ar) : kind;
};

export function FacetsTab({ facets, reload, notify }: Props) {
  const { loc, isEn, lang } = useLoc();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<FacetRow | null | { kind: string }>(null);
  const [del, setDel] = useState<FacetRow | null>(null);
  const [busyId, setBusyId] = useState('');
  // A deleted row takes the button the dialog would restore focus to with it.
  const addRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = () => window.setTimeout(() => addRef.current?.focus(), 0);

  const kinds = useMemo(() => [...new Set(facets.map((f) => f.kind))].sort(), [facets]);
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = s ? facets.filter((f) => `${f.name_ar} ${f.name_en} ${f.name_ckb} ${f.slug} ${f.kind}`.toLowerCase().includes(s)) : facets;
    const by = new Map<string, FacetRow[]>();
    for (const f of rows) by.set(f.kind, [...(by.get(f.kind) ?? []), f]);
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, list]) => ({ kind, list: list.sort((a, b) => a.sort - b.sort) }));
  }, [facets, q]);

  const toggle = async (f: FacetRow) => {
    setBusyId(f.id);
    try {
      await setActive('/api/admin/taxonomy/facets', f.id, !f.active);
      await reload();
      notify('ok', f.active ? loc(`عُطّل الفلتر «${nameOf(f, lang)}».`, `Filter "${nameOf(f, lang)}" deactivated.`) : loc(`فُعّل الفلتر «${nameOf(f, lang)}».`, `Filter "${nameOf(f, lang)}" activated.`));
    } catch (e) {
      notify('bad', errMsg(e));
    } finally {
      setBusyId('');
    }
  };

  return (
    <div>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={loc('بحث في الفلاتر…', 'Search filters…')} testId="facets" />
        <div className="ms-auto">
          <button ref={addRef} type="button" className={T.btnPrimary} onClick={() => setEdit({ kind: '' })} data-tax-add="facet">
            <Plus className="w-4 h-4" aria-hidden />
            {loc('فلتر جديد', 'New filter')}
          </button>
        </div>
      </Toolbar>
      <p className="mb-3 text-[12px] text-[var(--ap-text-3)]">
        {loc(
          'الفلاتر منفصلة عن الأقسام: المنتج قد يحمل عدة فلاتر (عرض، نوع مادة، خامة FDM…). في ملف الاستيراد تُكتب بالـ slug مفصولة بـ |.',
          'Filters are separate from sections: a product may carry several (offer, material type, FDM material…). In the import file they are written by slug, separated with |.'
        )}
      </p>

      {groups.length === 0 ? (
        <Empty text={facets.length === 0 ? loc('لا توجد فلاتر بعد.', 'No filters yet.') : loc('لا نتائج.', 'No results.')} />
      ) : (
        <div className="space-y-4">
          {groups.map(({ kind, list }) => (
            <section key={kind} data-tax-kind={kind}>
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-[13px] font-semibold text-[var(--ap-text-1)]">{kindLabel(kind, isEn)}</h2>
                <span className={`${mono}`} dir="ltr">
                  {kind}
                </span>
                <span className={`${T.kbd}`}>{fmtN(list.length)}</span>
                <button type="button" className={`${T.btnGhostSm} ms-auto`} onClick={() => setEdit({ kind })} data-tax-action="add-kind">
                  <Plus className="w-3.5 h-3.5" aria-hidden />
                  {loc('إضافة هنا', 'Add here')}
                </button>
              </div>
              <Table head={[loc('الفلتر', 'Filter'), 'slug', loc('المنتجات', 'Products'), loc('الحالة', 'State'), '']} minWidth={520}>
                {list.map((f) => (
                  <tr key={f.id} className={`${T.tableRow} ${f.active ? '' : 'opacity-60'}`} data-tax-row={f.id} data-tax-slug={f.slug}>
                    <td className={cell}>
                      <div className="font-semibold text-[var(--ap-text-1)] truncate">{nameOf(f, lang)}</div>
                      <div className="text-[11.5px] text-[var(--ap-text-3)] truncate">{altNames(f, lang)}</div>
                    </td>
                    <td className={cell}>
                      <span className={mono} dir="ltr">
                        {f.slug}
                      </span>
                    </td>
                    <td className={`${cell} tabular-nums`}>{fmtN(f.product_count)}</td>
                    <td className={cell}>
                      <ActiveBadge active={f.active} />
                    </td>
                    <td className={cell}>
                      <Actions>
                        <button type="button" className={T.btnIcon} onClick={() => setEdit(f)} aria-label={loc('تعديل', 'Edit')} title={loc('تعديل', 'Edit')} data-tax-action="edit">
                          <Pencil className="w-4 h-4" aria-hidden />
                        </button>
                        <button type="button" className={T.btnIcon} onClick={() => void toggle(f)} disabled={busyId === f.id} aria-label={f.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} title={f.active ? loc('تعطيل', 'Deactivate') : loc('تفعيل', 'Activate')} data-tax-action="toggle">
                          <Power className="w-4 h-4" aria-hidden />
                        </button>
                        <button type="button" className={T.btnIconDanger} onClick={() => setDel(f)} aria-label={loc('حذف', 'Delete')} title={loc('حذف', 'Delete')} data-tax-action="delete">
                          <Trash2 className="w-4 h-4" aria-hidden />
                        </button>
                      </Actions>
                    </td>
                  </tr>
                ))}
              </Table>
            </section>
          ))}
        </div>
      )}

      {edit && (
        <FacetDialog
          facet={'id' in edit ? edit : null}
          presetKind={'id' in edit ? edit.kind : edit.kind}
          kinds={kinds}
          onClose={() => setEdit(null)}
          onSaved={async (created, name) => {
            setEdit(null);
            await reload();
            notify('ok', created ? loc(`أُضيف الفلتر «${name}».`, `Filter "${name}" added.`) : loc(`حُفظ الفلتر «${name}».`, `Filter "${name}" saved.`));
          }}
        />
      )}

      {del && (
        <Dialog
          titleAr="حذف فلتر"
          titleEn="Delete filter"
          danger
          saveLabel={loc('حذف', 'Delete')}
          onClose={() => setDel(null)}
          testId="delete-facet"
          onSave={async () => {
            const res = await api.delete<{ deleted: boolean; deactivated: boolean; products?: number }>(`/api/admin/taxonomy/facets/${encodeURIComponent(del.id)}`);
            setDel(null);
            restoreFocus();
            await reload();
            if (res.deleted) notify('ok', loc(`حُذف الفلتر «${nameOf(del, lang)}» نهائيًا.`, `Filter "${nameOf(del, lang)}" deleted.`));
            else
              notify(
                'warn',
                loc(
                  `الفلتر «${nameOf(del, lang)}» على ${fmtN(res.products ?? 0)} منتج فتم تعطيله بدل حذفه.`,
                  `Filter "${nameOf(del, lang)}" is on ${fmtN(res.products ?? 0)} products, so it was deactivated instead of deleted.`
                )
              );
          }}
        >
          <p className="text-[13px] text-[var(--ap-text-1)]">{loc(`حذف «${nameOf(del, lang)}»؟`, `Delete "${nameOf(del, lang)}"?`)}</p>
          <p className="text-[12px] text-[var(--ap-text-3)]">
            {loc('يُحذف نهائيًا إن لم يكن على منتجات، وإلا يُعطَّل فقط.', 'Deleted for good when no product carries it; otherwise it is only deactivated.')}
          </p>
        </Dialog>
      )}
    </div>
  );
}

function FacetDialog({
  facet,
  presetKind,
  kinds,
  onClose,
  onSaved,
}: {
  facet: FacetRow | null;
  presetKind: string;
  kinds: string[];
  onClose: () => void;
  onSaved: (created: boolean, name: string) => Promise<void>;
}) {
  const { loc, isEn, lang } = useLoc();
  const [nameEn, setNameEn] = useState(facet?.name_en ?? '');
  const [nameAr, setNameAr] = useState(facet?.name_ar ?? '');
  const [nameCkb, setNameCkb] = useState(facet?.name_ckb ?? '');
  const [kind, setKind] = useState(facet?.kind ?? presetKind);
  const [slug, setSlug] = useState(facet?.slug ?? '');
  const [sort, setSort] = useState(String(facet?.sort ?? 0));
  const [active, setActiveState] = useState(facet?.active ?? true);
  const dirty =
    nameEn !== (facet?.name_en ?? '') ||
    nameAr !== (facet?.name_ar ?? '') ||
    nameCkb !== (facet?.name_ckb ?? '') ||
    kind !== (facet?.kind ?? presetKind) ||
    slug !== (facet?.slug ?? '') ||
    sort !== String(facet?.sort ?? 0) ||
    active !== (facet?.active ?? true);

  return (
    <Dialog
      titleAr={facet ? 'تعديل فلتر' : 'فلتر جديد'}
      titleEn={facet ? 'Edit filter' : 'New filter'}
      onClose={onClose}
      dirty={dirty}
      testId="facet"
      onSave={async () => {
        if (!nameEn.trim()) throw new Error(loc('الاسم بالإنجليزية مطلوب.', 'The English name is required.'));
        const body: Record<string, unknown> = {
          ...(facet ? { id: facet.id } : {}),
          name_en: nameEn.trim(),
          name_ar: nameAr.trim(),
          name_ckb: nameCkb.trim(),
          kind: kind.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tag',
          sort: Number(sort) || 0,
          active,
        };
        if (slug.trim()) body.slug = slug.trim();
        const res = await api.post<{ created: boolean; facet: { name_ar: string; name_en: string } }>('/api/admin/taxonomy/facets', body);
        await onSaved(res.created, nameOf(res.facet, lang));
      }}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FieldRow id="facet-name-en" label={loc('الاسم بالإنجليزية', 'English name')} required ltr>
          <input id="facet-name-en" className={`${T.input} w-full`} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </FieldRow>
        <FieldRow id="facet-name-ar" label={loc('الاسم بالعربية', 'Arabic name')}>
          <input id="facet-name-ar" className={`${T.input} w-full`} value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
        </FieldRow>
        <FieldRow id="facet-name-ckb" label={loc('الاسم بالكردية', 'Kurdish name')}>
          <input id="facet-name-ckb" className={`${T.input} w-full`} value={nameCkb} onChange={(e) => setNameCkb(e.target.value)} dir="rtl" />
        </FieldRow>
        <FieldRow id="facet-kind" label={loc('النوع (المجموعة)', 'Kind (group)')} hint={loc('اختر نوعًا موجودًا أو اكتب نوعًا جديدًا بالإنجليزية', 'Pick an existing kind or type a new one in English')} ltr>
          <input id="facet-kind" list="facet-kinds" className={`${T.input} w-full font-mono`} value={kind} onChange={(e) => setKind(e.target.value)} placeholder="offer" />
          <datalist id="facet-kinds">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k, isEn)}
              </option>
            ))}
          </datalist>
        </FieldRow>
        <FieldRow id="facet-slug" label="slug" hint={loc('هذا ما يُكتب في عمود facets عند الاستيراد', 'This is what goes in the facets column of an import')} ltr>
          <input id="facet-slug" className={`${T.input} w-full font-mono`} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto" />
        </FieldRow>
        <FieldRow id="facet-sort" label={loc('الترتيب', 'Sort')} ltr>
          <input id="facet-sort" type="number" min={0} className={`${T.input} w-full`} value={sort} onChange={(e) => setSort(e.target.value)} />
        </FieldRow>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <Check id="facet-active" label={loc('مفعّل', 'Active')} checked={active} onChange={setActiveState} />
          {facet && <Badge tone="neutral">{loc(`${fmtN(facet.product_count)} منتج`, `${fmtN(facet.product_count)} products`)}</Badge>}
        </div>
      </div>
    </Dialog>
  );
}
