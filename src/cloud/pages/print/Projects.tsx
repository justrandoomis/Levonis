/**
 * PROJECTS (GET/PATCH /projects/{id}, /projects/{id}/duplicate, /models,
 * /plates, /accessory-suggestions, POST /recommendations/{id}).
 *
 *   /projects       the customer's projects, active or archived;
 *   /projects/:id   one project: its models (each file's real status), its
 *                   build plates (arranged by the server's named arranger,
 *                   valid or not and why), the accessories the workshop's
 *                   rules suggest (accept or dismiss each), its prints — and
 *                   the ways on: print it, duplicate it to print again
 *                   without uploading again, rename, archive.
 *
 * Every figure and every verdict is the server's: a plate is «valid» because
 * the server checked it, an accessory is suggested because a rule matched a
 * word the server names.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button, IconButton } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Field, Input, Select } from '../../../components/ui/Field';
import { Segmented } from '../../../components/ui/Segmented';
import { formatFigure } from '../../../lib/localeNumber';
import { toast } from '../../../lib/toastStore';
import {
  addProjectModel,
  cloudErrorText,
  createPlate,
  decideRecommendation,
  duplicateProject,
  getProject,
  listAccessorySuggestions,
  listFiles,
  listProjects,
  updateProject,
  updateProjectModel,
} from '../../api';
import { buildVolumeParts, formatQuantity, formatRelative } from '../../format';
import { common, nav } from '../../strings/common';
import { configure, library, print, projectType, projectWords } from '../../strings/print';
import { tx, useCloudText } from '../../text';
import type { AccessorySuggestion, Plate, ProjectModel, ProjectView } from '../../types';
import {
  Archive,
  Undo2,
  Box,
  CloudEmptyState,
  CloudErrorState,
  CloudPageSkeleton,
  Copy,
  Boxes,
  History,
  Layers,
  ListRow,
  PageHeader,
  Pencil,
  Printer,
  SectionHeader,
  StatusPill,
  jobPillState,
} from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { FileStatusPill, ImportStatusPill, MoreRow, Swatch, printerName, usePrinterModels, useShown, useVariantNames } from './kit';
import { plateIssueText, shortfallLink } from './model';

const SERVER_CAP = 200;

function typeText(type: string, lang: 'ar' | 'en' | 'ckb'): string {
  return type in projectType ? tx(projectType[type as keyof typeof projectType], lang) : type;
}

// ------------------------------------------------------------------ /projects

function ProjectsList() {
  const { t, lang } = useCloudText();
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const q = useCloudQuery((signal) => listProjects({ signal }), []);
  const rows = (q.data ?? []).filter((p) => p.status === status);
  const { shown, hasMore, more } = useShown(rows);
  return (
    <div className="space-y-4">
      <PageHeader title={t(print.projects)} subtitle={t(projectWords.subtitle)} back={{ to: '/print', label: t(nav.print) }} />
      <Segmented
        group="print-projects"
        label={t(projectWords.statusLabel)}
        value={status}
        onChange={(id) => setStatus(id as 'active' | 'archived')}
        items={[
          { id: 'active', label: t(projectWords.active) },
          { id: 'archived', label: t(projectWords.archived) },
        ]}
      />
      {q.error && !q.data ? (
        <CloudErrorState error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <CloudPageSkeleton />
      ) : rows.length === 0 ? (
        <CloudEmptyState
          icon={<Boxes className="h-6 w-6" />}
          title={t(projectWords.none)}
          body={t(projectWords.noneBody)}
          action={
            <Link to="/print" className="lv-button lv-button-primary">
              {t(library.uploadModel)}
            </Link>
          }
        />
      ) : (
        <div className="space-y-2">
          <ul className="space-y-2">
            {shown.map((p) => (
              <li key={p.id}>
                <ListRow
                  to={`/projects/${encodeURIComponent(p.id)}`}
                  leading={<Boxes className="h-4 w-4" />}
                  title={<bdi>{p.name}</bdi>}
                  meta={`${typeText(p.project_type, lang)} · ${t(print.updated, { when: formatRelative(p.updated_at, lang) })}`}
                />
              </li>
            ))}
          </ul>
          <MoreRow hasMore={hasMore} onMore={more} total={q.data.length} cap={SERVER_CAP} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ /projects/:id

function modelSize(m: ProjectModel, lang: 'ar' | 'en' | 'ckb'): string | null {
  if (m.size_x_um == null || m.size_y_um == null || m.size_z_um == null) return null;
  const mm = (um: number) => Math.round(um / 100) / 10;
  const v = buildVolumeParts({ x: mm(m.size_x_um), y: mm(m.size_y_um), z: mm(m.size_z_um) }, lang);
  return `${v.figure} ${v.unit}`;
}

/** A model's name, renamable in place (PATCH /projects/{id}/models/{modelId}: the name is not frozen by a print). */
function ModelName({ project, model, onChanged }: { project: ProjectView; model: ProjectModel; onChanged: () => void }) {
  const { t, lang } = useCloudText();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(model.name);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setProblem(null);
    try {
      await updateProjectModel(project.id, model.id, { name: name.trim() });
      setEditing(false);
      toast.success(t(projectWords.renamed));
      onChanged();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };
  if (editing) {
    return (
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t(projectWords.modelName)} error={problem} className="flex-1">
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>
          {t(print.save)}
        </Button>
      </form>
    );
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-sm font-semibold text-text-primary">
      {model.file_id ? (
        <Link to={`/library/${encodeURIComponent(model.file_id)}`} className="min-w-0 truncate hover:underline">
          <bdi>{model.name}</bdi>
        </Link>
      ) : (
        <bdi className="min-w-0 truncate">{model.name}</bdi>
      )}
      <IconButton
        label={t(projectWords.rename)}
        icon={<Pencil className="h-4 w-4" />}
        onClick={() => {
          setName(model.name);
          setEditing(true);
        }}
      />
    </p>
  );
}

function Models({ project, onChanged }: { project: ProjectView; onChanged: () => void }) {
  const { t, lang } = useCloudText();
  const names = useVariantNames();
  const files = useCloudQuery((signal) => listFiles({ signal }), []);
  const [pick, setPick] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const inProject = new Set(project.models.map((m) => m.file_id));
  const ready = (files.data ?? []).filter((f) => f.status === 'ready' && !inProject.has(f.id));

  const add = async () => {
    if (!pick) return;
    setProblem(null);
    try {
      await addProjectModel(project.id, { file_id: pick, quantity: 1 });
      setPick('');
      toast.success(t(projectWords.added));
      onChanged();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };

  return (
    <section aria-labelledby="print-project-models" className="lv-surface space-y-3 p-4">
      <SectionHeader id="print-project-models" title={t(projectWords.models)} count={project.models.length} />
      {project.models.length === 0 ? (
        <p className="text-[13px] text-text-muted">{t(projectWords.noModels)}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {project.models.map((m) => {
            const size = modelSize(m, lang);
            const materials = m.material_assignments.map((a) => names(a.variant_id));
            return (
              <li key={m.id} className="flex items-start gap-3 py-2.5">
                <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl lv-well text-text-secondary">
                  <Box className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <ModelName project={project} model={m} onChanged={onChanged} />
                  <p className="text-[12px] text-text-muted">
                    {[t(projectWords.quantityOf, { n: formatFigure(m.quantity, lang) }), size].filter(Boolean).join(' · ')}
                  </p>
                  {materials.length ? (
                    <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-text-secondary">
                      {materials.map((v, i) => (
                        <span key={m.material_assignments[i].variant_id} className="inline-flex items-center gap-1">
                          <Swatch hex={v?.colorHex} />
                          {v ? tx(v.name, lang) : m.material_assignments[i].variant_id}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
                <div className="shrink-0">
                  {m.file_id && m.file_status ? (
                    <FileStatusPill status={m.file_status} />
                  ) : m.import_status ? (
                    <ImportStatusPill status={m.import_status} />
                  ) : (
                    <StatusChip tone="warning">{t(projectWords.noFile)}</StatusChip>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-2 border-t border-border-subtle pt-3">
        <Field label={t(projectWords.addModel)} error={problem}>
          <Select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!ready.length}>
            <option value="">{ready.length ? t(projectWords.pickFile) : t(projectWords.noReadyFiles)}</option>
            {ready.map((f) => (
              <option key={f.id} value={f.id}>
                {f.original_name}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" variant="secondary" onClick={add} disabled={!pick}>
          {t(projectWords.add)}
        </Button>
      </div>
    </section>
  );
}

function PlateRow({ plate, printerLabel }: { plate: Plate; printerLabel: string }) {
  const { t, lang } = useCloudText();
  return (
    <li className="space-y-1 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-text-primary">
          <bdi>{plate.label || printerLabel}</bdi>
        </p>
        <StatusChip tone={plate.valid ? 'success' : 'warning'}>{plate.valid ? t(projectWords.plateValid) : t(projectWords.plateInvalid)}</StatusChip>
      </div>
      <p className="text-[12px] text-text-muted">
        {printerLabel}
        {plate.arrangement === 'arranged' && plate.algorithm ? ` · ${t(projectWords.arrangeNote, { algorithm: plate.algorithm })}` : ''}
      </p>
      {plate.issues.length ? (
        <ul className="list-disc space-y-0.5 ps-5 text-[12px] text-warning">
          {plate.issues.map((i, n) => (
            <li key={`${i.code}-${n}`}>{plateIssueText(i.code, lang)}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Plates({ project, onChanged }: { project: ProjectView; onChanged: () => void }) {
  const { t, lang } = useCloudText();
  const printers = usePrinterModels();
  const [model, setModel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const label = (id: string) => {
    const m = printers.byId.get(id);
    return m ? printerName(m) : id;
  };
  const arrange = async () => {
    if (!model) return;
    setProblem(null);
    try {
      const r = await createPlate(project.id, { printer_model_id: model, arrange: true });
      toast.success(t(projectWords.arranged), { description: t(projectWords.placed, { placed: formatFigure(r.placed, lang), unplaced: formatFigure(r.unplaced.length, lang) }) });
      onChanged();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };
  return (
    <section aria-labelledby="print-project-plates" className="lv-surface space-y-3 p-4">
      <SectionHeader id="print-project-plates" title={t(projectWords.plates)} count={project.plates.length} />
      {project.plates.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-text-muted">{t(projectWords.noPlates)}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {project.plates.map((p) => (
            <PlateRow key={p.id} plate={p} printerLabel={label(p.printer_model_id)} />
          ))}
        </ul>
      )}
      {project.models.length ? (
        <div className="space-y-2 border-t border-border-subtle pt-3">
          <Field label={t(projectWords.arrangeFor)} error={problem}>
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">—</option>
              {(printers.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {printerName(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Button size="sm" variant="secondary" icon={<Layers aria-hidden="true" className="h-4 w-4" />} onClick={arrange} disabled={!model}>
            {t(projectWords.arrange)}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function AccessoryRow({ s, onDecided }: { s: AccessorySuggestion; onDecided: () => void }) {
  const { t, lang } = useCloudText();
  const names = useVariantNames();
  const v = names(s.variant_id);
  const unit = v?.unit ?? 'pc';
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (status: 'accepted' | 'rejected') => {
    setProblem(null);
    try {
      await decideRecommendation(s.recommendation_id, { status });
      onDecided();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };
  const words = s.reason.matches.map((m) => String((m as { word?: unknown }).word ?? '')).filter(Boolean);
  const note = tx(s.operator_note, lang).trim();
  return (
    <li className="space-y-1.5 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
          <Swatch hex={v?.colorHex} />
          <span className="truncate">{v ? tx(v.name, lang) : t(print.untitled)}</span>
        </p>
        {s.status === 'accepted' || s.status === 'rejected' ? (
          <StatusChip tone={s.status === 'accepted' ? 'success' : 'neutral'}>{s.status === 'accepted' ? t(projectWords.accepted) : t(projectWords.dismissed)}</StatusChip>
        ) : null}
      </div>
      <p className="text-[12px] text-text-muted">
        {[t(projectWords.suggested, { qty: formatQuantity(s.suggested_qty, unit, lang) }), t(projectWords.youHave, { qty: formatQuantity(s.owned_qty, unit, lang) })].join(' · ')}
      </p>
      {words.length ? <p className="text-[12px] text-text-muted">{[...new Set(words)].map((w) => t(projectWords.because, { word: w })).join(' · ')}</p> : null}
      {s.needs_pause_at_layer ? <p className="text-[12px] text-text-secondary">{t(projectWords.needsPause)}</p> : null}
      {note ? <p className="text-[12px] text-text-secondary">{note}</p> : null}
      {problem ? <p className="lv-field-error">{problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        {s.status !== 'accepted' ? (
          <Button size="sm" variant="secondary" onClick={() => decide('accepted')}>
            {t(projectWords.accept)}
          </Button>
        ) : null}
        {s.status !== 'rejected' ? (
          <Button size="sm" variant="ghost" onClick={() => decide('rejected')}>
            {t(projectWords.dismiss)}
          </Button>
        ) : null}
        {s.shortfall_qty > 0 && s.status !== 'rejected' ? (
          <Link to={shortfallLink({ kind: 'accessory', code: 'INSUFFICIENT_INVENTORY', id: s.variant_id, amount: s.shortfall_qty })} className="lv-button lv-button-ghost lv-button-sm">
            {t(configure.buyAccessories)}
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function Accessories({ projectId }: { projectId: string }) {
  const { t } = useCloudText();
  const q = useCloudQuery((signal) => listAccessorySuggestions(projectId, { signal }), [projectId]);
  if (q.error && !q.data) return <CloudErrorState compact error={q.error} onRetry={q.reload} />;
  if (!q.data || q.data.length === 0) return null;
  return (
    <section aria-labelledby="print-project-accessories" className="lv-surface space-y-2 p-4">
      <SectionHeader id="print-project-accessories" title={t(projectWords.accessories)} count={q.data.length} />
      <p className="text-[12px] leading-relaxed text-text-muted">{t(projectWords.accessoriesNote)}</p>
      <ul className="divide-y divide-border-subtle">
        {q.data.map((s) => (
          <AccessoryRow key={s.recommendation_id} s={s} onDecided={q.reload} />
        ))}
      </ul>
    </section>
  );
}

function ProjectJobs({ project }: { project: ProjectView }) {
  const { t, lang } = useCloudText();
  return (
    <section aria-labelledby="print-project-jobs" className="space-y-2">
      <SectionHeader id="print-project-jobs" title={t(projectWords.jobs)} count={project.jobs.length} />
      {project.jobs.length === 0 ? (
        <p className="lv-surface p-4 text-[13px] text-text-muted">{t(projectWords.noJobs)}</p>
      ) : (
        <ul className="space-y-2">
          {project.jobs.map((j) => (
            <li key={j.id}>
              <ListRow
                to={`/jobs/${encodeURIComponent(j.id)}`}
                leading={<History className="h-4 w-4" />}
                title={j.title.trim() || t(print.untitled)}
                meta={t(print.created, { when: formatRelative(j.created_at, lang) })}
                trailing={<StatusPill kind="job" state={jobPillState(j.status)} />}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectDetail() {
  const { t, lang } = useCloudText();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const q = useCloudQuery((signal) => getProject(id, { signal }), [id]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  if (q.error && !q.data) return <CloudErrorState error={q.error} onRetry={q.reload} />;
  const p = q.data;
  if (!p) return <CloudPageSkeleton />;

  const saveName = async () => {
    setNameProblem(null);
    try {
      await updateProject(p.id, { name: name.trim() });
      setRenaming(false);
      toast.success(t(projectWords.renamed));
      q.reload();
    } catch (e) {
      setNameProblem(cloudErrorText(e, lang));
    }
  };
  const toggleArchive = async () => {
    setProblem(null);
    try {
      await updateProject(p.id, { status: p.status === 'archived' ? 'active' : 'archived' });
      q.reload();
    } catch (e) {
      setProblem(e);
    }
  };
  const duplicate = async () => {
    setDuplicateError(null);
    try {
      const copy = await duplicateProject(p.id);
      setDuplicating(false);
      toast.success(t(projectWords.duplicated));
      navigate(`/projects/${encodeURIComponent(copy.project_id)}`);
    } catch (e) {
      setDuplicateError(cloudErrorText(e, lang));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: '/projects', label: t(print.projects) }}
        title={<bdi>{p.name}</bdi>}
        subtitle={`${typeText(p.project_type, lang)} · ${p.status === 'archived' ? t(projectWords.archived) : t(projectWords.active)} · ${t(print.updated, { when: formatRelative(p.updated_at, lang) })}`}
        actions={
          <>
            <Link to={`/projects/${encodeURIComponent(p.id)}/print`} className="lv-button lv-button-primary lv-button-sm">
              <Printer aria-hidden="true" className="h-4 w-4" />
              {t(projectWords.printProject)}
            </Link>
            <Button size="sm" variant="secondary" icon={<Copy aria-hidden="true" className="h-4 w-4" />} onClick={() => setDuplicating(true)}>
              {t(projectWords.duplicate)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil aria-hidden="true" className="h-4 w-4" />}
              onClick={() => {
                setName(p.name);
                setNameProblem(null);
                setRenaming((r) => !r);
              }}
            >
              {t(projectWords.rename)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={p.status === 'archived' ? <Undo2 aria-hidden="true" className="h-4 w-4" /> : <Archive aria-hidden="true" className="h-4 w-4" />}
              onClick={toggleArchive}
            >
              {p.status === 'archived' ? t(projectWords.restore) : t(projectWords.archive)}
            </Button>
          </>
        }
      />
      {renaming ? (
        <form
          className="lv-surface flex flex-col gap-2 p-4 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
        >
          <Field label={t(projectWords.name)} error={nameProblem} className="flex-1">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t(print.save)}
          </Button>
        </form>
      ) : null}
      {problem ? <CloudErrorState compact error={problem} /> : null}
      <Models project={p} onChanged={q.reload} />
      <Plates project={p} onChanged={q.reload} />
      <Accessories projectId={p.id} />
      <ProjectJobs project={p} />
      <ConfirmDialog
        open={duplicating}
        title={t(projectWords.duplicateQ)}
        consequence={t(projectWords.duplicateBody)}
        confirmLabel={t(projectWords.duplicate)}
        cancelLabel={t(common.close)}
        error={duplicateError}
        onConfirm={duplicate}
        onCancel={() => {
          setDuplicating(false);
          setDuplicateError(null);
        }}
      />
    </div>
  );
}

export default function Projects({ view }: { view: 'list' | 'detail' }) {
  return view === 'detail' ? <ProjectDetail /> : <ProjectsList />;
}
