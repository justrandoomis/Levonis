/**
 * The builder's three larger moments: starting from a template, publishing
 * (with what will change, before it does), and going back to a published
 * version.
 */
import { useMemo, useState } from 'react';
import { History, LayoutTemplate } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Button } from '../../ui/Button';
import { ConfirmDialog, useConfirm } from '../../ui/ConfirmDialog';
import { Input } from '../../ui/Field';
import { Sheet } from '../../ui/Sheet';
import { THEME_NAMES, type ThemeName } from '../../../../packages/storeLayout/src/tokens';
import { starterLayout } from '../../../../packages/storeLayout/src/starters';
import { BLOCK_COPY, say, THEME_COPY, TOKEN_COPY } from './catalog';
import type { ChangeSummary } from './editorModel';
import { ThemeSwatch } from './panels';
import { builderRefusal } from './refusal';
import type { LayoutRevision } from './storeLayoutApi';

// ------------------------------------------------------------ templates

export function StarterGrid({ storeAccent, onChoose, busy }: { storeAccent: unknown; onChoose: (t: ThemeName) => void; busy?: ThemeName | null }) {
  const { loc } = useLanguage();
  const starters = useMemo(() => THEME_NAMES.map((t) => ({ theme: t, layout: starterLayout(t) })), []);
  return (
    <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-3">
      {starters.map(({ theme, layout }) => (
        <li key={theme}>
          <button
            type="button"
            onClick={() => onChoose(theme)}
            disabled={!!busy}
            data-sd-starter={theme}
            aria-busy={busy === theme || undefined}
            className="lv-choice flex h-full w-full flex-col gap-2 p-2.5 text-start disabled:opacity-60"
          >
            <ThemeSwatch tokens={layout.tokens} storeAccent={storeAccent} className="h-14" />
            <span className="block text-[13px] font-bold text-text-primary">{say(loc, THEME_COPY[theme].name)}</span>
            <span className="block text-[11px] leading-snug text-text-muted">{layout.blocks.map((b) => say(loc, BLOCK_COPY[b.type].name)).join(' · ')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The first-run card: a store with no draft and nothing published. */
export function FirstRun({ storeAccent, onChoose, onDismiss, busy }: { storeAccent: unknown; onChoose: (t: ThemeName) => void; onDismiss: () => void; busy: ThemeName | null }) {
  const { loc } = useLanguage();
  return (
    <section aria-labelledby="sd-first-run" className="lv-surface space-y-3 p-4" data-sd-first-run>
      <div className="flex items-start gap-3">
        <LayoutTemplate className="mt-0.5 h-5 w-5 shrink-0 text-gold" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="sd-first-run" className="text-[15px] font-bold text-text-primary">
            {loc('ابدأ من قالب', 'Start from a template')}
          </h2>
          <p className="text-[12.5px] leading-relaxed text-text-muted">
            {loc(
              'كل قالب صفحة كاملة تُبنى من منتجاتك وبياناتك أنت. يُحفظ في المسودة فقط — لا يراه زبائنك حتى تنشر.',
              'Each template is a whole page built from your own products and data. It is saved to the draft only — customers see nothing until you publish.'
            )}
          </p>
        </div>
      </div>
      <StarterGrid storeAccent={storeAccent} onChoose={onChoose} busy={busy} />
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {loc('أبدأ من صفحتي الحالية', 'Start from my current page')}
      </Button>
    </section>
  );
}

export function StarterSheet({ open, onClose, storeAccent, onChoose }: { open: boolean; onClose: () => void; storeAccent: unknown; onChoose: (t: ThemeName) => void }) {
  const { loc } = useLanguage();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={loc('ابدأ من قالب', 'Start from a template')}
      detents={['large']}
      panelClassName="sm:max-w-2xl"
      header={
        <div className="px-4 pb-3 pt-1">
          <h2 className="text-[15px] font-bold text-text-primary">{loc('ابدأ من قالب', 'Start from a template')}</h2>
          <p className="text-[12px] text-text-muted">
            {loc('يحل القالب محل أقسام مسودتك وشكلها. يمكنك التراجع.', 'The template replaces your draft’s sections and look. You can undo.')}
          </p>
        </div>
      }
    >
      <div className="px-4 pb-5">
        <StarterGrid
          storeAccent={storeAccent}
          onChoose={(t) => {
            onChoose(t);
            onClose();
          }}
        />
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------ publish

export function ChangeList({ changes }: { changes: ChangeSummary }) {
  const { loc } = useLanguage();
  const names = (bs: ChangeSummary['added']) => bs.map((b) => say(loc, BLOCK_COPY[b.type].name)).join('، ');
  const rows: string[] = [];
  if (changes.theme || changes.tokens.length) {
    rows.push(
      changes.tokens.length
        ? loc(`الشكل: ${changes.tokens.map((k) => say(loc, TOKEN_COPY[k])).join('، ')}`, `Look: ${changes.tokens.map((k) => say(loc, TOKEN_COPY[k])).join(', ')}`)
        : loc('النمط', 'Style')
    );
  }
  if (changes.added.length) rows.push(loc(`أقسام جديدة: ${names(changes.added)}`, `New sections: ${names(changes.added)}`));
  if (changes.removed.length) rows.push(loc(`أقسام محذوفة: ${names(changes.removed)}`, `Removed sections: ${names(changes.removed)}`));
  if (changes.edited.length) rows.push(loc(`أقسام معدّلة: ${names(changes.edited)}`, `Edited sections: ${names(changes.edited)}`));
  if (changes.reordered) rows.push(loc('ترتيب الأقسام', 'Section order'));
  if (changes.header) rows.push(loc('رأس الصفحة', 'Page header'));
  if (changes.footer) rows.push(loc('تذييل الصفحة', 'Page footer'));
  // Phrasing content only: the confirmation puts its consequence inside a <p>.
  if (!rows.length) return <span className="block text-[12.5px] text-text-muted">{loc('لا تغييرات عن المنشور الآن.', 'No changes from what is live.')}</span>;
  return (
    <span role="list" className="block space-y-1 text-[12.5px] leading-relaxed text-text-secondary" data-sd-changes>
      {rows.map((r) => (
        <span role="listitem" key={r} className="flex gap-2">
          <span aria-hidden="true" className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-text-muted" />
          <span>{r}</span>
        </span>
      ))}
    </span>
  );
}

export function PublishDialog({
  open,
  onClose,
  changes,
  onPublish,
}: {
  open: boolean;
  onClose: () => void;
  changes: ChangeSummary | null;
  onPublish: (note: string) => Promise<unknown>;
}) {
  const { loc } = useLanguage();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open={open}
      testId="sd-publish-dialog"
      title={loc('نشر التصميم؟', 'Publish the design?')}
      consequence={
        <span className="block space-y-3">
          <span className="block">{loc('سيرى زبائنك هذه الصفحة فورًا. تبقى النسخة الحالية في السجل ويمكنك العودة إليها.', 'Customers will see this page right away. The current version stays in the history and you can go back to it.')}</span>
          {changes && <ChangeList changes={changes} />}
          <label className="block space-y-1">
            <span className="block text-[12px] text-text-muted">{loc('ملاحظة للسجل (اختياري)', 'A note for the history (optional)')}</span>
            <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          </label>
        </span>
      }
      confirmLabel={loc('انشر', 'Publish')}
      error={error ?? undefined}
      onCancel={() => {
        setError(null);
        onClose();
      }}
      onConfirm={async () => {
        setError(null);
        try {
          await onPublish(note);
          setNote('');
          onClose();
        } catch (e) {
          setError(builderRefusal(e, loc));
        }
      }}
    />
  );
}

// ------------------------------------------------------------ history

export function HistoryPanel({
  revisions,
  count,
  max,
  viewing,
  onView,
  onRestore,
  onMore,
}: {
  revisions: LayoutRevision[];
  count: number;
  max: number;
  viewing: number | null;
  onView: (revision: number | null) => Promise<void>;
  onRestore: (revision: number, publish: boolean) => Promise<unknown>;
  onMore: (() => Promise<void>) | null;
}) {
  const { loc, lang } = useLanguage();
  const [confirm, dialog] = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === 'en' ? 'en-US' : 'ar-IQ-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const restore = async (r: LayoutRevision, publish: boolean) => {
    const ok = await confirm({
      title: publish ? loc(`استعادة النسخة ${r.revision} ونشرها؟`, `Restore version ${r.revision} and publish it?`) : loc(`استعادة النسخة ${r.revision} إلى المسودة؟`, `Restore version ${r.revision} to the draft?`),
      consequence: publish
        ? loc(`ستحل محل مسودتك وتُنشر فورًا كنسخة جديدة.`, `It replaces your draft and goes live now as a new version.`)
        : loc(`ستحل محل مسودتك. ما يراه زبائنك لا يتغير حتى تنشر.`, `It replaces your draft. What customers see does not change until you publish.`),
      confirmLabel: publish ? loc('استعد وانشر', 'Restore and publish') : loc('استعد إلى المسودة', 'Restore to draft'),
    });
    if (!ok) return;
    setBusy(`${r.revision}:${publish}`);
    setError(null);
    try {
      await onRestore(r.revision, publish);
    } catch (e) {
      setError(builderRefusal(e, loc));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="sd-history" className="space-y-3" data-sd-history>
      <h3 id="sd-history" className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
        <History className="h-4 w-4" aria-hidden="true" />
        {loc('النسخ المنشورة', 'Published versions')}
        <span className="font-medium text-text-muted tabular-nums">
          ({count}/{max})
        </span>
      </h3>
      {error && (
        <p role="alert" className="lv-field-error">
          {error}
        </p>
      )}
      {revisions.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">{loc('لا نسخ بعد — كل نشر يحفظ نسخة يمكنك العودة إليها.', 'No versions yet — every publish keeps one you can return to.')}</p>
      ) : (
        <ul className="space-y-2">
          {revisions.map((r) => (
            <li key={r.id} className={`rounded-xl border p-3 ${viewing === r.revision ? 'border-gold/50 bg-surface-selected' : 'border-border-subtle bg-surface'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-bold text-text-primary tabular-nums">{loc(`النسخة ${r.revision}`, `Version ${r.revision}`)}</span>
                {r.live && (
                  <span className="rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[10.5px] font-bold text-success">{loc('منشورة الآن', 'Live')}</span>
                )}
                {r.restored_from && <span className="text-[11px] text-text-muted">{loc(`من النسخة ${r.restored_from}`, `from version ${r.restored_from}`)}</span>}
                <span className="ms-auto text-[11.5px] text-text-muted">{when(r.published_at)}</span>
              </div>
              {r.note && (
                <p className="mt-1 text-[12px] text-text-secondary" dir="auto">
                  {r.note}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" aria-pressed={viewing === r.revision} onClick={() => onView(viewing === r.revision ? null : r.revision)}>
                  {viewing === r.revision ? loc('عودة إلى المسودة', 'Back to the draft') : loc('معاينة', 'Preview')}
                </Button>
                {!r.live && (
                  <>
                    <Button size="sm" variant="secondary" loading={busy === `${r.revision}:false`} disabled={!!busy} onClick={() => restore(r, false)}>
                      {loc('استعد إلى المسودة', 'Restore to draft')}
                    </Button>
                    <Button size="sm" variant="ghost" loading={busy === `${r.revision}:true`} disabled={!!busy} onClick={() => restore(r, true)}>
                      {loc('استعد وانشر', 'Restore and publish')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {onMore && (
        <Button size="sm" variant="ghost" onClick={onMore}>
          {loc('نسخ أقدم', 'Older versions')}
        </Button>
      )}
      {dialog}
    </section>
  );
}
