/**
 * THE WORKSHOP'S PRINTERS (GET /printers) — every active printer model, its
 * hours class, what it can print, and how many of its machines the
 * scheduler would give work to right now. Real counts only: a model with no
 * machine in service says so, and «free now» is the scheduler's own test,
 * never a guess at «online».
 */
import { Link } from 'react-router-dom';
import { listPrinters } from '../api';
import { buildVolumeParts } from '../format';
import { nav } from '../strings/common';
import { printers as words } from '../strings/printers';
import { tx, useCloudText } from '../text';
import type { PrinterModel } from '../types';
import { Camera, CloudEmptyState, CloudErrorState, CloudPageSkeleton, Layers, PageHeader, Palette, Printer, Ruler, StatusPill, forwardChevron, modelPillState } from '../ui';
import { useCloudQuery } from '../useCloudQuery';

function PrinterCard({ model }: { model: PrinterModel }) {
  const { t, lang, dir } = useCloudText();
  const Forward = forwardChevron(dir);
  const volume = buildVolumeParts(model.build_mm, lang);
  return (
    <Link
      to={`/printers/${encodeURIComponent(model.id)}`}
      className="lv-surface flex min-w-0 flex-col gap-3 p-4 no-press transition-colors hover:bg-surface-raised hover:shadow-lg active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-text-muted">{model.brand}</p>
          <h2 className="truncate text-[17px] font-bold text-text-primary">{model.model_name}</h2>
          <p className="mt-0.5 truncate text-[12px] text-text-secondary">
            {t(words.hoursClass)}: {tx(model.tier_name, lang) || model.tier_code}
          </p>
        </div>
        <Forward aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-text-muted" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill kind="printer" state={modelPillState(model.machines_active, model.machines_idle)} />
        {model.machines_active > 0 ? (
          <span className="text-[12px] tabular-nums text-text-muted">{t(words.freeOfActive, { idle: model.machines_idle, active: model.machines_active })}</span>
        ) : null}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] text-text-secondary">
        <li className="flex min-w-0 items-center gap-1.5">
          <Ruler aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <span className="sr-only">{t(words.buildVolume)}: </span>
          <span className="truncate">
            <bdi dir="ltr">{volume.figure}</bdi> {volume.unit}
          </span>
        </li>
        <li className="flex min-w-0 items-center gap-1.5">
          <Palette aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <span className="truncate">{model.max_colors > 1 ? t(words.upToColours, { n: model.max_colors }) : t(words.oneColour)}</span>
        </li>
        {model.supported_materials.length ? (
          <li className="col-span-2 flex min-w-0 items-center gap-1.5">
            <Layers aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className="sr-only">{t(words.materials)}: </span>
            <bdi dir="ltr" className="truncate">
              {model.supported_materials.join(' · ')}
            </bdi>
          </li>
        ) : null}
        <li className="flex min-w-0 items-center gap-1.5">
          <Printer aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <span className="truncate">{model.enclosed ? t(words.enclosed) : t(words.openFrame)}</span>
        </li>
        {model.camera ? (
          <li className="flex min-w-0 items-center gap-1.5">
            <Camera aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className="truncate">{t(words.camera)}</span>
          </li>
        ) : null}
      </ul>
    </Link>
  );
}

export default function Printers() {
  const { t } = useCloudText();
  const list = useCloudQuery((signal) => listPrinters({ signal }), []);
  return (
    <div>
      <PageHeader title={t(words.title)} subtitle={t(words.subtitle)} back={{ to: '/', label: t(nav.home) }} />
      {list.error ? (
        <CloudErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <CloudPageSkeleton />
      ) : list.data.length === 0 ? (
        <CloudEmptyState icon={<Printer className="h-6 w-6" />} title={t(words.emptyTitle)} body={t(words.emptyBody)} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.data.map((model) => (
              <PrinterCard key={model.id} model={model} />
            ))}
          </div>
          <p className="mt-4 text-[12px] leading-relaxed text-text-muted">{t(words.availabilityNote)}</p>
        </>
      )}
    </div>
  );
}
