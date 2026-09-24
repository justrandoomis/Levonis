/**
 * The catalogue side of the merchant dashboard: sections (the shop's
 * shelves), services (print-on-demand and friends) and the showcase (the
 * workshop on display — printers, materials, finished works).
 *
 * Every list here is real data from /api/merchant/*; every control writes
 * back through the same API. Nothing renders that cannot be acted on.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Plus, Trash2, Pencil, Printer, Layers, Hammer, Check, Loader2,
} from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import {
  merchantApi, iqd,
  type StoreService, type ShowcaseItem,
} from '../../../lib/merchant';
import { ImagePicker } from '../../media/ImagePicker';
import { Btn, Card, Chip, ChipListEditor, Empty, Input, Notice, Spinner, TextArea } from './ui';
import { CollectionsManager } from '../catalog/CollectionsManager';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { merchantRefusal } from '../shell/refusal';

// ---------------------------------------------------------------- sections

/**
 * The shop's shelves ARE its collections now (merchant platform W2-F): manual
 * ones with the merchant's own product order, and the automatic featured /
 * new-arrivals / best-sellers. The screen lives with the catalogue editor.
 */
export function SectionsTab({ canSell, autoFocusCreate = false }: { canSell: boolean; autoFocusCreate?: boolean }) {
  // `autoFocusCreate`: the workspace's «new section» door (`?new=1`, W3-A) lands on the name field.
  return <CollectionsManager canSell={canSell} autoFocusCreate={autoFocusCreate} />;
}

// ---------------------------------------------------------------- services

const SERVICE_KIND_LABELS: Array<[string, string, string, string]> = [
  ['print_service', 'طباعة حسب الطلب', 'Print on demand', 'چاپ بەپێی داوا'],
  ['design', 'تصميم ونمذجة', 'Design & modelling', 'دیزاین'],
  ['finishing', 'تشطيب ومعالجة', 'Finishing', 'تەواوکاری'],
  ['scanning', 'مسح ثلاثي الأبعاد', '3D scanning', 'سکانی 3D'],
  ['repair', 'صيانة وإصلاح', 'Repair', 'چاککردنەوە'],
  ['other', 'أخرى', 'Other', 'هیتر'],
];

const EMPTY_SERVICE = {
  title: '',
  description: '',
  kind: 'print_service',
  price_from_iqd: null as number | null,
  price_unit: '',
  materials: [] as string[],
  imageUrl: null as string | null,
  active: true,
};

export function ServicesTab({ canSell }: { canSell: boolean }) {
  const { loc, lang } = useLanguage();
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  const [items, setItems] = useState<StoreService[] | null>(null);
  const [editing, setEditing] = useState<StoreService | 'new' | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    merchantApi.services().then((d) => setItems(d.services)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  if (items === null) return <Spinner />;

  if (editing) {
    return (
      <ServiceEditor
        service={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const kindLabel = (k: string) => {
    const row = SERVICE_KIND_LABELS.find(([id]) => id === k);
    return row ? loc(row[1], row[2], row[3]) : k;
  };

  return (
    <div className="space-y-3">
      {canSell ? (
        <Btn onClick={() => setEditing('new')} full>
          <Plus className="w-4 h-4" />
          {loc('خدمة جديدة', 'New service', 'خزمەتگوزاری نوێ')}
        </Btn>
      ) : (
        <Notice
          text={loc(
            'لا يمكن نشر خدمات جديدة الآن. خدماتك الحالية محفوظة.',
            'New services cannot be published right now. Existing ones are kept.',
            'ناتوانیت خزمەتگوزاری نوێ بڵاو بکەیتەوە.'
          )}
        />
      )}

      {!items.length && (
        <Empty
          text={loc('لا توجد خدمات بعد', 'No services yet', 'هێشتا خزمەتگوزاری نییە')}
          hint={loc(
            'اعرض ما تقدمه ورشتك: طباعة حسب الطلب، تصميم، تشطيب…',
            'Show what your workshop offers: print on demand, design, finishing…',
            'ئەوەی وەرشەکەت پێشکەشی دەکات نیشان بدە.'
          )}
        />
      )}

      {items.map((s) => (
        <div key={s.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex gap-3">
            <div className="w-12 h-12 rounded-xl bg-black/40 overflow-hidden shrink-0 flex items-center justify-center">
              {s.imageUrl ? (
                <img src={s.imageUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Hammer className="w-4 h-4 text-zinc-600" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-[13px] font-semibold truncate">{s.title}</p>
              <p className="text-zinc-500 text-[11px]">
                {kindLabel(s.kind)}
                {!s.active && ` · ${loc('موقوفة', 'paused', 'ڕاگیراوە')}`}
              </p>
              {s.price_from_iqd !== null && (
                <p className="text-gold text-[11.5px] font-bold" dir="ltr">
                  {loc('يبدأ من', 'From', 'لە')} {iqd(s.price_from_iqd)}
                  {s.price_unit ? ` / ${s.price_unit}` : ''}
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2 mt-2.5">
            <Btn kind="ghost" small onClick={() => setEditing(s)}>
              <Pencil className="w-3 h-3" />
              {loc('تعديل', 'Edit', 'دەستکاری')}
            </Btn>
            <Btn
              kind="ghost"
              small
              disabled={busy === s.id || (!s.active && !canSell)}
              onClick={async () => {
                setBusy(s.id);
                try {
                  await merchantApi.updateService(s.id, { active: !s.active });
                  load();
                } catch (e) {
                  toast.error(merchantRefusal(e, lang, loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت')));
                } finally {
                  setBusy('');
                }
              }}
            >
              {s.active ? loc('إيقاف', 'Pause', 'ڕاگرتن') : loc('تفعيل', 'Activate', 'چالاککردن')}
            </Btn>
            <Btn
              kind="danger"
              small
              disabled={busy === s.id}
              onClick={async () => {
                const ok = await confirm({
                  title: loc('حذف الخدمة؟', 'Delete this service?', 'بسڕدرێتەوە؟'),
                  // OWNER: Sorani to be written by hand.
                  consequence: loc('تختفي من صفحة متجرك، ولا يمكن التراجع.', 'It disappears from your store page, and this cannot be undone.'),
                  confirmLabel: loc('حذف', 'Delete', 'سڕینەوە'),
                  cancelLabel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
                  destructive: true,
                });
                if (!ok) return;
                setBusy(s.id);
                try {
                  await merchantApi.deleteService(s.id);
                  load();
                } catch (e) {
                  toast.error(merchantRefusal(e, lang, loc('تعذّر الحذف', 'Could not delete', 'نەسڕایەوە')));
                } finally {
                  setBusy('');
                }
              }}
            >
              <Trash2 className="w-3 h-3" />
            </Btn>
          </div>
        </div>
      ))}
      {confirmDialog}
    </div>
  );
}

function ServiceEditor({
  service,
  onDone,
  onCancel,
}: {
  service: StoreService | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { loc, lang } = useLanguage();
  const [f, setF] = useState(() => ({
    ...EMPTY_SERVICE,
    ...(service
      ? {
          title: service.title,
          description: service.description,
          kind: service.kind,
          price_from_iqd: service.price_from_iqd,
          price_unit: service.price_unit,
          materials: service.materials,
          imageUrl: service.imageUrl,
          active: service.active ?? true,
        }
      : {}),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    const body = {
      title: f.title,
      description: f.description,
      kind: f.kind,
      price_from_iqd: f.price_from_iqd,
      price_unit: f.price_unit,
      materials: f.materials,
      image_key: f.imageUrl ?? '',
      active: f.active,
    };
    try {
      if (service) await merchantApi.updateService(service.id, body);
      else await merchantApi.createService(body);
      onDone();
    } catch (e) {
      setError(merchantRefusal(e, lang, loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا')));
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 space-y-3.5">
      <h3 className="text-gold font-bold text-[13px]">
        {service ? loc('تعديل الخدمة', 'Edit service', 'دەستکاری') : loc('خدمة جديدة', 'New service', 'خزمەتگوزاری نوێ')}
      </h3>

      <Input label={loc('العنوان', 'Title', 'ناونیشان')} value={f.title} onChange={(v) => setF({ ...f, title: v })} />

      <div>
        <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{loc('النوع', 'Kind', 'جۆر')}</label>
        <div className="flex gap-1.5 flex-wrap">
          {SERVICE_KIND_LABELS.map(([id, ar, en, ckb]) => (
            <Chip key={id} label={loc(ar, en, ckb)} active={f.kind === id} onClick={() => setF({ ...f, kind: id })} />
          ))}
        </div>
      </div>

      <TextArea
        label={loc('الوصف', 'Description', 'وەسف')}
        value={f.description}
        onChange={(v) => setF({ ...f, description: v })}
        rows={3}
        hint={loc(
          'ماذا تشمل الخدمة؟ الدقة، المواد، أوقات التسليم…',
          'What does it include? Precision, materials, turnaround…',
          'چی لەخۆدەگرێت؟'
        )}
      />

      <div className="grid grid-cols-2 gap-2">
        <Input
          label={loc('السعر يبدأ من (د.ع)', 'Price from (IQD)', 'نرخ لە')}
          value={f.price_from_iqd === null ? '' : String(f.price_from_iqd)}
          type="number"
          ltr
          onChange={(v) => setF({ ...f, price_from_iqd: v === '' ? null : Number(v) || 0 })}
          hint={loc('اتركه فارغًا لعرض «حسب الطلب»', 'Empty shows “ask for a quote”', 'بەتاڵ = داوای نرخ')}
        />
        <Input
          label={loc('الوحدة (اختياري)', 'Unit (optional)', 'یەکە')}
          value={f.price_unit}
          onChange={(v) => setF({ ...f, price_unit: v })}
          placeholder={loc('للغرام، للساعة، للقطعة…', 'per gram, per hour…', 'بۆ گرام…')}
        />
      </div>

      <ChipListEditor
        label={loc('الخامات المتاحة', 'Available materials', 'کەرەستەکان')}
        values={f.materials}
        onChange={(materials) => setF({ ...f, materials })}
        placeholder={loc('PLA، PETG، Resin… ثم Enter', 'PLA, PETG, Resin… then Enter', 'PLA…')}
      />

      <ImagePicker
        label={loc('صورة الخدمة', 'Service image', 'وێنە')}
        shape="wide"
        value={f.imageUrl}
        onChange={(imageUrl) => setF({ ...f, imageUrl })}
      />

      {error && <p className="text-red-400 text-[11.5px]">{error}</p>}

      <div className="flex gap-2">
        <Btn onClick={save} disabled={saving || f.title.trim().length < 2} full>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {loc('حفظ', 'Save', 'پاشەکەوت')}
        </Btn>
        <Btn kind="ghost" onClick={onCancel}>
          {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- showcase

const SHOWCASE_KINDS: Array<{ id: 'printer' | 'material' | 'work'; icon: React.ReactNode; ar: string; en: string; ckb: string }> = [
  { id: 'printer', icon: <Printer className="w-3.5 h-3.5" />, ar: 'طابعاتنا', en: 'Our printers', ckb: 'چاپکەرەکانمان' },
  { id: 'material', icon: <Layers className="w-3.5 h-3.5" />, ar: 'الخامات', en: 'Materials', ckb: 'کەرەستەکان' },
  { id: 'work', icon: <Hammer className="w-3.5 h-3.5" />, ar: 'أعمالنا', en: 'Our work', ckb: 'کارەکانمان' },
];

export function ShowcaseTab() {
  const { loc, lang } = useLanguage();
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  const [items, setItems] = useState<ShowcaseItem[] | null>(null);
  const [kind, setKind] = useState<'printer' | 'material' | 'work'>('work');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    merchantApi.showcase().then((d) => setItems(d.items)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  if (items === null) return <Spinner />;

  async function add() {
    if (!title.trim()) return;
    setBusy('new');
    setError('');
    try {
      await merchantApi.createShowcase({ kind, title: title.trim(), details: details.trim(), image_key: imageUrl ?? '' });
      setTitle('');
      setDetails('');
      setImageUrl(null);
      load();
    } catch (e) {
      setError(merchantRefusal(e, lang, loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت')));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-3">
      <Card title={loc('أضف إلى معرض ورشتك', 'Add to your workshop showcase', 'زیادکردن بۆ پیشانگا')}>
        <div className="flex gap-1.5 mb-3">
          {SHOWCASE_KINDS.map((k) => (
            <Chip
              key={k.id}
              active={kind === k.id}
              onClick={() => setKind(k.id)}
              label={
                <span className="inline-flex items-center gap-1">
                  {k.icon}
                  {loc(k.ar, k.en, k.ckb)}
                </span>
              }
            />
          ))}
        </div>
        <div className="space-y-2.5">
          <Input
            value={title}
            onChange={setTitle}
            placeholder={
              kind === 'printer'
                ? loc('مثال: Bambu Lab A1', 'e.g. Bambu Lab A1', 'Bambu Lab A1')
                : kind === 'material'
                  ? loc('مثال: PETG-CF', 'e.g. PETG-CF', 'PETG-CF')
                  : loc('اسم العمل', 'Work title', 'ناوی کار')
            }
          />
          <TextArea
            value={details}
            onChange={setDetails}
            rows={2}
            hint={loc('تفاصيل قصيرة تظهر للزبون', 'A short caption visitors see', 'وردەکاری کورت')}
          />
          <ImagePicker shape="wide" value={imageUrl} onChange={setImageUrl} />
          {error && <p className="text-red-400 text-[11.5px]">{error}</p>}
          <Btn onClick={add} disabled={busy === 'new' || !title.trim()} full>
            {busy === 'new' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {loc('إضافة', 'Add', 'زیادکردن')}
          </Btn>
        </div>
      </Card>

      {!items.length && (
        <Empty
          text={loc('المعرض فارغ', 'The showcase is empty', 'پیشانگا بەتاڵە')}
          hint={loc(
            'اعرض طابعاتك وخاماتك وأفضل أعمالك — هذا ما يبني ثقة الزبون بورشتك.',
            'Show your printers, materials and best work — this is what earns a customer’s trust.',
            'چاپکەر و کەرەستە و باشترین کارەکانت نیشان بدە.'
          )}
        />
      )}

      {SHOWCASE_KINDS.map((k) => {
        const group = items.filter((i) => i.kind === k.id);
        if (!group.length) return null;
        return (
          <div key={k.id}>
            <p className="text-zinc-400 text-[12px] font-bold mb-2 flex items-center gap-1.5">
              {k.icon}
              {loc(k.ar, k.en, k.ckb)}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {group.map((it) => (
                <div key={it.id} className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
                  <div className="aspect-[3/2] bg-black/40">
                    {it.imageUrl && <img src={it.imageUrl} alt="" className="w-full h-full object-cover" />}
                  </div>
                  <div className="p-2">
                    <p className="text-white text-[12px] font-semibold truncate">{it.title}</p>
                    {it.details && <p className="text-zinc-500 text-[10.5px] line-clamp-2">{it.details}</p>}
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: loc('حذف؟', 'Delete?', 'بسڕدرێتەوە؟'),
                          // OWNER: Sorani to be written by hand.
                          consequence: loc('يختفي من معرض متجرك، ولا يمكن التراجع.', 'It disappears from your store’s showcase, and this cannot be undone.'),
                          confirmLabel: loc('حذف', 'Delete', 'سڕینەوە'),
                          cancelLabel: loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە'),
                          destructive: true,
                        });
                        if (!ok) return;
                        setBusy(it.id);
                        try {
                          await merchantApi.deleteShowcase(it.id);
                          load();
                        } catch (e) {
                          toast.error(merchantRefusal(e, lang, loc('تعذّر الحذف', 'Could not delete', 'نەسڕایەوە')));
                        } finally {
                          setBusy('');
                        }
                      }}
                      disabled={busy === it.id}
                      className="mt-1.5 text-red-300 text-[10.5px] font-bold disabled:opacity-40"
                    >
                      {loc('حذف', 'Delete', 'سڕینەوە')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {confirmDialog}
    </div>
  );
}
