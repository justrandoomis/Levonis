/**
 * CATALOGUE AND PRICES — every entity of `ENTITIES` (worker/lib/printCloud/
 * catalog.ts) listed with `GET /catalog/{entity}` and created or edited with
 * the generated form (catalog/EntitySheet.tsx), plus a variant's price tiers,
 * the categories' buyback rules and the price log.
 *
 * The live database starts empty: every list says so, and says what to add
 * first (a tier before a printer model, a model before a printer, a product
 * before a variant).
 */
import { useMemo, useState } from 'react';
import { History, Plus, Tag } from 'lucide-react';
import { Money } from '../../ui/Money';
import { Sheet } from '../../ui/Sheet';
import { Switch } from '../../ui/Switch';
import { toast } from '../../../lib/toastStore';
import { usePcAccess } from '../access';
import { pc, parseJsonColumn, type Category, type PriceChange, type Row } from '../api';
import { CLIENT_ENTITIES, ENTITY_ORDER, canCreate, type ClientEntity, type ClientField, type EntityKey, type RefSource } from '../catalogFields';
import { pick, tri, type Tri } from '../i18n';
import { bps, duration, formatDateTime, num } from '../format';
import { pcRefusal } from '../refusal';
import { invalidateRefs, useRefs } from '../refs';
import { Act, Chips, IntField, Json, LoadState, Note, type PcColumn, PcList, RefreshButton, SectionHead, T, TextField, useLoad, usePcLang, W, YesNo } from '../ui';
import { EntitySheet } from './catalog/EntitySheet';
import { PRICE_TIERS_LABEL, PriceTiersSheet } from './catalog/PriceTiersSheet';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('الكتالوج والأسعار', 'Catalogue and prices', 'کاتالۆگ و نرخەکان'),
  desc: tri(
    'ما تبيعه الخدمة وبكم. الترتيب الطبيعي للبدء: فئة ساعات ← طراز طابعة ← طابعة ← باقة؛ ومنتج ← صنف ← شرائح سعره.',
    'What the service sells, and for how much. The natural order to start: an hour tier → a printer model → a printer → a package; and a product → a variant → its price tiers.',
    'ئەوەی خزمەتگوزارییەکە دەیفرۆشێت و بە چەند. ڕیزبەندیی سروشتی بۆ دەستپێکردن: پلەی کاتژمێر ← مۆدێلی چاپکەر ← چاپکەر ← پاکێج؛ و بەرهەم ← جۆر ← پلەکانی نرخی.'
  ),
  entities: tri('أجزاء الكتالوج', 'Catalogue parts', 'بەشەکانی کاتالۆگ'),
  categories: tri('فئات المنتجات وإعادة الشراء', 'Categories and buyback', 'پۆلەکان و کڕینەوە'),
  priceLog: tri('سجل الأسعار', 'Price log', 'تۆماری نرخەکان'),
  add: tri('إضافة', 'Add', 'زیادکردن'),
  addNeedsMoney: tri('الإضافة هنا تحتاج المالك أو المدير المالي (فيها سعر أو شرط سعر).', 'Adding here needs the owner or a full admin (it carries a price or a term of one).', 'زیادکردن لێرە پێویستی بە خاوەن یان بەڕێوەبەری داراییە (نرخ یان مەرجێکی نرخی تێدایە).'),
  empty: tri('لا شيء بعد في هذا الجزء.', 'Nothing in this part yet.', 'هێشتا هیچ شتێک لەم بەشەدا نییە.'),
  filter: tri('تصفية القائمة', 'Filter the list', 'پاڵاوتنی لیست'),
  count: tri('صف', 'rows', 'ڕیز'),
  capNote: tri('تعرض القائمة أول 500 صف كما يرتّبها الخادم.', 'The list shows the first 500 rows in the server’s order.', 'لیستەکە یەکەم 500 ڕیز پیشان دەدات بە ڕیزبەندیی ڕاژەکار.'),
  kind: tri('النوع', 'Kind', 'جۆر'),
  buyback: tri('إعادة الشراء', 'Buyback', 'کڕینەوە'),
  rate: tri('نسبة إعادة الشراء', 'Buyback rate', 'ڕێژەی کڕینەوە'),
  storable: tri('قابلة للتخزين', 'Storable', 'هەڵدەگیرێت'),
  editBuyback: tri('قاعدة إعادة الشراء', 'Buyback rule', 'یاسای کڕینەوە'),
  buybackHelp: tri(
    'يبيع العميل المادة غير المستعملة بنسبة من سعر دفعات شرائه نفسها؛ تغيير القاعدة يُسجَّل كتغيير سعر.',
    'Customers sell unused material back at a share of what their own purchase lots cost; a change is recorded like a price change.',
    'کڕیار کەرەستەی بەکارنەهاتوو بە بەشێک لە نرخی کۆمەڵەکانی کڕینی خۆی دەفرۆشێتەوە؛ گۆڕینی یاساکە وەک گۆڕینی نرخ تۆمار دەکرێت.'
  ),
  rateBps: tri('النسبة بنقاط الأساس (5000 = 50٪)', 'Rate in basis points (5000 = 50%)', 'ڕێژە بە خاڵی بنەڕەت (5000 = 50٪)'),
  buybackSaved: tri('حُفظت قاعدة إعادة الشراء.', 'Buyback rule saved.', 'یاسای کڕینەوە پاشەکەوت کرا.'),
  filament: tri('خيوط', 'Filament', 'فیلامێنت'),
  accessory: tri('ملحقات', 'Accessory', 'پاشکۆ'),
  tool: tri('أدوات', 'Tool', 'ئامراز'),
  logEmpty: tri('لا تغييرات أسعار بعد.', 'No price changes yet.', 'هێشتا هیچ گۆڕینێکی نرخ نییە.'),
  before: tri('قبل', 'Before', 'پێشتر'),
  after: tri('بعد', 'After', 'دواتر'),
  limit: tri('أحدث 200 تغيير.', 'The latest 200 changes.', 'نوێترین 200 گۆڕانکاری.'),
} satisfies Record<string, Tri>;

/** What the price log's `entity_type` names, in words. */
const LOG_TYPE: Readonly<Record<string, Tri>> = {
  ...Object.fromEntries(ENTITY_ORDER.map((k) => [k, CLIENT_ENTITIES[k].label])),
  price_tiers: PRICE_TIERS_LABEL,
  category_buyback: tri('قاعدة إعادة شراء فئة', 'A category’s buyback rule', 'یاسای کڕینەوەی پۆلێک'),
};

type View = EntityKey | 'categories' | 'price_changes';

export default function CatalogSection(_: SectionProps) {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const [view, setView] = useState<View>('tiers');
  const items: Array<{ id: View; label: string }> = [
    ...ENTITY_ORDER.map((k) => ({ id: k as View, label: pick(CLIENT_ENTITIES[k].label, lang) })),
    { id: 'categories', label: t(S.categories) },
    ...(access.money ? [{ id: 'price_changes' as View, label: t(S.priceLog) }] : []),
  ];
  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} />
      <Chips<View> label={t(S.entities)} value={view} onChange={setView} items={items} />
      {view === 'categories' ? (
        <CategoriesPanel />
      ) : view === 'price_changes' ? (
        access.money && <PriceLog />
      ) : (
        <EntityPanel key={view} entity={CLIENT_ENTITIES[view]} />
      )}
    </div>
  );
}

/** The reference lists an entity's fields point at. */
const refsOf = (entity: ClientEntity): RefSource[] => [...new Set(entity.fields.map((f) => f.ref).filter((r): r is RefSource => !!r)), ...(entity.key === 'packages' || entity.key === 'promotions' ? (['variants', 'tiers', 'categories'] as RefSource[]) : [])];

function EntityPanel({ entity }: { entity: ClientEntity }) {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const list = useLoad(() => pc.get<Row[]>(`/catalog/${entity.key}`), [entity.key]);
  const refs = useRefs(refsOf(entity), lang);
  const [editing, setEditing] = useState<{ row: Row | null; key: number } | null>(null);
  const [tiersOf, setTiersOf] = useState<Row | null>(null);
  const [filter, setFilter] = useState('');
  const mayCreate = canCreate(entity, access.money);

  const rows = useMemo(() => {
    if (!list.data) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return list.data;
    return list.data.filter((r) => Object.values(r).some((v) => typeof v === 'string' && v.toLowerCase().includes(q)));
  }, [list.data, filter]);

  const fieldOf = (name: string) => entity.fields.find((f) => f.name === name) as ClientField;
  const columns: PcColumn<Row>[] = entity.columns.map((name, i) => {
    const f = fieldOf(name);
    return {
      id: name,
      header: pick(f.label, lang),
      card: i === 0 ? 'title' : f.kind === 'bool' ? 'badge' : 'field',
      numeric: f.kind === 'int' && !f.editor,
      cell: (row: Row) =>
        i === 0 ? (
          <button type="button" className="text-start font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm" onClick={() => setEditing({ row, key: Date.now() })}>
            {cellText(f, row) || String(row.id)}
          </button>
        ) : (
          <CellValue field={f} row={row} refName={(kind, id) => refs.name(kind, id)} />
        ),
    };
  });

  return (
    <div className="space-y-3">
      <SectionHead
        level={3}
        title={pick(entity.label, lang)}
        description={pick(entity.help, lang)}
        actions={
          <>
            <RefreshButton onClick={() => list.reload()} loading={list.loading} />
            <Act kind="primary" icon={<Plus size={14} aria-hidden />} disabled={!mayCreate} title={mayCreate ? undefined : t(S.addNeedsMoney)} onClick={() => setEditing({ row: null, key: Date.now() })}>
              {t(S.add)}
            </Act>
          </>
        }
      />
      {!mayCreate && <Note tone="info">{t(S.addNeedsMoney)}</Note>}
      {list.data && list.data.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <TextField className="w-full max-w-sm" label={t(S.filter)} value={filter} onChange={setFilter} />
          <span className={`pb-2 text-[12px] ${T.text3}`}>
            {num(rows?.length ?? 0)} {t(S.count)}
            {list.data.length >= 500 ? ` · ${t(S.capNote)}` : ''}
          </span>
        </div>
      )}
      <PcList<Row>
        label={pick(entity.label, lang)}
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.id)}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        empty={{ title: t(S.empty), description: pick(entity.help, lang) }}
        rowLabel={(r) => cellText(fieldOf(entity.columns[0]), r) || String(r.id)}
        rowActions={(r) => [
          { id: 'edit', label: t(W.edit), onSelect: () => setEditing({ row: r, key: Date.now() }) },
          ...(entity.key === 'variants' && access.money ? [{ id: 'tiers', label: pick(PRICE_TIERS_LABEL, lang), icon: <Tag size={14} aria-hidden />, onSelect: () => setTiersOf(r) }] : []),
        ]}
      />
      {editing && (
        <EntitySheet
          key={editing.key}
          entity={entity}
          row={editing.row}
          open
          onClose={() => setEditing(null)}
          onSaved={() => void list.reload()}
          access={access}
          refs={refs}
        />
      )}
      {tiersOf && <PriceTiersSheet key={String(tiersOf.id)} variant={tiersOf} open onClose={() => setTiersOf(null)} />}
    </div>
  );
}

/** A cell's plain text (for the title button and the row's accessible name). */
function cellText(f: ClientField, row: Row): string {
  const v = row[f.name];
  if (v === null || v === undefined) return '';
  return String(v);
}

function CellValue({ field: f, row, refName }: { field: ClientField; row: Row; refName: (kind: RefSource, id: string) => string }) {
  const { lang } = usePcLang();
  const v = row[f.name];
  if (v === null || v === undefined || v === '') return <span className={T.text3}>—</span>;
  if (f.kind === 'bool') return <YesNo value={v} />;
  if (f.kind === 'ref' && f.ref) return <span>{refName(f.ref, String(v))}</span>;
  if (f.kind === 'enum') return <span>{f.valueLabels?.[String(v)] ? pick(f.valueLabels[String(v)], lang) : String(v)}</span>;
  if (f.kind === 'int') {
    if (f.iqd) return <Money iqd={Number(v)} />;
    if (f.bps) return <bdi dir="ltr">{bps(Number(v))}</bdi>;
    if (f.editor === 'duration') return <span>{duration(Number(v), lang)}</span>;
    return <span className="tabular-nums">{num(Number(v))}</span>;
  }
  if (f.kind === 'iso') return <span>{formatDateTime(String(v), lang)}</span>;
  if (f.kind === 'json_array') return <bdi dir="ltr">{parseJsonColumn<unknown[]>(v, []).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')}</bdi>;
  if (f.kind === 'code') return <bdi dir="ltr" className="font-mono text-[12px]">{String(v)}</bdi>;
  return <span>{String(v)}</span>;
}

// ------------------------------------------------------------------ categories

function CategoriesPanel() {
  const { t, lang } = usePcLang();
  const access = usePcAccess();
  const list = useLoad(() => pc.get<Category[]>('/categories'), []);
  const [editing, setEditing] = useState<Category | null>(null);
  const kindWord = (k: string) => t(k === 'filament' ? S.filament : k === 'tool' ? S.tool : S.accessory);
  const columns: PcColumn<Category>[] = [
    { id: 'name', header: t(W.details), card: 'title', cell: (c) => <span>{String(c[`name_${lang}` as keyof Category] || c.name_en)}</span> },
    { id: 'kind', header: t(S.kind), cell: (c) => kindWord(c.kind) },
    { id: 'buyback', header: t(S.buyback), card: 'badge', cell: (c) => <YesNo value={c.buyback_enabled} /> },
    { id: 'rate', header: t(S.rate), numeric: true, cell: (c) => <bdi dir="ltr">{bps(c.buyback_rate_bps)}</bdi> },
    { id: 'storable', header: t(S.storable), cell: (c) => <YesNo value={c.storable} /> },
  ];
  return (
    <div className="space-y-3">
      <SectionHead level={3} title={t(S.categories)} description={t(S.buybackHelp)} actions={<RefreshButton onClick={() => list.reload()} loading={list.loading} />} />
      <PcList<Category>
        label={t(S.categories)}
        columns={columns}
        rows={list.data}
        rowKey={(c) => c.code}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        rowActions={access.money ? (c) => [{ id: 'buyback', label: t(S.editBuyback), onSelect: () => setEditing(c) }] : undefined}
      />
      {editing && (
        <BuybackRuleSheet
          key={editing.code}
          category={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidateRefs('categories');
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

function BuybackRuleSheet({ category, onClose, onSaved }: { category: Category; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = usePcLang();
  const [enabled, setEnabled] = useState(category.buyback_enabled === 1);
  const [rate, setRate] = useState<number | null>(category.buyback_rate_bps);
  const [failure, setFailure] = useState<string | null>(null);
  const bad = rate === null || rate < 0 || rate > 10000;
  const save = async () => {
    setFailure(null);
    if (bad) return;
    try {
      await pc.patch(`/categories/${encodeURIComponent(category.code)}/buyback`, { buyback_enabled: enabled, buyback_rate_bps: rate });
      toast.success(t(S.buybackSaved));
      onSaved();
      onClose();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };
  const titleId = `pc-buyback-${category.code}`;
  return (
    <Sheet open onClose={onClose} labelledBy={titleId} panelClassName="ap w-full sm:max-w-md">
      <div className="space-y-3 px-5 pb-5 pt-2">
        <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
          {t(S.editBuyback)} — {String(category[`name_${lang}` as keyof Category] || category.name_en)}
        </h2>
        <p className={`text-[12.5px] leading-relaxed ${T.text3}`}>{t(S.buybackHelp)}</p>
        <Switch checked={enabled} onChange={setEnabled} label={t(S.buyback)} />
        <IntField label={t(S.rateBps)} value={rate} onChange={setRate} error={bad ? '0–10,000' : null} hint={rate !== null ? <bdi dir="ltr">= {bps(rate)}</bdi> : undefined} />
        {failure && <p className="lv-field-error">{failure}</p>}
        <div className="flex gap-2">
          <Act kind="primary" onClick={save} disabled={bad}>
            {t(W.save)}
          </Act>
          <Act kind="ghost" onClick={onClose}>
            {t(W.cancel)}
          </Act>
        </div>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ the price log

function PriceLog() {
  const { t, lang } = usePcLang();
  const log = useLoad(() => pc.get<PriceChange[]>('/price-changes?limit=200'), []);
  return (
    <div className="space-y-3">
      <SectionHead
        level={3}
        title={
          <span className="inline-flex items-center gap-2">
            <History size={16} aria-hidden /> {t(S.priceLog)}
          </span>
        }
        description={t(S.limit)}
        actions={<RefreshButton onClick={() => log.reload()} loading={log.loading} />}
      />
      <LoadState state={log}>
        {(rows) =>
          rows.length === 0 ? (
            <Note tone="info">{t(S.logEmpty)}</Note>
          ) : (
            <ul className="space-y-2">
              {rows.map((c) => {
                const before = parseJsonColumn<Row>(c.before_json, {});
                const after = parseJsonColumn<Row>(c.after_json, {});
                const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
                return (
                  <li key={c.id} className={`${T.surface} p-3`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                      <span className={`font-semibold ${T.text1}`}>
                        {LOG_TYPE[c.entity_type] ? pick(LOG_TYPE[c.entity_type], lang) : c.entity_type} · <bdi dir="ltr" className="font-mono">{c.entity_id}</bdi>
                      </span>
                      <span className={T.text3}>
                        {formatDateTime(c.created_at, lang)} · <bdi dir="ltr" className="font-mono">{c.actor_id}</bdi>
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div className="min-w-0">
                        <p className={`mb-1 text-[11.5px] font-semibold ${T.text3}`}>{t(S.before)}</p>
                        <Json value={Object.fromEntries(keys.map((k) => [k, before[k]]))} />
                      </div>
                      <div className="min-w-0">
                        <p className={`mb-1 text-[11.5px] font-semibold ${T.text3}`}>{t(S.after)}</p>
                        <Json value={Object.fromEntries(keys.map((k) => [k, after[k]]))} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        }
      </LoadState>
    </div>
  );
}
