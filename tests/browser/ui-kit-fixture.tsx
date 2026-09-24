/**
 * THE UI KIT — every wave-3 primitive, mounted as shipped, on one page.
 *
 * A browser fixture, not an app route: it lives beside the other fixtures in
 * tests/browser/, is served only by a local `vite` dev server, and is never
 * reachable from production. scripts/e2e-ui-kit.mjs drives it in Arabic (RTL)
 * and English (LTR), dark, at 360px and 1280px — it screenshots every
 * primitive and checks the behaviour a source rule cannot see (the focus
 * trap, focus coming back, Escape reaching only the top layer, the menu and
 * tab keyboards, one DataList layout mounted, the live regions).
 *
 *   /tests/browser/ui-kit.html?lang=ar|en[&density=compact]
 *
 * Only utilities that already exist in the app are used here: Tailwind scans
 * this folder too, and a fixture must not grow the store's stylesheet.
 */
import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Archive, Copy, Pencil, Printer, Trash2, Truck, Package, ReceiptText, Settings, ShoppingBag, Users, Bell } from 'lucide-react';
import { LanguageProvider, useLanguage } from '../../src/LanguageContext';
import { ApiError } from '../../src/lib/api';
import { Button, IconButton } from '../../src/components/ui/Button';
import { Field, Input, Select, Textarea } from '../../src/components/ui/Field';
import { NumberInput } from '../../src/components/ui/NumberInput';
import { Checkbox, Switch } from '../../src/components/ui/Switch';
import { ConfirmDialog, useConfirm } from '../../src/components/ui/ConfirmDialog';
import { Toaster, useToast } from '../../src/components/ui/Toast';
import { Badge, StatusChip, type Tone } from '../../src/components/ui/Badge';
import { Card } from '../../src/components/ui/Card';
import { KpiTile, Sparkline } from '../../src/components/ui/KpiTile';
import { Money } from '../../src/components/ui/Money';
import { DataList, type DataListColumn } from '../../src/components/ui/DataList';
import { Menu } from '../../src/components/ui/Menu';
import { Overlay } from '../../src/components/ui/Overlay';
import { Sheet } from '../../src/components/ui/Sheet';
import { CommandPalette, useCommandPaletteShortcut } from '../../src/components/ui/CommandPalette';
import { TabPanels, TabStrip } from '../../src/components/ui/Tabs';
import { CardSkeleton, FormSkeleton, KpiRowSkeleton, ListRowsSkeleton, TableRowsSkeleton } from '../../src/components/ui/DashboardSkeletons';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
try {
  localStorage.setItem('levo_lang', params.get('lang') === 'en' ? 'en' : 'ar');
} catch {
  /* storage blocked: Arabic, the default */
}
const DENSITY = params.get('density') === 'compact' ? 'compact' : undefined;

interface Order {
  id: string;
  customer: string;
  status: 'pending' | 'paid' | 'shipped' | 'cancelled';
  total: number;
  items: number;
  city: string;
}

const ORDERS: Order[] = [
  { id: 'LV-10241', customer: 'علي حسن', status: 'pending', total: 185000, items: 3, city: 'بغداد' },
  { id: 'LV-10240', customer: 'Sara Kareem', status: 'paid', total: 72500, items: 1, city: 'Erbil' },
  { id: 'LV-10236', customer: 'مصطفى عبد الله الجبوري', status: 'shipped', total: 1240000, items: 7, city: 'البصرة' },
  { id: 'LV-10231', customer: 'Hawre Omar', status: 'cancelled', total: 39000, items: 2, city: 'Sulaymaniyah' },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-kit={id} className="space-y-3">
      <h2 className="border-b border-border-subtle pb-2 text-sm font-semibold text-text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Where() {
  const where = useLocation();
  return (
    <p data-kit-location className="text-[13px] text-text-muted" dir="ltr">
      {where.pathname}
    </p>
  );
}

function Kit() {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const [ask, askDialog] = useConfirm();
  const [answer, setAnswer] = useState('—');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [nestedOpen, setNestedOpen] = useState(false);
  const [dirtyOpen, setDirtyOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [price, setPrice] = useState<number | null>(125000);
  const [priceOk, setPriceOk] = useState(true);
  const [qty, setQty] = useState<number | null>(2);
  const [open, setOpen] = useState(true);
  const [notify, setNotify] = useState(false);
  const [agree, setAgree] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['LV-10240']));
  const [tab, setTab] = useState('details');
  const confirmAnchor = useRef<HTMLButtonElement | null>(null);
  useCommandPaletteShortcut(() => setPaletteOpen(true));

  const statusTone: Record<Order['status'], Tone> = { pending: 'warning', paid: 'success', shipped: 'info', cancelled: 'neutral' };
  const statusLabel = (s: Order['status']) =>
    ({
      pending: loc('بانتظار التجهيز', 'Awaiting preparation'),
      paid: loc('مدفوع', 'Paid'),
      shipped: loc('تم الشحن', 'Shipped'),
      cancelled: loc('ملغى', 'Cancelled'),
    })[s];

  const columns: DataListColumn<Order>[] = [
    { id: 'id', header: loc('الطلب', 'Order'), cell: (o) => <span dir="ltr">{o.id}</span>, card: 'title', width: '22%' },
    { id: 'customer', header: loc('الزبون', 'Customer'), cell: (o) => o.customer, card: 'meta' },
    { id: 'status', header: loc('الحالة', 'Status'), cell: (o) => <StatusChip tone={statusTone[o.status]}>{statusLabel(o.status)}</StatusChip>, card: 'badge' },
    { id: 'items', header: loc('القطع', 'Items'), cell: (o) => <span dir="ltr">{o.items}</span>, numeric: true },
    { id: 'total', header: loc('المبلغ', 'Total'), cell: (o) => <Money iqd={o.total} />, numeric: true },
  ];

  const rowActions = (o: Order) => [
    { id: 'edit', label: loc('تعديل', 'Edit'), icon: <Pencil className="h-4 w-4" />, onSelect: () => toast.info(loc(`تعديل ${o.id}`, `Editing ${o.id}`)) },
    { id: 'print', label: loc('طباعة الفاتورة', 'Print invoice'), icon: <Printer className="h-4 w-4" />, onSelect: () => toast.success(loc('أُرسلت للطباعة', 'Sent to print')) },
    { id: 'ship', label: loc('طلب الشحن', 'Request pickup'), icon: <Truck className="h-4 w-4" />, disabled: o.status !== 'paid', hint: o.status !== 'paid' ? loc('متاح بعد الدفع', 'Available once paid') : undefined },
    { id: 'sep', separator: true as const },
    {
      id: 'cancel',
      label: loc('إلغاء الطلب', 'Cancel order'),
      icon: <Trash2 className="h-4 w-4" />,
      destructive: true,
      onSelect: async () => {
        const yes = await ask({
          title: loc(`إلغاء الطلب ${o.id}؟`, `Cancel order ${o.id}?`),
          consequence: loc('سيُعاد المبلغ إلى محفظة الزبون ويُبلَّغ بالإلغاء.', 'The amount goes back to the customer’s wallet and they are notified.'),
          confirmLabel: loc('إلغاء الطلب', 'Cancel order'),
          cancelLabel: loc('رجوع', 'Back'),
          destructive: true,
        });
        setAnswer(yes ? 'yes' : 'no');
      },
    },
  ];

  const groups = useMemo(
    () => [
      {
        id: 'go',
        label: loc('انتقال', 'Go to'),
        items: [
          { id: 'orders', label: loc('الطلبات', 'Orders'), icon: <ReceiptText className="h-4 w-4" />, href: '/merchant/orders', keywords: ['orders', 'الطلبات'] },
          { id: 'products', label: loc('المنتجات', 'Products'), icon: <Package className="h-4 w-4" />, href: '/merchant/products', keywords: ['products', 'المنتجات'] },
          { id: 'customers', label: loc('العملاء', 'Customers'), icon: <Users className="h-4 w-4" />, href: '/merchant/customers' },
          { id: 'settings', label: loc('إعدادات المتجر', 'Store settings'), icon: <Settings className="h-4 w-4" />, href: '/merchant/store/settings' },
          { id: 'notifications', label: loc('الإشعارات', 'Notifications'), icon: <Bell className="h-4 w-4" />, href: '/merchant/notifications' },
        ],
      },
      {
        id: 'do',
        label: loc('إجراءات', 'Actions'),
        items: [
          { id: 'new-product', label: loc('منتج جديد', 'New product'), icon: <ShoppingBag className="h-4 w-4" />, hint: 'N', onSelect: () => toast.success(loc('فُتح منتج جديد', 'New product opened')) },
          { id: 'archive', label: loc('أرشفة الطلبات المكتملة', 'Archive completed orders'), icon: <Archive className="h-4 w-4" />, onSelect: () => toast.info(loc('تمت الأرشفة', 'Archived')) },
        ],
      },
    ],
    [loc, toast]
  );

  const networkError = new ApiError(0, 'Failed to fetch');

  return (
    <div className="min-h-screen bg-canvas text-text-primary" data-density={DENSITY}>
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">{loc('مكونات مساحة التاجر', 'Merchant workspace primitives')}</h1>
            <p className="text-[13px] text-text-muted">{loc('كل مكوّن كما يُشحن — بالعربية والإنجليزية', 'Every primitive as shipped — Arabic and English')}</p>
          </div>
          <Where />
        </header>

        <Section id="buttons" title={loc('الأزرار', 'Buttons')}>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Package className="h-4 w-4" />}>{loc('حفظ المنتج', 'Save product')}</Button>
            <Button variant="secondary">{loc('معاينة', 'Preview')}</Button>
            <Button variant="ghost">{loc('تجاهل', 'Skip')}</Button>
            <Button variant="accent">{loc('ترقية', 'Upgrade')}</Button>
            <Button variant="danger" icon={<Trash2 className="h-4 w-4" />}>{loc('حذف', 'Delete')}</Button>
            <Button variant="primary" loading loadingLabel={loc('جارٍ الحفظ…', 'Saving…')}>{loc('حفظ', 'Save')}</Button>
            <Button variant="secondary" disabled>{loc('غير متاح', 'Unavailable')}</Button>
            <Button
              variant="secondary"
              size="sm"
              data-kit-async
              onClick={() => new Promise<void>((resolve) => setTimeout(resolve, 900)).then(() => toast.success(loc('تم الحفظ', 'Saved')))}
            >
              {loc('حفظ (غير متزامن)', 'Save (async)')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label={loc('نسخ', 'Copy')} icon={<Copy className="h-[18px] w-[18px]" />} />
            <IconButton label={loc('الإعدادات', 'Settings')} variant="secondary" icon={<Settings className="h-[18px] w-[18px]" />} />
            <IconButton label={loc('حذف', 'Delete')} variant="danger" icon={<Trash2 className="h-[18px] w-[18px]" />} />
            <IconButton label={loc('الإشعارات: 3 غير مقروءة', 'Notifications: 3 unread')} icon={<Bell className="h-[18px] w-[18px]" />} badge={3} />
          </div>
        </Section>

        <Section id="form" title={loc('النماذج', 'Forms')}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={loc('اسم المنتج', 'Product name')} hint={loc('يظهر في المتجر وفي الفاتورة.', 'Shown in the store and on the invoice.')}>
              <Input defaultValue={lang === 'en' ? 'PLA filament 1kg' : 'خيط PLA ‏1 كغم'} />
            </Field>
            <Field label={loc('رابط المتجر', 'Store link')} error={loc('هذا العنوان محجوز لمتجر آخر.', 'That address is reserved by another store.')}>
              <Input ltr defaultValue="levo-prints" />
            </Field>
            <Field label={loc('السعر', 'Price')} hint={loc('بالدينار، عدد صحيح.', 'Whole dinars.')}>
              <NumberInput
                kind="money"
                value={price}
                onValueChange={(v, ok) => {
                  setPrice(v);
                  setPriceOk(ok);
                }}
                data-kit-price
              />
            </Field>
            <Field label={loc('الكمية في المخزون', 'Quantity in stock')}>
              <NumberInput kind="quantity" value={qty} max={50} onValueChange={(v) => setQty(v)} data-kit-qty />
            </Field>
            <Field label={loc('طريقة التوصيل', 'Delivery method')} optional>
              <Select defaultValue="std">
                <option value="std">{loc('التوصيل العادي', 'Standard delivery')}</option>
                <option value="pickup">{loc('الاستلام من الورشة', 'Pickup from the workshop')}</option>
              </Select>
            </Field>
            <Field label={loc('وصف قصير', 'Short description')}>
              <Textarea rows={3} defaultValue={loc('خيط طباعة عالي الجودة بقطر 1.75 ملم.', 'High quality 1.75 mm printing filament.')} />
            </Field>
          </div>
          <p data-kit-price-state className="text-[13px] text-text-muted" dir="ltr">
            {String(price)} {priceOk ? 'valid' : 'invalid'}
          </p>
          <Card padding="md">
            <Switch checked={open} onChange={setOpen} label={loc('المتجر مفتوح', 'Store is open')} description={loc('الزبائن يستطيعون الطلب الآن.', 'Customers can order right now.')} />
            <Switch checked={notify} onChange={setNotify} label={loc('إشعار عند كل طلب', 'Notify me on every order')} />
            <div className="flex flex-wrap items-center gap-4">
              <Checkbox checked={agree} onChange={setAgree} label={loc('أوافق على شروط البيع', 'I accept the selling terms')} />
              <Checkbox checked={false} indeterminate onChange={() => {}} label={loc('بعض المنتجات', 'Some products')} />
            </div>
          </Card>
        </Section>

        <Section id="status" title={loc('الحالات والمبالغ', 'Status and money')}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone="success">{loc('مدفوع', 'Paid')}</StatusChip>
            <StatusChip tone="warning">{loc('بانتظار التجهيز', 'Awaiting preparation')}</StatusChip>
            <StatusChip tone="danger">{loc('نزاع مفتوح', 'Dispute open')}</StatusChip>
            <StatusChip tone="info">{loc('تم الشحن', 'Shipped')}</StatusChip>
            <StatusChip tone="accent">PRO</StatusChip>
            <StatusChip>{loc('مسودة', 'Draft')}</StatusChip>
            <Badge>{12}</Badge>
            <Badge tone="danger">{140}</Badge>
          </div>
          <p className="flex flex-wrap items-center gap-4 text-sm" data-kit-money>
            <Money iqd={1250000} />
            <Money iqd={-3000} signed />
            <Money iqd={45000} signed />
            <Money iqd={null} />
          </p>
        </Section>

        <Section id="kpi" title={loc('المؤشرات', 'KPIs')}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label={loc('المبيعات اليوم', 'Sales today')}
              icon={<ReceiptText className="h-4 w-4" />}
              value={<Money iqd={1250000} />}
              delta={{ value: 12.5, format: 'percent', label: loc('مقارنة بالأمس', 'vs yesterday') }}
              trend={<Sparkline series={[3, 5, 4, 8, 7, 11, 12]} />}
              to="/merchant/money"
            />
            <KpiTile
              label={loc('طلبات تحتاج إجراء', 'Orders needing action')}
              value={<span dir="ltr">4</span>}
              delta={{ value: -2, good: 'down', label: loc('مقارنة بالأمس', 'vs yesterday') }}
              hint={loc('أقدمها منذ 5 ساعات', 'Oldest waiting 5 hours')}
            />
            <KpiTile label={loc('المتاح للسحب', 'Available to withdraw')} value={<Money iqd={null} />} hint={loc('لا توجد مبالغ متاحة بعد', 'Nothing available yet')} />
            <KpiTile label={loc('زيارات المتجر', 'Store visits')} value={null} loading />
          </div>
          <KpiRowSkeleton />
        </Section>

        <Section id="datalist" title={loc('قائمة البيانات', 'DataList')}>
          <DataList
            label={loc('طلبات المتجر', 'Store orders')}
            columns={columns}
            rows={ORDERS}
            rowKey={(o) => o.id}
            rowLabel={(o) => o.id}
            rowHref={(o) => `/merchant/orders/${o.id}`}
            rowActions={rowActions}
            selection={{
              selected,
              onChange: setSelected,
              actions: (
                <Button size="sm" variant="secondary" icon={<Printer className="h-4 w-4" />}>
                  {loc('طباعة', 'Print')}
                </Button>
              ),
            }}
          />
          <p data-kit-answer className="text-[13px] text-text-muted" dir="ltr">
            confirm: {answer}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div data-kit-list="error">
              <DataList label={loc('الطلبات', 'Orders')} columns={columns} rows={[]} rowKey={(o) => o.id} error={networkError} onRetry={() => toast.info(loc('إعادة المحاولة…', 'Retrying…'))} />
            </div>
            <div data-kit-list="empty">
              <DataList
                label={loc('الطلبات', 'Orders')}
                columns={columns}
                rows={[]}
                rowKey={(o) => o.id}
                empty={{ title: loc('لا توجد طلبات بعد', 'No orders yet'), description: loc('ستظهر هنا طلبات متجرك.', 'Your store’s orders will appear here.') }}
              />
            </div>
            <div data-kit-list="loading">
              <DataList label={loc('الطلبات', 'Orders')} columns={columns} rows={undefined} rowKey={(o) => o.id} loading />
            </div>
            <div data-kit-list="narrow" className="max-w-sm">
              <DataList label={loc('الطلبات', 'Orders')} columns={columns} rows={ORDERS.slice(0, 2)} rowKey={(o) => o.id} rowActions={rowActions} rowLabel={(o) => o.id} />
            </div>
          </div>
        </Section>

        <Section id="tabs" title={loc('التبويبات', 'Tabs')}>
          <TabStrip
            group="kit-order"
            panels
            label={loc('تفاصيل الطلب', 'Order details')}
            value={tab}
            onChange={setTab}
            indicatorClassName="bg-gold"
            idleClassName="text-text-muted"
            activeClassName="text-text-primary"
            className="border-b border-border-subtle"
            items={[
              { id: 'details', label: loc('التفاصيل', 'Details') },
              { id: 'items', label: loc('المنتجات', 'Items'), badge: <Badge>{3}</Badge> },
              { id: 'timeline', label: loc('السجل', 'Timeline') },
            ]}
          />
          <TabPanels group="kit-order" value={tab} order={['details', 'items', 'timeline']}>
            <p className="p-3 text-sm text-text-secondary">{tab}</p>
          </TabPanels>
          <TabStrip
            group="kit-links"
            label={loc('أقسام الطلبات', 'Order sections')}
            value="open"
            fill={false}
            indicatorClassName="bg-gold"
            idleClassName="text-text-muted"
            activeClassName="text-text-primary"
            items={[
              { id: 'open', label: loc('مفتوحة', 'Open'), href: '/merchant/orders?status=open' },
              { id: 'done', label: loc('مكتملة', 'Completed'), href: '/merchant/orders?status=done' },
              { id: 'returns', label: loc('المرتجعات', 'Returns'), href: '/merchant/orders?status=returns' },
            ]}
          />
        </Section>

        <Section id="overlays" title={loc('النوافذ والقوائم', 'Windows and menus')}>
          <div className="flex flex-wrap items-center gap-2">
            <Menu
              label={loc('إجراءات المنتج', 'Product actions')}
              items={rowActions(ORDERS[1])}
              trigger={(props) => (
                <Button {...props} variant="secondary" data-kit-menu-trigger>
                  {loc('إجراءات', 'Actions')}
                </Button>
              )}
            />
            <Button ref={confirmAnchor} variant="danger" data-open="confirm" onClick={() => setConfirmOpen(true)}>
              {loc('حذف المنتج', 'Delete product')}
            </Button>
            <Button variant="secondary" data-open="sheet" onClick={() => setSheetOpen(true)}>
              {loc('الفلاتر', 'Filters')}
            </Button>
            <Button variant="secondary" data-open="dirty" onClick={() => setDirtyOpen(true)}>
              {loc('تعديل الوصف', 'Edit description')}
            </Button>
            <Button variant="secondary" data-open="palette" onClick={() => setPaletteOpen(true)}>
              {loc('بحث', 'Search')} <kbd className="text-[13px] text-text-muted" dir="ltr">Ctrl K</kbd>
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" data-kit-toast="success" onClick={() => toast.success(loc('تم الحفظ', 'Saved'))}>
              success
            </Button>
            <Button size="sm" variant="secondary" data-kit-toast="error" onClick={() => toast.error(loc('تعذّر حفظ المنتج', 'Couldn’t save the product'), { description: loc('تحقق من الاتصال ثم أعد المحاولة.', 'Check your connection and try again.') })}>
              error
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-kit-toast="undo"
              onClick={() => toast.info(loc('حُذف المنتج', 'Product deleted'), { action: { label: loc('تراجع', 'Undo'), onClick: () => toast.success(loc('أُعيد المنتج', 'Product restored')) } })}
            >
              undo
            </Button>
          </div>
        </Section>

        <Section id="skeletons" title={loc('هياكل التحميل', 'Skeletons')}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="lv-surface overflow-hidden">
              <ListRowsSkeleton rows={3} />
            </div>
            <div className="lv-surface overflow-hidden">
              <TableRowsSkeleton rows={3} columns={4} />
            </div>
            <div className="lv-surface p-4">
              <FormSkeleton fields={2} />
            </div>
            <CardSkeleton />
          </div>
        </Section>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        destructive
        title={loc('حذف المنتج؟', 'Delete this product?')}
        consequence={loc('سيختفي من متجرك ومن نتائج البحث. لا يمكن التراجع عن الحذف.', 'It disappears from your store and from search. Deleting cannot be undone.')}
        confirmLabel={loc('حذف', 'Delete')}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => new Promise<void>((resolve) => setTimeout(resolve, 600)).then(() => setConfirmOpen(false))}
      />

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        label={loc('الفلاتر', 'Filters')}
        detents={['medium', 'large']}
        testId="kit-sheet"
        panelClassName="sm:max-w-md"
        header={
          <div className="flex items-center justify-between gap-3 px-4 pb-2">
            <h2 className="text-sm font-bold">{loc('الفلاتر', 'Filters')}</h2>
            <Button size="sm" variant="ghost" data-open="nested" onClick={() => setNestedOpen(true)}>
              {loc('مسح الكل', 'Clear all')}
            </Button>
          </div>
        }
        footer={
          <Button variant="primary" block onClick={() => setSheetOpen(false)}>
            {loc('عرض النتائج', 'Show results')}
          </Button>
        }
      >
        <div className="space-y-1 px-4 pb-4">
          {Array.from({ length: 18 }, (_, i) => (
            <Checkbox key={i} checked={i % 3 === 0} onChange={() => {}} label={loc(`تصنيف ${i + 1}`, `Category ${i + 1}`)} className="w-full" />
          ))}
        </div>
      </Sheet>

      <ConfirmDialog
        open={nestedOpen}
        destructive
        title={loc('مسح كل الفلاتر؟', 'Clear every filter?')}
        consequence={loc('ستعود القائمة إلى كل الطلبات.', 'The list goes back to every order.')}
        confirmLabel={loc('مسح', 'Clear')}
        onCancel={() => setNestedOpen(false)}
        onConfirm={() => setNestedOpen(false)}
        testId="kit-nested-confirm"
      />

      <Overlay
        open={dirtyOpen}
        onClose={() => {
          setDirtyOpen(false);
          setDraft('');
        }}
        label={loc('تعديل الوصف', 'Edit description')}
        dirty={draft.length > 0}
        placement="bottom"
        testId="kit-dirty"
        panelClassName="w-full sm:max-w-md"
      >
        {({ close }) => (
          <div className="space-y-3 p-4">
            <h2 className="text-sm font-bold">{loc('تعديل الوصف', 'Edit description')}</h2>
            <Field label={loc('الوصف', 'Description')}>
              <Textarea value={draft} onChange={(e) => setDraft(e.currentTarget.value)} data-kit-draft />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" onClick={close}>
                {loc('إغلاق', 'Close')}
              </Button>
              <Button variant="primary" onClick={() => { setDraft(''); setDirtyOpen(false); }}>
                {loc('حفظ', 'Save')}
              </Button>
            </div>
          </div>
        )}
      </Overlay>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        groups={groups}
        recentKey="kit-recent"
        placeholder={loc('ابحث في الصفحات والإجراءات…', 'Search pages and actions…')}
      />
      {askDialog}
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <MemoryRouter initialEntries={['/merchant']}>
      <Kit />
    </MemoryRouter>
  </LanguageProvider>
);
