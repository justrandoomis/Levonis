/**
 * «استلام الجهاز» — THE DEVICE REACHES THE SHOP (owner decision 2, spec §6.5). Any admin, an
 * assistant too (no money moves here), never on their own request. The desk scans (or types) the
 * serial off the label, reads the hours off the screen, records the condition as it sees it, the
 * findings and the intake photographs, and how the device came in. The server matches the serial
 * against the unit sold, flags hours above what was declared and works out the ceiling — none of
 * it is decided here.
 *
 * A serial that does not match is the owner's: the server refuses the desk
 * (TRADE_IN_SERIAL_MISMATCH) and the owner may receive it with a recorded reason.
 */
import React, { Suspense, useRef, useState } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api, ApiError } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { Overlay } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { checklistOf, familyCountsHours, type TradeInFamily } from '../../../packages/pricing/src/tradeIn';
import { uploadTradeInPhoto } from '../tradeIn/photoUpload';
import { labelOf, type PhotoView } from '../tradeIn/model';
import type { ScanRead } from '../scanner/BarcodeScanner';
import { useA } from './useA';
import type { AdminRequestView } from './types';
import type { AdminKey } from './copy';

// The camera and its reader are their own lazy chunks: a desk that types the serial downloads neither.
const BarcodeScanner = React.lazy(() => import('../scanner/BarcodeScanner'));

type Overall = 'excellent' | 'good' | 'care';
const PRESET: Record<Overall, 5 | 4 | 2> = { excellent: 5, good: 4, care: 2 };
interface PartInput {
  overall: Overall | null;
  faults: string[];
  original_accessories: 'all' | 'partial' | 'none';
}

function initialPart(inputs: Record<string, unknown> | undefined): PartInput {
  const i = (inputs ?? {}) as { cleanliness?: number; exterior?: number; scratches?: number; faults?: string[]; original_accessories?: PartInput['original_accessories'] };
  const overall = (['excellent', 'good', 'care'] as const).find((o) => i.cleanliness === PRESET[o] && i.exterior === PRESET[o] && i.scratches === PRESET[o]) ?? null;
  return { overall, faults: Array.isArray(i.faults) ? i.faults : [], original_accessories: i.original_accessories ?? 'all' };
}

export default function IntakeSheet({ req, ownerScope, onDone }: { req: AdminRequestView; ownerScope: boolean; onDone: (r: AdminRequestView) => void }) {
  const { a, loc, lang } = useA();
  const scanButton = useRef<HTMLButtonElement>(null);
  const [serial, setSerial] = useState('');
  const [hours, setHours] = useState('');
  const [findings, setFindings] = useState('');
  const [handover, setHandover] = useState<'store' | 'pickup'>(req.handover ?? 'store');
  const [parts, setParts] = useState<Record<string, PartInput>>(() => Object.fromEntries(req.components.map((c) => [c.role, initialPart(c.inputs as Record<string, unknown>)])));
  const [photos, setPhotos] = useState<Array<PhotoView & { proves?: string }>>(req.intake_photos ?? []);
  const [uploading, setUploading] = useState(0);
  const [scanner, setScanner] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const countsHours = req.components.some((c) => c.role === 'device' && familyCountsHours(c.family));
  const amsOnly = req.scope === 'ams_only';

  const faultsOf = (family: TradeInFamily) => {
    const q = req.questions?.[family]?.faults;
    if (q) return q;
    const rules = (req as unknown as { rules?: Partial<Record<TradeInFamily, Parameters<typeof checklistOf>[0]>> }).rules?.[family];
    return rules ? checklistOf(rules, 'faults') : [];
  };

  const upload = async (file: File) => {
    setUploading((n) => n + 1);
    setError('');
    try {
      const p = await uploadTradeInPhoto(
        `/api/admin/trade-in/requests/${encodeURIComponent(req.id)}/photos`,
        file,
        { component: req.components[0]?.role ?? 'device' },
        () => undefined
      );
      setPhotos((cur) => [...cur, p]);
    } catch (e) {
      setError(apiRefusal(e, refusalLang(lang), a('failed')));
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const components: Record<string, Record<string, unknown>> = {};
      for (const c of req.components) {
        const p = parts[c.role];
        if (!p) continue;
        components[c.role] = {
          ...(p.overall ? { cleanliness: PRESET[p.overall], exterior: PRESET[p.overall], scratches: PRESET[p.overall] } : {}),
          faults: p.faults,
          original_accessories: p.original_accessories,
        };
      }
      const d = await api.post<{ request: AdminRequestView }>(`/api/admin/trade-in/requests/${encodeURIComponent(req.id)}/intake`, {
        serial: serial.trim(),
        hours: countsHours && hours.trim() !== '' ? Number(hours) : null,
        components,
        findings: findings.trim(),
        handover,
        ...(mismatch && ownerScope && overrideReason.trim() ? { serial_override_reason: overrideReason.trim() } : {}),
      });
      onDone(d.request);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TRADE_IN_SERIAL_MISMATCH') setMismatch(true);
      setError(apiRefusal(e, refusalLang(lang), a('failed')));
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (read: ScanRead) => {
    setScanner(false);
    const text = read.productSn ?? read.boxSn ?? '';
    if (text) setSerial(text);
  };

  return (
    <section className={`${T.surface} space-y-4 p-4`} data-intake-sheet aria-labelledby="ti-intake-title">
      <h3 id="ti-intake-title" className="text-[15px] font-bold">
        {a('intake')}
      </h3>

      {!amsOnly ? (
        <div>
          <label htmlFor="ti-serial" className={`mb-1 block text-[12px] ${T.text3}`}>
            {a('intake.serial')}
          </label>
          <div className="flex gap-2">
            <input
              id="ti-serial"
              className={`${T.input} min-w-0 flex-1 font-mono`}
              dir="ltr"
              autoComplete="off"
              autoCapitalize="characters"
              value={serial}
              onChange={(e) => {
                setSerial(e.target.value);
                setMismatch(false);
              }}
              data-intake-serial
            />
            <button ref={scanButton} type="button" className={`${T.btnSecondary} min-h-[40px]`} onClick={() => setScanner(true)} data-intake-scan>
              <ScanLine className="h-4 w-4" aria-hidden />
              {a('intake.scan')}
            </button>
          </div>
        </div>
      ) : null}

      {countsHours ? (
        <label className="block">
          <span className={`mb-1 block text-[12px] ${T.text3}`}>{a('intake.hours')}</span>
          <input
            className={`${T.input} w-40 tabular-nums`}
            dir="ltr"
            inputMode="numeric"
            value={hours}
            onChange={(e) => setHours(e.target.value.replace(/[^0-9]/g, ''))}
            data-intake-hours
          />
        </label>
      ) : null}

      {req.components.map((c) => {
        const p = parts[c.role] ?? initialPart(undefined);
        const set = (patch: Partial<PartInput>) => setParts((cur) => ({ ...cur, [c.role]: { ...p, ...patch } }));
        const faults = faultsOf(c.family);
        return (
          <div key={c.role} className="space-y-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-3" data-intake-part={c.role}>
            {req.components.length > 1 ? <p className="text-[13px] font-bold">{a(c.role === 'ams' ? 'part.ams' : 'part.device')}</p> : null}
            <p className={`text-[12px] ${T.text3}`}>{a('intake.condition')}</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={a('intake.condition')}>
              {(['excellent', 'good', 'care'] as const).map((o) => (
                <button key={o} type="button" aria-pressed={p.overall === o} className={T.chip} onClick={() => set({ overall: o })} data-intake-overall={o}>
                  {a(`cond.${o}` as AdminKey)}
                </button>
              ))}
            </div>
            {faults.length ? (
              <>
                <p className={`text-[12px] ${T.text3}`}>{a('intake.faults')}</p>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" aria-pressed={p.faults.length === 0} className={T.chip} onClick={() => set({ faults: [] })}>
                    {a('intake.noFaults')}
                  </button>
                  {faults.map((f) => {
                    const on = p.faults.includes(f.id);
                    return (
                      <button
                        key={f.id}
                        type="button"
                        aria-pressed={on}
                        className={T.chip}
                        onClick={() => set({ faults: on ? p.faults.filter((x) => x !== f.id) : [...p.faults, f.id] })}
                        data-intake-fault={f.id}
                      >
                        {labelOf(f, loc)}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
            <p className={`text-[12px] ${T.text3}`}>{a('intake.accessories')}</p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['all', 'acc.all'],
                  ['partial', 'acc.some'],
                  ['none', 'acc.none'],
                ] as const
              ).map(([id, key]) => (
                <button key={id} type="button" aria-pressed={p.original_accessories === id} className={T.chip} onClick={() => set({ original_accessories: id })}>
                  {a(key)}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <label className="block">
        <span className={`mb-1 block text-[12px] ${T.text3}`}>{a('intake.findings')}</span>
        <textarea
          className="lv-input resize-y px-3 py-2 text-[13px]"
          rows={3}
          maxLength={1000}
          value={findings}
          onChange={(e) => setFindings(e.target.value)}
          data-intake-findings
        />
      </label>

      <div>
        <p className={`mb-1 text-[12px] ${T.text3}`}>{a('intake.photos')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {photos.map((p) => (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block h-14 w-14 overflow-hidden rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)]">
              <img src={p.url} alt={a('intake.photos')} className="h-full w-full object-cover" loading="lazy" />
            </a>
          ))}
          {uploading > 0 ? <Spinner size="sm" /> : null}
          <label className={`${T.btnSecondary} cursor-pointer focus-within:ring-2 focus-within:ring-focus`}>
            <Camera className="h-4 w-4" aria-hidden />
            {a('intake.addPhoto')}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void upload(f);
              }}
              data-intake-photo
            />
          </label>
        </div>
      </div>

      <div>
        <p className={`mb-1 text-[12px] ${T.text3}`}>{a('f.handover')}</p>
        <div className="flex flex-wrap gap-1.5">
          {(['store', 'pickup'] as const).map((h) => (
            <button key={h} type="button" aria-pressed={handover === h} className={T.chip} onClick={() => setHandover(h)} data-intake-handover={h}>
              {a(`handover.${h}` as AdminKey)}
            </button>
          ))}
        </div>
      </div>

      {mismatch ? (
        ownerScope ? (
          <label className="block" data-intake-override>
            <span className={`mb-1 block text-[12px] ${T.text3}`}>{a('intake.overrideReason')}</span>
            <input className={`${T.input} w-full`} maxLength={500} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
          </label>
        ) : (
          <p className="text-[12.5px] text-[var(--ap-warning)]">{a('intake.mismatchOwner')}</p>
        )
      ) : null}

      {error ? (
        <p className="text-[13px] text-[var(--ap-danger)]" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className={`${T.btnPrimary} min-h-[44px] w-full`}
        disabled={busy || uploading > 0 || (!amsOnly && !serial.trim()) || (mismatch && ownerScope && overrideReason.trim().length < 5)}
        onClick={submit}
        data-intake-submit
      >
        {a('intake.submit')}
      </button>

      <Overlay
        open={scanner}
        onClose={() => setScanner(false)}
        labelledBy="ti-scanner-title"
        anchor={scanButton}
        solid
        z={210}
        panelClassName="w-full max-w-md bg-surface-raised border border-border-subtle overflow-hidden"
      >
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-16">
              <Spinner size="md" delayMs={150} decorative />
            </div>
          }
        >
          <BarcodeScanner
            mode="single"
            frame="strip"
            titleId="ti-scanner-title"
            title={a('intake.scan')}
            onRead={onScanned}
            onManual={(text) => onScanned({ productSn: text } as ScanRead)}
            onClose={() => setScanner(false)}
          />
        </Suspense>
      </Overlay>
    </section>
  );
}
