/**
 * /projects/:id/print — WHAT TO PRINT IT WITH (the prototype's «Print
 * Settings», bottom half of IMG_8439), then «ask the workshop for an
 * estimate».
 *
 *   Material: per model, from the customer's own inventory first (with what
 *   they hold), then the store's filament they do not hold yet — the
 *   projection will say what is short and link to buy it. Saved on the model
 *   as it is chosen (PATCH /projects/{id}/models/{modelId}).
 *   Printer: every model the server compares for this project
 *   (GET /projects/{id}/printer-recommendations) — fit, materials, colours,
 *   machines in service, the hours the customer holds in its class, prints
 *   ahead, and the server's own picks. An incompatible model is shown with
 *   its reasons and cannot be chosen.
 *   Settings: the project's, or a saved profile's, edited here and savable as
 *   a profile. Accessories the workshop's rules suggest: accepted ones go
 *   with the print and are reserved at confirmation.
 *
 * NOTHING HERE IS AN ESTIMATE. «Ask for an estimate» creates the job
 * (POST /jobs) and asks the workshop's slicer to measure it
 * (POST /jobs/{id}/analyze); the job's page then shows «awaiting estimate»
 * until a real one arrives, and what confirming would reserve after that.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Field, Input, Select } from '../../../components/ui/Field';
import { NumberInput } from '../../../components/ui/NumberInput';
import { formatFigure } from '../../../lib/localeNumber';
import { toast } from '../../../lib/toastStore';
import {
  cloudErrorText,
  createJob,
  createProfile,
  decideRecommendation,
  getPrinterRecommendations,
  getProject,
  listAccessorySuggestions,
  listInventory,
  listProfiles,
  listStoreCategories,
  listStoreProducts,
  replaceProfile,
  requestJobAnalysis,
  updateProjectModel,
} from '../../api';
import { useCloud } from '../../CloudContext';
import { formatHours, formatQuantity } from '../../format';
import { service } from '../../strings/common';
import { configure, jobWords, projectWords, settingWords } from '../../strings/print';
import { tx, useCloudText } from '../../text';
import type { AccessorySuggestion, PrintSettings, PrinterRecommendations, ProjectModel, ProjectView } from '../../types';
import { Box, CloudErrorState, CloudPageSkeleton, Disc3, Info, PageHeader, Printer, SectionHeader, ShoppingBag, StatusPill, modelPillState } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { FileStatusPill, Swatch, printerName, usePrinterModels, useVariantNames } from './kit';
import { printerBadges, printerReasonText, shortfallLink } from './model';
import { SettingsFields } from './SettingsForm';

interface MaterialOption {
  id: string;
  label: string;
}

/** The filament a model may be printed in: the customer's own first, then the store's. */
function useMaterialOptions() {
  const { t, lang } = useCloudText();
  const inventory = useCloudQuery((signal) => listInventory(undefined, { signal }), []);
  const catalogue = useCloudQuery(
    (signal) => Promise.all([listStoreCategories({ signal }), listStoreProducts(undefined, { signal })]),
    []
  );
  const ownRows = (inventory.data ?? []).filter((r) => r.category_kind === 'filament');
  const owned: MaterialOption[] = ownRows.map((r) => ({
    id: r.variant_id,
    label: t(configure.yours, { name: [tx(r.name, lang), r.brand].filter(Boolean).join(' · '), qty: formatQuantity(r.available_qty, r.unit_code, lang) }),
  }));
  const ownIds = new Set(ownRows.map((r) => r.variant_id));
  const [categories, products] = catalogue.data ?? [[], []];
  const filament = new Set(categories.filter((c) => c.kind === 'filament').map((c) => c.code));
  const store: MaterialOption[] = products
    .filter((v) => filament.has(v.category_code) && !ownIds.has(v.id))
    .map((v) => ({ id: v.id, label: [tx(v.name, lang), v.brand].filter(Boolean).join(' · ') }));
  return {
    owned,
    store,
    error: inventory.error ?? catalogue.error,
    loading: !inventory.data || !catalogue.data,
    reload: () => {
      inventory.reload();
      catalogue.reload();
    },
  };
}

// ------------------------------------------------------------------ materials

function ModelRow({
  project,
  model,
  options,
  quantity,
  onQuantity,
  onSaved,
}: {
  project: ProjectView;
  model: ProjectModel;
  options: ReturnType<typeof useMaterialOptions>;
  quantity: number;
  onQuantity: (n: number) => void;
  onSaved: () => void;
}) {
  const { t, lang } = useCloudText();
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const assigned = model.material_assignments;
  const current = assigned.length === 1 ? assigned[0].variant_id : '';
  const choose = async (variantId: string) => {
    setProblem(null);
    setSaving(true);
    try {
      const part = assigned.length === 1 ? (assigned[0].part ?? 'default') : 'default';
      await updateProjectModel(project.id, model.id, { material_assignments: variantId ? [{ part, variant_id: variantId }] : [] });
      toast.success(t(configure.materialSaved));
      onSaved();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    } finally {
      setSaving(false);
    }
  };
  const known = new Set([...options.owned, ...options.store].map((o) => o.id));
  return (
    <li className="space-y-2 py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl lv-well text-text-secondary">
          <Box className="h-4 w-4" />
        </span>
        <p className="min-w-0 flex-1 truncate pt-2 text-sm font-semibold text-text-primary">
          <bdi>{model.name}</bdi>
        </p>
        {model.file_status ? <FileStatusPill status={model.file_status} /> : <StatusChip tone="warning">{t(projectWords.noFile)}</StatusChip>}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        {assigned.length > 1 ? (
          <p className="text-[13px] text-text-secondary">{t(configure.multiMaterial, { n: formatFigure(assigned.length, lang) })}</p>
        ) : (
          <Field label={t(jobWords.material)} error={problem}>
            <Select value={current} disabled={saving || options.loading} onChange={(e) => void choose(e.target.value)}>
              <option value="">{t(configure.chooseMaterial)}</option>
              {current && !known.has(current) ? <option value={current}>{current}</option> : null}
              {options.owned.length ? (
                <optgroup label={t(configure.inInventory)}>
                  {options.owned.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {options.store.length ? (
                <optgroup label={t(configure.notOwned)}>
                  {options.store.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          </Field>
        )}
        <Field label={t(projectWords.quantity)}>
          <NumberInput
            kind="quantity"
            value={quantity}
            min={1}
            max={1000}
            onValueChange={(n, valid) => {
              if (valid && n !== null) onQuantity(n);
            }}
          />
        </Field>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ printers

function PrinterChoice({
  recs,
  value,
  onChange,
}: {
  recs: PrinterRecommendations;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const { t, lang } = useCloudText();
  const printers = usePrinterModels();
  // Only the picks the server's figures back (model.ts `printerBadges`): no «lowest cost» without costs to compare.
  const badges = (id: string) => printerBadges(recs, id).map((b) => configure[b]);
  if (recs.models.length === 0) return <p className="text-[13px] text-text-muted">{t(configure.noPrinters)}</p>;
  const sorted = [...recs.models].sort((a, b) => Number(b.compatible) - Number(a.compatible));
  return (
    <div role="radiogroup" aria-label={t(configure.printer)} className="grid gap-2 md:grid-cols-2">
      {sorted.map((m) => {
        const model = printers.byId.get(m.printer_model_id);
        const checked = value === m.printer_model_id;
        const tier = model ? tx(model.tier_name, lang) || model.tier_code : '';
        return (
          <label
            key={m.printer_model_id}
            data-selected={checked || undefined}
            className={`lv-choice flex items-start gap-3 p-3 ${m.compatible ? 'cursor-pointer' : 'opacity-60'}`}
          >
            <input
              type="radio"
              name="print-printer-model"
              value={m.printer_model_id}
              checked={checked}
              disabled={!m.compatible}
              onChange={() => onChange(m.printer_model_id)}
              className="sr-only"
            />
            <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl lv-well text-text-secondary">
              <Printer className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block truncate text-sm font-bold text-text-primary">
                <bdi>{model ? printerName(model) : m.name}</bdi>
              </span>
              {m.compatible ? (
                <span className="block text-[12px] text-text-muted">
                  {[
                    tier ? t(configure.hoursInClass, { amount: formatHours(m.credit.available_seconds, lang), class: tier }) : null,
                    t(configure.jobsAhead, { n: formatFigure(m.jobs_ahead_on_model, lang) }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : (
                <span className="block text-[12px] text-warning">{m.reasons.map((r) => printerReasonText(r, lang)).join(' · ')}</span>
              )}
              <span className="flex flex-wrap gap-1.5">
                {model ? <StatusPill kind="printer" state={modelPillState(model.machines_active, model.machines_idle)} /> : null}
                {m.compatible
                  ? badges(m.printer_model_id).map((b) => (
                      <StatusChip key={b.en} tone="accent" dot={false}>
                        {t(b)}
                      </StatusChip>
                    ))
                  : null}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ accessories

function AccessoryChoices({ items, onDecided }: { items: AccessorySuggestion[]; onDecided: () => void }) {
  const { t, lang } = useCloudText();
  // Each suggestion names its item and counts it in that item's own unit — an accepted one is reserved at confirmation.
  const names = useVariantNames();
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (id: string, status: 'accepted' | 'rejected') => {
    setProblem(null);
    try {
      await decideRecommendation(id, { status });
      onDecided();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };
  return (
    <section aria-labelledby="print-configure-accessories" className="lv-surface space-y-2 p-4">
      <SectionHeader id="print-configure-accessories" title={t(configure.accessories)} link={{ to: '/store?tab=accessories', label: t(configure.buyAccessories) }} />
      <p className="text-[12px] leading-relaxed text-text-muted">{t(configure.accessoriesUsed)}</p>
      {problem ? <p className="lv-field-error">{problem}</p> : null}
      <ul className="divide-y divide-border-subtle">
        {items.map((s) => {
          const accepted = s.status === 'accepted';
          const v = names(s.variant_id);
          const name = v ? tx(v.name, lang) : t(configure.accessoryUnnamed);
          // An item this screen could not look up keeps its bare count — never a guessed unit.
          const qty = (n: number) => (v ? formatQuantity(n, v.unit, lang) : formatFigure(n, lang));
          return (
            <li key={s.recommendation_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 space-y-0.5 text-[13px] text-text-primary">
                <span className="flex min-w-0 items-center gap-2 font-semibold">
                  <Swatch hex={v?.colorHex} />
                  <span className="truncate">{name}</span>
                </span>
                <span className="block">
                  {t(projectWords.suggested, { qty: qty(s.suggested_qty) })} ·{' '}
                  <span className="text-text-muted">{t(projectWords.youHave, { qty: qty(s.owned_qty) })}</span>
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                {accepted ? <StatusChip tone="success">{t(projectWords.accepted)}</StatusChip> : null}
                {s.status === 'rejected' ? <StatusChip>{t(projectWords.dismissed)}</StatusChip> : null}
                {!accepted ? (
                  <Button size="sm" variant="secondary" aria-label={`${t(projectWords.accept)}: ${name}`} onClick={() => decide(s.recommendation_id, 'accepted')}>
                    {t(projectWords.accept)}
                  </Button>
                ) : null}
                {s.status !== 'rejected' ? (
                  <Button size="sm" variant="ghost" aria-label={`${t(projectWords.dismiss)}: ${name}`} onClick={() => decide(s.recommendation_id, 'rejected')}>
                    {t(projectWords.dismiss)}
                  </Button>
                ) : null}
                {accepted && s.shortfall_qty > 0 ? (
                  <Link
                    to={shortfallLink({ kind: 'accessory', code: 'INSUFFICIENT_INVENTORY', id: s.variant_id, amount: s.shortfall_qty })}
                    className="lv-button lv-button-ghost lv-button-sm"
                  >
                    {t(configure.buyAccessories)}
                  </Link>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ the page

export default function Configure() {
  const { t, lang } = useCloudText();
  const navigate = useNavigate();
  const cloud = useCloud();
  const { id = '' } = useParams();
  const project = useCloudQuery((signal) => getProject(id, { signal }), [id]);
  const recs = useCloudQuery((signal) => getPrinterRecommendations(id, undefined, { signal }), [id]);
  const profiles = useCloudQuery((signal) => listProfiles({ signal }), []);
  const suggestions = useCloudQuery((signal) => listAccessorySuggestions(id, { signal }), [id]);
  const printers = usePrinterModels();
  const options = useMaterialOptions();

  const [printerId, setPrinterId] = useState<string | null>(null);
  const [plateId, setPlateId] = useState('');
  const [settings, setSettings] = useState<PrintSettings | null>(null);
  const [profileId, setProfileId] = useState('');
  const [copies, setCopies] = useState(1);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [profileName, setProfileName] = useState('');
  const [profileProblem, setProfileProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  // The form starts from what the server holds for the project, once.
  useEffect(() => {
    if (project.data && settings === null) setSettings(project.data.settings);
  }, [project.data, settings]);

  // One compatible printer is the only choice; with more, the customer chooses.
  useEffect(() => {
    if (printerId || !recs.data) return;
    const compatible = recs.data.models.filter((m) => m.compatible);
    if (compatible.length === 1) setPrinterId(compatible[0].printer_model_id);
  }, [recs.data, printerId]);

  if (project.error && !project.data) return <CloudErrorState error={project.error} onRetry={project.reload} />;
  const p = project.data;
  if (!p || !settings) return <CloudPageSkeleton />;

  const chosen = recs.data?.models.find((m) => m.printer_model_id === printerId && m.compatible) ?? null;
  const plates = p.plates.filter((pl) => pl.printer_model_id === printerId && pl.valid);
  const nozzles = (printerId && printers.byId.get(printerId)?.nozzle_options_um) || [];
  const needMaterial = p.models.some((m) => m.material_assignments.length === 0);
  const filesPending = p.models.some((m) => m.file_status !== 'ready');
  const accepted = (suggestions.data ?? []).filter((s) => s.status === 'accepted');
  const qtyOf = (m: ProjectModel) => quantities[m.id] ?? m.quantity;
  const reloadModels = () => {
    project.reload();
    recs.reload();
    suggestions.reload();
  };

  const applyProfile = (pid: string) => {
    setProfileId(pid);
    const prof = (profiles.data ?? []).find((x) => x.id === pid);
    setSettings(prof ? { ...p.settings, ...prof.settings } : p.settings);
  };
  const saveProfile = async () => {
    setProfileProblem(null);
    try {
      const current = (profiles.data ?? []).find((x) => x.id === profileId);
      if (current) await replaceProfile(current.id, { name: current.name, settings });
      else {
        const made = await createProfile({ name: profileName.trim(), settings });
        setProfileId(made.profile_id);
        setProfileName('');
      }
      toast.success(t(settingWords.profileSaved));
      profiles.reload();
    } catch (e) {
      setProfileProblem(cloudErrorText(e, lang));
    }
  };

  const submit = async () => {
    setProblem(null);
    if (!chosen) return;
    try {
      // Quantities typed but not yet saved go to their models first: the slicer measures the models as they are.
      for (const m of p.models) {
        const q = qtyOf(m);
        if (q !== m.quantity) await updateProjectModel(p.id, m.id, { quantity: q });
      }
      const created = await createJob({
        project_id: p.id,
        printer_model_id: chosen.printer_model_id,
        ...(plateId ? { plate_id: plateId } : {}),
        settings: plateId ? { ...settings, orientation: 'as_uploaded' } : settings,
        copies,
        ...(accepted.length ? { accessories: accepted.map((s) => ({ variant_id: s.variant_id, qty: s.suggested_qty })) } : {}),
      });
      let analyzeError: string | null = null;
      if (created.status === 'uploaded') {
        try {
          await requestJobAnalysis(created.job_id);
        } catch (e) {
          analyzeError = cloudErrorText(e, lang);
        }
      }
      cloud.refreshDashboard();
      navigate(`/jobs/${encodeURIComponent(created.job_id)}`, { state: analyzeError ? { analyzeError } : null });
    } catch (e) {
      setProblem(e);
    }
  };

  const slicer = cloud.status?.slicer;

  return (
    <div className="space-y-4">
      <PageHeader back={{ to: `/projects/${encodeURIComponent(p.id)}`, label: p.name }} title={t(configure.title)} subtitle={t(configure.subtitle)} />

      <section aria-labelledby="print-configure-materials" className="lv-surface p-4">
        <SectionHeader
          id="print-configure-materials"
          title={t(configure.materials)}
          link={{ to: '/store?tab=materials', label: t(configure.buyMaterial) }}
        />
        {options.error ? <CloudErrorState compact className="mt-2" error={options.error} onRetry={options.reload} /> : null}
        {!options.loading && options.owned.length === 0 && options.store.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-muted">{t(configure.noMaterials)}</p>
        ) : null}
        <ul className="divide-y divide-border-subtle">
          {p.models.map((m) => (
            <ModelRow
              key={m.id}
              project={p}
              model={m}
              options={options}
              quantity={qtyOf(m)}
              onQuantity={(n) => setQuantities((q) => ({ ...q, [m.id]: n }))}
              onSaved={reloadModels}
            />
          ))}
        </ul>
        {p.models.length === 0 ? <p className="text-[13px] text-text-muted">{t(projectWords.noModels)}</p> : null}
      </section>

      <section aria-labelledby="print-configure-printer" className="lv-surface space-y-3 p-4">
        <SectionHeader id="print-configure-printer" title={t(configure.printer)} />
        <p className="text-[12px] leading-relaxed text-text-muted">{t(configure.printerNote)}</p>
        {recs.error && !recs.data ? (
          <CloudErrorState compact error={recs.error} onRetry={recs.reload} />
        ) : !recs.data ? (
          <CloudPageSkeleton />
        ) : (
          <>
            <PrinterChoice recs={recs.data} value={printerId} onChange={setPrinterId} />
            {recs.data.models.length > 0 && !recs.data.models.some((m) => m.compatible) ? (
              <p className="lv-alert lv-alert-warning text-[13px] text-text-primary">{t(configure.noCompatible)}</p>
            ) : null}
          </>
        )}
        {plates.length ? (
          <Field label={t(settingWords.plate)}>
            <Select value={plateId} onChange={(e) => setPlateId(e.target.value)}>
              <option value="">{t(settingWords.noPlate)}</option>
              {plates.map((pl, i) => (
                <option key={pl.id} value={pl.id}>
                  {pl.label || `${t(settingWords.plate)} ${i + 1}`}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </section>

      <section aria-labelledby="print-configure-settings" className="lv-surface space-y-4 p-4">
        <SectionHeader id="print-configure-settings" title={t(settingWords.title)} />
        {profiles.data && profiles.data.length ? (
          <Field label={t(settingWords.profile)}>
            <Select value={profileId} onChange={(e) => applyProfile(e.target.value)}>
              <option value="">{t(settingWords.profileNone)}</option>
              {profiles.data.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <SettingsFields
          group="print-configure"
          value={settings}
          onChange={setSettings}
          nozzles={nozzles}
          plateChosen={!!plateId}
          copies={{ value: copies, onChange: setCopies }}
        />
        <div className="space-y-2 border-t border-border-subtle pt-3">
          {profileId ? (
            <Button size="sm" variant="secondary" onClick={saveProfile}>
              {t(settingWords.updateProfile, { name: (profiles.data ?? []).find((x) => x.id === profileId)?.name ?? '' })}
            </Button>
          ) : (
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void saveProfile();
              }}
            >
              <Field label={t(settingWords.profileName)} className="flex-1" error={profileProblem}>
                <Input value={profileName} maxLength={80} onChange={(e) => setProfileName(e.target.value)} />
              </Field>
              <Button type="submit" size="sm" variant="secondary" disabled={!profileName.trim()}>
                {t(settingWords.saveProfile)}
              </Button>
            </form>
          )}
          {profileId && profileProblem ? <p className="lv-field-error">{profileProblem}</p> : null}
        </div>
      </section>

      {suggestions.data && suggestions.data.length ? <AccessoryChoices items={suggestions.data} onDecided={suggestions.reload} /> : null}

      <section aria-labelledby="print-configure-go" className="lv-surface space-y-3 p-4">
        <h2 id="print-configure-go" className="sr-only">
          {t(configure.getEstimate)}
        </h2>
        <p className="flex items-start gap-2 text-[13px] leading-relaxed text-text-secondary">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {t(configure.getEstimateHint)}
        </p>
        {slicer && slicer !== 'connected' ? (
          <p className="text-[12px] leading-relaxed text-text-muted">{slicer === 'stale' ? t(service.slicerStale) : t(service.slicerOff)}</p>
        ) : null}
        {needMaterial ? <p className="text-[13px] text-warning">{t(configure.needMaterial)}</p> : null}
        {!chosen ? <p className="text-[13px] text-warning">{t(configure.needPrinter)}</p> : null}
        {filesPending ? <p className="text-[13px] text-text-muted">{t(configure.filesPending)}</p> : null}
        {problem ? <CloudErrorState compact error={problem} /> : null}
        <Button
          variant="primary"
          block
          icon={<Disc3 aria-hidden="true" className="h-4 w-4" />}
          disabled={!chosen || needMaterial || p.models.length === 0}
          onClick={submit}
        >
          {t(configure.getEstimate)}
        </Button>
        <p className="text-center text-[12px] text-text-muted">
          <Link to="/store?tab=hours" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-text-secondary">
            <ShoppingBag aria-hidden="true" className="h-3.5 w-3.5" />
            {t(jobWords.buyHoursPlain)}
          </Link>
        </p>
      </section>
    </div>
  );
}
