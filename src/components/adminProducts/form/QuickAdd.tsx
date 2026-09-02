/**
 * Quick-add for the classification section of the product form: a main
 * section, a sub-section under the chosen main section, or a brand — created
 * through the same taxonomy endpoints the التصنيفات page uses, then selected
 * in the form without leaving it.
 */
import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { Modal } from '../ui';
import { Field, Grid, Select, TextInput, btnGhost, btnPrimary } from './formUi';

export type QuickAddKind = 'category' | 'sub_category' | 'brand';

export interface QuickAddResult {
  kind: QuickAddKind;
  id: string;
  row: Record<string, unknown>;
}

export function QuickAddDialog({
  kind,
  parentId,
  parentName,
  onClose,
  onCreated,
}: {
  kind: QuickAddKind;
  parentId?: string | null;
  parentName?: string;
  onClose: () => void;
  onCreated: (result: QuickAddResult) => void;
}) {
  const { lang } = useLanguage();
  const loc = (ar: string, en: string) => (lang === 'en' ? en : ar);
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [family, setFamily] = useState<'' | 'devices' | 'materials'>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const title =
    kind === 'brand'
      ? { ar: 'علامة تجارية جديدة', en: 'New brand' }
      : kind === 'category'
        ? { ar: 'قسم رئيسي جديد', en: 'New main section' }
        : { ar: `قسم فرعي جديد تحت «${parentName ?? ''}»`, en: `New sub-section under "${parentName ?? ''}"` };

  const save = async () => {
    if (!nameEn.trim()) {
      setErr(loc('الاسم بالإنجليزية مطلوب.', 'The English name is required.'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'brand') {
        const res = await api.post<{ brand: Record<string, unknown> & { id: string } }>('/api/admin/taxonomy/brands', {
          name_en: nameEn.trim(),
          name_ar: nameAr.trim(),
        });
        onCreated({ kind, id: res.brand.id, row: res.brand });
      } else {
        const res = await api.post<{ catalog: Record<string, unknown> & { id: string } }>('/api/admin/taxonomy/catalogs', {
          name_en: nameEn.trim(),
          name_ar: nameAr.trim(),
          parent_id: kind === 'sub_category' ? (parentId ?? null) : null,
          template_family: kind === 'category' ? family || null : null,
        });
        onCreated({ kind, id: res.catalog.id, row: res.catalog });
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      titleAr={title.ar}
      titleEn={title.en}
      onClose={onClose}
      dirty={!!(nameEn || nameAr)}
      footer={
        <div className="flex items-center justify-end gap-2" data-quick-add={kind}>
          {err && (
            <span className="me-auto text-[12px] text-red-400 min-w-0 break-words" role="alert">
              {err}
            </span>
          )}
          <button type="button" className={btnGhost} onClick={onClose} disabled={busy}>
            {loc('إلغاء', 'Cancel')}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void save()} disabled={busy} data-quick-add-save>
            {busy && <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />}
            {loc('إضافة واختيار', 'Add and select')}
          </button>
        </div>
      }
    >
      <Grid cols={2}>
        <Field ar="الاسم بالإنجليزية" en="English name" required>
          {/* No autoFocus: Modal reads document.activeElement on mount to know
              where to send focus back, and an input focused during the same
              commit would be recorded as its own opener. Modal focuses the
              first control itself. */}
          <TextInput value={nameEn} onChange={(e) => setNameEn(e.target.value)} data-quick-add-name />
        </Field>
        <Field ar="الاسم بالعربية" en="Arabic name" hint={loc('يظهر للزبائن في الواجهة العربية', 'Shown to customers in the Arabic UI')}>
          <TextInput value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
        </Field>
        {kind === 'category' && (
          <Field ar="القالب" en="Template family" hint={loc('يحدد حقول المواصفات وأعمدة الاستيراد', 'Decides the spec fields and the import columns')} span>
            <Select value={family} onChange={(e) => setFamily(e.target.value as '' | 'devices' | 'materials')} data-quick-add-family>
              <option value="">{loc('— بلا قالب —', '— none —')}</option>
              <option value="devices">{loc('الأجهزة · Devices', 'Devices')}</option>
              <option value="materials">{loc('المواد · Materials', 'Materials')}</option>
            </Select>
          </Field>
        )}
      </Grid>
      <p className="mt-3 text-[11px] text-zinc-500">
        {loc('يُضاف إلى قائمة التصنيفات فورًا ويصبح متاحًا في قالب الاستيراد التالي.', 'Added to the taxonomy list at once and offered by the next import template.')}
      </p>
    </Modal>
  );
}
