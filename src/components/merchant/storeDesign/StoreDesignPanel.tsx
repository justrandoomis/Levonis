/**
 * «تصميم المتجر» — THE STORE BUILDER (/merchant/store/design).
 *
 * The merchant builds their page block by block, on the store-layout contract
 * W2-C shipped (docs/MERCHANT_PLATFORM.md §4.4; worker/routes/storeLayout.ts):
 *
 *   - SECTIONS: the page's blocks in order — add from a categorised picker
 *     with a live preview of each type, drag (or ↑/↓) to reorder, duplicate,
 *     hide, per-width visibility, delete with «تراجع». Limits (40 sections,
 *     12 product lists, each type's own) are shown before they bite.
 *   - INSPECTOR: each block's form, generated from its registry entry, and
 *     checked live by the SAME `normalizeLayout` the server runs.
 *   - THEME: a preset, then each token — enums only. PAGE: header and footer.
 *   - PREVIEW: the storefront's own renderer, in place (no iframe — the CSP
 *     forbids framing), at 360 / 768 / 1280; click a block to edit it.
 *   - The draft AUTOSAVES (debounced, version-fenced; a conflict asks «reload
 *     or keep mine»); PUBLISH shows what will change and asks first; HISTORY
 *     previews and restores any published version.
 *   - A store with nothing yet starts from one of seven whole-page templates,
 *     written to the draft only.
 *
 * THE SECURITY LINE: nothing in this screen writes to the server except the
 * autosaver, and the autosaver sends only `normalizeLayout(editorLayout,
 * {ownerUserId})`'s output — and nothing at all while that gate reports a
 * fatal issue. The server normalises and checks references again on every
 * write. There is no HTML, script, style, class, URL-to-a-picture or
 * free-path input anywhere in the builder.
 *
 * Self-contained (it asks the server for the merchant's own store and
 * layout), lazily loaded by the workspace shell as its own chunk.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, CloudOff, ExternalLink, Eye, Loader2, Plus, Redo2, Undo2, Upload } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { Button, IconButton } from '../../ui/Button';
import { Segmented } from '../../ui/Segmented';
import { TabStrip } from '../../ui/Tabs';
import { useToast } from '../../ui/Toast';
import Spinner from '../../ui/Spinner';
import { ErrorState } from '../../ui/AsyncStates';
import StoreRenderer from '../../storefront/StoreRenderer';
import '../../storefront/styles';
import { StorefrontRuntimeProvider } from '../../storefront/runtime';
import { previewRuntime } from '../../storefront/preview';
import { BLOCKS, type BlockType, type RefKind } from '../../../../packages/storeLayout/src/blocks';
import { renderableBlocks } from '../../../../packages/storeLayout/src/normalize';
import { starterLayout } from '../../../../packages/storeLayout/src/starters';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';
import type { ThemeName } from '../../../../packages/storeLayout/src/tokens';
import './builder.css';
import { ADD_REFUSAL_COPY, BLOCK_COPY, ISSUE_COPY, say } from './catalog';
import {
  addBlock,
  canAdd,
  duplicateBlock,
  limitsOf,
  moveBy,
  removeBlock,
  reorder,
  restoreBlock,
  setHidden,
  starvedProductLists,
} from './editorModel';
import { useLayoutEditor, type LayoutEditor } from './useLayoutEditor';
import BlockList from './BlockList';
import BlockInspector from './BlockInspector';
import BlockPicker from './BlockPicker';
import PreviewCanvas, { DEVICE_WIDTHS, type Device } from './PreviewCanvas';
import { PagePanel, ThemePanel } from './panels';
import { FirstRun, HistoryPanel, PublishDialog, StarterSheet } from './flows';
import { rememberFromData, usePreloadRefNames } from './pickers';
import { builderRefusal } from './refusal';

const runtime = previewRuntime();

type Tab = 'sections' | 'theme' | 'page' | 'history';

export default function StoreDesignPanel() {
  const ed = useLayoutEditor();
  if (ed.loadError) return <ErrorState error={ed.loadError} onRetry={() => void ed.reload()} compact />;
  if (!ed.layout || !ed.store || !ed.server || !ed.validation) {
    return (
      <div className="flex justify-center py-16" aria-busy="true">
        <Spinner size="md" />
      </div>
    );
  }
  return <Builder ed={ed} layout={ed.layout} />;
}

function refKindsOf(type: BlockType | undefined): RefKind[] {
  if (!type) return [];
  const out = new Set<RefKind>();
  const walk = (specs: Record<string, { t: string; ref?: RefKind; item?: Record<string, { t: string; ref?: RefKind }> }>) => {
    for (const s of Object.values(specs)) {
      if ((s.t === 'ref' || s.t === 'refs') && s.ref) out.add(s.ref);
      if (s.t === 'link') {
        out.add('product');
        out.add('collection');
      }
      if (s.t === 'list' && s.item) walk(s.item);
    }
  };
  walk(BLOCKS[type].settings as never);
  return [...out];
}

function Builder({ ed, layout }: { ed: LayoutEditor; layout: StoreLayout }) {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const wide = useMediaQuery('(min-width: 1024px)');
  const validation = ed.validation!;
  const store = ed.store!;
  const server = ed.server!;
  const [tab, setTab] = useState<Tab>('sections');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>('phone');
  const [phoneView, setPhoneView] = useState<'edit' | 'preview'>('edit');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [starterOpen, setStarterOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  const [starting, setStarting] = useState<ThemeName | null>(null);
  const [revCursor, setRevCursor] = useState<number | null>(() =>
    server.revisions.length < server.revision_count && server.revisions.length ? server.revisions[server.revisions.length - 1].revision : null
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const selected = selectedId ? layout.blocks.find((b) => b.id === selectedId) ?? null : null;
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  useEffect(() => rememberFromData(ed.data, lang), [ed.data, lang]);
  const kinds = useMemo(() => refKindsOf(selected?.type), [selected?.type]);
  usePreloadRefNames(kinds);

  // ⌘Z / ⌘⇧Z outside text fields (inside one, the field's own undo applies).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        ed.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        ed.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ed]);

  const limits = limitsOf(layout);
  const starved = useMemo(() => starvedProductLists(layout), [layout]);
  const visible = renderableBlocks(validation.result.layout).length;
  const status = ed.save?.status ?? 'saved';
  const changes = ed.changes;
  const nothingToPublish = !!changes?.none && !!server.published;

  const select = (id: string) => {
    setSelectedId(id);
    setTab('sections');
    setPhoneView('edit');
  };

  const refuse = (reason: string) => toast.error(say(loc, ADD_REFUSAL_COPY[reason], reason));

  const add = (type: BlockType, variant: string) => {
    const at = selected ? layout.blocks.indexOf(selected) + 1 : undefined;
    const r = addBlock(layout, type, at, { variant });
    if ('refused' in r) return refuse(r.refused);
    ed.change(r.layout);
    select(r.id);
  };

  const duplicate = (id: string) => {
    const r = duplicateBlock(layout, id);
    if ('refused' in r) return refuse(r.refused);
    ed.change(r.layout);
    setSelectedId(r.id);
  };

  const remove = (id: string) => {
    const { layout: next, removed } = removeBlock(layout, id);
    if (!removed) return;
    ed.change(next);
    if (selectedId === id) setSelectedId(null);
    const name = say(loc, BLOCK_COPY[removed.block.type].name);
    toast.success(loc(`حُذف «${name}»`, `«${name}» deleted`), {
      id: `sd-del-${removed.block.id}`,
      action: {
        label: loc('تراجع', 'Undo'),
        onClick: () => {
          const r = restoreBlock(layoutRef.current, removed);
          if ('refused' in r) return refuse(r.refused);
          ed.change(r.layout);
        },
      },
    });
  };

  const toggleHidden = (id: string) => {
    const b = layout.blocks.find((x) => x.id === id);
    if (b) ed.change(setHidden(layout, id, !b.hidden));
  };

  const applyStarter = async (t: ThemeName, first: boolean) => {
    ed.change(starterLayout(t));
    setSelectedId(null);
    if (first) {
      setStarting(t);
      const ok = await ed.flush();
      setStarting(null);
      setFirstRunDismissed(true);
      if (!ok) toast.error(loc('تعذّر حفظ القالب في المسودة — حاول مجددًا.', 'Could not save the template to the draft — try again.'));
    } else {
      toast.success(loc('طُبّق القالب على المسودة.', 'Template applied to the draft.'), { action: { label: loc('تراجع', 'Undo'), onClick: ed.undo } });
    }
  };

  const publish = async (note: string) => {
    const r = await ed.publish(note);
    toast.success(loc(`نُشرت النسخة ${r.revision} — هذا ما يراه زبائنك الآن.`, `Version ${r.revision} is live — this is what customers see now.`), {
      action: store.url ? { label: loc('عرض المتجر', 'View store'), onClick: () => window.open(store.url, '_blank', 'noopener') } : undefined,
    });
  };

  const firstRun = !server.draft.exists && !server.published && !firstRunDismissed && !ed.canUndo;
  const serverCleaned = (ed.save?.issues ?? []).filter((i) => i.code === 'unknown_ref' || i.code === 'media_not_found');

  // ------------------------------------------------------------ pieces

  const toolbar = (
    <div className="sticky top-0 z-20 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-border-subtle bg-canvas/90 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" data-sd-toolbar>
      <SaveState status={status} onRetry={() => void ed.flush()} />
      <span className={`hidden text-[12px] sm:inline ${nothingToPublish ? 'text-text-muted' : 'text-warning'}`} data-sd-publish-state>
        {nothingToPublish ? loc('· منشور كما هو', '· Live as is') : loc('· تغييرات غير منشورة', '· Unpublished changes')}
      </span>
      <span className="ms-auto flex items-center gap-0.5">
        <IconButton icon={<Undo2 className="h-4 w-4 rtl:-scale-x-100" />} label={loc('تراجع', 'Undo')} disabled={!ed.canUndo} onClick={ed.undo} />
        <IconButton icon={<Redo2 className="h-4 w-4 rtl:-scale-x-100" />} label={loc('إعادة', 'Redo')} disabled={!ed.canRedo} onClick={ed.redo} />
        {store.url && (
          <a
            href={store.url}
            target="_blank"
            rel="noopener noreferrer"
            className="lv-button lv-button-ghost lv-button-sm hidden sm:inline-flex"
            title={loc('يفتح ما يراه زبائنك الآن', 'Opens what customers see now')}
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {loc('المتجر', 'Store')}
          </a>
        )}
        <Button
          variant="primary"
          size="sm"
          icon={<Upload className="h-4 w-4" aria-hidden="true" />}
          disabled={nothingToPublish || validation.fatal || status === 'conflict' || visible === 0}
          title={visible === 0 ? loc('الصفحة تحتاج قسمًا ظاهرًا', 'The page needs a visible section') : undefined}
          onClick={() => setPublishOpen(true)}
          data-sd-publish
        >
          {loc('نشر', 'Publish')}
        </Button>
      </span>
      {status === 'conflict' && (
        <div role="alert" className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/[0.07] px-3 py-2 text-[12.5px] text-text-secondary" data-sd-conflict>
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">{loc('حُفظت المسودة من تبويب أو جهاز آخر بعد أن فتحتها هنا.', 'The draft was saved from another tab or device after you opened it here.')}</span>
          <Button size="sm" variant="secondary" onClick={() => ed.reloadDraft().catch((e) => toast.error(builderRefusal(e, loc)))}>
            {loc('حمّل المحفوظة', 'Load the saved one')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => ed.keepMine().catch((e) => toast.error(builderRefusal(e, loc)))}>
            {loc('أبقِ تعديلاتي', 'Keep mine')}
          </Button>
        </div>
      )}
      {status === 'blocked' && (
        <p role="alert" className="w-full text-[12px] text-danger" data-sd-blocked>
          {ed.save?.errorCode
            ? builderRefusal({ code: ed.save.errorCode }, loc)
            : loc('لم تُحفظ آخر تعديلاتك: في التصميم حقل يحتاج تصحيحًا (معلَّم بالأحمر).', 'Your latest edits are not saved: a field needs fixing (marked in red).')}
          {validation.page.filter((i) => i.fatal).map((i) => ` ${say(loc, ISSUE_COPY[i.code], i.code)}`)}
        </p>
      )}
      {status === 'error' && ed.save?.errorCode && <p className="w-full text-[12px] text-danger">{builderRefusal({ code: ed.save.errorCode }, loc)}</p>}
      {serverCleaned.length > 0 && (
        <p className="w-full text-[12px] text-text-muted">
          {loc('أُزيل من التصميم ما لم يعد في متجرك (منتج أو مجموعة أو ملف حُذف).', 'Removed from the design what is no longer in your store (a deleted product, collection or file).')}
        </p>
      )}
    </div>
  );

  const sectionsPanel = selected ? (
    <BlockInspector
      key={selected.id}
      layout={layout}
      block={selected}
      validation={validation}
      onChange={ed.change}
      onBack={() => setSelectedId(null)}
      onDuplicate={() => duplicate(selected.id)}
      onToggleHidden={() => toggleHidden(selected.id)}
      onDelete={() => remove(selected.id)}
      canDuplicate={!canAdd(layout, selected.type)}
    />
  ) : (
    <div className="space-y-3" data-sd-sections>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] text-text-muted tabular-nums" data-sd-limits>
          {loc(`${limits.blocks} من ${limits.maxBlocks} قسمًا`, `${limits.blocks} of ${limits.maxBlocks} sections`)}
          <span className="mx-1.5" aria-hidden="true">
            ·
          </span>
          {loc(`${limits.productLists} من ${limits.maxProductLists} قوائم منتجات`, `${limits.productLists} of ${limits.maxProductLists} product lists`)}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="ms-auto whitespace-nowrap"
          icon={<Plus className="h-4 w-4" aria-hidden="true" />}
          disabled={limits.blocks >= limits.maxBlocks}
          onClick={() => setPickerOpen(true)}
          data-sd-open-picker
        >
          {loc('أضف قسمًا', 'Add a section')}
        </Button>
      </div>
      {limits.blocks >= limits.maxBlocks - 4 && (
        <p className="text-[12px] text-warning">
          {limits.blocks >= limits.maxBlocks
            ? say(loc, ADD_REFUSAL_COPY.max_blocks)
            : loc(`بقي ${limits.maxBlocks - limits.blocks} أقسام قبل الحد الأقصى.`, `${limits.maxBlocks - limits.blocks} sections left before the limit.`)}
        </p>
      )}
      {layout.blocks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-subtle p-6 text-center">
          <p className="text-[13px] text-text-secondary">{loc('الصفحة فارغة.', 'The page is empty.')}</p>
          <p className="mt-1 text-[12px] text-text-muted">{loc('أضف قسمًا، أو ابدأ من قالب من تبويب «الشكل».', 'Add a section, or start from a template under «Look».')}</p>
        </div>
      ) : (
        <BlockList
          blocks={layout.blocks}
          selectedId={selectedId}
          flags={(b) => ({
            fatal: (validation.byBlock.get(b.id) ?? []).some((i) => i.fatal),
            starved: starved.has(b.id),
            canDuplicate: !canAdd(layout, b.type),
          })}
          onSelect={select}
          onReorder={(ids) => ed.change(reorder(layoutRef.current, ids), 'drag')}
          onMove={(id, d) => ed.change(moveBy(layoutRef.current, id, d))}
          onDuplicate={duplicate}
          onToggleHidden={toggleHidden}
          onDelete={remove}
        />
      )}
    </div>
  );

  const editor = (
    <div className="min-w-0 space-y-4">
      <TabStrip
        group="sd-panels"
        label={loc('أجزاء المحرّر', 'Editor parts')}
        value={tab}
        onChange={(id) => setTab(id as Tab)}
        fill
        panels
        items={[
          { id: 'sections', label: loc('الأقسام', 'Sections') },
          { id: 'theme', label: loc('الشكل', 'Look') },
          { id: 'page', label: loc('الصفحة', 'Page') },
          { id: 'history', label: loc('السجل', 'History') },
        ]}
      />
      <div role="tabpanel" id={`tabpanel-sd-panels-${tab}`} aria-labelledby={`tab-sd-panels-${tab}`} tabIndex={-1} className="focus:outline-none">
        {tab === 'sections' && sectionsPanel}
        {tab === 'theme' && <ThemePanel layout={layout} storeAccent={store.accent} onChange={(l) => ed.change(l)} onStarter={() => setStarterOpen(true)} />}
        {tab === 'page' && <PagePanel layout={layout} onChange={(l) => ed.change(l)} />}
        {tab === 'history' && (
          <HistoryPanel
            revisions={server.revisions}
            count={server.revision_count}
            max={server.limits.max_revisions}
            viewing={ed.viewing?.revision ?? null}
            onView={async (r) => {
              try {
                await ed.viewRevision(r);
                if (!wide) setPhoneView('preview');
              } catch (e) {
                toast.error(builderRefusal(e, loc));
              }
            }}
            onRestore={async (r, pub) => {
              await ed.restore(r, pub);
              setSelectedId(null);
              toast.success(pub ? loc(`أُعيدت النسخة ${r} ونُشرت.`, `Version ${r} restored and published.`) : loc(`أُعيدت النسخة ${r} إلى المسودة.`, `Version ${r} restored to the draft.`));
            }}
            onMore={
              revCursor
                ? async () => {
                    setRevCursor(await ed.loadMoreRevisions(revCursor));
                  }
                : null
            }
          />
        )}
      </div>
    </div>
  );

  const shown = ed.viewing ? ed.viewing.layout : validation.result.layout;
  const preview = (
    <div className="min-w-0 space-y-2" data-sd-preview>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-bold text-text-secondary">
          {ed.viewing ? loc(`النسخة ${ed.viewing.revision}`, `Version ${ed.viewing.revision}`) : loc('معاينة المسودة', 'Draft preview')}
        </h2>
        {ed.viewing && (
          <Button size="sm" variant="ghost" onClick={() => void ed.viewRevision(null)}>
            {loc('عودة إلى المسودة', 'Back to the draft')}
          </Button>
        )}
        <Segmented
          size="sm"
          group="sd-device"
          label={loc('عرض المعاينة على', 'Preview on')}
          value={device}
          onChange={(id) => setDevice(id as Device)}
          className="ms-auto w-auto min-w-[15rem]"
          items={[
            { id: 'phone', label: '360' },
            { id: 'tablet', label: '768' },
            { id: 'desktop', label: '1280' },
          ]}
        />
      </div>
      {renderableBlocks(shown).length === 0 ? (
        <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border-subtle p-6 text-center text-[13px] text-text-muted">
          {loc('لا قسم ظاهرًا في الصفحة بعد.', 'No visible section on the page yet.')}
        </div>
      ) : (
        <PreviewCanvas
          width={DEVICE_WIDTHS[device]}
          selectedId={ed.viewing ? null : selectedId}
          onSelect={ed.viewing ? undefined : select}
          maxHeight={wide ? 'calc(100dvh - 13rem)' : 'min(75dvh, 760px)'}
        >
          <StorefrontRuntimeProvider value={runtime}>
            <StoreRenderer store={store} layout={shown} data={ed.viewing ? ed.viewing.data : ed.data} className="min-h-[420px] pb-6" />
          </StorefrontRuntimeProvider>
        </PreviewCanvas>
      )}
      <p className="text-[11.5px] text-text-muted">
        {ed.viewing ? loc('هذه نسخة منشورة سابقًا — للمعاينة فقط.', 'A previously published version — preview only.') : loc('انقر قسمًا في المعاينة لتعديله. الأزرار فيها لا تعمل هنا.', 'Click a section in the preview to edit it. Its buttons do nothing here.')}
      </p>
    </div>
  );

  return (
    <div data-store-design className="pb-6">
      {toolbar}
      {firstRun && (
        <div className="mb-5">
          <FirstRun storeAccent={store.accent} busy={starting} onChoose={(t) => void applyStarter(t, true)} onDismiss={() => setFirstRunDismissed(true)} />
        </div>
      )}
      {wide ? (
        <div className="grid grid-cols-[minmax(0,22.5rem)_minmax(0,1fr)] items-start gap-6">
          {editor}
          <div className="sticky top-16">{preview}</div>
        </div>
      ) : (
        <div className="space-y-4">
          <Segmented
            group="sd-phone-view"
            label={loc('العرض', 'View')}
            value={phoneView}
            onChange={(v) => setPhoneView(v as 'edit' | 'preview')}
            items={[
              { id: 'edit', label: loc('تحرير', 'Edit') },
              { id: 'preview', label: loc('معاينة', 'Preview'), icon: <Eye className="h-4 w-4" aria-hidden="true" /> },
            ]}
          />
          {phoneView === 'edit' ? editor : preview}
        </div>
      )}

      <BlockPicker open={pickerOpen} onClose={() => setPickerOpen(false)} layout={layout} store={store} data={ed.data} onAdd={add} />
      <StarterSheet open={starterOpen} onClose={() => setStarterOpen(false)} storeAccent={store.accent} onChoose={(t) => void applyStarter(t, false)} />
      <PublishDialog open={publishOpen} onClose={() => setPublishOpen(false)} changes={changes} onPublish={publish} />
    </div>
  );
}

function SaveState({ status, onRetry }: { status: string; onRetry: () => void }) {
  const { loc } = useLanguage();
  const base = 'inline-flex items-center gap-1.5 text-[12.5px]';
  return (
    <span aria-live="polite" data-sd-save={status} className="inline-flex items-center">
      {status === 'saved' ? (
        <span className={`${base} text-text-muted`}>
          <Check className="h-4 w-4 text-success" aria-hidden="true" />
          {loc('محفوظ في المسودة', 'Saved to draft')}
        </span>
      ) : status === 'pending' || status === 'saving' ? (
        <span className={`${base} text-text-muted`}>
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {loc('جارٍ الحفظ…', 'Saving…')}
        </span>
      ) : status === 'error' ? (
        <span className={`${base} text-danger`}>
          <CloudOff className="h-4 w-4" aria-hidden="true" />
          {loc('لم يُحفظ', 'Not saved')}
          <button type="button" onClick={onRetry} className="min-h-8 rounded-md px-1.5 font-semibold underline underline-offset-2">
            {loc('أعد المحاولة', 'Retry')}
          </button>
        </span>
      ) : (
        <span className={`${base} text-warning`}>
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          {status === 'conflict' ? loc('المسودة تغيّرت', 'Draft changed') : loc('لم يُحفظ', 'Not saved')}
        </span>
      )}
    </span>
  );
}
