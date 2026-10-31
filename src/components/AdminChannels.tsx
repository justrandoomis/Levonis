import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Loader2, Mail, MessageCircle, RefreshCw, Send } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../LanguageContext';

/**
 * THE THREE CUSTOMER CHANNELS, AND WHETHER THEY ACTUALLY WORK.
 *
 * "Is the secret set?" is the question this panel refuses to stop at, because
 * it is not the question the owner has. A Resend key can be present and its
 * sending domain unverified. A staging allowlist can be quietly dropping
 * every message. A WhatsApp session can be logged out while its API token
 * stays perfectly valid. None of those show up as a missing secret, and all
 * of them look exactly like "notifications are broken" from the shop floor.
 *
 * So the panel reports two different kinds of fact, and never confuses them:
 *
 *   CONFIGURATION — read from the Worker's environment. Cheap, always shown.
 *   REALITY       — the WhatsApp session state, which costs a live request to
 *                   the provider, and a REAL TEST MESSAGE the owner sends to
 *                   an address or number they name.
 *
 * And it says the one thing every provider integration gets wrong: accepted
 * is not delivered. A green result here means the provider took the message,
 * which is the last thing this software can honestly observe.
 *
 * META (server events, DECISIONS row 277) sits beside them for the same
 * reason: "No server events" in Events Manager looks the same whether the
 * token is missing, set on another Worker, or refused. Its check is a read of
 * the dataset with the token, never an event.
 */

type Channel = 'email' | 'whatsapp' | 'telegram' | 'meta';

interface Providers {
  email: {
    configured: boolean;
    hasKey: boolean;
    hasFromAddress: boolean;
    restrictedToAllowlist: boolean;
    allowlistSize: number;
    warning: string | null;
  };
  telegram: { configured: boolean; botAnswered: boolean; botUsername: string; webhookSecretSet: boolean };
  whatsapp: {
    configured: boolean;
    sessionStatus: string | null;
    canSend: boolean;
    error: string | null;
    detail?: string | null;
  };
  /** The Meta Conversions API (server events). Absent from an older Worker's answer. */
  meta?: { configured: boolean; testMode: boolean; datasetId: string };
}

interface TestResult {
  channel: Channel;
  sent: boolean;
  detail: string;
}

const STRINGS = {
  ar: {
    title: 'قنوات التواصل',
    intro:
      'الحالة الحقيقية لكل قناة، ثم رسالة اختبار فعلية. «تم القبول» تعني أن المزوّد استلم الرسالة — وهو آخر ما يمكن للنظام أن يؤكده بصدق؛ الوصول إلى الصندوق أو الهاتف يحتاج منك أن تنظر.',
    refresh: 'تحديث الحالة',
    email: 'البريد الإلكتروني (Resend)',
    whatsapp: 'واتساب (WasenderAPI)',
    telegram: 'تيليغرام',
    on: 'مهيّأ',
    off: 'غير مهيّأ',
    working: 'يعمل',
    notWorking: 'لا يعمل',
    noKey: 'لا يوجد مفتاح API',
    noFrom: 'لا يوجد عنوان مُرسِل (EMAIL_FROM)',
    allowlist: (n: number) => `قائمة سماح مفعّلة (${n} عنوان): أي بريد خارجها يُسقَط بصمت.`,
    waSession: 'حالة الجلسة',
    waNoSession: 'المفتاح موجود لكن الجلسة غير متصلة — أعد ربط هاتف المتجر.',
    waKeyOnly: 'وجود المفتاح لا يعني أن واتساب متصل. الحالة أدناه هي الجواب.',
    tgBot: 'البوت',
    tgAnswered: 'البوت ردّ على getMe',
    tgSilent: 'البوت لم يردّ — تحقّق من التوكن',
    testTo: 'أرسل رسالة اختبار إلى',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: '+9647XXXXXXXXX',
    tgTestNote: 'يُرسَل إلى مجموعة الإدارة المرتبطة، وليس إلى رقم تكتبه.',
    send: 'إرسال اختبار',
    sending: 'جارٍ الإرسال…',
    accepted: 'قبله المزوّد',
    refused: 'رفضه المزوّد',
    loadFailed: 'تعذّر قراءة حالة القنوات.',
    retry: 'إعادة المحاولة',
    scopeDenied: 'حساب إداري مقيّد لا يمكنه إرسال اختبارات.',
    meta: 'Meta — أحداث الخادم (Conversions API)',
    metaDataset: 'مجموعة البيانات',
    metaNoToken:
      'لا يوجد META_CAPI_ACCESS_TOKEN على الموقع، فلا تُرسل أحداث الخادم. أضِفه في GitHub ← Settings ← Secrets and variables ← Actions باسم META_CAPI_ACCESS_TOKEN، ويرفعه النشر التالي إلى الموقع.',
    metaTestMode: 'وضع الاختبار مفعّل (META_CAPI_TEST_EVENT_CODE): أحداث الخادم تظهر في «Test events» فقط.',
    metaTestBadge: 'وضع الاختبار',
    metaCheckNote: 'يسأل Meta عن مجموعة البيانات بهذا الرمز، ولا يُنشئ أي حدث.',
    metaCheck: 'افحص مع Meta',
    metaChecking: 'جارٍ الفحص…',
    metaOk: 'Meta قبل الرمز',
    metaRefused: 'Meta لم يقبل الرمز',
  },
  en: {
    title: 'Customer channels',
    intro:
      'The real state of each channel, then an actual test message. "Accepted" means the provider took the message — the last thing this software can honestly observe; whether it reached the inbox or the phone is for you to look at.',
    refresh: 'Refresh status',
    email: 'Email (Resend)',
    whatsapp: 'WhatsApp (WasenderAPI)',
    telegram: 'Telegram',
    on: 'Configured',
    off: 'Not configured',
    working: 'Working',
    notWorking: 'Not working',
    noKey: 'No API key',
    noFrom: 'No sender address (EMAIL_FROM)',
    allowlist: (n: number) => `Allowlist active (${n} address): mail to anyone else is dropped silently.`,
    waSession: 'Session status',
    waNoSession: 'The key is set but the session is not connected — relink the shop phone.',
    waKeyOnly: 'A key present does not mean WhatsApp is linked. The status below is the answer.',
    tgBot: 'Bot',
    tgAnswered: 'The bot answered getMe',
    tgSilent: 'The bot did not answer — check the token',
    testTo: 'Send a test message to',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: '+9647XXXXXXXXX',
    tgTestNote: 'Goes to the bound admin group, not to a number you type.',
    send: 'Send test',
    sending: 'Sending…',
    accepted: 'Accepted by the provider',
    refused: 'Refused by the provider',
    loadFailed: 'Could not read the channel status.',
    retry: 'Try again',
    scopeDenied: 'A restricted admin account cannot send provider tests.',
    meta: 'Meta — server events (Conversions API)',
    metaDataset: 'Dataset',
    metaNoToken:
      'No META_CAPI_ACCESS_TOKEN on the live site, so no server events are sent. Add it in GitHub → Settings → Secrets and variables → Actions, named META_CAPI_ACCESS_TOKEN; the next deploy uploads it to the site.',
    metaTestMode: 'Test mode is on (META_CAPI_TEST_EVENT_CODE): server events appear under Test events only.',
    metaTestBadge: 'Test mode',
    metaCheckNote: 'Asks Meta about the dataset with this token; creates no event.',
    metaCheck: 'Check with Meta',
    metaChecking: 'Checking…',
    metaOk: 'Meta accepted the token',
    metaRefused: 'Meta did not accept the token',
  },
  ckb: {
    title: 'کەناڵەکانی پەیوەندی',
    intro:
      'دۆخی ڕاستەقینەی هەر کەناڵێک، پاشان نامەیەکی تاقیکردنەوەی ڕاستەقینە. «وەرگیرا» واتە دابینکەرەکە نامەکەی وەرگرت — دواین شتە کە ئەم سیستەمە بە دڵسۆزی دەیبینێت.',
    refresh: 'نوێکردنەوەی دۆخ',
    email: 'ئیمەیڵ (Resend)',
    whatsapp: 'واتساپ (WasenderAPI)',
    telegram: 'تێلێگرام',
    on: 'ڕێکخراوە',
    off: 'ڕێکنەخراوە',
    working: 'کاردەکات',
    notWorking: 'کارناکات',
    noKey: 'کلیلی API نییە',
    noFrom: 'ناونیشانی نێرەر نییە (EMAIL_FROM)',
    allowlist: (n: number) => `لیستی ڕێپێدان چالاکە (${n} ناونیشان): هەر ئیمەیڵێکی دەرەوەی فڕێدەدرێت.`,
    waSession: 'دۆخی سێشن',
    waNoSession: 'کلیلەکە هەیە بەڵام سێشنەکە پەیوەست نییە — تەلەفۆنی فرۆشگا دووبارە ببەستەوە.',
    waKeyOnly: 'بوونی کلیل واتای ئەوە نییە واتساپ پەیوەستە. دۆخی خوارەوە وەڵامەکەیە.',
    tgBot: 'بۆت',
    tgAnswered: 'بۆتەکە وەڵامی getMe دایەوە',
    tgSilent: 'بۆتەکە وەڵامی نەدایەوە — تۆکنەکە بپشکنە',
    testTo: 'نامەی تاقیکردنەوە بنێرە بۆ',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: '+9647XXXXXXXXX',
    tgTestNote: 'بۆ گرووپی بەڕێوەبردنی بەستراو دەنێردرێت، نەک بۆ ژمارەیەک کە دەینووسیت.',
    send: 'ناردنی تاقیکردنەوە',
    sending: 'دەنێردرێت…',
    accepted: 'دابینکەر وەریگرت',
    refused: 'دابینکەر ڕەتیکردەوە',
    loadFailed: 'نەتوانرا دۆخی کەناڵەکان بخوێندرێتەوە.',
    retry: 'هەوڵدانەوە',
    scopeDenied: 'هەژماری بەڕێوەبەری سنووردار ناتوانێت تاقیکردنەوە بنێرێت.',
    meta: 'Meta — ڕووداوەکانی ڕاژەکار (Conversions API)',
    metaDataset: 'کۆمەڵەی داتا',
    metaNoToken:
      'META_CAPI_ACCESS_TOKEN لەسەر ماڵپەڕەکە نییە، بۆیە هیچ ڕووداوێکی ڕاژەکار نانێردرێت. لە GitHub ← Settings ← Secrets and variables ← Actions بە ناوی META_CAPI_ACCESS_TOKEN زیادی بکە؛ بڵاوکردنەوەی داهاتوو بۆ ماڵپەڕەکەی بەرز دەکاتەوە.',
    metaTestMode: 'دۆخی تاقیکردنەوە چالاکە (META_CAPI_TEST_EVENT_CODE): ڕووداوەکانی ڕاژەکار تەنها لە «Test events» دەردەکەون.',
    metaTestBadge: 'دۆخی تاقیکردنەوە',
    metaCheckNote: 'بەم تۆکنە پرسیار لە Meta دەکات دەربارەی کۆمەڵەی داتاکە، و هیچ ڕووداوێک دروست ناکات.',
    metaCheck: 'لەگەڵ Meta بیپشکنە',
    metaChecking: 'پشکنین…',
    metaOk: 'Meta تۆکنەکەی پەسەند کرد',
    metaRefused: 'Meta تۆکنەکەی پەسەند نەکرد',
  },
} as const;

export default function AdminChannels() {
  const { lang, dir } = useLanguage();
  const s = STRINGS[lang] || STRINGS.ar;

  const [data, setData] = useState<Providers | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [to, setTo] = useState<Record<Channel, string>>({ email: '', whatsapp: '', telegram: '', meta: '' });
  const [busy, setBusy] = useState<Channel | null>(null);
  const [result, setResult] = useState<Record<Channel, TestResult | null>>({
    email: null, whatsapp: null, telegram: null, meta: null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const r = await api.get<{ success: true } & Providers>('/api/admin/providers');
      setData(r);
    } catch (e) {
      setLoadError(e instanceof ApiError && e.message ? e.message : s.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [s]);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = async (channel: Channel) => {
    setBusy(channel);
    setResult((r) => ({ ...r, [channel]: null }));
    try {
      const r = await api.post<{ sent: boolean; detail: string }>('/api/admin/providers/test', {
        channel,
        // Telegram goes to the bound admin group and Meta is a read of the
        // dataset: neither has a destination to type.
        ...(channel === 'telegram' || channel === 'meta' ? {} : { to: to[channel].trim() }),
      });
      setResult((prev) => ({ ...prev, [channel]: { channel, sent: !!r.sent, detail: r.detail } }));
      // The WhatsApp session may have changed state; re-read rather than let
      // the badge above disagree with the result below.
      if (channel === 'whatsapp') void load();
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'SCOPE_FORBIDDEN'
          ? s.scopeDenied
          : e instanceof ApiError && e.message
            ? e.message
            : s.loadFailed;
      setResult((prev) => ({ ...prev, [channel]: { channel, sent: false, detail: msg } }));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 text-text-secondary py-8">
        <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />
        <span>…</span>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="lv-alert lv-alert-danger flex items-center justify-between gap-3">
        <span>{loadError || s.loadFailed}</span>
        <button type="button" onClick={() => void load()} className="lv-button lv-button-secondary lv-button-sm">
          {s.retry}
        </button>
      </div>
    );
  }

  return (
    <div dir={dir}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">{s.title}</h2>
          <p className="mt-1 text-[12px] text-text-secondary leading-relaxed max-w-[62ch]">{s.intro}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="lv-button lv-button-secondary lv-button-sm shrink-0 inline-flex items-center gap-1.5"
        >
          <RefreshCw aria-hidden="true" className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {s.refresh}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* -------------------------------------------------------- email */}
        <Card icon={<Mail aria-hidden="true" className="w-4 h-4" />} title={s.email} ok={data.email.configured} okLabel={s.on} offLabel={s.off}>
          {!data.email.hasKey && <Line tone="warn">{s.noKey}</Line>}
          {!data.email.hasFromAddress && <Line tone="warn">{s.noFrom}</Line>}
          {data.email.restrictedToAllowlist && <Line tone="warn">{s.allowlist(data.email.allowlistSize)}</Line>}
          <TestBox
            label={s.testTo}
            placeholder={s.emailPlaceholder}
            value={to.email}
            onChange={(v) => setTo((p) => ({ ...p, email: v }))}
            onSend={() => void runTest('email')}
            busy={busy === 'email'}
            disabled={!data.email.configured || to.email.trim().length < 5}
            sendLabel={s.send}
            sendingLabel={s.sending}
            inputMode="email"
          />
          <Result r={result.email} accepted={s.accepted} refused={s.refused} />
        </Card>

        {/* ----------------------------------------------------- whatsapp */}
        <Card
          icon={<MessageCircle aria-hidden="true" className="w-4 h-4" />}
          title={s.whatsapp}
          ok={data.whatsapp.canSend}
          okLabel={s.working}
          offLabel={data.whatsapp.configured ? s.notWorking : s.off}
        >
          <Line tone="muted">{s.waKeyOnly}</Line>
          {data.whatsapp.sessionStatus ? (
            <Line tone={data.whatsapp.canSend ? 'ok' : 'warn'}>
              {s.waSession}: <span dir="ltr">{data.whatsapp.sessionStatus}</span>
            </Line>
          ) : null}
          {data.whatsapp.configured && !data.whatsapp.canSend ? <Line tone="warn">{s.waNoSession}</Line> : null}
          {data.whatsapp.error ? (
            <Line tone="warn">
              <span dir="ltr">{data.whatsapp.error}{data.whatsapp.detail ? `: ${data.whatsapp.detail}` : ''}</span>
            </Line>
          ) : null}
          <TestBox
            label={s.testTo}
            placeholder={s.phonePlaceholder}
            value={to.whatsapp}
            onChange={(v) => setTo((p) => ({ ...p, whatsapp: v }))}
            onSend={() => void runTest('whatsapp')}
            busy={busy === 'whatsapp'}
            disabled={!data.whatsapp.configured || to.whatsapp.trim().length < 6}
            sendLabel={s.send}
            sendingLabel={s.sending}
            inputMode="tel"
          />
          <Result r={result.whatsapp} accepted={s.accepted} refused={s.refused} />
        </Card>

        {/* ----------------------------------------------------- telegram */}
        <Card
          icon={<Send aria-hidden="true" className="w-4 h-4" />}
          title={s.telegram}
          ok={data.telegram.botAnswered}
          okLabel={s.working}
          offLabel={data.telegram.configured ? s.notWorking : s.off}
        >
          <Line tone={data.telegram.botAnswered ? 'ok' : 'warn'}>
            {data.telegram.botAnswered ? s.tgAnswered : s.tgSilent}
            {data.telegram.botUsername ? (
              <>
                {' — '}
                <span dir="ltr">@{data.telegram.botUsername}</span>
              </>
            ) : null}
          </Line>
          <Line tone="muted">{s.tgTestNote}</Line>
          <button
            type="button"
            onClick={() => void runTest('telegram')}
            disabled={busy === 'telegram' || !data.telegram.configured}
            className="lv-button lv-button-secondary lv-button-sm mt-2"
          >
            {busy === 'telegram' ? s.sending : s.send}
          </button>
          <Result r={result.telegram} accepted={s.accepted} refused={s.refused} />
        </Card>

        {/* --------------------------------------------------------- meta */}
        {data.meta ? (
          <Card
            icon={<Activity aria-hidden="true" className="w-4 h-4" />}
            title={s.meta}
            ok={data.meta.configured && !data.meta.testMode}
            okLabel={s.on}
            offLabel={data.meta.configured ? s.metaTestBadge : s.off}
          >
            {data.meta.configured ? null : <Line tone="warn">{s.metaNoToken}</Line>}
            {data.meta.testMode ? <Line tone="warn">{s.metaTestMode}</Line> : null}
            <Line tone="muted">
              {s.metaDataset}: <span dir="ltr">{data.meta.datasetId}</span>
            </Line>
            <Line tone="muted">{s.metaCheckNote}</Line>
            <button
              type="button"
              onClick={() => void runTest('meta')}
              disabled={busy === 'meta' || !data.meta.configured}
              className="lv-button lv-button-secondary lv-button-sm mt-2"
            >
              {busy === 'meta' ? s.metaChecking : s.metaCheck}
            </button>
            <Result r={result.meta} accepted={s.metaOk} refused={s.metaRefused} />
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function Card({
  icon, title, ok, okLabel, offLabel, children,
}: {
  icon: React.ReactNode; title: string; ok: boolean; okLabel: string; offLabel: string; children: React.ReactNode;
}) {
  return (
    <section className="lv-surface p-4 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-text-secondary shrink-0">{icon}</span>
          <span className="font-bold text-[14px] text-white truncate">{title}</span>
        </span>
        <span
          className={`shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full ${
            ok ? 'lv-chip [--chip:var(--color-success)]' : 'lv-chip [--chip:var(--color-warning)]'
          }`}
        >
          {ok ? okLabel : offLabel}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  );
}

function Line({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  const cls = tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-text-muted';
  return <p className={`text-[12px] leading-relaxed ${cls}`}>{children}</p>;
}

function TestBox({
  label, placeholder, value, onChange, onSend, busy, disabled, sendLabel, sendingLabel, inputMode,
}: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; onSend: () => void;
  busy: boolean; disabled: boolean; sendLabel: string; sendingLabel: string; inputMode: 'email' | 'tel';
}) {
  const id = `channel-test-${inputMode}`;
  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-[11px] font-bold text-text-muted uppercase mb-1">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          className="lv-input flex-1 min-w-0 text-sm"
          id={id}
          type="text"
          dir="ltr"
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={busy || disabled}
          className="lv-button lv-button-secondary lv-button-sm shrink-0"
        >
          {busy ? sendingLabel : sendLabel}
        </button>
      </div>
    </div>
  );
}

function Result({ r, accepted, refused }: { r: TestResult | null; accepted: string; refused: string }) {
  if (!r) return null;
  return (
    <div
      role="status"
      className={`lv-alert mt-2 flex items-start gap-2 px-2.5 py-2 text-[12px] leading-relaxed text-text-primary ${
        r.sent ? 'lv-alert-success' : 'lv-alert-warning'
      }`}
    >
      {r.sent ? (
        <CheckCircle2 aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-success" />
      ) : (
        <AlertTriangle aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
      )}
      <span className="min-w-0">
        <span className="font-bold">{r.sent ? accepted : refused}</span>
        {r.detail ? (
          <>
            {' — '}
            <span dir="ltr" className="break-words">{r.detail}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
