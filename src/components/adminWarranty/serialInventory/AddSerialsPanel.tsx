/**
 * «إضافة أرقام تسلسلية» — ONE BUTTON, THEN A CHOICE.
 *
 * The owner: «عند الضغط على إضافة أرقام تسلسلية … نافذة منبثقة من الأسفل على
 * تصميم أبل ديزاين يختار: الكاميرا أو الإدخال يدويًا. عند الضغط على الكاميرا
 * يفتح الكاميرا بنافذة منبثقة … وإضافة صوت نجاح عند تسجيل الطابعة بنجاح، وإذا
 * رجع مرة ثانية يسجل طابعة مسجلة مسبقًا يظهر صوت خطأ واهتزاز».
 *
 *  1. THE CHOICE is an action sheet from the bottom edge at every width (the
 *     «اللغة والمظهر» sheet's clothes — the owner works on an iPad): two
 *     grouped rows, Camera first, and a separate Cancel under them.
 *  2. CAMERA is a tall sheet around the continuous scanner. A label is not a
 *     row waiting for «حفظ الكل» any more: it is REGISTERED the moment it is
 *     read (POST /scan), and the sound is the server's verdict — the success
 *     chime for a printer that was just stored, the error tone and a buzz for
 *     one the inventory already holds (or that this session already scanned),
 *     with when and by whom it was added. The product is the label's own
 *     (a learned or known EAN) unless the owner picks one; a box the store
 *     cannot place is still registered, and «حدّد المنتج» files every serial
 *     of that EAN at once — after which the camera recognises it by itself.
 *  3. MANUAL is a sheet with one serial or a pasted list (ManualEntry).
 *
 * Nothing in the camera sheet is unsaved, so closing it never asks; the
 * manual sheet asks only while a pasted list is waiting.
 */
import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Camera, Check, ChevronLeft, ChevronRight, Keyboard, Link2, ScanLine, X } from 'lucide-react';
import * as T from '../../adminProducts/theme';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import { Overlay, Sheet } from '../../ui/Overlay';
import { Segmented } from '../../ui/Segmented';
import { useToast } from '../../ui/Toast';
import ProductPicker from '../../adminProducts/form/ProductPicker';
import { normalizeSerial, serialProblem } from '../../../../packages/catalog/src/deviceSerials';
import { primeScannerAudio, scanFeedback, type ScanFeedback } from '../../scanner/feedback';
import type { ScanRead } from '../../scanner/BarcodeScanner';
import ManualEntry from './ManualEntry';
import LinkProductDialog, { type LinkTarget } from './LinkProductDialog';
import { inventoryApi, problemText, refusalText, type InventoryRow, type InventoryStrings } from './model';

const BarcodeScanner = React.lazy(() => import('../../scanner/BarcodeScanner'));

/** The 44px icon button of these panels (the .ap recipe is 32px; these are touch targets on a phone). */
export const ICON_BTN_44 =
  'inline-flex items-center justify-center shrink-0 h-11 w-11 rounded-[var(--ap-radius-md)] text-[var(--ap-text-2)] transition-colors hover:text-[var(--ap-text-1)] hover:bg-[var(--ap-surface-2)] active:bg-[var(--ap-surface-3)] disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]';

type Step = 'choose' | 'camera' | 'manual' | null;

type ItemState = 'saving' | 'added' | 'exists' | 'invalid' | 'error';

interface SessionItem {
  key: string;
  norm: string;
  serial: string;
  ean: string;
  box_sn: string;
  state: ItemState;
  row: InventoryRow | null;
  via: string | null;
  hint: string | null;
  needsProduct: boolean;
  problem: string | null;
  /** A repeat of a serial this session already registered. */
  repeat?: boolean;
}

const STATE_TONE: Record<ItemState, string> = {
  saving: 'text-[var(--ap-text-3)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]',
  added: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]',
  exists: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  invalid: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  error: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
};

const toFeedback = (s: ItemState): ScanFeedback => (s === 'added' ? 'added' : s === 'exists' ? 'exists' : 'invalid');

/** A row's product in the viewer's language, else what the label says. */
function rowProductLabel(row: InventoryRow | null, lang: string): string {
  if (!row) return '';
  if (row.product) return lang === 'en' ? row.product.name || row.product.name_ar : row.product.name_ar || row.product.name;
  return row.model_name || row.model_hint || '';
}

export default function AddSerialsPanel({
  t,
  open,
  onClose,
  onSaved,
}: {
  t: InventoryStrings;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { dir, lang } = useLanguage();
  const m = useMotion();
  const toast = useToast();
  const chooseTitleId = useId();
  const scanTitleId = useId();
  const manualTitleId = useId();

  // The flow's own step; `open` from the list starts it at the choice. The
  // component stays mounted so every sheet can play its exit.
  const [step, setStep] = useState<Step>(null);
  useEffect(() => {
    if (open) setStep((s) => s ?? 'choose');
  }, [open]);

  const changed = useRef(false);
  const finish = useCallback(() => {
    setStep(null);
    onClose();
    if (changed.current) {
      changed.current = false;
      onSaved();
    }
  }, [onClose, onSaved]);

  // ------------------------------------------------------------ camera
  const [filingMode, setFilingMode] = useState<'auto' | 'chosen'>('auto');
  const [chosen, setChosen] = useState<{ id: string; name: string }>({ id: '', name: '' });
  const filingRef = useRef({ mode: filingMode, id: chosen.id });
  filingRef.current = { mode: filingMode, id: chosen.id };

  const [items, setItems] = useState<SessionItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [last, setLast] = useState<SessionItem | null>(null);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);

  const put = useCallback((item: SessionItem) => {
    const list = itemsRef.current.some((x) => x.key === item.key)
      ? itemsRef.current.map((x) => (x.key === item.key ? item : x))
      : [item, ...itemsRef.current];
    itemsRef.current = list;
    setItems(list);
    setLast(item);
  }, []);

  /** One label → registered on the server, and the verdict the scanner sounds. */
  const register = useCallback(
    async (input: { serial: string; box_sn: string; ean: string }): Promise<ScanFeedback> => {
      const norm = normalizeSerial(input.serial);
      const key = `${norm}-${Date.now()}`;
      const base: SessionItem = {
        key,
        norm,
        serial: input.serial,
        ean: input.ean,
        box_sn: input.box_sn,
        state: 'saving',
        row: null,
        via: null,
        hint: null,
        needsProduct: false,
        problem: null,
      };
      // Scanned earlier in this session: the owner's «مسجلة مسبقًا», at once.
      const prior = itemsRef.current.find((x) => x.norm === norm && (x.state === 'added' || x.state === 'exists' || x.state === 'saving'));
      if (prior) {
        put({ ...base, state: 'exists', row: prior.row, repeat: true });
        return 'exists';
      }
      const problem = serialProblem(input.serial);
      if (problem) {
        put({ ...base, state: 'invalid', problem });
        return 'invalid';
      }
      put(base);
      try {
        const f = filingRef.current;
        const res = await inventoryApi.scan(
          { serial: input.serial, box_sn: input.box_sn, ean: input.ean },
          { product_id: f.mode === 'chosen' ? f.id : '', variant_id: '' }
        );
        const state: ItemState = res.outcome === 'added' || res.outcome === 'added_assigned' ? 'added' : res.outcome === 'exists' ? 'exists' : 'invalid';
        if (state === 'added') changed.current = true;
        put({
          ...base,
          state,
          row: res.row,
          via: res.via ?? null,
          hint: res.hint?.label ?? res.row?.model_hint ?? null,
          needsProduct: state === 'added' && !!res.needs_product,
          problem: res.problem ?? null,
        });
        return toFeedback(state);
      } catch (e) {
        put({ ...base, state: 'error', problem: refusalText(e, t) });
        return 'invalid';
      }
    },
    [put, t]
  );

  const onRead = useCallback(
    (read: ScanRead): ScanFeedback | Promise<ScanFeedback> => {
      if (!read.productSn) return 'invalid';
      return register({ serial: read.productSn, box_sn: read.boxSn ?? '', ean: read.ean ?? '' });
    },
    [register]
  );

  // The scanner's typed fallback: registered the same way, and sounded here
  // (the scanner sounds only what the camera read).
  const onManualScan = (value: string) => {
    void register({ serial: value, box_sn: '', ean: '' }).then(scanFeedback);
  };

  const onLinked = ({ linked, productId, productName, ean }: { linked: number; productId: string; productName: string; ean: string }) => {
    setLinkTarget(null);
    changed.current = true;
    toast.success(linked > 0 ? t.linked(linked, productName) : t.linkedNone);
    // Every row of this session with that EAN now has its product.
    const list = itemsRef.current.map((x) =>
      x.needsProduct && ((ean && x.ean === ean) || (!ean && x.norm === linkTarget?.serialNorm))
        ? {
            ...x,
            needsProduct: false,
            via: 'chosen',
            row: x.row ? { ...x.row, product: { id: productId, name: productName, name_ar: productName } } : x.row,
          }
        : x
    );
    itemsRef.current = list;
    setItems(list);
    setLast((l) => (l ? list.find((x) => x.key === l.key) ?? l : l));
  };

  const added = items.filter((x) => x.state === 'added').length;
  const repeats = items.filter((x) => x.state === 'exists').length;

  // ------------------------------------------------------------ manual
  const [manualDirty, setManualDirty] = useState(false);

  // ------------------------------------------------------------ render
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  const option = (icon: React.ReactNode, title: string, hint: string, onPick: () => void, data: string) => (
    <button
      type="button"
      onClick={onPick}
      data-serial-add-option={data}
      className="flex w-full items-center gap-3 px-4 min-h-[68px] text-start transition-colors hover:bg-[var(--ap-surface-2)] active:bg-[var(--ap-surface-3)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ap-ring)]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--ap-accent-soft)] text-[var(--ap-accent-text)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-[var(--ap-text-1)]">{title}</span>
        <span className="block mt-0.5 text-[12.5px] leading-snug text-[var(--ap-text-3)]">{hint}</span>
      </span>
      <Chevron className="h-4 w-4 shrink-0 text-[var(--ap-text-3)]" aria-hidden />
    </button>
  );

  const verdictCard = last && (
    <div aria-live="assertive" className="pt-3" data-scan-verdict={last.state}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={last.key}
          initial={{ opacity: 0, y: m.travel(6), scale: m.reduced ? 1 : 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={m.reduced ? { duration: 0.15 } : m.spring('quick')}
          className={`flex items-start gap-3 rounded-2xl border p-3 ${
            last.state === 'added'
              ? 'border-[var(--ap-success-border)] bg-[var(--ap-success-bg)]'
              : last.state === 'saving'
                ? 'border-[var(--ap-border)] bg-[var(--ap-surface-2)]'
                : last.state === 'error'
                  ? 'border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)]'
                  : 'border-[var(--ap-danger-border)] bg-[var(--ap-danger-bg)]'
          }`}
        >
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              last.state === 'added'
                ? 'bg-[var(--ap-success)] text-white'
                : last.state === 'saving'
                  ? 'bg-[var(--ap-surface-3)] text-[var(--ap-text-2)]'
                  : last.state === 'error'
                    ? 'bg-[var(--ap-warning)] text-white'
                    : 'bg-[var(--ap-danger)] text-white'
            }`}
          >
            {last.state === 'added' ? (
              <Check className="h-5 w-5" strokeWidth={3} aria-hidden />
            ) : last.state === 'saving' ? (
              <ScanLine className="h-5 w-5" aria-hidden />
            ) : last.state === 'invalid' ? (
              <X className="h-5 w-5" strokeWidth={3} aria-hidden />
            ) : (
              <AlertTriangle className="h-5 w-5" aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-bold text-[var(--ap-text-1)]">
              {last.state === 'added'
                ? t.scanRegistered
                : last.state === 'saving'
                  ? t.checking
                  : last.state === 'exists'
                    ? last.repeat
                      ? t.alreadyInSession
                      : t.alreadyRegistered
                    : last.state === 'invalid'
                      ? t.notASerial
                      : t.scanFailed}
            </p>
            <p className="mt-0.5 font-mono text-[13px] text-[var(--ap-text-1)] break-all" dir="ltr">
              {last.serial}
            </p>
            {last.state === 'exists' && last.row && (
              <p className="mt-0.5 text-[12px] text-[var(--ap-text-2)]" dir="auto">
                {t.alreadyAt(last.row.created_at.slice(0, 10), last.row.created_by.email ?? last.row.created_by.username ?? '')}
                {rowProductLabel(last.row, lang) ? ` · ${rowProductLabel(last.row, lang)}` : ''}
              </p>
            )}
            {last.state === 'added' && (
              <p className="mt-0.5 text-[12px] text-[var(--ap-text-2)]" dir="auto">
                {last.needsProduct ? (
                  <>
                    {last.hint ? `${last.hint} · ` : ''}
                    <span className="font-semibold text-[var(--ap-warning)]">{t.unknownProduct}</span>
                  </>
                ) : (
                  <>
                    {rowProductLabel(last.row, lang)}
                    {last.via && t.linkedVia[last.via] ? ` · ${t.linkedVia[last.via]}` : ''}
                  </>
                )}
              </p>
            )}
            {(last.state === 'invalid' || last.state === 'error') && last.problem && (
              <p className="mt-0.5 text-[12px] text-[var(--ap-text-2)]">{problemText(t, lang, last.problem) ?? last.problem}</p>
            )}
            {last.state === 'added' && last.needsProduct && (
              <button
                type="button"
                className={`${T.btnSecondary} mt-2 min-h-[40px]`}
                onClick={() => setLinkTarget({ ean: last.ean, serialNorm: last.norm, serial: last.serial, hint: last.hint })}
                data-scan-pick-product
              >
                <Link2 className="h-4 w-4" aria-hidden />
                {t.pickForEan}
              </button>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );

  const sessionList = (
    <section aria-labelledby={`${scanTitleId}-session`} className="space-y-2" data-scan-list>
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h3 id={`${scanTitleId}-session`} className="text-[12.5px] font-semibold text-[var(--ap-text-2)]">
          {t.sessionTitle}
        </h3>
        {items.length > 0 && (
          <span className="text-[12px] tabular-nums text-[var(--ap-text-3)]" aria-live="polite">
            {t.sessionCounts(added, repeats)}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-1 text-[12.5px] leading-relaxed text-[var(--ap-text-3)]">{t.sessionEmpty}</p>
      ) : (
        <ul className={`${T.surface} divide-y divide-[var(--ap-hairline)] overflow-hidden`}>
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-2 px-3 py-2 min-h-[52px]" data-scan-item={i.norm} data-scan-state={i.state}>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px] text-[var(--ap-text-1)] truncate" dir="ltr">
                  {i.serial}
                </div>
                <div className="text-[11.5px] text-[var(--ap-text-3)] truncate" dir="auto">
                  {[rowProductLabel(i.row, lang) || i.hint, i.ean && `EAN ${i.ean}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              {i.needsProduct ? (
                <button
                  type="button"
                  className={`${T.btnSecondary} h-9 min-h-[36px]`}
                  onClick={() => setLinkTarget({ ean: i.ean, serialNorm: i.norm, serial: i.serial, hint: i.hint })}
                >
                  <Link2 className="h-3.5 w-3.5" aria-hidden />
                  {t.pickForEan}
                </button>
              ) : (
                <span className={`${T.badgeBase} ${STATE_TONE[i.state]}`}>
                  {i.state === 'added'
                    ? t.scanRegistered
                    : i.state === 'exists'
                      ? t.alreadyRegistered
                      : i.state === 'saving'
                        ? t.checking
                        : i.state === 'invalid'
                          ? t.outcomes.invalid
                          : t.genericError}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const sheetHeader = (titleId: string, title: string, onDone: () => void) => (
    <div className="shrink-0 border-b border-[var(--ap-hairline)]">
      {!m.reduced && (
        <div className="flex justify-center pt-2" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-[var(--ap-text-3)]/40" />
        </div>
      )}
      <div className="flex items-center justify-between gap-3 ps-4 pe-2 py-2">
        <h2 id={titleId} className="text-[16px] font-bold text-[var(--ap-text-1)] truncate">
          {title}
        </h2>
        <button
          type="button"
          onClick={onDone}
          className="min-h-[44px] px-3 rounded-[var(--ap-radius-md)] text-[15px] font-semibold text-[var(--ap-accent-text)] hover:bg-[var(--ap-surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]"
          data-sheet-done
        >
          {t.done}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* ------------------------------------------------ 1. the choice */}
      <Sheet
        open={step === 'choose'}
        onClose={finish}
        docked
        labelledBy={chooseTitleId}
        z={220}
        testId="serial-add-choose"
        panelClassName="w-full max-w-md"
      >
        <div className={`${T.AP} px-4 pt-1 pb-4`} dir={dir} data-serial-add-choose>
          <h2 id={chooseTitleId} className="text-[16px] font-bold text-[var(--ap-text-1)]">
            {t.chooseTitle}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-[var(--ap-text-3)]">{t.chooseBody}</p>
          <div className={`${T.surface} mt-3 overflow-hidden divide-y divide-[var(--ap-hairline)]`}>
            {option(
              <Camera className="h-5 w-5" aria-hidden />,
              t.optCamera,
              t.optCameraHint,
              () => {
                // The tap that opens the camera is the gesture iOS needs for sound.
                primeScannerAudio();
                setStep('camera');
              },
              'camera'
            )}
            {option(
              <Keyboard className="h-5 w-5" aria-hidden />,
              t.optManual,
              t.optManualHint,
              () => {
                primeScannerAudio();
                setStep('manual');
              },
              'manual'
            )}
          </div>
          <button
            type="button"
            onClick={finish}
            className={`${T.surface} mt-2.5 w-full min-h-[50px] text-[15px] font-semibold text-[var(--ap-text-1)] transition-colors hover:bg-[var(--ap-surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]`}
          >
            {t.cancel}
          </button>
        </div>
      </Sheet>

      {/* ------------------------------------------------ 2. the camera */}
      <Overlay
        open={step === 'camera'}
        onClose={finish}
        placement="dock"
        labelledBy={scanTitleId}
        z={225}
        testId="serial-scan-sheet"
        panelClassName="w-full sm:max-w-xl h-[94dvh] flex flex-col overflow-hidden"
      >
        <div className={`${T.AP} flex min-h-0 flex-1 flex-col`} dir={dir} data-serial-scan>
          {sheetHeader(scanTitleId, t.scanTitle, finish)}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            <div className="space-y-2">
              <Segmented
                group="serial-scan-filing"
                label={t.filing}
                value={filingMode}
                onChange={(id) => setFilingMode(id as 'auto' | 'chosen')}
                size="sm"
                dataAttr="data-scan-filing"
                items={[
                  { id: 'auto', label: t.fileAuto },
                  { id: 'chosen', label: t.fileChosen },
                ]}
              />
              {filingMode === 'chosen' ? (
                <ProductPicker
                  value={chosen.id}
                  ariaLabel={t.product}
                  placeholder={t.pickProduct}
                  onChange={(pid, p) => setChosen({ id: pid, name: p ? p.name_en || p.name_ar : '' })}
                />
              ) : (
                <p className="px-1 text-[11.5px] leading-relaxed text-[var(--ap-text-3)]">{t.fileAutoHint}</p>
              )}
            </div>
            <div className="mt-3">
              {step === 'camera' && (
                <Suspense fallback={<div className="py-16 text-center text-[13px] text-[var(--ap-text-3)]">{t.loading}</div>}>
                  <BarcodeScanner
                    mode="continuous"
                    frame="label"
                    embedded
                    title={t.scanTitle}
                    onRead={onRead}
                    onManual={onManualScan}
                    onClose={finish}
                    verdict={verdictCard}
                  >
                    {sessionList}
                  </BarcodeScanner>
                </Suspense>
              )}
            </div>
          </div>
        </div>
      </Overlay>

      {/* ------------------------------------------------ 3. manual entry */}
      <Overlay
        open={step === 'manual'}
        onClose={() => {
          setManualDirty(false);
          finish();
        }}
        placement="dock"
        labelledBy={manualTitleId}
        z={225}
        dirty={manualDirty}
        testId="serial-manual-sheet"
        panelClassName="w-full sm:max-w-xl max-h-[94dvh] flex flex-col overflow-hidden"
      >
        {(api) => (
          <div className={`${T.AP} flex min-h-0 flex-1 flex-col`} dir={dir}>
            {sheetHeader(manualTitleId, t.manualTitle, api.close)}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
              <ManualEntry
                t={t}
                toast={toast}
                onDirty={setManualDirty}
                onSaved={() => {
                  changed.current = true;
                }}
              />
            </div>
          </div>
        )}
      </Overlay>

      <LinkProductDialog t={t} target={linkTarget} onClose={() => setLinkTarget(null)} onLinked={onLinked} />
    </>
  );
}
