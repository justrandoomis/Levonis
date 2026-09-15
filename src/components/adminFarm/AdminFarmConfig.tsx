/**
 * LEVO Printer Farm — the balancing console (docs/PRINTER_FARM.md §4 "Admin",
 * §5 "Configuration"). Admin → مزرعة الطابعات.
 *
 * Schema-less by design: `GET /api/admin/farm/config` returns the normalised
 * document, the code defaults, the public projection, the stored document's
 * problems and the version; this screen renders one accordion card per
 * top-level key in the contract's order and edits every field from its own
 * JSON type and the default beside it (editors.tsx). The backend's
 * `FarmConfig` is the only schema, so a section the engine grows tomorrow
 * appears here with no client change.
 *
 * State: `{ saved, draft }` per document, dirty by JSON compare per section.
 * Save PUTs ONE section with `expected_version`; the server normalises, and
 * both copies are replaced from the document it returns (never from what was
 * typed). 409 CONFIG_VERSION_MISMATCH → a banner with reload (unsaved edits
 * in other sections are kept); 400 FARM_CONFIG_INVALID → the server's problem
 * list under the section. Reset to defaults sits behind a typed RESET window.
 *
 * Nothing shown is fabricated: every number is a server field or the code
 * default the server sent. Levonis Points are never touched here.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Factory, RefreshCw } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Banner, btnGhost } from '../adminProducts/form/formUi';
import { ErrorState } from '../ui/AsyncStates';
import Spinner from '../ui/Spinner';
import {
  farmAdminApi,
  farmAdminCurrentVersion,
  farmAdminErrorText,
  farmAdminProblems,
  type FarmConfigDocument,
} from '../../lib/farmAdminApi';
import type { EditorCtx } from './editors';
import { SectionPanel, type SectionNote } from './SectionPanel';
import { PublicPreview } from './PublicPreview';
import { ShelvedPanel } from './ShelvedPanel';
import { PlayersPanel } from './PlayersPanel';
import { isPlainObject, jsonEqual, orderedSections, privateKeys, problemsFor, type JsonObject } from './schema';
import { adminStrings } from './strings';

interface Docs {
  /** The last document read from the server — the yardstick the dirty flag uses. */
  saved: JsonObject | null;
  draft: JsonObject | null;
}

export default function AdminFarmConfig() {
  const { lang, dir } = useLanguage();
  const s = adminStrings(lang);

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [docs, setDocs] = useState<Docs>({ saved: null, draft: null });
  const [defaults, setDefaults] = useState<JsonObject>({});
  const [pub, setPub] = useState<JsonObject | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [sections, setSections] = useState<string[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState('');
  const [notes, setNotes] = useState<Record<string, SectionNote>>({});
  const [invalid, setInvalid] = useState<Record<string, string[]>>({});
  const [conflict, setConflict] = useState<{ section: string; current: number | null } | null>(null);
  const [pageNote, setPageNote] = useState<SectionNote | null>(null);

  /**
   * Replace `saved` with the server's document and re-derive `draft`: the
   * section just written (`only`) and every clean section follow the server;
   * a section with unsaved edits keeps them. So a save, a reset or a reload
   * never throws away work parked in another card.
   */
  const applyServer = useCallback((config: FarmConfigDocument, only?: string) => {
    setDocs(({ saved, draft }) => {
      if (!saved || !draft) return { saved: config, draft: config };
      const next: JsonObject = { ...config };
      for (const k of Object.keys(config)) {
        if (k === only) continue;
        if (k in draft && !jsonEqual(draft[k], saved[k])) next[k] = draft[k];
      }
      return { saved: config, draft: next };
    });
  }, []);

  const load = useCallback(async () => {
    const res = await farmAdminApi.config();
    setVersion(res.version);
    setDefaults(isPlainObject(res.defaults) ? res.defaults : {});
    setPub(isPlainObject(res.public) ? res.public : null);
    setProblems(Array.isArray(res.problems) ? res.problems : []);
    setSections(Array.isArray(res.sections) ? res.sections : null);
    applyServer(res.config);
    setConflict(null);
    return res;
  }, [applyServer]);

  useEffect(() => {
    let alive = true;
    load()
      .then((res) => {
        if (alive) setOpen((cur) => cur ?? orderedSections(res.config)[0] ?? null);
      })
      .catch((e: unknown) => {
        if (alive) setLoadErr(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const retry = () => {
    setLoadErr(null);
    setLoading(true);
    load()
      .catch((e: unknown) => setLoadErr(e))
      .finally(() => setLoading(false));
  };

  const refresh = async () => {
    setPageNote(null);
    try {
      const res = await load();
      setPageNote({ ok: true, text: s.refreshed(res.version) });
    } catch (e) {
      setPageNote({ ok: false, text: farmAdminErrorText(e, s.loadFailed) });
    }
  };

  const note = (section: string, n: SectionNote | null) =>
    setNotes((cur) => {
      const next = { ...cur };
      if (n) next[section] = n;
      else delete next[section];
      return next;
    });

  const change = (section: string, value: unknown) => {
    setDocs((d) => (d.draft ? { ...d, draft: { ...d.draft, [section]: value } } : d));
    note(section, null);
  };

  const discard = (section: string) => {
    setDocs((d) => (d.saved && d.draft ? { ...d, draft: { ...d.draft, [section]: d.saved[section] } } : d));
    setInvalid((i) => ({ ...i, [section]: [] }));
    note(section, { ok: true, text: s.discarded });
  };

  const save = async (section: string) => {
    const value = docs.draft?.[section];
    if (value === undefined || saving) return;
    setSaving(section);
    setInvalid((i) => ({ ...i, [section]: [] }));
    note(section, null);
    try {
      const res = await farmAdminApi.saveSection(section, value, version);
      setVersion(res.version);
      applyServer(res.config, section);
      setConflict(null);
      note(section, { ok: true, text: s.savedOk(res.version) });
      // The public projection and the stored-document problems are the
      // server's to compute; a quiet re-read keeps them true after a write.
      load().catch(() => undefined);
    } catch (e) {
      const current = farmAdminCurrentVersion(e);
      const list = farmAdminProblems(e);
      if (current !== null) setConflict({ section, current });
      else if (list.length) setInvalid((i) => ({ ...i, [section]: list }));
      else note(section, { ok: false, text: farmAdminErrorText(e, s.saveFailed) });
    } finally {
      setSaving('');
    }
  };

  const reset = async (section: string): Promise<boolean> => {
    setSaving(section);
    setInvalid((i) => ({ ...i, [section]: [] }));
    note(section, null);
    try {
      const res = await farmAdminApi.resetSection(section);
      setVersion(res.version);
      applyServer(res.config, section);
      setConflict(null);
      note(section, { ok: true, text: s.resetDone(res.version) });
      load().catch(() => undefined);
      return true;
    } catch (e) {
      const list = farmAdminProblems(e);
      if (list.length) setInvalid((i) => ({ ...i, [section]: list }));
      else note(section, { ok: false, text: farmAdminErrorText(e, s.saveFailed) });
      return false;
    } finally {
      setSaving('');
    }
  };

  const ctx = useMemo<EditorCtx>(
    () => ({ s, lang, doc: docs.draft ?? {}, saved: docs.saved }),
    [s, lang, docs.draft, docs.saved]
  );

  const ordered = orderedSections(docs.draft);
  const hidden = new Set(privateKeys(docs.saved ?? docs.draft, pub));
  const schema = docs.saved?.schema;

  return (
    <div dir={dir} className="min-w-0 space-y-4" data-farm-admin>
      <div className="flex flex-wrap items-start gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-black text-white flex items-center gap-2">
            <Factory className="w-5 h-5 text-gold" aria-hidden="true" />
            {s.title}
          </h2>
          <p className="text-[12.5px] text-zinc-400 leading-relaxed mt-1 max-w-3xl">{s.subtitle}</p>
          {docs.saved && (
            <div className="flex flex-wrap gap-1.5 mt-2 text-[11px] tabular-nums">
              <span className="h-6 px-2 rounded-full bg-gold/10 border border-gold/30 text-gold font-bold grid place-items-center" data-farm-version={version}>
                {s.version(version)}
              </span>
              {typeof schema === 'number' && (
                <span className="h-6 px-2 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 grid place-items-center">{s.schema(schema)}</span>
              )}
              <span className="h-6 px-2 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 grid place-items-center">{s.sectionsCount(ordered.length)}</span>
            </div>
          )}
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className={btnGhost} data-farm-refresh>
          <RefreshCw className="w-4 h-4" aria-hidden="true" />
          {s.refresh}
        </button>
      </div>

      {/* WHO MAY PLAY, before any balancing: while the game is shelved none of
          the numbers below reach a customer at all. */}
      <ShelvedPanel s={s} />

      {pageNote && (
        <p role={pageNote.ok ? 'status' : 'alert'} className={`text-[12px] ${pageNote.ok ? 'text-emerald-300' : 'text-red-400'}`} data-farm-page-note>
          {pageNote.text}
        </p>
      )}

      {loading && (
        <div role="status" className="flex items-center justify-center gap-2 py-12 text-[13px] text-zinc-400">
          <Spinner size="sm" delayMs={0} decorative />
          {s.loading}
        </div>
      )}

      {!loading && loadErr !== null && <ErrorState error={loadErr} onRetry={retry} compact />}

      {conflict && (
        <div role="alert">
          <Banner kind="warn">
            <p className="font-bold">{s.conflictTitle}</p>
            <p className="mt-0.5">{s.conflictBody(conflict.current ?? version)}</p>
            <p className="mt-0.5 text-[11px] opacity-80">{s.reloadNote}</p>
            <button type="button" onClick={() => void refresh()} className={`${btnGhost} mt-2 h-8 text-[12px]`} data-farm-conflict-reload>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              {s.reload}
            </button>
          </Banner>
        </div>
      )}

      {problems.length > 0 && (
        <Banner kind="error">
          <p className="font-bold">{s.problemsTitle}</p>
          <p className="mt-0.5">{s.problemsBody}</p>
          <ul className="mt-1.5 space-y-0.5" dir="ltr" data-farm-problems>
            {problems.map((p) => (
              <li key={p} className="font-mono text-[11px]">{p}</li>
            ))}
          </ul>
        </Banner>
      )}

      {docs.draft && docs.saved && (
        <div className="space-y-2.5 min-w-0" data-farm-sections>
          {ordered.map((section, i) => (
            <SectionPanel
              key={section}
              n={i + 1}
              section={section}
              open={open === section}
              onToggle={() => setOpen((cur) => (cur === section ? null : section))}
              draft={docs.draft?.[section]}
              fallback={defaults[section]}
              ctx={ctx}
              dirty={!jsonEqual(docs.draft?.[section], docs.saved?.[section])}
              saving={saving === section}
              savable={!sections || sections.includes(section)}
              isPrivate={hidden.has(section)}
              note={notes[section] ?? null}
              invalid={invalid[section] ?? []}
              storedProblems={problemsFor(section, problems)}
              onChange={(v) => change(section, v)}
              onSave={() => void save(section)}
              onDiscard={() => discard(section)}
              onReset={() => reset(section)}
            />
          ))}
        </div>
      )}

      {docs.saved && <PublicPreview config={docs.saved} pub={pub} s={s} lang={lang} />}

      {!loading && loadErr === null && <PlayersPanel s={s} lang={lang} />}
    </div>
  );
}
