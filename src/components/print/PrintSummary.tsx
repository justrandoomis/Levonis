/**
 * WHAT THE FILE TURNED OUT TO BE — shown on a request, to both sides.
 *
 * The customer sees it to confirm Levonis read their model correctly. The
 * merchant sees the same numbers, because a merchant pricing a job needs the
 * size, the volume and the support burden more than they need the description.
 * Neither sees the cost breakdown: the server never sends it (§ printApi).
 *
 * IT RENDERS NOTHING WHEN THERE IS NOTHING. A request created before this
 * system existed, or one whose link could not be measured, has no print row;
 * this component returns null rather than an empty card promising data.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box, Ruler, Scale, Clock, Layers, TriangleAlert, Sparkles, Loader2, Rotate3d,
} from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useSignInPrompt } from '../../lib/guest';
import { formatIqd } from '../../lib/api';
import {
  printApi, priceRange, mmSize, cm3, duration,
  type PrintFacts, type Confidence, type ModelWarningCode,
} from '../../lib/printApi';

/**
 * Warning codes travel without prose — the analyser emits a code, the UI writes
 * the sentence. `Record<ModelWarningCode, ...>` rather than a loose map: adding
 * a code on the worker side then fails the typecheck here instead of silently
 * showing a customer the literal string DEGENERATE_TRIANGLES.
 */
const WARNING_TEXT: Record<ModelWarningCode, [string, string]> = {
  NOT_WATERTIGHT: ['المجسم غير مغلق تمامًا — قد يحتاج إصلاحًا قبل الطباعة', 'The mesh is not fully closed — it may need repair before printing'],
  ZERO_VOLUME: ['تعذّر حساب حجم المجسم من هذا الملف', 'The model has no measurable volume in this file'],
  INVERTED_NORMALS: ['بعض الأوجه معكوسة الاتجاه', 'Some faces point the wrong way'],
  VERY_LARGE: ['المجسم كبير جدًا وقد لا يناسب معظم الطابعات', 'Very large — it may not fit most printers'],
  VERY_SMALL: ['المجسم صغير جدًا — تأكد من المقياس', 'Very small — check the scale'],
  THIN_FEATURES: ['فيه تفاصيل رفيعة جدًا قد لا تُطبع جيدًا', 'It has very thin features that may not print well'],
  HEAVY_OVERHANG: ['فيه أجزاء بارزة كثيرة — سيحتاج دعامات', 'Heavy overhangs — it will need supports'],
  MANY_PARTS: ['المجسم مكوّن من عدة قطع منفصلة', 'The model is several separate bodies'],
  TOPOLOGY_NOT_ANALYSED: ['الملف كبير، فاكتفينا بالقياسات الأساسية', 'The file is large, so only the basic measurements were taken'],
  HUGE_MESH: ['ملف كثيف جدًا بالتفاصيل', 'A very dense, highly detailed file'],
  UNIT_ASSUMED: ['الصيغة لا تذكر وحدة القياس — افترضنا الملّيمتر', 'The format does not state a unit — millimetres assumed'],
  DEGENERATE_TRIANGLES: ['فيه مثلثات تالفة تم تجاهلها أثناء القياس', 'It has broken triangles, which were ignored while measuring'],
};

const CONFIDENCE_TEXT: Record<Confidence, [string, string]> = {
  high: ['دقة عالية', 'High confidence'],
  medium: ['دقة متوسطة', 'Medium confidence'],
  low: ['تقدير مبدئي', 'Rough estimate'],
};

const CONFIDENCE_CLASS: Record<Confidence, string> = {
  high: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  low: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
};

export default function PrintSummary({
  requestId,
  onLoaded,
}: {
  requestId: string;
  /** Lets the parent show the estimate in its own header without a second GET. */
  onLoaded?: (facts: PrintFacts | null) => void;
}) {
  const { loc, lang } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const ar = lang === 'ar' || lang === 'ckb';
  const [facts, setFacts] = useState<PrintFacts | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading');
  const [viewer, setViewer] = useState('');

  useEffect(() => {
    let alive = true;
    setState('loading');
    printApi
      .facts(requestId)
      .then((d) => {
        if (!alive) return;
        setFacts(d.print);
        setState(d.print ? 'ready' : 'none');
        onLoaded?.(d.print);
      })
      .catch(() => {
        if (!alive) return;
        setState('none');
        onLoaded?.(null);
      });
    return () => {
      alive = false;
    };
    // onLoaded is a render-scoped callback in every caller; depending on it
    // would refetch on each parent render for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  /**
   * The token is minted on demand, not on page load. Minting is rate-limited
   * and creates a row; doing it for every visitor who merely opened a request
   * would fill the table with links nobody clicked.
   */
  const openViewer = useCallback(async () => {
    if (!facts?.primary_file_id) return;
    // MINTING NEEDS A SESSION — `POST .../viewer-token` is behind requireAuth,
    // so for a signed-out visitor this button could only ever fail. The board
    // itself is browsable signed out, so the honest move is to ask for the
    // sign-in the token needs rather than to show a dead control or a shrug.
    if (!isAuthenticated) {
      signIn();
      return;
    }
    setViewer('loading');
    try {
      const d = await printApi.viewerToken(requestId, facts.primary_file_id);
      setViewer('');
      window.open(d.url, '_blank', 'noopener');
    } catch {
      setViewer('error');
    }
  }, [facts?.primary_file_id, requestId, isAuthenticated, signIn]);

  if (state === 'loading') {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4 flex justify-center">
        <Loader2 className="w-4 h-4 text-gold animate-spin" />
      </div>
    );
  }
  if (state === 'none' || !facts) return null;

  const a = facts.analysis;
  const est = facts.estimate;
  const conf = facts.estimate_confidence;

  return (
    <div
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4"
      data-print-summary={requestId}
    >
      <h2 className="text-gold font-bold text-[13px] mb-3 flex items-center gap-1.5">
        <Box className="w-4 h-4" />
        {loc('قراءة الملف', 'What we read from the file', 'خوێندنەوەی فایل')}
      </h2>

      {(facts.estimate_low_iqd !== null || facts.estimate_high_iqd !== null) && (
        <div className="rounded-xl border border-gold/25 bg-gold/[0.06] px-3.5 py-3 mb-3" data-print-summary-estimate>
          <p className="text-[11px] text-zinc-400 mb-0.5">
            {loc('تقدير Levonis', 'Levonis estimate', 'خەمڵاندنی Levonis')}
          </p>
          <p className="text-gold font-bold text-[16px]" dir="ltr">
            {priceRange(facts.estimate_low_iqd, facts.estimate_high_iqd, formatIqd)}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            {conf && (
              <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full border ${CONFIDENCE_CLASS[conf]}`}>
                {loc(...CONFIDENCE_TEXT[conf])}
              </span>
            )}
            <span className="text-[11px] text-zinc-500">
              {loc(
                'تقدير وليس عرضًا نهائيًا — عروض التجار قد تختلف.',
                'An estimate, not a final offer — merchant offers may differ.',
                'خەمڵاندنە نەک ئۆفەری کۆتایی.'
              )}
            </span>
          </div>
        </div>
      )}

      {a?.measured ? (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <Fact
            icon={<Ruler className="w-3.5 h-3.5" />}
            label={loc('الأبعاد (مم)', 'Size (mm)', 'ڕەهەند (مم)')}
            value={mmSize(a.dimensions_mm)}
          />
          <Fact
            icon={<Box className="w-3.5 h-3.5" />}
            label={loc('الحجم', 'Volume', 'قەبارە')}
            value={`${cm3(a.volume_mm3)} cm³`}
          />
          {typeof est.material_grams === 'number' && est.material_grams > 0 && (
            <Fact
              icon={<Scale className="w-3.5 h-3.5" />}
              label={loc('المادة المقدّرة', 'Estimated material', 'ماددەی خەمڵێنراو')}
              value={`${Math.round(est.material_grams)} g`}
            />
          )}
          {typeof est.total_time_minutes === 'number' && est.total_time_minutes > 0 && (
            <Fact
              icon={<Clock className="w-3.5 h-3.5" />}
              label={loc('زمن الطباعة', 'Print time', 'کاتی چاپ')}
              value={duration(est.total_time_minutes, ar)}
            />
          )}
          {a.shell_count !== null && a.shell_count > 1 && (
            <Fact
              icon={<Layers className="w-3.5 h-3.5" />}
              label={loc('عدد القطع', 'Parts', 'ژمارەی پارچە')}
              value={String(a.shell_count)}
            />
          )}
          <Fact
            icon={<Sparkles className="w-3.5 h-3.5" />}
            label={loc('التعقيد', 'Complexity', 'ئاڵۆزی')}
            value={`${Math.round(a.complexity * 100)}%`}
          />
        </div>
      ) : (
        <p className="text-zinc-400 text-[12.5px] leading-relaxed mb-3">
          {loc(
            'هذا الطلب لا يحمل ملفًا يمكن قياسه، فالتقدير مبني على ما وصفه صاحب الطلب.',
            'This request carries no measurable file, so the estimate is based on what the customer described.',
            'ئەم داواکارییە فایلێکی پێوانەکراوی نییە.'
          )}
        </p>
      )}

      {!!a?.warnings?.length && (
        <ul className="space-y-1.5 mb-3" data-print-summary-warnings>
          {a.warnings.map((w) => {
            const text = WARNING_TEXT[w.code];
            return (
              <li
                key={w.code}
                className={`flex items-start gap-1.5 text-[11.5px] leading-relaxed ${
                  w.severity === 'info' ? 'text-zinc-400' : 'text-amber-300'
                }`}
              >
                <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{text ? loc(text[0], text[1]) : w.code}</span>
              </li>
            );
          })}
        </ul>
      )}

      {facts.primary_file_id && (
        <>
          <button
            onClick={openViewer}
            disabled={viewer === 'loading'}
            data-print-summary="viewer"
            className="w-full min-h-[44px] rounded-2xl border border-gold/30 bg-gold/10 text-gold font-semibold text-[13px] flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {viewer === 'loading' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Rotate3d className="w-4 h-4" />
            )}
            {loc('مشاهدة المجسم ثلاثي الأبعاد', 'View the model in 3D', 'بینینی مۆدێل بە سێ ڕەهەند')}
          </button>
          {viewer === 'error' && (
            <p className="text-red-300 text-[11.5px] mt-2 text-center">
              {loc('تعذّر فتح العارض الآن', 'Could not open the viewer right now', 'نەتوانرا بینەر بکرێتەوە')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
      <p className="text-[10.5px] text-zinc-500 flex items-center gap-1 mb-0.5">
        {icon}
        {label}
      </p>
      <p className="text-white text-[13px] font-semibold" dir="ltr">
        {value}
      </p>
    </div>
  );
}
