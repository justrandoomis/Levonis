/**
 * «تجهيز لـ MakerWorld» — the primary output flow UI (slice S7, mandate §9).
 *
 * Renders the four honest steps around MakerWorldExportManager:
 *   1. فحص المشروع  — preflight (volume/plates/materials/paint limits).
 *   2. تجهيز 3MF    — the engine's real save path, structurally verified.
 *   3. ملخص النقل   — what transfers and what may not be supported.
 *   4. فتح MakerWorld — official-path handoff with the user's own account.
 *
 * Honest wording is a hard rule here: the flow says "الملف جاهز" (file ready)
 * and "فتح MakerWorld" (open MakerWorld) and explicitly notes that opening the
 * page uploads nothing — it NEVER claims the upload happened, because no
 * sanctioned third-party upload API exists (tests/makerworld-flow.test.mjs
 * guards this file against upload-success wording).
 *
 * Strings live locally (ar default + en + ckb) following the app convention;
 * the Sorani strings carry the same review caveat as S6's dictionaries
 * (human-written, native review still pending — never described as reviewed).
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { EngineAdapter } from "../engine-adapter";
import {
  MAKERWORLD_UPLOAD_URL,
  MakerWorldExportManager,
  type ExportFailureReason,
  type ExportManagerDeps,
} from "../export-manager";
import type { Locale } from "../i18n";
import type {
  PreflightCode,
  PreflightFinding,
  PreflightInput,
  TransferKey,
  TransferStatus,
} from "./preflight";

// ---------------------------------------------------------------------------
// Browser wiring for the manager (kept here so export-manager.ts stays
// dependency-free and Node-testable)
// ---------------------------------------------------------------------------

function browserDownload(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

/**
 * Builds manager deps on top of the S4 engine adapter: save-project through
 * the adapter, anchor downloads, window.open for the official upload page.
 */
export function createMakerWorldManagerDeps(
  adapter: EngineAdapter,
  overrides: Partial<Omit<ExportManagerDeps, "engine">> = {},
): ExportManagerDeps {
  return {
    engine: { requestSave: () => adapter.runPrepareAction("save-project") },
    download: overrides.download ?? browserDownload,
    openExternal: overrides.openExternal ?? ((url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    }),
    saveTimeoutMs: overrides.saveTimeoutMs,
    now: overrides.now,
  };
}

// ---------------------------------------------------------------------------
// Local dictionaries (ar default + en + ckb)
// ---------------------------------------------------------------------------

interface PrepareText {
  title: string;
  subtitle: string;
  stepCheck: string;
  stepPrepare: string;
  stepSummary: string;
  stepHandoff: string;
  runCheck: string;
  rerunCheck: string;
  checkPassed: string;
  checkBlocked: string;
  prepareFile: string;
  reprepareFile: string;
  preparing: string;
  fileReady: string;
  openMakerWorld: string;
  handoffOpenedNote: string;
  noUploadNote: string;
  privateNote: string;
  summaryTransfers: string;
  summaryPartial: string;
  summaryNotTransferred: string;
  fileLine: string;
  retry: string;
  failureEngine: string;
  failureTimeout: string;
  failureInvalid: string;
  invalidatedNote: string;
  gcodeSecondaryNote: string;
  objectsSuffix: string;
}

const TEXT: Record<Locale, PrepareText> = {
  ar: {
    title: "تجهيز لـ MakerWorld",
    subtitle: "المسار الأساسي للإخراج: فحص، ثم ملف 3MF حقيقي، ثم ملخص صادق، ثم الرفع بنفسك من حسابك عبر الصفحة الرسمية.",
    stepCheck: "فحص المشروع والتوافق",
    stepPrepare: "تجهيز ملف مشروع 3MF",
    stepSummary: "ملخص ما سيُنقل وما قد لا يُدعم",
    stepHandoff: "فتح MakerWorld والرفع بحسابك",
    runCheck: "افحص المشروع",
    rerunCheck: "أعد الفحص",
    checkPassed: "الفحص ناجح — يمكن تجهيز الملف.",
    checkBlocked: "لا يمكن التجهيز قبل معالجة الموانع أدناه.",
    prepareFile: "جهّز ملف 3MF",
    reprepareFile: "أعد تجهيز الملف",
    preparing: "جارٍ حفظ المشروع من المحرك…",
    fileReady: "الملف جاهز",
    openMakerWorld: "فتح MakerWorld",
    handoffOpenedNote: "فُتحت صفحة الرفع الرسمية. لم يُرفع أي شيء تلقائيًا — الرفع يتم بيدك وبحسابك.",
    noUploadNote: "فتح الصفحة لا يعني أن الرفع تم؛ لا يوجد رفع تلقائي ولا API رفع مصرّح به لطرف ثالث.",
    privateNote: "عند الرفع اختر Private Model إن أردت إبقاء المشروع خاصًا؛ لا يُنشر شيء دون قرارك.",
    summaryTransfers: "سيُنقل",
    summaryPartial: "يُنقل جزئيًا (بحدود معلنة)",
    summaryNotTransferred: "لن يُنقل / غير مدعوم",
    fileLine: "الملف",
    retry: "أعد المحاولة",
    failureEngine: "المحرك غير متاح الآن — تعذر بدء الحفظ.",
    failureTimeout: "انتهت مهلة حفظ المشروع دون ملف. أعد المحاولة.",
    failureInvalid: "الملف الناتج فشل فحص بنية 3MF ولن يُقدَّم كملف جاهز.",
    invalidatedNote: "تغيّر المشروع أو الإعدادات بعد آخر تجهيز، فأُلغيت النتيجة. ابدأ بالفحص من جديد.",
    gcodeSecondaryNote: "تنزيل G-code الخام بقي إجراءً ثانويًا/متقدمًا في لوحة الطباعة — ليس بديلًا عن ملف المشروع.",
    objectsSuffix: "مجسم",
  },
  en: {
    title: "Prepare for MakerWorld",
    subtitle: "The primary output path: check the project, prepare a real 3MF, review an honest summary, then upload it yourself from your own account on the official page.",
    stepCheck: "Check project & compatibility",
    stepPrepare: "Prepare the 3MF project file",
    stepSummary: "What transfers, what may not be supported",
    stepHandoff: "Open MakerWorld and upload with your account",
    runCheck: "Check project",
    rerunCheck: "Re-run check",
    checkPassed: "Check passed — the file can be prepared.",
    checkBlocked: "Preparation is blocked until the issues below are resolved.",
    prepareFile: "Prepare 3MF file",
    reprepareFile: "Re-prepare file",
    preparing: "Saving the project from the engine…",
    fileReady: "File ready",
    openMakerWorld: "Open MakerWorld",
    handoffOpenedNote: "The official upload page was opened. Nothing was uploaded automatically — the upload is yours, with your account.",
    noUploadNote: "Opening the page does not mean an upload happened; there is no automatic upload and no sanctioned third-party upload API.",
    privateNote: "When uploading, pick Private Model to keep the project private; nothing is published without your decision.",
    summaryTransfers: "Transfers",
    summaryPartial: "Transfers partially (declared limits)",
    summaryNotTransferred: "Does not transfer / unsupported",
    fileLine: "File",
    retry: "Retry",
    failureEngine: "The engine is unavailable right now — the save could not start.",
    failureTimeout: "The project save timed out without producing a file. Try again.",
    failureInvalid: "The produced file failed the 3MF structure check and will not be presented as ready.",
    invalidatedNote: "The project or settings changed after the last preparation, so the result was discarded. Start with a new check.",
    gcodeSecondaryNote: "Raw G-code download remains a secondary/advanced action in the print sheet — it is not a substitute for the project file.",
    objectsSuffix: "object(s)",
  },
  // Human-written Sorani; native-speaker review still pending (same caveat as
  // the S6 dictionaries) — not described anywhere as a reviewed translation.
  ckb: {
    title: "ئامادەکردن بۆ MakerWorld",
    subtitle: "ڕێگای سەرەکی دەرچوون: پشکنین، پاشان فایلی 3MF ی ڕاستەقینە، پاشان پوختەیەکی ڕاستگۆ، پاشان بارکردن بە دەستی خۆت و بە هەژماری خۆت لە پەڕەی فەرمی.",
    stepCheck: "پشکنینی پڕۆژە و گونجان",
    stepPrepare: "ئامادەکردنی فایلی پڕۆژەی 3MF",
    stepSummary: "چی دەگوازرێتەوە و چی لەوانەیە پشتگیری نەکرێت",
    stepHandoff: "کردنەوەی MakerWorld و بارکردن بە هەژمارت",
    runCheck: "پڕۆژەکە بپشکنە",
    rerunCheck: "دووبارە بپشکنە",
    checkPassed: "پشکنین سەرکەوتوو بوو — دەتوانرێت فایلەکە ئامادە بکرێت.",
    checkBlocked: "ئامادەکردن ناکرێت هەتا کێشەکانی خوارەوە چارەسەر نەکرێن.",
    prepareFile: "فایلی 3MF ئامادە بکە",
    reprepareFile: "دووبارە ئامادەی بکە",
    preparing: "پاشەکەوتکردنی پڕۆژە لە بزوێنەرەوە…",
    fileReady: "فایلەکە ئامادەیە",
    openMakerWorld: "کردنەوەی MakerWorld",
    handoffOpenedNote: "پەڕەی بارکردنی فەرمی کرایەوە. هیچ شتێک بە شێوەی ئۆتۆماتیکی بار نەکراوە — بارکردنەکە بە دەستی خۆتە و بە هەژماری خۆت.",
    noUploadNote: "کردنەوەی پەڕەکە مانای ئەوە نییە بارکردن ئەنجام دراوە؛ بارکردنی ئۆتۆماتیکی نییە و هیچ API یەکی ڕێپێدراوی لایەنی سێیەم بۆ بارکردن بوونی نییە.",
    privateNote: "لە کاتی بارکردن Private Model هەڵبژێرە ئەگەر دەتەوێت پڕۆژەکە تایبەت بمێنێتەوە؛ هیچ شتێک بەبێ بڕیاری تۆ بڵاو ناکرێتەوە.",
    summaryTransfers: "دەگوازرێتەوە",
    summaryPartial: "بەشێکی دەگوازرێتەوە (بە سنووری ڕاگەیەنراو)",
    summaryNotTransferred: "ناگوازرێتەوە / پشتگیری ناکرێت",
    fileLine: "فایل",
    retry: "دووبارە هەوڵ بدە",
    failureEngine: "بزوێنەر ئێستا بەردەست نییە — پاشەکەوتکردن دەستی پێ نەکرد.",
    failureTimeout: "کاتی پاشەکەوتکردنی پڕۆژە تەواو بوو بەبێ فایل. دووبارە هەوڵ بدە.",
    failureInvalid: "فایلی دەرچوو لە پشکنینی پێکهاتەی 3MF سەرکەوتوو نەبوو و وەک فایلی ئامادە پێشکەش ناکرێت.",
    invalidatedNote: "پڕۆژە یان ڕێکخستنەکان دوای دوایین ئامادەکردن گۆڕان، بۆیە ئەنجامەکە هەڵوەشێنرایەوە. بە پشکنینێکی نوێ دەست پێ بکە.",
    gcodeSecondaryNote: "داگرتنی G-code ی خاو وەک کردارێکی لاوەکی/پێشکەوتوو لە پانێڵی چاپکردن مایەوە — جێگرەوەی فایلی پڕۆژە نییە.",
    objectsSuffix: "تەن",
  },
};

const FINDING_TEXT: Record<Locale, Record<PreflightCode, string>> = {
  ar: {
    "no-objects": "لا توجد مجسمات في المشروع — أضف ملفًا أولًا.",
    "object-exceeds-bed": "مجسم يتجاوز حجم الطباعة للطابعة المختارة ({printer}: {bed} مم).",
    "objects-unmeasured": "تعذر قياس أبعاد بعض المجسمات؛ لم يُفحص تجاوز الحجم لها.",
    "objects-hidden": "توجد مجسمات مخفية — تُحفظ داخل ملف المشروع أيضًا.",
    "preset-fallback": "إعدادات الطابعة الحالية بديلة عامة وليست الملف الشخصي الموثّق ({missing}).",
    "multi-extruder-unverified": "إسناد أكثر من مستخرج (T{extruders}) يُكتب في الملف ويصل لطلب التقطيع، لكن وصوله إلى G-code النهائي غير مُتحقق في هذا الإصدار — حدود تعدد المواد المتبقية معلنة.",
    "surface-paint-unavailable": "رسم الألوان على الأسطح بنمط Bambu الكامل غير متاح في هذا الإصدار من المحرك؛ الملف لا يحمل بيانات تلوين facets.",
    "paint-multi-plate-limit": "مشروع متعدد الألواح: يُحفظ رسم الدعامات المستورد فقط (حد موثق في المحرك).",
    "thumbnail-not-embedded": "المحرك لا يضمّن صورة مصغرة في ملف 3MF؛ ستطلب MakerWorld صورًا عند الرفع.",
    "print-profile-not-accepted": "فحص Print Profile في MakerWorld يرفض ملفات لم تُولَّد بـ Bambu Studio — هذا الملف يُرفع كنموذج/مشروع فقط.",
    "plate-cap": "المشروع عند حد الألواح المعلن للمحرك ({cap} ألواح).",
  },
  en: {
    "no-objects": "The project has no objects — add a file first.",
    "object-exceeds-bed": "An object exceeds the selected printer's build volume ({printer}: {bed} mm).",
    "objects-unmeasured": "Some objects could not be measured; their volume check was skipped.",
    "objects-hidden": "Hidden objects exist — they are still saved inside the project file.",
    "preset-fallback": "Current printer settings are a generic fallback, not the verified profile ({missing}).",
    "multi-extruder-unverified": "Multiple extruders are assigned (T{extruders}). The assignment is written to the file and feeds the slice request, but its presence in final G-code is unverified in this build — remaining multi-material limits are declared.",
    "surface-paint-unavailable": "Full Bambu-style surface color painting is not available in this engine build; the file carries no facet-paint color data.",
    "paint-multi-plate-limit": "Multi-plate project: only imported support paint is persisted (a documented engine limit).",
    "thumbnail-not-embedded": "The engine embeds no thumbnail in the 3MF; MakerWorld will ask for images at upload.",
    "print-profile-not-accepted": "MakerWorld's print-profile check rejects files not generated by Bambu Studio — this file uploads as a model/project only.",
    "plate-cap": "The project is at the engine's declared plate limit ({cap} plates).",
  },
  ckb: {
    "no-objects": "پڕۆژەکە هیچ تەنێکی تێدا نییە — سەرەتا فایلێک زیاد بکە.",
    "object-exceeds-bed": "تەنێک لە قەبارەی چاپکردنی چاپکەرە هەڵبژێردراوەکە تێدەپەڕێت ({printer}: {bed} مم).",
    "objects-unmeasured": "پێوانەی هەندێک تەن نەکرا؛ پشکنینی قەبارە بۆیان جێ هێڵرا.",
    "objects-hidden": "تەنی شاراوە هەیە — ئەوانیش لەناو فایلی پڕۆژەکە پاشەکەوت دەکرێن.",
    "preset-fallback": "ڕێکخستنەکانی ئێستای چاپکەر جێگرەوەی گشتین، نەک پرۆفایلی پشتڕاستکراو ({missing}).",
    "multi-extruder-unverified": "زیاتر لە یەک دەرهێنەر دیاری کراوە (T{extruders}). دیاریکردنەکە لە فایلەکە دەنووسرێت و دەگاتە داواکاری پارچەکردن، بەڵام گەیشتنی بۆ G-code ی کۆتایی لەم وەشانە پشتڕاست نەکراوەتەوە — سنوورە ماوەکانی فرە-ماددە ڕاگەیەنراون.",
    "surface-paint-unavailable": "بۆیاخکردنی ڕەنگی ڕووکار بە شێوازی تەواوی Bambu لەم وەشانەی بزوێنەر بەردەست نییە؛ فایلەکە داتای ڕەنگی facet هەڵناگرێت.",
    "paint-multi-plate-limit": "پڕۆژەی فرە-پلێت: تەنها بۆیاخی پشتیوانی هاوردەکراو پاشەکەوت دەکرێت (سنوورێکی تۆمارکراوی بزوێنەر).",
    "thumbnail-not-embedded": "بزوێنەر وێنەی بچووک لە 3MF دا جێگیر ناکات؛ MakerWorld لە کاتی بارکردن داوای وێنە دەکات.",
    "print-profile-not-accepted": "پشکنینی Print Profile لە MakerWorld فایلانە ڕەت دەکاتەوە کە بە Bambu Studio دروست نەکراون — ئەم فایلە تەنها وەک مۆدێل/پڕۆژە بار دەکرێت.",
    "plate-cap": "پڕۆژەکە لە سنووری ڕاگەیەنراوی پلێتەکانی بزوێنەرە ({cap} پلێت).",
  },
};

const TRANSFER_TEXT: Record<Locale, Record<TransferKey, string>> = {
  ar: {
    geometry: "هندسة المجسمات",
    plates: "توزيع الألواح",
    transforms: "التحويلات (نقل/تدوير/تحجيم)",
    "extruder-assignment": "إسناد المستخرج لكل مجسم",
    "support-paint": "رسم الدعامات",
    "global-settings": "إعدادات التقطيع العامة",
    "surface-colors": "تلوين الأسطح (facets)",
    thumbnail: "الصورة المصغرة داخل الملف",
    "print-profile": "Print Profile لـ MakerWorld",
    "slice-info": "بيانات slice_info",
  },
  en: {
    geometry: "Object geometry",
    plates: "Plate layout",
    transforms: "Transforms (move/rotate/scale)",
    "extruder-assignment": "Per-object extruder assignment",
    "support-paint": "Support painting",
    "global-settings": "Global slicing settings",
    "surface-colors": "Surface (facet) colors",
    thumbnail: "Embedded thumbnail",
    "print-profile": "MakerWorld print profile",
    "slice-info": "slice_info data",
  },
  ckb: {
    geometry: "جیۆمەتری تەنەکان",
    plates: "دابەشکردنی پلێتەکان",
    transforms: "گۆڕانکارییەکان (گواستنەوە/سووڕان/قەبارە)",
    "extruder-assignment": "دیاریکردنی دەرهێنەر بۆ هەر تەنێک",
    "support-paint": "بۆیاخی پشتیوانی",
    "global-settings": "ڕێکخستنە گشتییەکانی پارچەکردن",
    "surface-colors": "ڕەنگی ڕووکار (facets)",
    thumbnail: "وێنەی بچووکی ناو فایل",
    "print-profile": "Print Profile بۆ MakerWorld",
    "slice-info": "داتای slice_info",
  },
};

function fillTemplate(template: string, values: Record<string, string | number> | undefined): string {
  if (!values) return template;
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function findingMessage(locale: Locale, finding: PreflightFinding): string {
  return fillTemplate(FINDING_TEXT[locale][finding.code], finding.data);
}

function failureMessage(locale: Locale, reason: ExportFailureReason): string {
  const text = TEXT[locale];
  if (reason === "engine-unavailable") return text.failureEngine;
  if (reason === "save-timeout") return text.failureTimeout;
  return text.failureInvalid;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface MakerWorldPrepareProps {
  locale: Locale;
  manager: MakerWorldExportManager;
  /** Collects the current scene/profile facts for the preflight (called on demand). */
  collectPreflightInput: () => PreflightInput;
  /** Current project name, used for the prepared file's clear name. */
  projectName?: string;
  className?: string;
}

const STATUS_ORDER: readonly TransferStatus[] = ["transfers", "partial", "not-transferred"];

export function MakerWorldPrepare({
  locale,
  manager,
  collectPreflightInput,
  projectName,
  className,
}: MakerWorldPrepareProps): React.JSX.Element {
  const state = useSyncExternalStore(manager.subscribe, manager.getState, manager.getState);
  const text = TEXT[locale];
  const dir = locale === "en" ? "ltr" : "rtl";

  const handleCheck = useCallback(() => {
    manager.runCheck(collectPreflightInput());
  }, [manager, collectPreflightInput]);

  const handlePrepare = useCallback(() => {
    manager.prepare({ projectName: projectName ?? "" });
  }, [manager, projectName]);

  const handleHandoffClick = useCallback(() => {
    manager.markHandoffOpened();
  }, [manager]);

  const stepLabels = useMemo(
    () => [text.stepCheck, text.stepPrepare, text.stepSummary, text.stepHandoff],
    [text],
  );

  const { report, file, phase } = state;
  const blockers = report?.findings.filter((finding) => finding.severity === "blocker") ?? [];
  const nonBlockers = report?.findings.filter((finding) => finding.severity !== "blocker") ?? [];
  const canPrepare = phase === "checked" || phase === "failed" || phase === "file-ready";

  return (
    <section className={`mw-prepare ${className ?? ""}`} dir={dir} aria-label={text.title}>
      <style>{PREPARE_CSS}</style>
      <header className="mw-head">
        <h3>{text.title}</h3>
        <p>{text.subtitle}</p>
      </header>

      {state.invalidatedBy && phase === "idle" && (
        <p className="mw-note mw-invalidated" role="status">{text.invalidatedNote}</p>
      )}

      <ol className="mw-steps">
        {stepLabels.map((label, index) => {
          const stepNumber = (index + 1) as 1 | 2 | 3 | 4;
          const stepState = stepNumber < state.step ? "done" : stepNumber === state.step ? "current" : "pending";
          return (
            <li key={label} className={`mw-step mw-step-${stepState}`} aria-current={stepState === "current" ? "step" : undefined}>
              <span className="mw-step-index">{stepNumber}</span>
              <div className="mw-step-body">
                <strong>{label}</strong>

                {stepNumber === 1 && (
                  <div className="mw-step-content">
                    <button type="button" className="mw-action" onClick={handleCheck}>
                      {report ? text.rerunCheck : text.runCheck}
                    </button>
                    {report && (
                      <p className={`mw-check-result ${report.ok ? "ok" : "blocked"}`} role="status">
                        {report.ok ? text.checkPassed : text.checkBlocked}
                        {" "}({report.checkedObjectCount + report.unmeasuredObjectCount} {text.objectsSuffix})
                      </p>
                    )}
                    {blockers.length > 0 && (
                      <ul className="mw-findings mw-blockers">
                        {blockers.map((finding) => (
                          <li key={finding.code}>{findingMessage(locale, finding)}</li>
                        ))}
                      </ul>
                    )}
                    {report && nonBlockers.length > 0 && (
                      <ul className="mw-findings">
                        {nonBlockers.map((finding) => (
                          <li key={finding.code} className={`mw-finding-${finding.severity}`}>
                            {findingMessage(locale, finding)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {stepNumber === 2 && (
                  <div className="mw-step-content">
                    <button
                      type="button"
                      className="mw-action"
                      onClick={handlePrepare}
                      disabled={!canPrepare}
                    >
                      {phase === "failed" ? text.retry : file ? text.reprepareFile : text.prepareFile}
                    </button>
                    {phase === "preparing" && (
                      <p className="mw-preparing" role="status" aria-busy="true">
                        <span className="mw-indeterminate" aria-hidden="true" />
                        {text.preparing}
                      </p>
                    )}
                    {phase === "failed" && state.failure && (
                      <p className="mw-failure" role="alert">{failureMessage(locale, state.failure)}</p>
                    )}
                  </div>
                )}

                {stepNumber === 3 && report && (phase === "file-ready" || phase === "handoff-opened") && (
                  <div className="mw-step-content">
                    {file && (
                      <p className="mw-file-line" dir="ltr">
                        <b>{text.fileLine}:</b> {file.filename} · {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
                      </p>
                    )}
                    {STATUS_ORDER.map((status) => {
                      const items = report.transfers.filter((item) => item.status === status);
                      if (!items.length) return null;
                      const heading = status === "transfers"
                        ? text.summaryTransfers
                        : status === "partial" ? text.summaryPartial : text.summaryNotTransferred;
                      return (
                        <div key={status} className={`mw-transfer-group mw-transfer-${status}`}>
                          <h4>{heading}</h4>
                          <ul>
                            {items.map((item) => (
                              <li key={item.key}>{TRANSFER_TEXT[locale][item.key]}</li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}

                {stepNumber === 4 && (phase === "file-ready" || phase === "handoff-opened") && (
                  <div className="mw-step-content">
                    <p className="mw-file-ready" role="status">
                      <span className="mw-ready-badge">✓</span> {text.fileReady}
                    </p>
                    <a
                      className="mw-action mw-open-link"
                      href={MAKERWORLD_UPLOAD_URL}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={handleHandoffClick}
                    >
                      {text.openMakerWorld} ↗
                    </a>
                    {phase === "handoff-opened" && (
                      <p className="mw-note" role="status">{text.handoffOpenedNote}</p>
                    )}
                    <p className="mw-note">{text.noUploadNote}</p>
                    <p className="mw-note">{text.privateNote}</p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="mw-foot">
        <p className="mw-note">{text.gcodeSecondaryNote}</p>
      </footer>
    </section>
  );
}

// Scoped styles: iPad-first touch targets, works under the studio dark theme
// without editing globals.css (S6-owned).
const PREPARE_CSS = `
.mw-prepare{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid rgba(128,140,152,.25);border-radius:14px;background:rgba(18,23,28,.55)}
.mw-head h3{margin:0 0 4px;font-size:16px}
.mw-head p{margin:0;font-size:12.5px;opacity:.8;line-height:1.6}
.mw-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.mw-step{display:flex;gap:10px;padding:10px;border-radius:12px;border:1px solid rgba(128,140,152,.18)}
.mw-step-current{border-color:rgba(0,174,66,.55);background:rgba(0,174,66,.06)}
.mw-step-done{opacity:.85}
.mw-step-pending{opacity:.55}
.mw-step-index{flex:0 0 auto;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(0,174,66,.18);font-weight:700;font-size:13px}
.mw-step-body{flex:1;min-width:0}
.mw-step-body>strong{display:block;font-size:13.5px;margin-bottom:4px}
.mw-step-content{display:flex;flex-direction:column;gap:8px}
.mw-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:8px 16px;border-radius:10px;border:1px solid rgba(0,174,66,.6);background:rgba(0,174,66,.14);color:inherit;font-size:13.5px;font-weight:600;cursor:pointer;text-decoration:none;align-self:flex-start}
.mw-action:disabled{opacity:.45;cursor:not-allowed}
.mw-check-result{margin:0;font-size:12.5px}
.mw-check-result.ok{color:#7ad19a}
.mw-check-result.blocked{color:#f0a0a0}
.mw-findings{margin:0;padding:0 18px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.55}
.mw-blockers li{color:#f0a0a0}
.mw-finding-warning{color:#f0c060}
.mw-finding-info{opacity:.75}
.mw-preparing{display:flex;align-items:center;gap:8px;margin:0;font-size:12.5px}
.mw-indeterminate{width:64px;height:6px;border-radius:3px;overflow:hidden;background:rgba(128,140,152,.25);position:relative}
.mw-indeterminate::after{content:"";position:absolute;top:0;bottom:0;width:40%;border-radius:3px;background:rgba(0,174,66,.8);animation:mw-slide 1.1s ease-in-out infinite alternate}
@keyframes mw-slide{from{inset-inline-start:0}to{inset-inline-start:60%}}
@media (prefers-reduced-motion: reduce){.mw-indeterminate::after{animation:none;width:100%}}
.mw-failure{margin:0;font-size:12.5px;color:#f0a0a0}
.mw-file-line{margin:0;font-size:12px;opacity:.85;overflow-wrap:anywhere}
.mw-transfer-group h4{margin:0 0 3px;font-size:12px}
.mw-transfer-group ul{margin:0;padding:0 18px;font-size:12px;line-height:1.6}
.mw-transfer-transfers h4{color:#7ad19a}
.mw-transfer-partial h4{color:#f0c060}
.mw-transfer-not-transferred h4{color:#f0a0a0}
.mw-file-ready{display:flex;align-items:center;gap:8px;margin:0;font-weight:700;font-size:14px;color:#7ad19a}
.mw-ready-badge{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:rgba(0,174,66,.25)}
.mw-note{margin:0;font-size:11.5px;line-height:1.6;opacity:.75}
.mw-invalidated{color:#f0c060;opacity:1}
.mw-foot{border-top:1px dashed rgba(128,140,152,.25);padding-top:8px}
`;
