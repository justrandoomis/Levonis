import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { ApiError } from '../../lib/api';
import { refusalText } from '../../lib/refusalStrings';
import { Overlay } from '../ui/Overlay';
import { primeScannerAudio, scanFeedback } from '../scanner/feedback';
import type { ScanRead } from '../scanner/BarcodeScanner';
import { formatNoteTexts, type FormatNoteWire } from '../adminOrders/serials/formatNotes';
import { T, useLabels } from './shared';

const BarcodeScanner = lazy(() => import('../scanner/BarcodeScanner'));

export type PurchaseSerialRead = { code: string; source: 'camera' | 'scanner' | 'manual' };
export type PurchaseSerialResult = { serial_norm: string; already: boolean; version: number; format_warnings?: FormatNoteWire[] };

/** Reuses the same camera, label decoder and permission fallbacks as warranty.
 * A saved unit is persisted immediately, and the chime follows the server's
 * verdict. An unsaved purchase only records a draft: its UI says so. */
export default function PurchaseUnitSerial({ value = '', mode, disabled = false, onChange, onSave }: {
  value?: string;
  mode: 'draft' | 'saved';
  disabled?: boolean;
  onChange?: (serial: string) => void;
  onSave?: (read: PurchaseSerialRead) => Promise<PurchaseSerialResult>;
}) {
  const { loc } = useLabels();
  const { lang } = useLanguage();
  const [typed, setTyped] = useState(value), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [notes, setNotes] = useState<string[]>([]), [attempt, setAttempt] = useState(0);
  const saving = useRef(false), cameraButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const locked = mode === 'saved' && !!value;
  useEffect(() => { setTyped(value); }, [value]);
  const describeError = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'INVENTORY_ORIGIN_SERIAL_CONFLICT') return loc('هذا الرقم التسلسلي مرتبط بقطعة أو طلب آخر. راجع الملصق والقطعة المحددة.', 'This serial belongs to another unit or order. Check the label and selected unit.', 'ئەم ژمارەیە بە پارچە یان داواکارییەکی ترەوە بەستراوە. لیبڵ و پارچەی هەڵبژێردراو بپشکنە.');
      if (e.code === 'INVENTORY_ORIGIN_SERIAL_LOCKED') return loc('لهذه القطعة رقم تسلسلي مثبت مسبقًا ولا يمكن استبداله هنا.', 'This unit already has a fixed serial and it cannot be replaced here.', 'ئەم پارچەیە پێشتر ژمارەیەکی جێگیری هەیە و لێرە ناگۆڕدرێت.');
      return refusalText(e.code, lang, e.message);
    }
    return e instanceof Error ? e.message : String(e);
  };
  const accept = async (read: PurchaseSerialRead) => {
    if (saving.current || disabled || locked || !read.code.trim()) return;
    setError(''); setNotice(''); setNotes([]);
    if (mode === 'draft') {
      setTyped(read.code); onChange?.(read.code);
      setNotice(loc('تمت قراءة الرقم في المسودة. يُسجّل مع تأكيد الشراء.', 'Read into the draft. Registered when the purchase is confirmed.', 'ژمارەکە لە ڕەشنووسدا خوێندرایەوە. لە کاتی پشتڕاستکردنەوەی کڕین تۆمار دەکرێت.'));
      scanFeedback('captured'); setOpen(false);
      return;
    }
    if (!onSave) return;
    saving.current = true; setBusy(true);
    try {
      const result = await onSave(read);
      setTyped(result.serial_norm);
      setNotes(formatNoteTexts(result.format_warnings, lang));
      setNotice(loc('تم حفظ الرقم التسلسلي وربطه بهذه القطعة.', 'Serial saved and linked to this unit.', 'ژمارەی زنجیرەیی پاشەکەوت کرا و بەم پارچەیەوە بەسترا.'));
      scanFeedback('added'); setOpen(false);
    } catch (e) {
      setError(describeError(e)); scanFeedback('invalid');
    } finally { saving.current = false; setBusy(false); }
  };
  const readCamera = async (read: ScanRead) => {
    // Follow the existing inventory scanner's conservative branch when a
    // product-specific box rule is not loaded: only Product SN is automatic.
    // Never promote EAN, tracking, raw codes or a lone Box SN into a binding.
    if (!read.productSn) {
      setError(loc('لم يُقرأ Product SN. وجّه الكاميرا إلى الرقم التسلسلي للجهاز، أو أدخله يدويًا بعد التحقق من الملصق.', 'Product SN was not read. Aim at the device serial, or verify the label and enter it manually.', 'Product SN نەخوێندرایەوە. کامێرا بەرەو ژمارەی زنجیرەیی ئامێر بگرە، یان دوای پشکنینی لیبڵ بە دەست بینووسە.'));
      scanFeedback('invalid');
      return;
    }
    await accept({ code: read.productSn, source: 'camera' });
  };
  return <div className="mt-3 min-w-0 border-t border-[var(--ap-border)] pt-3">
    <label className="grid min-w-0 gap-1 text-sm">
      <span className={T.text2}>{loc('الرقم التسلسلي للجهاز (اختياري)', 'Device serial number (optional)', 'ژمارەی زنجیرەیی ئامێر (ئارەزوومەندانە)')}</span>
      <input type="text" dir="ltr" value={typed} readOnly={locked} disabled={disabled || busy} maxLength={120} autoComplete="off" spellCheck={false} className={`${T.input} min-w-0 font-mono`} onChange={(e) => { setTyped(e.target.value); setNotice(''); setError(''); if (mode === 'draft') onChange?.(e.target.value); }} onKeyDown={(e) => {
        if (e.key === 'Enter' && mode === 'saved' && !locked) { e.preventDefault(); primeScannerAudio(); void accept({ code: typed, source: 'manual' }); }
      }} />
    </label>
    <p className={`mt-2 text-xs ${T.text3}`}>{locked
      ? loc('مرتبط بهذه القطعة. يبقى تتبع المورد قابلًا للتعديل.', 'Linked to this unit. Supplier tracking remains editable.', 'بەم پارچەیەوە بەستراوە. شوێنکەوتنی دابینکەر هێشتا دەگۆڕدرێت.')
      : mode === 'draft'
        ? loc('امسح Product SN أو أدخله يدويًا للطابعة أو AMS أو الليزر. يبقى في المسودة حتى تأكيد الشراء؛ أكمل الكمية والتكاليف قبل التأكيد مع أرقام تسلسلية.', 'Scan Product SN or enter it for a printer, AMS or laser. It stays in the draft until purchase confirmation; finish quantities and costs before confirming with serials.', 'Product SN سکان بکە یان بۆ چاپکەر، AMS یان لەیزەر بینووسە. تا پشتڕاستکردنەوە لە ڕەشنووسدا دەمێنێت؛ پێش پشتڕاستکردنەوە لەگەڵ ژمارەکان بڕ و تێچوو تەواو بکە.')
        : loc('المسح يحفظ الرقم فورًا لهذه القطعة. أكمل الكمية والتكاليف أولًا؛ بعد تثبيت أي رقم لا يمكن إعادة تحرير كميات وتكاليف أمر الشراء.', 'Scanning saves immediately for this unit. Finish quantities and costs first; after a serial is fixed, purchase quantities and costs cannot be rewritten.', 'سکانکردن ژمارەکە دەستبەجێ بۆ ئەم پارچەیە پاشەکەوت دەکات. سەرەتا بڕ و تێچوو تەواو بکە؛ دوای جێگیرکردنی ژمارە بڕ و تێچووی کڕین ناگۆڕدرێن.')}</p>
    {!locked && <div className="mt-2 flex flex-wrap gap-2">
      <button ref={cameraButton} type="button" disabled={disabled || busy} className={`${T.btnSecondary} inline-flex items-center gap-2`} onClick={() => { primeScannerAudio(); setError(''); setAttempt((n) => n + 1); setOpen(true); }}><Camera className="h-4 w-4" aria-hidden />{loc('مسح بالكاميرا', 'Scan with camera', 'سکان بە کامێرا')}</button>
      {mode === 'saved' && <button type="button" disabled={disabled || busy || !typed.trim()} className={T.btnSecondary} onClick={() => { primeScannerAudio(); void accept({ code: typed, source: 'manual' }); }}>{busy ? loc('جارٍ الحفظ…', 'Saving…', 'پاشەکەوتکردن…') : loc('حفظ الرقم لهذه القطعة', 'Save serial for this unit', 'پاشەکەوتکردنی ژمارە بۆ ئەم پارچەیە')}</button>}
    </div>}
    {error && !open && <p role="alert" className="mt-2 text-sm text-[var(--ap-danger)]">{error}</p>}
    {notice && <p role="status" className={`mt-2 text-xs ${T.text2}`}>{notice}</p>}
    {notes.map((note) => <p key={note} className="mt-2 text-xs text-[var(--ap-warning)]">{note}</p>)}
    <Overlay open={open} onClose={() => setOpen(false)} labelledBy={titleId} anchor={cameraButton} solid z={80} testId="purchase-unit-serial-scanner" panelClassName="w-full max-w-md overflow-hidden border border-border-subtle bg-surface-raised">
      <Suspense fallback={<p role="status" className="p-6">{loc('جارٍ فتح الكاميرا…', 'Opening camera…', 'کردنەوەی کامێرا…')}</p>}>
        <BarcodeScanner key={attempt} mode="single" frame="label" deferFeedback waitForCompanions titleId={titleId} title={loc('امسح الرقم التسلسلي لهذه القطعة', 'Scan this unit’s serial number', 'ژمارەی زنجیرەیی ئەم پارچەیە سکان بکە')} onRead={readCamera} onManual={(code) => { void accept({ code, source: 'manual' }); }} onClose={() => setOpen(false)} verdict={<>
          {busy && <p role="status" className="p-3 text-sm">{loc('جارٍ حفظ الرقم لهذه القطعة…', 'Saving serial for this unit…', 'پاشەکەوتکردنی ژمارە بۆ ئەم پارچەیە…')}</p>}
          {error && <div className="p-3"><p role="alert" className="text-sm text-[var(--ap-danger)]">{error}</p><button type="button" className={`${T.btnSecondary} mt-2`} disabled={busy} onClick={() => { setError(''); setAttempt((n) => n + 1); }}>{loc('مسح مجددًا', 'Scan again', 'دووبارە سکان بکە')}</button></div>}
        </>} />
      </Suspense>
    </Overlay>
  </div>;
}
