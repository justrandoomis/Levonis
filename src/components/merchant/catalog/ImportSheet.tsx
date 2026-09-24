/**
 * CSV import, in two steps: CHECK (the server parses the file and writes
 * nothing — `confirm: false`) shows every refused row with its field and the
 * reason in words; IMPORT sends the same text with `confirm: true`, and only
 * the rows that passed become products — always as DRAFTS.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { FileDown, FileUp } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { CATALOG_CSV_COLUMNS } from '../../../../packages/catalog/src/csv';
import { catalogApi, type ImportReport } from './catalogApi';
import { catalogStrings, fieldErrorText } from './strings';
import { readRefusal } from './parts';

export default function ImportSheet({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const { loc } = useLanguage();
  const s = catalogStrings(loc);
  const toast = useToast();
  const titleId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'import'>('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setCsv('');
    setFileName('');
    setReport(null);
    setError('');
    setBusy('');
  }, [open]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setReport(null);
    setError('');
    setCsv(await file.text());
    if (input.current) input.current.value = '';
  }

  function template() {
    const example = ['dragon', 'Dragon figure', '', '', '', 'draft', '12000', '', '', '', '1', '', '', 'new', '2', '0', '', 'pla', 'fdm', '', 'raw', '', '', '', '', 'Size', 'S', '', '', '', '', '', '', 'DR-S', '3', '1'];
    const text = `${CATALOG_CSV_COLUMNS.join(',')}\n${example.join(',')}\n`;
    const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'products-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function run(confirm: boolean) {
    setBusy(confirm ? 'import' : 'check');
    setError('');
    try {
      const r = await catalogApi.importCsv(csv, confirm);
      if (confirm) {
        toast.success(s.importDone(r.created));
        onImported();
        onClose();
      } else setReport(r);
    } catch (e) {
      setError(readRefusal(e, loc, s.importFailed).message || s.importFailed);
    } finally {
      setBusy('');
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="w-full sm:max-w-lg"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{s.importTitle}</h2>
        </div>
      }
      footer={
        <div className="flex gap-2 px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={!!busy} className="flex-1">{s.cancel}</Button>
          {report && report.valid > 0 ? (
            <Button variant="primary" onClick={() => run(true)} loading={busy === 'import'} className="flex-[2]" data-import-confirm>
              {s.importN(report.valid)}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => run(false)} loading={busy === 'check'} disabled={!csv} className="flex-[2]" data-import-check>
              {s.check}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-6 pt-1" data-import>
        <p className="text-[12.5px] leading-relaxed text-text-secondary">{s.importLead}</p>
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} onChange={(e) => pick(e.target.files?.[0])} />
          <Button variant="secondary" size="sm" icon={<FileUp className="h-4 w-4" />} onClick={() => input.current?.click()}>
            {fileName || s.chooseFile}
          </Button>
          <Button variant="ghost" size="sm" icon={<FileDown className="h-4 w-4" />} onClick={template}>
            {s.downloadTemplate}
          </Button>
        </div>
        {error && <p role="alert" className="lv-field-error">{error}</p>}
        {report && (
          <div className="space-y-3" aria-live="polite">
            <p className="text-[13px] font-semibold text-text-primary tabular-nums">{s.importSummary(report.valid, report.invalid)}</p>
            {report.errors.length > 0 && (
              <ul className="max-h-72 divide-y divide-border-subtle overflow-y-auto rounded-xl border border-danger/30" data-import-errors>
                {report.errors.map((e, i) => (
                  <li key={`${e.row}-${e.field}-${i}`} className="px-3 py-2 text-[12.5px]">
                    <span className="font-semibold text-text-primary tabular-nums">{s.row(e.row)}</span>
                    <span className="text-text-muted"> · <span dir="ltr">{e.field}</span></span>
                    <span className="block text-danger">{fieldErrorText(e.code, loc)}</span>
                  </li>
                ))}
              </ul>
            )}
            {report.products.length > 0 && (
              <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
                {report.products.slice(0, 50).map((p) => (
                  <li key={p.row} className="flex items-center justify-between gap-3 px-3 py-2 text-[12.5px]">
                    <span className="min-w-0 truncate text-text-primary">{p.name}</span>
                    <span className="shrink-0 text-text-muted tabular-nums">{p.variants ? s.variantsCount(p.variants) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
