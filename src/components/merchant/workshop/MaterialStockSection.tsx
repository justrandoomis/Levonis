/**
 * «مخزون الخامات» — WHAT IS ON THE SHELF (stream W5-B).
 *
 * A LIGHT stock: material × colour × grams, in the same material ids the
 * requests use. Until the workshop saves a line, stock plays no part in which
 * requests it is shown (it is judged on its printers alone); once it does, a
 * job in a material or colour the shelf lacks — or heavier than any spool of
 * it, when the job's weight is known — is not its job, on the board, in the
 * notices and at the offer. Clearing the shelf is an explicit «أوقف تتبّع
 * المخزون», confirmed, because it WIDENS what the workshop is shown.
 */
import { useEffect, useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Card } from '../../ui/Card';
import { Button, IconButton } from '../../ui/Button';
import { Select } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { Skeleton } from '../../ui/Skeleton';
import { formatFigure } from '../../../lib/localeNumber';
import { merchantRefusal } from '../shell/refusal';
import { workshopApi, type StockLine, type StockResponse } from './api';

/** The colours a line can name — the same swatches the printer form offers, plus «any colour». */
const SWATCHES: Array<{ hex: string; ar: string; en: string }> = [
  { hex: '#000000', ar: 'أسود', en: 'Black' },
  { hex: '#ffffff', ar: 'أبيض', en: 'White' },
  { hex: '#808080', ar: 'رمادي', en: 'Grey' },
  { hex: '#ff0000', ar: 'أحمر', en: 'Red' },
  { hex: '#0000ff', ar: 'أزرق', en: 'Blue' },
  { hex: '#00a651', ar: 'أخضر', en: 'Green' },
  { hex: '#ffd700', ar: 'أصفر', en: 'Yellow' },
  { hex: '#ff8c00', ar: 'برتقالي', en: 'Orange' },
];

type Row = StockLine & { key: string };
let seq = 0;
const rowOf = (l: StockLine): Row => ({ ...l, key: `r${++seq}` });

export default function MaterialStockSection() {
  const { loc, lang } = useLanguage();
  const L = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const id = useId();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [data, setData] = useState<StockResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    workshopApi
      .stock()
      .then((d) => {
        setData(d);
        setRows(d.stock.map(rowOf));
        setDirty(false);
      })
      .catch(() => setData({ tracked: false, stock: [], materials: [], max_lines: 120 }));
  useEffect(() => {
    void load();
  }, []);

  const matName = (mid: string) => {
    const m = data?.materials.find((x) => x.id === mid);
    return m ? (lang === 'en' ? m.name_en : m.name_ar || m.name_en) : mid;
  };
  const edit = (key: string, patch: Partial<StockLine>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const add = () => {
    setRows((rs) => [...rs, rowOf({ material_id: data?.materials[0]?.id ?? 'pla', color_hex: '', color_name: '', grams: 1000 })]);
    setDirty(true);
  };
  const duplicate = (() => {
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.material_id}|${r.color_hex}`;
      if (seen.has(k)) return k;
      seen.add(k);
    }
    return '';
  })();

  async function save() {
    setError('');
    if (!rows.length) return stopTracking();
    if (duplicate) {
      setError(loc('الخامة واللون نفسهما مكرران — اجمعهما في سطر واحد.', 'The same material and colour appear twice — combine them in one line.'));
      return;
    }
    try {
      await workshopApi.saveStock(rows.map(({ key: _key, ...l }) => ({ ...l, grams: Math.max(0, Math.round(l.grams || 0)) })));
      toast.success(loc('حُفظ المخزون — يُطابَق عليه من الآن.', 'Stock saved — requests are matched against it from now on.'));
      await load();
    } catch (e) {
      setError(merchantRefusal(e, L, loc('تعذّر حفظ المخزون', 'Could not save the stock')));
    }
  }

  async function stopTracking() {
    const ok = await confirm({
      title: loc('إيقاف تتبّع المخزون؟', 'Stop tracking stock?'),
      consequence: loc(
        'ستُعرض عليك الطلبات حسب طابعاتك وحدها، مهما كان على الرف.',
        'You will be shown requests by your printers alone, whatever is on the shelf.'
      ),
      confirmLabel: loc('أوقف التتبّع', 'Stop tracking'),
    });
    if (!ok) return;
    try {
      await workshopApi.saveStock([], true);
      await load();
    } catch (e) {
      setError(merchantRefusal(e, L, loc('تعذّر الحفظ', 'Could not save')));
    }
  }

  const total = rows.reduce((n, r) => n + (r.grams || 0), 0);

  return (
    <Card
      id="stock"
      title={loc('مخزون الخامات', 'Material stock')}
      description={
        data?.tracked
          ? loc(`${formatFigure(rows.length, lang)} سطر · ${formatFigure(total / 1000, lang, 1)} كغ على الرف`, `${formatFigure(rows.length, lang)} lines · ${formatFigure(total / 1000, lang, 1)} kg on the shelf`)
          : loc('اختياري. حين تسجّله، لا تُعرض عليك طلبات بخامة أو لون ليس عندك.', 'Optional. Once you record it, you are not shown jobs in a material or colour you do not have.')
      }
      action={
        data && (
          <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={add} disabled={rows.length >= (data.max_lines ?? 120)} data-stock-add>
            {data.tracked || rows.length ? loc('أضف سطرًا', 'Add line') : loc('ابدأ التتبّع', 'Start tracking')}
          </Button>
        )
      }
    >
      {data === null ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[12.5px] text-text-muted" data-stock-empty>
          {loc('لا مخزون مسجَّل — تُطابَق الطلبات على طابعاتك وحدها.', 'No stock recorded — requests are matched on your printers alone.')}
        </p>
      ) : (
        <ul className="space-y-2" data-stock-lines aria-describedby={`${id}-hint`}>
          {rows.map((r) => (
            <li key={r.key} className="space-y-2 rounded-xl bg-white/[0.03] p-2.5" data-stock-line>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Select aria-label={loc('الخامة', 'Material')} value={r.material_id} onChange={(e) => edit(r.key, { material_id: e.target.value })} className="w-full">
                    {(data.materials ?? []).map((m) => (
                      <option key={m.id} value={m.id}>{matName(m.id)}</option>
                    ))}
                  </Select>
                </div>
                <IconButton
                  label={loc('احذف السطر', 'Remove line')}
                  icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                  variant="ghost"
                  onClick={() => {
                    setRows((rs) => rs.filter((x) => x.key !== r.key));
                    setDirty(true);
                  }}
                />
              </div>
              {/* Two columns while each keeps 8.5rem (a colour name, «2,750 g»); stacked below that (W6: 320px clipped both). */}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
                <div className="min-w-0">
                  <Select
                    aria-label={loc('اللون', 'Colour')}
                    value={r.color_hex}
                    className="w-full"
                    onChange={(e) => {
                      const sw = SWATCHES.find((x) => x.hex === e.target.value);
                      edit(r.key, { color_hex: e.target.value, color_name: sw ? (lang === 'en' ? sw.en : sw.ar) : '' });
                    }}
                  >
                    <option value="">{loc('أي لون', 'Any colour')}</option>
                    {SWATCHES.map((x) => (
                      <option key={x.hex} value={x.hex}>{lang === 'en' ? x.en : x.ar}</option>
                    ))}
                    {r.color_hex && !SWATCHES.some((x) => x.hex === r.color_hex) && <option value={r.color_hex}>{r.color_name || r.color_hex}</option>}
                  </Select>
                </div>
                <NumberInput
                  aria-label={loc('الغرامات', 'Grams')}
                  kind="number"
                  decimals={0}
                  min={0}
                  max={1_000_000}
                  unit={loc('غ', 'g')}
                  value={r.grams}
                  onValueChange={(v) => edit(r.key, { grams: v ?? 0 })}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p id={`${id}-hint`} className="mt-2 text-[11.5px] text-text-muted">
        {loc('«أي لون» يعني أنك لا تتتبّع ألوان هذه الخامة. الصفر يعني أنها نفدت.', '“Any colour” means you do not track this material’s colours. Zero means it ran out.')}
      </p>
      {error && <p className="lv-field-error mt-2" role="alert">{error}</p>}
      {(dirty || data?.tracked) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {dirty && (
            <Button variant="primary" onClick={save} loadingLabel={loc('جارٍ الحفظ…', 'Saving…')} data-stock-save>
              {loc('احفظ المخزون', 'Save stock')}
            </Button>
          )}
          {data?.tracked && (
            <Button variant="ghost" onClick={stopTracking} data-stock-untrack>
              {loc('أوقف تتبّع المخزون', 'Stop tracking stock')}
            </Button>
          )}
        </div>
      )}
      {confirmDialog}
    </Card>
  );
}
