/**
 * «إضافة أرقام تسلسلية» — three ways to fill the serial inventory, one filing.
 *
 *  - ONE SERIAL: type it (with its box SN and EAN when at hand) and add.
 *  - A LIST: paste one per line or CSV; «معاينة» asks the server what each
 *    line would do (new, already there, repeated, invalid — and why), and
 *    only then «حفظ» commits. The server re-checks everything on commit; the
 *    preview is advice, never trusted.
 *  - CAMERA: continuous scanning of box labels. Each label adds a row (the
 *    product SN, plus the box SN and EAN when they were in view), beeps and
 *    keeps going; a repeated label buzzes twice and adds nothing. The rows
 *    stay on screen, removable, until «حفظ الكل». The EAN also teaches the
 *    screen which product this is: the first time the owner files an EAN
 *    under a product, every later label with that EAN picks it by itself.
 */
import React, { Suspense, useCallback, useRef, useState } from 'react';
import { Camera, ClipboardList, Hash, Plus, Save, Trash2, X } from 'lucide-react';
import * as T from '../../adminProducts/theme';
import { TabPanels, TabStrip } from '../../ui/Tabs';
import { useToast } from '../../ui/Toast';
import { useConfirm } from '../../ui/ConfirmDialog';
import { serialProblem, normalizeSerial } from '../../../../packages/catalog/src/deviceSerials';
import { primeScannerAudio, type ScanFeedback } from '../../scanner/feedback';
import type { ScanRead } from '../../scanner/BarcodeScanner';
import FilingFields, { EMPTY_FILING, type FilingState } from './FilingFields';
import {
  inventoryApi,
  refusalText,
  type InventoryStrings,
  type PreviewOutcome,
  type PreviewResponse,
  type ScanRowInput,
} from './model';

const BarcodeScanner = React.lazy(() => import('../../scanner/BarcodeScanner'));

type Mode = 'single' | 'bulk' | 'scan';
const MODES: Mode[] = ['single', 'bulk', 'scan'];

/** The 44px icon button of this panel (the .ap recipe is 32px; these are touch targets on a phone). */
export const ICON_BTN_44 =
  'inline-flex items-center justify-center shrink-0 h-11 w-11 rounded-[var(--ap-radius-md)] text-[var(--ap-text-2)] transition-colors hover:text-[var(--ap-text-1)] hover:bg-[var(--ap-surface-2)] active:bg-[var(--ap-surface-3)] disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]';

const TEXTAREA =
  'w-full min-h-[160px] rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--ap-text-1)] placeholder:text-[var(--ap-text-3)] transition-colors hover:border-[var(--ap-border-hover)] focus:outline-none focus:border-[var(--ap-accent)] focus:shadow-[0_0_0_3px_var(--ap-accent-soft)]';

const OUTCOME_TONE: Record<PreviewOutcome | 'checking' | 'error', string> = {
  new: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]',
  new_assigned: 'text-[var(--ap-info)] bg-[var(--ap-info-bg)] border-[var(--ap-info-border)]',
  exists: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  duplicate_in_batch: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  invalid: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  checking: 'text-[var(--ap-text-3)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]',
  error: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
};

interface ScanItem extends ScanRowInput {
  key: string;
  norm: string;
  product_id: string;
  variant_id: string;
  state: PreviewOutcome | 'checking' | 'error';
  problem?: string | null;
}

export default function AddSerialsPanel({
  t,
  onClose,
  onSaved,
}: {
  t: InventoryStrings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [mode, setMode] = useState<Mode>('scan');
  const [filing, setFiling] = useState<FilingState>(EMPTY_FILING);
  const filingRef = useRef(filing);
  filingRef.current = filing;

  // ---- one serial
  const [one, setOne] = useState({ serial: '', box_sn: '', ean: '' });
  const [oneBusy, setOneBusy] = useState(false);
  const [oneError, setOneError] = useState<string | null>(null);

  // ---- list
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewFor, setPreviewFor] = useState('');
  const [bulkBusy, setBulkBusy] = useState<'preview' | 'commit' | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // ---- camera
  const [scanning, setScanning] = useState(false);
  const [items, setItems] = useState<ScanItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [saving, setSaving] = useState(false);
  const eanCache = useRef(new Map<string, Awaited<ReturnType<typeof inventoryApi.resolve>>['match']>());

  const unsaved = items.some((i) => i.state === 'new' || i.state === 'new_assigned' || i.state === 'checking') || (!!text.trim() && mode === 'bulk');

  const close = async () => {
    if (unsaved && !(await confirm({ title: t.unsavedTitle, confirmLabel: t.discard, cancelLabel: t.cancel, destructive: true }))) return;
    onClose();
  };

  // ------------------------------------------------------------ one serial
  const addOne = async (e: React.FormEvent) => {
    e.preventDefault();
    if (oneBusy) return;
    const problem = serialProblem(one.serial);
    if (problem) {
      setOneError(t.problems[problem] ?? t.genericError);
      return;
    }
    setOneBusy(true);
    setOneError(null);
    try {
      const res = await inventoryApi.commitRows([{ ...one, model_code: filing.model_code, model_name: filing.model_name }], filing, 'manual');
      if (res.inserted > 0) {
        toast.success(t.committed(res.inserted));
        setOne({ serial: '', box_sn: '', ean: '' });
        onSaved();
      } else if (res.counts.exists > 0) setOneError(t.outcomes.exists);
      else setOneError(t.refusal.SERIAL_NOTHING_TO_ADD);
    } catch (err) {
      setOneError(refusalText(err, t));
    } finally {
      setOneBusy(false);
    }
  };

  // ------------------------------------------------------------------ list
  const runPreview = async () => {
    if (!text.trim() || bulkBusy) return;
    setBulkBusy('preview');
    setBulkError(null);
    try {
      const res = await inventoryApi.previewText(text, filing);
      setPreview(res);
      setPreviewFor(text);
    } catch (err) {
      setBulkError(refusalText(err, t));
      setPreview(null);
    } finally {
      setBulkBusy(null);
    }
  };

  const commitList = async () => {
    if (!preview || bulkBusy) return;
    setBulkBusy('commit');
    setBulkError(null);
    try {
      const res = await inventoryApi.commitText(previewFor, filing);
      toast.success(res.skipped_concurrent ? t.committedSome(res.inserted, res.skipped_concurrent) : t.committed(res.inserted));
      setText('');
      setPreview(null);
      setPreviewFor('');
      onSaved();
    } catch (err) {
      setBulkError(refusalText(err, t));
    } finally {
      setBulkBusy(null);
    }
  };

  const toAdd = preview ? preview.counts.new + preview.counts.new_assigned : 0;
  const stale = !!preview && previewFor !== text;

  // ---------------------------------------------------------------- camera
  const checkItem = useCallback(async (item: ScanItem) => {
    try {
      const res = await inventoryApi.previewRows([{ serial: item.serial, box_sn: item.box_sn, ean: item.ean }], {
        product_id: item.product_id,
        variant_id: item.variant_id,
        model_code: item.model_code ?? '',
        model_name: item.model_name ?? '',
      });
      const row = res.rows[0];
      setItems((list) =>
        list.map((x) => (x.key === item.key ? { ...x, state: row?.outcome ?? 'error', problem: row?.problem ?? null } : x))
      );
    } catch {
      setItems((list) => list.map((x) => (x.key === item.key ? { ...x, state: 'error' } : x)));
    }
  }, []);

  /** The EAN → product memory: a label whose EAN was filed before picks its product (sticky). */
  const learnFromEan = useCallback(
    async (ean: string) => {
      if (!ean || filingRef.current.product_id) return;
      let match = eanCache.current.get(ean);
      if (match === undefined) {
        try {
          match = (await inventoryApi.resolve(ean)).match;
        } catch {
          match = null;
        }
        eanCache.current.set(ean, match);
      }
      if (!match || filingRef.current.product_id) return;
      const name = match.product.name_en || match.product.name_ar;
      setFiling((f) => ({
        ...f,
        product_id: match.product.id,
        variant_id: match.variant_id ?? '',
        product_name: name,
        serialized: null,
        model_code: f.model_code || match.model_code,
        model_name: f.model_name || match.model_name || name,
      }));
      // The rows already scanned without a product take it too.
      setItems((list) => list.map((x) => (x.product_id ? x : { ...x, product_id: match.product.id, variant_id: match.variant_id ?? '' })));
      toast.info(t.eanMatched(name));
    },
    [t, toast]
  );

  const onRead = useCallback(
    (read: ScanRead): ScanFeedback => {
      const sn = read.productSn;
      if (!sn) return 'invalid';
      const norm = normalizeSerial(sn);
      if (itemsRef.current.some((x) => x.norm === norm)) return 'duplicate';
      const f = filingRef.current;
      const item: ScanItem = {
        key: `${norm}-${Date.now()}`,
        norm,
        serial: sn,
        box_sn: read.boxSn ?? '',
        ean: read.ean ?? '',
        model_code: f.model_code,
        model_name: f.model_name,
        product_id: f.product_id,
        variant_id: f.variant_id,
        state: serialProblem(sn) ? 'invalid' : 'checking',
      };
      itemsRef.current = [item, ...itemsRef.current];
      setItems(itemsRef.current);
      if (item.state === 'invalid') return 'invalid';
      void checkItem(item);
      if (read.ean) void learnFromEan(read.ean);
      return 'added';
    },
    [checkItem, learnFromEan]
  );

  const onManualScan = (value: string) => {
    onRead({ productSn: normalizeSerial(value), boxSn: null, ean: null, receipt: null, raw: [] });
  };

  const saveAll = async () => {
    const ready = items.filter((i) => i.state === 'new' || i.state === 'new_assigned');
    if (!ready.length || saving) return;
    setSaving(true);
    // One commit per product the rows were scanned under: switching the
    // product mid-session must not refile the boxes scanned before.
    const groups = new Map<string, ScanItem[]>();
    for (const i of ready) {
      const k = `${i.product_id}|${i.variant_id}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    let inserted = 0;
    const saved = new Set<string>();
    try {
      for (const group of groups.values()) {
        const { product_id, variant_id } = group[0];
        const res = await inventoryApi.commitRows(
          group.map((i) => ({ serial: i.serial, box_sn: i.box_sn, ean: i.ean, model_code: i.model_code, model_name: i.model_name })),
          { product_id, variant_id, model_code: '', model_name: '' },
          'scan'
        );
        inserted += res.inserted;
        group.forEach((i) => saved.add(i.key));
      }
      toast.success(t.committed(inserted));
      setItems((list) => list.filter((i) => !saved.has(i.key)));
      onSaved();
    } catch (err) {
      // What was saved before the failure is off the list; the rest stays.
      setItems((list) => list.filter((i) => !saved.has(i.key)));
      toast.error(refusalText(err, t));
    } finally {
      setSaving(false);
    }
  };

  const readyCount = items.filter((i) => i.state === 'new' || i.state === 'new_assigned').length;

  const scanList = (
      <div className="space-y-2" data-scan-list>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] font-semibold text-[var(--ap-text-2)]" aria-live="polite">
            {items.length ? t.scanned(items.length) : t.scannedEmpty}
          </span>
          <button type="button" className={`${T.btnPrimary} min-h-[44px]`} disabled={!readyCount || saving} onClick={() => void saveAll()} data-scan-save>
            <Save className="w-4 h-4" aria-hidden />
            {saving ? t.committing : t.commitAll(readyCount)}
          </button>
        </div>
        {items.length > 0 && (
          <ul className={`${T.surface} divide-y divide-[var(--ap-hairline)] max-h-[40vh] overflow-y-auto`}>
            {items.map((i) => (
              <li key={i.key} className="flex items-center gap-2 px-3 py-2 min-h-[52px]" data-scan-item={i.norm}>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[13px] text-[var(--ap-text-1)] truncate" dir="ltr">
                    {i.serial}
                  </div>
                  <div className="text-[11px] text-[var(--ap-text-3)] truncate" dir="ltr">
                    {[i.model_name || i.model_code, i.box_sn && `${t.box} ${i.box_sn}`, i.ean && `EAN ${i.ean}`].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className={`${T.badgeBase} ${OUTCOME_TONE[i.state]}`}>
                  {i.state === 'checking' ? t.checking : i.state === 'error' ? t.genericError : t.outcomes[i.state]}
                </span>
                <button
                  type="button"
                  className={ICON_BTN_44}
                  aria-label={`${t.remove} ${i.serial}`}
                  onClick={() => setItems((list) => list.filter((x) => x.key !== i.key))}
                >
                  <Trash2 className="w-4 h-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
  );

  const tabLabel = (Icon: React.ElementType, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" className="w-4 h-4" />
      {label}
    </span>
  );

  return (
    <section className={`${T.surfaceRaised} overflow-hidden`} aria-labelledby="serial-add-title" data-serial-add>
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <h2 id="serial-add-title" className="text-[15px] font-bold text-[var(--ap-text-1)]">
          {t.dialogTitle}
        </h2>
        <button type="button" className={ICON_BTN_44} onClick={() => void close()} aria-label={t.cancel}>
          <X className="w-5 h-5" aria-hidden />
        </button>
      </div>
      <TabStrip
        items={[
          { id: 'scan', label: tabLabel(Camera, t.modeScan) },
          { id: 'bulk', label: tabLabel(ClipboardList, t.modeBulk) },
          { id: 'single', label: tabLabel(Hash, t.modeSingle) },
        ]}
        value={mode}
        onChange={(id) => setMode(id as Mode)}
        group="serial-add"
        label={t.dialogTitle}
        indicatorClassName="bg-[var(--ap-accent)]"
        activeClassName="text-[var(--ap-text-1)]"
        idleClassName="text-[var(--ap-text-3)] hover:text-[var(--ap-text-2)]"
        className="mt-1 border-b border-[var(--ap-border)]"
      />
      <div className="p-3 sm:p-4 space-y-4">
        <FilingFields t={t} value={filing} onChange={setFiling} disabled={saving || bulkBusy === 'commit'} />
        <TabPanels value={mode} order={MODES}>
          {mode === 'single' && (
            <form onSubmit={addOne} className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end" data-serial-single>
              <label className="block min-w-0">
                <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.serial}</span>
                <input
                  className={`${T.input} w-full font-mono`}
                  dir="ltr"
                  value={one.serial}
                  onChange={(e) => setOne({ ...one, serial: e.target.value })}
                  placeholder={t.serialPh}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  maxLength={80}
                  aria-invalid={!!oneError}
                  aria-describedby={oneError ? 'serial-one-error' : undefined}
                />
              </label>
              <label className="block min-w-0">
                <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">
                  {t.boxSn} <span className="text-[var(--ap-text-3)] font-normal">({t.optional})</span>
                </span>
                <input className={`${T.input} w-full font-mono`} dir="ltr" value={one.box_sn} onChange={(e) => setOne({ ...one, box_sn: e.target.value })} placeholder={t.boxPh} maxLength={60} spellCheck={false} />
              </label>
              <label className="block min-w-0">
                <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">
                  {t.ean} <span className="text-[var(--ap-text-3)] font-normal">({t.optional})</span>
                </span>
                <input className={`${T.input} w-full font-mono`} dir="ltr" inputMode="numeric" value={one.ean} onChange={(e) => setOne({ ...one, ean: e.target.value })} placeholder={t.eanPh} maxLength={14} />
              </label>
              <button type="submit" className={`${T.btnPrimary} h-10 min-h-[44px]`} disabled={oneBusy || !one.serial.trim()}>
                <Plus className="w-4 h-4" aria-hidden />
                {oneBusy ? t.committing : t.addOne}
              </button>
              {oneError && (
                <p id="serial-one-error" role="alert" className="sm:col-span-4 text-[12.5px] text-[var(--ap-danger)]">
                  {oneError}
                </p>
              )}
            </form>
          )}

          {mode === 'bulk' && (
            <div className="space-y-3" data-serial-bulk>
              <label className="block">
                <span className="block mb-1 text-[12.5px] font-semibold text-[var(--ap-text-1)]">{t.pasteLabel}</span>
                <textarea
                  className={`${TEXTAREA} font-mono`}
                  dir="ltr"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t.pastePh}
                  spellCheck={false}
                  aria-describedby="serial-bulk-hint"
                  data-serial-paste
                />
                <span id="serial-bulk-hint" className="block mt-1 text-[11.5px] text-[var(--ap-text-3)]">
                  {t.pasteHint}
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={`${T.btnSecondary} min-h-[44px]`} disabled={!text.trim() || !!bulkBusy} onClick={() => void runPreview()} data-serial-preview>
                  {bulkBusy === 'preview' ? t.previewing : t.previewBtn}
                </button>
                {preview && !stale && (
                  <button type="button" className={`${T.btnPrimary} min-h-[44px]`} disabled={!toAdd || !!bulkBusy} onClick={() => void commitList()} data-serial-commit>
                    <Save className="w-4 h-4" aria-hidden />
                    {bulkBusy === 'commit' ? t.committing : t.commitN(toAdd)}
                  </button>
                )}
              </div>
              {bulkError && (
                <p role="alert" className="text-[12.5px] text-[var(--ap-danger)]">
                  {bulkError}
                </p>
              )}
              {preview && (
                <div className={`space-y-2 ${stale ? 'opacity-50' : ''}`} data-serial-preview-table>
                  <p className="text-[12.5px] text-[var(--ap-text-2)]" role="status">
                    {t.summary(preview.counts)}
                  </p>
                  {preview.product?.serialized === false && (
                    <p className="text-[12px] text-[var(--ap-danger)]">{t.notSerialized}</p>
                  )}
                  <div className={`${T.surface} overflow-auto max-h-[46vh]`}>
                    <table className="w-full border-collapse min-w-[560px]">
                      <thead className={`${T.tableHead} sticky top-0 bg-[var(--ap-surface-2)]`}>
                        <tr>
                          {[t.line, t.serial, t.model, t.outcome].map((h) => (
                            <th key={h} scope="col" className="px-3 py-2 text-start font-semibold text-[11.5px] whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--ap-hairline)]">
                        {preview.rows.map((r) => (
                          <tr key={r.line} data-preview-outcome={r.outcome}>
                            <td className="px-3 py-2 text-[12px] text-[var(--ap-text-3)] tabular-nums">{r.line}</td>
                            <td className="px-3 py-2 font-mono text-[12.5px] text-[var(--ap-text-1)]" dir="ltr">
                              {r.serial_raw || '—'}
                            </td>
                            <td className="px-3 py-2 text-[12px] text-[var(--ap-text-2)]" dir="ltr">
                              {[r.model_name, r.model_code].filter(Boolean).join(' · ') || '—'}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`${T.badgeBase} ${OUTCOME_TONE[r.outcome]}`}>{t.outcomes[r.outcome]}</span>
                              {(r.problem || r.duplicate_of) && (
                                <span className="ms-2 text-[11.5px] text-[var(--ap-text-3)]">
                                  {r.problem ? t.problems[r.problem] ?? r.problem : t.duplicateOf(r.duplicate_of as number)}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'scan' && (
            <div className="space-y-3" data-serial-scan>
              {!scanning && (
                <>
                  <p className="text-[12.5px] leading-relaxed text-[var(--ap-text-2)] max-w-[70ch]">{t.scanIntro}</p>
                  <button
                    type="button"
                    className={`${T.btnPrimary} min-h-[44px] px-5`}
                    onClick={() => {
                      primeScannerAudio();
                      setScanning(true);
                    }}
                    data-scan-start
                  >
                    <Camera className="w-4 h-4" aria-hidden />
                    {t.scanStart}
                  </button>
                </>
              )}
              {scanning && (
                <div className="rounded-[var(--ap-radius-lg)] border border-[var(--ap-border)] bg-zinc-950 overflow-hidden max-w-2xl">
                  <Suspense fallback={<div className="py-16 text-center text-[13px] text-[var(--ap-text-3)]">{t.loading}</div>}>
                    <BarcodeScanner
                      mode="continuous"
                      frame="label"
                      title={t.scanTitle}
                      onRead={onRead}
                      onManual={onManualScan}
                      onClose={() => setScanning(false)}
                    />
                  </Suspense>
                </div>
              )}
              {scanList}
            </div>
          )}
        </TabPanels>
      </div>
      {confirmDialog}
    </section>
  );
}
