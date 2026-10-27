/**
 * OVERVIEW — what needs attention, whether the service is open, and which
 * integrations are really connected.
 *
 * The counters are `GET /overview` (jobs by state, printers by state, low
 * stock, open failures, jobs awaiting approval); the integrations are
 * `GET /adapters`, printed with the server's own `connected` flag — an
 * adapter the server calls not connected is never labelled otherwise here —
 * and the outbox each one has waiting. The service state, the slicer and the
 * installed flag are the customer API's `GET /status` (the frame reads it).
 */
import { Activity, AlertTriangle, ClipboardCheck, PackageOpen, Printer } from 'lucide-react';
import { KpiTile } from '../../ui/KpiTile';
import { StatusChip } from '../../ui/Badge';
import { pc, type AdaptersAnswer, type Overview, type ServiceStatus } from '../api';
import { ADAPTER, JOB_STATUS, OUTBOX_STATUS, PRINTER_STATUS, SLICER_STATE, labelOf, tri } from '../i18n';
import { num } from '../format';
import { Empty, LoadState, Note, RefreshButton, SectionHead, T, Tray, useLoad, usePcLang, type Loaded } from '../ui';
import type { SectionProps } from '../AdminPrintCloud';

const S = {
  title: tri('نظرة عامة', 'Overview', 'تێڕوانینی گشتی'),
  desc: tri('ما ينتظر قراراً الآن، وحالة الخدمة والتكاملات كما يقولها الخادم.', 'What waits for a decision now, and the service and its integrations as the server reports them.', 'ئەوەی ئێستا چاوەڕێی بڕیارە، و دۆخی خزمەتگوزاری و پەیوەستکردنەکان وەک ڕاژەکار دەیڵێت.'),
  awaiting: tri('مهام بانتظار الموافقة', 'Jobs awaiting approval', 'کار چاوەڕێی پەسەندکردنە'),
  failures: tri('أعطال بانتظار قرار', 'Failures awaiting a decision', 'شکست چاوەڕێی بڕیارە'),
  lowStock: tri('أصناف منخفضة المخزون', 'Variants low on stock', 'جۆری کەم لە کۆگا'),
  printing: tri('مهام على الطابعات', 'Jobs on printers', 'کار لەسەر چاپکەرەکان'),
  open: tri('فتح', 'Open', 'کردنەوە'),
  jobsByState: tri('المهام حسب الحالة', 'Jobs by state', 'کارەکان بەپێی دۆخ'),
  printersByState: tri('الطابعات حسب الحالة الإدارية', 'Printers by administrative status', 'چاپکەرەکان بەپێی دۆخی کارگێڕی'),
  noJobs: tri('لا مهام بعد.', 'No jobs yet.', 'هێشتا هیچ کارێک نییە.'),
  noPrinters: tri('لا طابعات مسجّلة بعد — أضفها من الكتالوج.', 'No printers registered yet — add them in the catalogue.', 'هێشتا هیچ چاپکەرێک تۆمار نەکراوە — لە کاتالۆگەوە زیادیان بکە.'),
  service: tri('الخدمة', 'The service', 'خزمەتگوزارییەکە'),
  installed: tri('مثبتة على قاعدة البيانات', 'Installed on the database', 'لەسەر بنکەدراوە دامەزراوە'),
  notInstalled: tri(
    'غير مثبتة: الهجرة 0215 لم تُطبَّق على هذه القاعدة؛ القراءات فارغة وكل كتابة تُرفض.',
    'Not installed: migration 0215 is not applied to this database; reads are empty and every write is refused.',
    'دانەمەزراوە: کۆچی 0215 لەسەر ئەم بنکەدراوەیە جێبەجێ نەکراوە؛ خوێندنەوەکان بەتاڵن و هەموو نووسینێک ڕەتدەکرێتەوە.'
  ),
  isOpen: tri('مفتوحة: يستطيع العملاء الشراء وإرسال المهام.', 'Open: customers can buy and send jobs.', 'کراوەیە: کڕیاران دەتوانن بکڕن و کار بنێرن.'),
  isClosed: tri(
    'مغلقة: أبواب العملاء تجيب «غير مفتوحة بعد»؛ مديرو المنصة فقط يستطيعون التجربة. يفتحها المالك من الإعدادات.',
    'Closed: customer doors answer “not open yet”; only platform admins can try it. The owner opens it in Settings.',
    'داخراوە: دەرگاکانی کڕیار دەڵێن «هێشتا نەکراوەتەوە»؛ تەنها بەڕێوەبەرانی پلاتفۆرم دەتوانن تاقی بکەنەوە. خاوەن لە ڕێکخستنەکانەوە دەیکاتەوە.'
  ),
  slicer: tri('السلايسر (عبر وكيل الورشة)', 'The slicer (through the workshop agent)', 'سلایسەر (لە ڕێگەی بریکاری کارگەوە)'),
  slicerNote: tri(
    'بلا سلايسر متصل تبقى المهام «بانتظار التقدير» حتى يدخل مشغّل التقدير يدوياً.',
    'With no slicer connected, jobs stay “awaiting an estimate” until an operator enters one by hand.',
    'بێ سلایسەری پەیوەست، کارەکان «چاوەڕێی خەمڵاندن» دەمێننەوە تا کارپێکەرێک بە دەست تۆماری بکات.'
  ),
  delivery: tri('التوصيل', 'Delivery', 'گەیاندن'),
  pickup: tri('الاستلام من الورشة', 'Pickup', 'وەرگرتن لە کارگە'),
  on: tri('متاح', 'Available', 'بەردەستە'),
  off: tri('متوقف', 'Off', 'کوژاوە'),
  integrations: tri('التكاملات مع Levonis', 'Levonis integrations', 'پەیوەستکردنەکان لەگەڵ Levonis'),
  integrationsDesc: tri(
    'كما يقولها الخادم: «غير متصل» يعني أن لا شيء يُرسل إلى ذلك النظام بعد.',
    'As the server reports them: “not connected” means nothing reaches that system yet.',
    'وەک ڕاژەکار دەیڵێت: «پەیوەست نییە» واتە هێشتا هیچ شتێک ناگاتە ئەو سیستەمە.'
  ),
  connected: tri('متصل', 'Connected', 'پەیوەستە'),
  notConnected: tri('غير متصل', 'Not connected', 'پەیوەست نییە'),
  outbox: tri('أحداث بانتظار الإرسال', 'Events waiting to be sent', 'ڕووداوەکان چاوەڕێی ناردنن'),
  noOutbox: tri('لا أحداث في صندوق الإرسال.', 'No events in the outbox.', 'هیچ ڕووداوێک لە سندووقی ناردندا نییە.'),
};

export default function OverviewSection({ go, status }: SectionProps & { status: Loaded<ServiceStatus> }) {
  const { t, lang } = usePcLang();
  const overview = useLoad(() => pc.get<Overview>('/overview'), []);
  const adapters = useLoad(() => pc.get<AdaptersAnswer>('/adapters'), []);

  const reloadAll = () => Promise.all([overview.reload(), adapters.reload(), status.reload()]);

  return (
    <div className="space-y-4">
      <SectionHead title={t(S.title)} description={t(S.desc)} actions={<RefreshButton onClick={reloadAll} loading={overview.loading} />} />

      <LoadState state={overview}>
        {(o) => {
          const onPrinters = (o.jobs_by_status.preparing ?? 0) + (o.jobs_by_status.printing ?? 0) + (o.jobs_by_status.paused ?? 0);
          const jobStates = Object.entries(o.jobs_by_status).sort((a, b) => b[1] - a[1]);
          const printerStates = Object.entries(o.printers_by_status);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <button type="button" className="min-w-0 text-start rounded-xl no-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => go('jobs', { status: 'confirmed' })}>
                  <KpiTile label={t(S.awaiting)} value={num(o.jobs_awaiting_approval)} icon={<ClipboardCheck size={15} />} hint={t(S.open)} className="h-full" />
                </button>
                <button type="button" className="min-w-0 text-start rounded-xl no-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => go('jobs', { tab: 'failures' })}>
                  <KpiTile label={t(S.failures)} value={num(o.open_failures)} icon={<AlertTriangle size={15} />} hint={t(S.open)} className="h-full" />
                </button>
                <button type="button" className="min-w-0 text-start rounded-xl no-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => go('stock', { low: '1' })}>
                  <KpiTile label={t(S.lowStock)} value={num(o.low_stock_variants)} icon={<PackageOpen size={15} />} hint={t(S.open)} className="h-full" />
                </button>
                <button type="button" className="min-w-0 text-start rounded-xl no-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => go('printers')}>
                  <KpiTile label={t(S.printing)} value={num(onPrinters)} icon={<Printer size={15} />} hint={t(S.open)} className="h-full" />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Tray title={t(S.jobsByState)}>
                  {jobStates.length === 0 ? (
                    <p className={`text-[13px] ${T.text3}`}>{t(S.noJobs)}</p>
                  ) : (
                    <ul className="space-y-1.5 text-[13px]">
                      {jobStates.map(([st, n]) => (
                        <li key={st} className="flex items-center justify-between gap-3">
                          <button type="button" className={`${T.btnGhostSm} min-w-0`} onClick={() => go('jobs', { status: st })}>
                            {labelOf(JOB_STATUS, st, lang)}
                          </button>
                          <span className={`tabular-nums font-semibold ${T.text1}`}>{num(n)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Tray>
                <Tray title={t(S.printersByState)}>
                  {printerStates.length === 0 ? (
                    <p className={`text-[13px] ${T.text3}`}>{t(S.noPrinters)}</p>
                  ) : (
                    <ul className="space-y-1.5 text-[13px]">
                      {printerStates.map(([st, n]) => (
                        <li key={st} className="flex items-center justify-between gap-3">
                          <span className={T.text2}>{labelOf(PRINTER_STATUS, st, lang)}</span>
                          <span className={`tabular-nums font-semibold ${T.text1}`}>{num(n)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Tray>
              </div>
            </div>
          );
        }}
      </LoadState>

      <Tray title={t(S.service)}>
        <LoadState state={status}>
          {(s) => (
            <div className="space-y-3">
              {!s.installed ? (
                <Note tone="danger">{t(S.notInstalled)}</Note>
              ) : (
                <Note tone={s.enabled ? 'success' : 'warning'}>{t(s.enabled ? S.isOpen : S.isClosed)}</Note>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Activity size={15} aria-hidden className={T.text3} />
                  <span className={T.text2}>{t(S.slicer)}:</span>
                  <StatusChip tone={s.slicer === 'connected' ? 'success' : s.slicer === 'stale' ? 'warning' : 'neutral'}>{labelOf(SLICER_STATE, s.slicer, lang)}</StatusChip>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className={T.text2}>{t(S.delivery)}:</span>
                  <StatusChip tone={s.delivery.enabled ? 'success' : 'neutral'}>{t(s.delivery.enabled ? S.on : S.off)}</StatusChip>
                  <span className={T.text2}>{t(S.pickup)}:</span>
                  <StatusChip tone={s.delivery.pickup_enabled ? 'success' : 'neutral'}>{t(s.delivery.pickup_enabled ? S.on : S.off)}</StatusChip>
                </div>
              </div>
              {s.slicer !== 'connected' && <p className={`text-[12px] ${T.text3}`}>{t(S.slicerNote)}</p>}
            </div>
          )}
        </LoadState>
      </Tray>

      <Tray title={t(S.integrations)} description={t(S.integrationsDesc)}>
        <LoadState state={adapters}>
          {(a) => (
            <div className="space-y-4">
              <ul className="divide-y divide-[var(--ap-hairline)]">
                {a.adapters.map((ad) => (
                  <li key={ad.name} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className={`text-[13px] font-semibold ${T.text1}`}>{labelOf(ADAPTER, ad.name, lang)}</p>
                      <p dir="ltr" className={`mt-0.5 text-[11.5px] ${T.text3}`}>
                        <span className="font-mono">{ad.implementation}</span> — {ad.note}
                      </p>
                    </div>
                    <StatusChip tone={ad.connected ? 'success' : 'neutral'}>{t(ad.connected ? S.connected : S.notConnected)}</StatusChip>
                  </li>
                ))}
              </ul>
              <div>
                <h4 className={`mb-2 text-[12.5px] font-bold ${T.text2}`}>{t(S.outbox)}</h4>
                {a.backlog.length === 0 ? (
                  <Empty title={t(S.noOutbox)} />
                ) : (
                  <ul className="space-y-1 text-[12.5px]">
                    {a.backlog.map((b) => (
                      <li key={`${b.adapter}-${b.kind}-${b.status}`} className="flex flex-wrap items-center justify-between gap-2">
                        <span className={T.text2}>
                          {labelOf(ADAPTER, b.adapter, lang)} · <bdi dir="ltr" className="font-mono">{b.kind}</bdi> · {labelOf(OUTBOX_STATUS, b.status, lang)}
                        </span>
                        <span className={`tabular-nums font-semibold ${T.text1}`}>{num(b.n)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </LoadState>
      </Tray>
    </div>
  );
}
