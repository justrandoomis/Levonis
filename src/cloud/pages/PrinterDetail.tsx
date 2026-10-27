/**
 * ONE PRINTER MODEL (GET /printers/{id} and /printers/{id}/availability):
 * what it can print — build volume, nozzles, colours and the colour system,
 * materials, enclosure, camera, temperatures — what is free right now, and
 * the hour packages of its class with the server's own prices.
 *
 * Every figure is the server's: a specification the owner did not enter is
 * left out rather than filled in; availability is the scheduler's count; a
 * package's price is integer dinars of record (`<Money>`), and its expiry is
 * stated as the package states it — «never expires» unless the owner set one.
 */
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Money } from '../../components/ui/Money';
import { getPrinter, getPrinterAvailability } from '../api';
import { buildVolumeParts, formatDays, formatHours, formatNozzle } from '../format';
import { common, nav } from '../strings/common';
import { printers as words } from '../strings/printers';
import { tx, useCloudText } from '../text';
import type { PrinterAvailability, PrinterModelDetail } from '../types';
import { CloudErrorState, CloudPageSkeleton, Clock, PageHeader, SectionHeader, StatusPill, modelPillState } from '../ui';
import { useCloudQuery } from '../useCloudQuery';

function Spec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className="min-w-0 text-end text-[13px] font-semibold text-text-primary">{children}</dd>
    </div>
  );
}

function Specs({ model }: { model: PrinterModelDetail }) {
  const { t, lang } = useCloudText();
  const volume = buildVolumeParts(model.build_mm, lang);
  const extruder = { single: words.extruder_single, dual: words.extruder_dual, idex: words.extruder_idex, toolchanger: words.extruder_toolchanger }[
    model.extruder_config as 'single' | 'dual' | 'idex' | 'toolchanger'
  ];
  return (
    <section className="lv-surface p-4" aria-labelledby="cloud-printer-specs">
      <SectionHeader id="cloud-printer-specs" title={t(words.specs)} />
      <dl className="mt-2 divide-y divide-border-subtle">
        <Spec label={t(words.buildVolume)}>
          <bdi dir="ltr">{volume.figure}</bdi> {volume.unit}
        </Spec>
        {model.nozzle_options_um.length ? <Spec label={t(words.nozzles)}>{model.nozzle_options_um.map((um) => formatNozzle(um, lang)).join(' · ')}</Spec> : null}
        {extruder ? <Spec label={t(words.extruder)}>{t(extruder)}</Spec> : null}
        <Spec label={t(words.colours)}>{model.max_colors > 1 ? t(words.upToColours, { n: model.max_colors }) : t(words.oneColour)}</Spec>
        {model.ams_systems.length ? (
          <Spec label={t(words.colourSystem)}>
            <bdi dir="ltr">{model.ams_systems.join(' · ')}</bdi>
          </Spec>
        ) : null}
        {model.supported_materials.length ? (
          <Spec label={t(words.materials)}>
            <bdi dir="ltr">{model.supported_materials.join(' · ')}</bdi>
          </Spec>
        ) : null}
        <Spec label={t(words.enclosure)}>{model.enclosed ? t(words.enclosed) : t(words.openFrame)}</Spec>
        <Spec label={t(words.camera)}>{model.camera ? t(common.yes) : t(common.no)}</Spec>
        {model.max_nozzle_temp_c != null ? (
          <Spec label={t(words.maxNozzleTemp)}>
            <bdi dir="ltr">{model.max_nozzle_temp_c} °C</bdi>
          </Spec>
        ) : null}
        {model.max_bed_temp_c != null ? (
          <Spec label={t(words.maxBedTemp)}>
            <bdi dir="ltr">{model.max_bed_temp_c} °C</bdi>
          </Spec>
        ) : null}
      </dl>
    </section>
  );
}

function Availability({ id, model }: { id: string; model: PrinterModelDetail }) {
  const { t } = useCloudText();
  const avail = useCloudQuery((signal) => getPrinterAvailability(id, { signal }), [id]);
  const counts: Array<[string, (a: PrinterAvailability) => number]> = [
    [t(words.machinesActive), (a) => a.machines_active],
    [t(words.machinesIdle), (a) => a.machines_idle],
    [t(words.machinesOffline), (a) => a.machines_offline],
    [t(words.machinesMaintenance), (a) => a.machines_in_maintenance],
    [t(words.jobsWaiting), (a) => a.jobs_waiting],
  ];
  return (
    <section className="lv-surface p-4" aria-labelledby="cloud-printer-availability">
      <SectionHeader
        id="cloud-printer-availability"
        title={t(words.availability)}
        action={avail.data ? <StatusPill kind="printer" state={modelPillState(avail.data.machines_active, avail.data.machines_idle)} /> : <StatusPill kind="printer" state={modelPillState(model.machines_active, model.machines_idle)} />}
      />
      {avail.error ? (
        <CloudErrorState compact className="mt-3" error={avail.error} onRetry={avail.reload} />
      ) : !avail.data ? (
        <CloudPageSkeleton className="mt-3" />
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {counts.map(([label, of]) => (
              <div key={label} className="rounded-xl lv-well px-3 py-2">
                <dt className="truncate text-[12px] text-text-muted">{label}</dt>
                <dd className="text-ui-lg font-bold tabular-nums text-text-primary">{of(avail.data!)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[12px] leading-relaxed text-text-muted">{t(words.availabilityNote)}</p>
        </>
      )}
    </section>
  );
}

function Packages({ model }: { model: PrinterModelDetail }) {
  const { t, lang } = useCloudText();
  return (
    <section className="lv-surface p-4" aria-labelledby="cloud-printer-packages">
      <SectionHeader id="cloud-printer-packages" title={t(words.packages)} />
      <p className="mt-1 text-[12px] text-text-muted">{t(words.hoursOnlyThisClass)}</p>
      {model.packages.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">{t(words.noPackages)}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {model.packages.map((p) => (
            <li key={p.id} className="flex items-center gap-3 rounded-xl lv-well px-3 py-2">
              <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text-primary">{tx(p.name, lang) || formatHours(p.seconds, lang)}</p>
                <p className="truncate text-[12px] text-text-muted">
                  {formatHours(p.seconds, lang)} · {p.expires_after_days ? t(words.expiresAfter, { days: formatDays(p.expires_after_days, lang) }) : t(words.neverExpires)}
                  {p.bundle.length ? ` · ${t(words.bundleIncluded)}` : ''}
                </p>
              </div>
              <span className="shrink-0 text-sm font-bold text-text-primary">
                <Money iqd={p.price_iqd} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link to={`/store?tab=hours&tier=${encodeURIComponent(model.tier_id)}`} className="lv-button lv-button-primary mt-4 w-full">
        {t(words.buyHoursForClass)}
      </Link>
    </section>
  );
}

export default function PrinterDetail() {
  const { id = '' } = useParams();
  const { t, lang } = useCloudText();
  const printer = useCloudQuery((signal) => getPrinter(id, { signal }), [id]);
  const back = { to: '/printers', label: t(nav.printers) };

  if (printer.error) {
    return (
      <div>
        <PageHeader title={t(words.notFoundTitle)} back={back} />
        <CloudErrorState error={printer.error} onRetry={printer.reload} />
      </div>
    );
  }
  const model = printer.data && printer.data.id === id ? printer.data : null;
  if (!model) return <CloudPageSkeleton />;
  return (
    <div>
      <PageHeader
        back={back}
        title={
          <>
            <span className="block text-[13px] font-medium text-text-muted">{model.brand}</span>
            {model.model_name}
          </>
        }
        subtitle={`${t(words.hoursClass)}: ${tx(model.tier_name, lang) || model.tier_code}`}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-3">
          <Availability id={id} model={model} />
          <Packages model={model} />
        </div>
        <Specs model={model} />
      </div>
    </div>
  );
}
