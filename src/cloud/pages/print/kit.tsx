/**
 * THE PIECES EVERY PRINT SCREEN SHARES — status pills for a file and an
 * import, the «could not refresh» line, a fact row, honest «show more»,
 * the polling hook, the printer models and variant names a screen looks
 * figures up in, and the one way a model becomes a project.
 *
 * Re-exported by PrintRoutes.tsx (the section's lazy entry), so these ride in
 * that chunk, which every print screen needs loaded first anyway — not in
 * small shared chunks of their own (the reasoning of src/cloud/PrintCloudApp.tsx
 * for the ui barrel).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { formatFigure } from '../../../lib/localeNumber';
import { addProjectModel, cloudErrorText, createProject, getProject, listInventory, listPrinters, listStoreProducts } from '../../api';
import { fileStatus, importStatus, print } from '../../strings/print';
import { common } from '../../strings/common';
import { useCloudText } from '../../text';
import type { FileStatus, ImportStatus, InventoryBalance, PrinterModel, StoreProduct, Tri } from '../../types';
import { RefreshCw } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { fileTone, importOutcome } from './model';

// ------------------------------------------------------------------ pills

export function FileStatusPill({ status, className = '' }: { status: FileStatus | string; className?: string }) {
  const { t } = useCloudText();
  const words = status in fileStatus ? fileStatus[status as FileStatus] : null;
  return (
    <StatusChip tone={fileTone(status)} className={className}>
      {words ? t(words) : status}
    </StatusChip>
  );
}

export function ImportStatusPill({ status, fileId, className = '' }: { status: ImportStatus | string; fileId?: string | null; className?: string }) {
  const { t } = useCloudText();
  const words = status in importStatus ? importStatus[status as ImportStatus] : null;
  return (
    <StatusChip tone={importOutcome({ status, file_id: fileId }).tone} className={className}>
      {words ? t(words) : status}
    </StatusChip>
  );
}

// ------------------------------------------------------------------ small layout

/** One fact of a definition list: a quiet label at the inline start, the value at the end. */
export function Fact({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className="min-w-0 text-end text-[13px] font-semibold text-text-primary">{children}</dd>
    </div>
  );
}

/** The colour of a material itself (the owner's catalogue data), not a theme colour. */
export function Swatch({ hex }: { hex: string | null | undefined }) {
  if (!hex) return null;
  return <span aria-hidden="true" className="block h-5 w-5 shrink-0 rounded-full border border-border-subtle" style={{ backgroundColor: hex }} />;
}

/**
 * A poll that failed while the last answer is still on screen: say so, keep
 * the answer, offer the retry — never swap the page for an error, never pass
 * the old answer off as fresh.
 */
export function RefreshNote({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t, lang } = useCloudText();
  if (!error) return null;
  return (
    <div role="status" className="lv-alert lv-alert-warning flex flex-wrap items-center justify-between gap-2 text-[13px] text-text-primary">
      <span className="min-w-0">
        {t(print.refreshFailed)} <span className="text-text-muted">{cloudErrorText(error, lang)}</span>
      </span>
      <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />} onClick={onRetry}>
        {t(common.retry)}
      </Button>
    </div>
  );
}

/** «Show more», a page at a time — and, at the server's own cap, the honest note that older rows exist. */
export function useShown<T>(rows: readonly T[], step = 20) {
  const [count, setCount] = useState(step);
  return { shown: rows.slice(0, count), hasMore: rows.length > count, more: () => setCount((c) => c + step) };
}

export function MoreRow({ hasMore, onMore, total, cap }: { hasMore: boolean; onMore: () => void; total: number; cap?: number }) {
  const { t, lang } = useCloudText();
  return (
    <>
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={onMore}>
            {t(print.showMore)}
          </Button>
        </div>
      ) : null}
      {cap && total >= cap ? <p className="text-center text-[12px] text-text-muted">{t(print.capNote, { n: formatFigure(cap, lang) })}</p> : null}
    </>
  );
}

// ------------------------------------------------------------------ asking again

export { usePoll } from '../../useCloudQuery';

// ------------------------------------------------------------------ lookups

/** The printer models by id (GET /printers): names, classes, nozzles and machine counts. */
export function usePrinterModels() {
  const q = useCloudQuery((signal) => listPrinters({ signal }), []);
  const byId = useMemo(() => new Map((q.data ?? []).map((m) => [m.id, m])), [q.data]);
  return { ...q, byId };
}

export const printerName = (m: Pick<PrinterModel, 'brand' | 'model_name'>) => `${m.brand} ${m.model_name}`.trim();

export interface VariantName {
  name: Tri;
  colorHex: string;
  unit: string;
  kind: string;
}

/**
 * What a variant is called, for a screen that has only its id (a projection,
 * a reservation): the customer's own inventory first, then the public
 * catalogue. A name that cannot be found reads «Material <id>» — the lookup
 * failing is never an error that hides the figures beside it.
 */
export function useVariantNames() {
  const q = useCloudQuery(
    (signal) =>
      Promise.all([
        listInventory(undefined, { signal }).catch((): InventoryBalance[] => []),
        listStoreProducts(undefined, { signal }).catch((): StoreProduct[] => []),
      ]),
    []
  );
  return useCallback(
    (variantId: string): VariantName | null => {
      const [mine, catalogue] = q.data ?? [[], []];
      const own = mine.find((r) => r.variant_id === variantId);
      if (own) return { name: own.name, colorHex: own.color_hex, unit: own.unit_code, kind: String(own.category_kind) };
      const listed = catalogue.find((v) => v.id === variantId);
      if (listed) return { name: listed.name, colorHex: listed.color_hex, unit: listed.unit_code, kind: '' };
      return null;
    },
    [q.data]
  );
}

// ------------------------------------------------------------------ a model becomes a project

/** A file's name without its extension, as a project's name («dragon.stl» → «dragon»). */
export function projectNameOf(fileName: string): string {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return (base || fileName).slice(0, 120);
}

/**
 * «Continue to print settings»: a project holding this one model (quantity
 * one, its material chosen next), created only when the customer asks — never
 * on a page load. The ids it made are kept by the caller so a retry after a
 * failed second step does not make a second project.
 */
export async function startProject(file: { id: string; original_name: string }, importId: string | null, made: { projectId: string | null }): Promise<string> {
  const retry = made.projectId !== null;
  const projectId = made.projectId ?? (await createProject({ name: projectNameOf(file.original_name), project_type: 'generic' })).project_id;
  made.projectId = projectId;
  // A retry whose first model call landed (only its answer was lost) must not add the model twice.
  if (retry && (await getProject(projectId)).models.some((m) => m.file_id === file.id)) return projectId;
  await addProjectModel(projectId, importId ? { file_id: file.id, import_id: importId, quantity: 1 } : { file_id: file.id, quantity: 1 });
  return projectId;
}
