/**
 * ADMIN → المكافآت → سحب ليفو كير (migration 0244; docs/DECISIONS.md row 359).
 *
 * «Random, I confirm each month» · «I set the prize each month». On the 1st of each Baghdad month the
 * system picks ONE random customer among the holders of an active Levo Care and waits here. Nothing is
 * granted and the customer is told nothing until the owner chooses the prize and confirms; then the prize
 * arrives in the customer's «هداياي» as a free gift.
 *
 * This screen decides nothing: the name, the candidates and every rule are the server's
 * (worker/lib/careDraw.ts). It sends only the prize the owner picked, his reason for another name or for
 * skipping, and the winner he saw (so a name that changed under him is refused, never adopted).
 * The prize must be on the shelf: the picker reads how many units are sellable now and says so beside
 * «تأكيد». A confirmed prize the winner has not redeemed can be cancelled («إلغاء الجائزة»). Only the
 * owner reads the proposed name and acts; another admin sees the months and their outcomes.
 * A lazy chunk of the admin's Rewards tab.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trophy, Users } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { refusalText } from '../../lib/refusalStrings';
import { isolateLatin } from '../rewards/model';
import { usePrompt } from '../ui/PromptDialog';
import { useConfirm } from '../ui/ConfirmDialog';
import ItemFields, { blankItem } from '../adminGifts/ItemFields';
import { adminLang } from '../adminGifts/strings';
import type { ItemInput } from '../adminGifts/types';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { baghdadDay } from './AdminCompetitions';

type Tri = { ar: string; en: string; ckb: string };
interface Draw {
  id: string;
  month: string;
  state: 'proposed' | 'confirmed' | 'skipped' | 'void';
  candidates: number;
  candidate_hash: string;
  seed: string;
  redraws: number;
  winner: {
    user_id: string;
    name: string;
    username: string;
    phone_tail: string;
    eligible: boolean | null;
    device: { unit_id: string; name: Tri; care_end_at: string | null } | null;
  } | null;
  prize: { product_id: string; name: Tri; qty: number; note: string } | null;
  gift_id: string | null;
  can_void?: boolean;
  proposed_at: string | null;
  confirmed_at: string | null;
  confirmed_by: string;
  skip_reason: string;
}
interface PrizeCheck {
  valid: boolean;
  ok: boolean;
  available: number | null;
  code: string | null;
}
interface Data {
  viewer?: 'owner' | 'staff';
  installed: boolean;
  month: string;
  due_at: string;
  holders_now: number;
  current: Draw | null;
  can_draw: boolean;
  history: Draw[];
  rules: { prize_qty_max: number; rest_draws: number; reason_min: number };
}

const label = 'block text-text-secondary text-[11px] font-bold mb-1.5';
/** Every press target is at least 44 px tall. Inline: the stylesheet pays nothing. */
const TAP = { minHeight: 44 } as const;

export default function AdminCareDraw() {
  const { loc, lang, dir } = useLanguage();
  const l = adminLang(lang);
  const [prompt, promptDialog] = usePrompt();
  const [confirm, confirmDialog] = useConfirm();
  const [data, setData] = useState<Data | null>(null);
  const [prize, setPrize] = useState<ItemInput>(blankItem());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // What the server says of the prize on screen: giftable, and how many units are sellable now.
  const [check, setCheck] = useState<PrizeCheck | null>(null);
  const prizeKey = prize.productId
    ? [prize.productId, prize.optionValueIds.join(','), prize.colorId, prize.saleType, prize.transportMethod, prize.qty].join('|')
    : '';
  useEffect(() => {
    setCheck(null);
    if (!prizeKey) return;
    let alive = true;
    const [productId, optionValueIds, colorId, saleType, transportMethod, qty] = prizeKey.split('|');
    const q = new URLSearchParams({ productId, optionValueIds, colorId, saleType, transportMethod, qty });
    const timer = setTimeout(() => {
      api
        .get<PrizeCheck>(`/api/admin/rewards/care-draws/prize-check?${q.toString()}`)
        .then((r) => alive && setCheck(r))
        .catch(() => alive && setCheck(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [prizeKey]);

  const say = useCallback(
    (err: unknown) => {
      const code = err instanceof ApiError ? err.code : '';
      const status = err instanceof ApiError ? err.status : 0;
      const own = refusalText(code, lang, '');
      setError(
        own ||
          (status === 403
            ? loc('سحب ليفو كير وتأكيده للمالك وحده.', 'Only the owner runs and confirms the Levo Care draw.', 'تیروپشکی لیڤۆ کێر و پشتڕاستکردنەوەی تەنها بۆ خاوەنەکەیە.')
            : err instanceof Error && err.message
              ? err.message
              : loc('تعذّر تنفيذ الطلب. حاول مرة أخرى.', 'That did not go through. Try again.', 'جێبەجێ نەکرا. دووبارە هەوڵ بدەرەوە.'))
      );
    },
    [lang, loc]
  );

  const load = useCallback(async () => {
    try {
      setData(await api.get<Data>('/api/admin/rewards/care-draws'));
    } catch (err) {
      say(err);
    }
  }, [say]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, path: string, body: Record<string, unknown>) => {
    setBusy(key);
    setError('');
    try {
      setData(await api.post<Data>(path, body));
      return true;
    } catch (err) {
      say(err);
      void load();
      return false;
    } finally {
      setBusy('');
    }
  };

  const reasonFor = (title: string, description: string, confirmLabel: string) =>
    prompt({
      title,
      description,
      label: loc('السبب (يُحفظ في سجل التدقيق)', 'Reason (kept in the audit log)', 'هۆکار (لە تۆماری وردبینیدا هەڵدەگیرێت)'),
      required: true,
      multiline: true,
      maxLength: 300,
      validate: (v) =>
        v.trim().length >= (data?.rules.reason_min ?? 5) ? null : loc('اكتب 5 أحرف على الأقل.', 'Write at least 5 characters.', 'لانیکەم 5 پیت بنووسە.'),
      confirmLabel,
      cancelLabel: loc('رجوع', 'Back', 'گەڕانەوە'),
    });

  if (!data) {
    return (
      <div className="space-y-4">
        {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}
        {!error && <p className="text-text-secondary text-sm">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>}
      </div>
    );
  }
  if (!data.installed) {
    return (
      <p className="text-text-secondary text-sm rounded-xl border border-dashed border-border-subtle p-6 text-center">
        {loc('سحب ليفو كير غير مفعّل بعد على قاعدة البيانات.', 'The Levo Care draw is not set up on the database yet.', 'تیروپشکی لیڤۆ کێر هێشتا لە بنکەدراوەکەدا ئامادە نەکراوە.')}
      </p>
    );
  }

  const cur = data.current;
  const isOwner = data.viewer !== 'staff';
  const max = data.rules.prize_qty_max;
  const day = (iso: string | null) => (iso ? baghdadDay(iso) : '');
  const stateText = (d: Draw) =>
    d.state === 'proposed'
      ? loc('بانتظار تأكيدك', 'Waiting for your confirmation', 'چاوەڕێی پشتڕاستکردنەوەی تۆیە')
      : d.state === 'confirmed'
        ? loc('مؤكَّد — مُنحت الجائزة', 'Confirmed — prize granted', 'پشتڕاستکراوە — خەڵاتەکە درا')
        : d.state === 'skipped'
          ? loc('متخطّى', 'Skipped', 'تێپەڕێنراوە')
          : loc('أُلغيت الجائزة', 'Prize cancelled', 'خەڵاتەکە هەڵوەشێنرایەوە');
  const skipText = (d: Draw) =>
    d.skip_reason === 'no_candidates'
      ? loc('لا يوجد صاحب ليفو كير سارٍ في هذا الشهر.', 'No holder of an active Levo Care this month.', 'لەم مانگەدا هیچ خاوەنێکی لیڤۆ کێری کارا نییە.')
      : d.skip_reason === 'not_confirmed_in_time'
        ? loc('لم يُؤكَّد الاسم المقترح قبل نهاية شهره، فأُغلق السحب بلا جائزة.', 'The proposed name was not confirmed before its month ended, so the draw closed without a prize.', 'ناوە پێشنیارکراوەکە پێش کۆتایی مانگەکەی پشتڕاست نەکرایەوە، بۆیە تیروپشکەکە بەبێ خەڵات داخرا.')
        : d.skip_reason === 'owner'
          ? loc('بقرار المالك.', 'By the owner’s decision.', 'بە بڕیاری خاوەنەکە.')
          : d.skip_reason;
  const winnerLine = (d: Draw) =>
    d.winner ? `${d.winner.name || d.winner.username || d.winner.user_id}${d.winner.phone_tail ? ` · ••••${d.winner.phone_tail}` : ''}` : '';

  // Why «تأكيد» is not pressable, said beside it.
  const blocked = !cur || cur.state !== 'proposed'
    ? ''
    : cur.winner?.eligible === false
      ? loc('الاسم المقترح لم يعد لديه ليفو كير سارٍ — اسحب اسماً آخر.', 'The proposed winner no longer holds an active Levo Care — draw another name.', 'ناوە پێشنیارکراوەکە چیتر لیڤۆ کێری کارای نییە — ناوێکی تر ڕابکێشە.')
      : !prize.productId
        ? loc('اختر الجائزة أولاً.', 'Choose the prize first.', 'سەرەتا خەڵاتەکە هەڵبژێرە.')
        : !check
          ? loc('جارٍ التحقق من توفر الجائزة…', 'Checking the prize’s stock…', 'بەردەستیی خەڵاتەکە دەپشکنرێت…')
          : !check.valid
            ? loc('أكمل اختيار الجائزة: الموديل واللون ونوع البيع.', 'Finish choosing the prize: its model, colour and sale type.', 'هەڵبژاردنی خەڵاتەکە تەواو بکە: مۆدێل و ڕەنگ و جۆری فرۆشتن.')
            : !check.ok
              ? loc(
                  `المتوفر الآن ${check.available ?? 0} والكمية المختارة ${prize.qty} — قلّل الكمية أو اختر منتجاً آخر.`,
                  `${check.available ?? 0} available now and ${prize.qty} chosen — lower the quantity or pick another product.`,
                  `ئێستا ${check.available ?? 0} بەردەستە و ${prize.qty} هەڵبژێردراوە — ژمارەکە کەم بکەرەوە یان بەرهەمێکی تر هەڵبژێرە.`
                )
              : '';
  const stockLine = !check || !check.valid
    ? ''
    : check.available === null
      ? loc('المخزون غير محدود لهذا الاختيار.', 'Stock is not counted for this selection.', 'کۆگا بۆ ئەم هەڵبژاردنە ناژمێردرێت.')
      : loc(`المتوفر الآن: ${check.available}`, `Available now: ${check.available}`, `ئێستا بەردەستە: ${check.available}`);

  const onConfirm = async () => {
    if (!cur?.winner) return;
    const ok = await confirm({
      title: loc('تأكيد الفائز ومنح الجائزة؟', 'Confirm the winner and grant the prize?', 'براوەکە پشتڕاست بکرێتەوە و خەڵاتەکە بدرێت؟'),
      consequence: loc(
        `تُمنح الجائزة (الكمية ${prize.qty}) إلى ${winnerLine(cur)} كهدية مجانية ويُبلَّغ فوراً. لا يمكن التراجع من هنا.`,
        `The prize (quantity ${prize.qty}) is granted to ${winnerLine(cur)} as a free gift and he is told at once. This cannot be undone from here.`,
        `خەڵاتەکە (ژمارە ${prize.qty}) وەک دیارییەکی بەخۆڕایی دەدرێت بە ${winnerLine(cur)} و دەستبەجێ ئاگادار دەکرێتەوە. لێرەوە ناگەڕێتەوە.`
      ),
      confirmLabel: loc('تأكيد ومنح', 'Confirm and grant', 'پشتڕاستکردنەوە و پێدان'),
      cancelLabel: loc('رجوع', 'Back', 'گەڕانەوە'),
    });
    if (!ok) return;
    const done = await run('confirm', `/api/admin/rewards/care-draws/${encodeURIComponent(cur.id)}/confirm`, {
      winner_user_id: cur.winner.user_id,
      prize: { productId: prize.productId, optionValueIds: prize.optionValueIds, colorId: prize.colorId, saleType: prize.saleType, transportMethod: prize.transportMethod, qty: prize.qty },
      note,
    });
    if (done) {
      setPrize(blankItem());
      setNote('');
    }
  };
  const onRedraw = async () => {
    if (!cur) return;
    const reason = await reasonFor(
      loc('سحب اسم آخر', 'Draw another name', 'ڕاکێشانی ناوێکی تر'),
      loc('يُستبعد الاسم الحالي من سحب هذا الشهر ويُختار اسم آخر عشوائياً.', 'The current name is left out of this month’s draw and another is picked at random.', 'ناوی ئێستا لە تیروپشکی ئەم مانگە دەردەهێنرێت و ناوێکی تر بە هەڕەمەکی هەڵدەبژێردرێت.'),
      loc('اسحب اسماً آخر', 'Draw another name', 'ناوێکی تر ڕابکێشە')
    );
    if (reason === null) return;
    await run('redraw', `/api/admin/rewards/care-draws/${encodeURIComponent(cur.id)}/redraw`, { reason });
  };
  const onVoid = async (d: Draw) => {
    const reason = await reasonFor(
      loc('إلغاء الجائزة', 'Cancel the prize', 'هەڵوەشاندنەوەی خەڵات'),
      loc(
        'تُلغى الهدية التي مُنحت للفائز (لم يستردّها بعد) ويُبلَّغ بذلك. يبقى هذا الشهر بلا جائزة ولا يُسحب من جديد.',
        'The gift granted to the winner (not redeemed yet) is cancelled and he is told. This month stays without a prize and is not drawn again.',
        'ئەو دیارییەی بە براوەکە درابوو (هێشتا وەری نەگرتووەتەوە) هەڵدەوەشێنرێتەوە و ئاگادار دەکرێتەوە. ئەم مانگە بەبێ خەڵات دەمێنێتەوە و دووبارە ڕاناکێشرێت.'
      ),
      loc('ألغِ الجائزة', 'Cancel the prize', 'خەڵاتەکە هەڵبوەشێنەوە')
    );
    if (reason === null) return;
    await run(`void:${d.id}`, `/api/admin/rewards/care-draws/${encodeURIComponent(d.id)}/void`, { reason });
  };
  const voidButton = (d: Draw) =>
    isOwner && d.can_void ? (
      <div className="flex gap-2 mt-3 flex-wrap">
        <button type="button" style={TAP} disabled={busy !== ''} onClick={() => void onVoid(d)} className="lv-button lv-button-ghost text-danger" data-care-draw-void>
          {busy === `void:${d.id}` && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
          {loc('إلغاء الجائزة', 'Cancel the prize', 'هەڵوەشاندنەوەی خەڵات')}
        </button>
      </div>
    ) : null;
  const onSkip = async () => {
    if (!cur) return;
    const reason = await reasonFor(
      loc('تخطّي هذا الشهر', 'Skip this month', 'تێپەڕاندنی ئەم مانگە'),
      loc('لا تُمنح جائزة لهذا الشهر. لم يُبلَّغ أحد بشيء.', 'No prize is granted this month. Nobody was told anything.', 'بۆ ئەم مانگە هیچ خەڵاتێک نادرێت. کەس لە هیچ شتێک ئاگادار نەکراوەتەوە.'),
      loc('تخطَّ الشهر', 'Skip the month', 'مانگەکە تێپەڕێنە')
    );
    if (reason === null) return;
    await run('skip', `/api/admin/rewards/care-draws/${encodeURIComponent(cur.id)}/skip`, { reason });
  };

  return (
    <div className="space-y-4" data-admin-care-draw>
      {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}
      <p className="text-text-secondary text-xs">
        {loc(
          `في أول كل شهر يختار النظام عشوائياً زبوناً واحداً من أصحاب ليفو كير الساري (تذكرة واحدة لكل زبون، والفائز يستريح ${data.rules.rest_draws} سحوبات). لا يُمنح شيء حتى تختار الجائزة وتؤكّد — السحب وتأكيده للمالك وحده.`,
          `On the 1st of each month the system picks one customer at random among the holders of an active Levo Care (one ticket per customer; a winner rests for ${data.rules.rest_draws} draws). Nothing is granted until you choose the prize and confirm — the draw and its confirmation are the owner’s alone.`,
          `لە سەرەتای هەر مانگێکدا سیستەمەکە بە هەڕەمەکی کڕیارێک لەنێو خاوەنانی لیڤۆ کێری کارادا هەڵدەبژێرێت (بۆ هەر کڕیارێک یەک بلیت، و براوە ${data.rules.rest_draws} تیروپشک پشوو دەدات). هیچ شتێک نادرێت تا خەڵاتەکە هەڵنەبژێریت و پشتڕاستی نەکەیتەوە — تیروپشکەکە و پشتڕاستکردنەوەی تەنها بۆ خاوەنەکەیە.`
        )}
      </p>

      <div className="lv-surface p-4" data-care-draw-current={cur?.state ?? 'none'}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-text-primary font-bold flex items-center gap-2">
              <Trophy className="w-4 h-4 text-gold" aria-hidden />
              <span>{loc('سحب شهر', 'Draw for', 'تیروپشکی مانگی')}</span> <span dir="ltr">{data.month}</span>
            </p>
            <p className="text-text-secondary text-[12px] flex items-center gap-1.5 mt-1">
              <Users className="w-3.5 h-3.5" aria-hidden />
              {cur && cur.state !== 'skipped'
                ? loc(`المرشّحون: ${cur.candidates}`, `Candidates: ${cur.candidates}`, `پاڵێوراوان: ${cur.candidates}`)
                : loc(`أصحاب ليفو كير الساري الآن: ${data.holders_now}`, `Holders of an active Levo Care now: ${data.holders_now}`, `خاوەنانی لیڤۆ کێری کارا ئێستا: ${data.holders_now}`)}
              {cur && cur.redraws > 0 ? ` · ${loc(`أُعيد السحب ${cur.redraws}`, `Redrawn ${cur.redraws}`, `${cur.redraws} جار دووبارە ڕاکێشراوە`)}` : ''}
            </p>
          </div>
          {cur && <span className="lv-chip [--chip:var(--color-gold)] text-[11px] font-bold rounded-full px-2 py-0.5">{stateText(cur)}</span>}
        </div>

        {!cur && (
          <p className="text-text-secondary text-[12px] mt-1">
            {loc('لم يُسحب اسم هذا الشهر بعد. موعد السحب التلقائي: ', 'No name was drawn this month yet. The automatic draw is due: ', 'هێشتا ناوی ئەم مانگە ڕانەکێشراوە. کاتی تیروپشکی خۆکار: ')}
            <span dir="ltr">{day(data.due_at)} 10:00</span>
          </p>
        )}
        {(cur?.state === 'skipped' || cur?.state === 'void') && <p className="text-text-secondary text-[12px] mt-1" dir="auto">{skipText(cur)}</p>}
        {cur?.state === 'skipped' && isOwner && (
          <p className="text-text-secondary text-[12px] mt-1" data-care-draw-skipped-help>
            {loc(
              'هذا الشهر بلا سحب حتى الآن. متى صار عندك صاحب ليفو كير سارٍ اضغط «اسحب الآن» أدناه ليُسحب اسم لهذا الشهر.',
              'This month has no draw so far. Once a customer holds an active Levo Care, press «Draw now» below to draw a name for this month.',
              'ئەم مانگە تا ئێستا تیروپشکی نییە. هەر کاتێک کڕیارێک لیڤۆ کێری کارای هەبوو، «ئێستا ڕایبکێشە»ی خوارەوە دابگرە بۆ ڕاکێشانی ناوێک بۆ ئەم مانگە.'
            )}
          </p>
        )}
        {cur?.state === 'proposed' && !isOwner && (
          <p className="text-text-secondary text-[12px] mt-1" data-care-draw-staff>
            {loc('اسم مقترح بانتظار تأكيد المالك. الاسم والتأكيد للمالك وحده.', 'A proposed name is waiting for the owner’s confirmation. The name and the confirmation are the owner’s alone.', 'ناوێکی پێشنیارکراو چاوەڕێی پشتڕاستکردنەوەی خاوەنەکەیە. ناوەکە و پشتڕاستکردنەوەکە تەنها بۆ خاوەنەکەن.')}
          </p>
        )}

        {cur?.winner && (
          <div className="mt-3">
            <p className={label}>{cur.state === 'confirmed' ? loc('الفائز', 'Winner', 'براوە') : loc('الاسم المقترح', 'Proposed winner', 'ناوی پێشنیارکراو')}</p>
            <p className="text-text-primary font-bold" dir="auto" data-care-draw-winner>{isolateLatin(winnerLine(cur))}</p>
            {cur.winner.device && (
              <p className="text-text-secondary text-[12px] mt-1">
                <span dir="auto">{isolateLatin(cur.winner.device.name[l] || cur.winner.device.name.ar)}</span>
                {cur.winner.device.care_end_at && (
                  <>
                    {' · '}
                    {loc('ليفو كير حتى', 'Levo Care until', 'لیڤۆ کێر تا')} <span dir="ltr">{day(cur.winner.device.care_end_at)}</span>
                  </>
                )}
              </p>
            )}
            {cur.winner.eligible === false && (
              <p className="text-warning text-[11px] mt-1">
                {loc('لم يعد لديه ليفو كير سارٍ — لا يمكن تأكيده.', 'He no longer holds an active Levo Care — he cannot be confirmed.', 'چیتر لیڤۆ کێری کارای نییە — ناتوانرێت پشتڕاست بکرێتەوە.')}
              </p>
            )}
          </div>
        )}

        {cur?.state === 'confirmed' && cur.prize && (
          <p className="text-text-secondary text-[12px] mt-1">
            {loc('الجائزة:', 'Prize:', 'خەڵات:')} <span dir="auto">{isolateLatin(cur.prize.name[l] || cur.prize.name.ar)}</span> × <span dir="ltr">{cur.prize.qty}</span>
            {cur.confirmed_at && (
              <>
                {' · '}
                <span dir="ltr">{day(cur.confirmed_at)}</span>
              </>
            )}
          </p>
        )}

        {cur?.state === 'confirmed' && voidButton(cur)}

        {cur?.state === 'proposed' && isOwner && (
          <div className="mt-3 space-y-3">
            <div className={T.AP} dir={dir}>
              <p className={label}>{loc(`جائزة هذا الشهر (الكمية من 1 إلى ${max})`, `This month’s prize (quantity 1 to ${max})`, `خەڵاتی ئەم مانگە (ژمارە لە 1 تا ${max})`)}</p>
              <ItemFields lang={l} value={prize} disabled={busy !== ''} onChange={(next) => setPrize({ ...next, qty: Math.max(1, Math.min(max, next.qty)) })} />
              {stockLine && <p className="text-text-secondary text-[12px] mt-1" data-care-draw-stock={check?.available ?? 'uncounted'}>{stockLine}</p>}
            </div>
            <div>
              <label className={label} htmlFor="care-draw-note">{loc('ملاحظة داخلية (اختيارية)', 'Internal note (optional)', 'تێبینیی ناوخۆیی (ئارەزوومەندانە)')}</label>
              <input id="care-draw-note" className="lv-input text-sm" dir="auto" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex gap-2 mt-3 flex-wrap">
              <button type="button" style={TAP} disabled={busy !== '' || blocked !== ''} onClick={() => void onConfirm()} className="lv-button lv-button-primary" data-care-draw-confirm>
                {busy === 'confirm' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
                {loc('تأكيد الفائز ومنح الجائزة', 'Confirm the winner and grant the prize', 'پشتڕاستکردنەوەی براوە و پێدانی خەڵات')}
              </button>
              <button type="button" style={TAP} disabled={busy !== ''} onClick={() => void onRedraw()} className="lv-button lv-button-secondary">
                {busy === 'redraw' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
                {loc('سحب اسم آخر', 'Draw another name', 'ڕاکێشانی ناوێکی تر')}
              </button>
              <button type="button" style={TAP} disabled={busy !== ''} onClick={() => void onSkip()} className="lv-button lv-button-ghost">
                {loc('تخطّي هذا الشهر', 'Skip this month', 'تێپەڕاندنی ئەم مانگە')}
              </button>
            </div>
            {blocked && <p className="text-warning text-[11px] mt-1" data-care-draw-blocked>{blocked}</p>}
          </div>
        )}

        {data.can_draw && (
          <div className="flex gap-2 mt-3 flex-wrap">
            <button type="button" style={TAP} disabled={busy !== '' || data.holders_now === 0} onClick={() => void run('draw', '/api/admin/rewards/care-draws/draw', {})} className="lv-button lv-button-primary" data-care-draw-now>
              {busy === 'draw' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {loc('اسحب الآن', 'Draw now', 'ئێستا ڕایبکێشە')}
            </button>
          </div>
        )}
        {data.can_draw && data.holders_now === 0 && (
          <p className="text-warning text-[11px] mt-1">
            {loc('لا يوجد الآن صاحب ليفو كير سارٍ، فلا اسم يُسحب.', 'Nobody holds an active Levo Care right now, so there is no name to draw.', 'ئێستا هیچ کەسێک لیڤۆ کێری کارای نییە، بۆیە ناوێک نییە ڕابکێشرێت.')}
          </p>
        )}

        {cur && cur.seed && (
          <p className="text-text-secondary text-[11px] mt-3" dir="ltr" style={{ overflowWrap: 'anywhere' }} data-care-draw-audit>
            seed {cur.seed} · candidates sha-256 {cur.candidate_hash}
          </p>
        )}
      </div>

      <div>
        <p className={label}>{loc('الأشهر السابقة', 'Past months', 'مانگەکانی پێشوو')}</p>
        {data.history.length === 0 ? (
          <p className="text-text-secondary text-sm rounded-xl border border-dashed border-border-subtle p-6 text-center">{loc('لا سحوبات سابقة بعد.', 'No past draws yet.', 'هێشتا هیچ تیروپشکێکی پێشوو نییە.')}</p>
        ) : (
          <ul className="space-y-3">
            {data.history.map((d) => (
              <li key={d.id} className="lv-surface p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-text-primary font-bold" dir="ltr">{d.month}</p>
                    {d.winner && d.state !== 'skipped' && <p className="text-text-secondary text-[12px] mt-1" dir="auto">{isolateLatin(winnerLine(d))}</p>}
                    {d.prize && (
                      <p className="text-text-secondary text-[12px] mt-1">
                        <span dir="auto">{isolateLatin(d.prize.name[l] || d.prize.name.ar)}</span> × <span dir="ltr">{d.prize.qty}</span>
                      </p>
                    )}
                    {(d.state === 'skipped' || d.state === 'void') && <p className="text-text-secondary text-[12px] mt-1" dir="auto">{skipText(d)}</p>}
                    {d.state === 'confirmed' && voidButton(d)}
                  </div>
                  <span className="lv-chip [--chip:var(--color-gold)] text-[11px] font-bold rounded-full px-2 py-0.5">{stateText(d)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {promptDialog}
      {confirmDialog}
    </div>
  );
}
