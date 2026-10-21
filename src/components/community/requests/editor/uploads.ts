/**
 * THE EDITOR’S UPLOADS (plan P1-06, acceptance 13; design §4.3, critique 10
 * of the second).
 *
 * Each picked file is its own row with its own state, and one failure never
 * stops the others (partial success):
 *
 *   rejected   asked the request table before a byte is sent (kind, size,
 *              count) and refused — with its reason; never counted, never sent
 *   queued     waiting for one of the two upload lanes
 *   checking   the session door hashing the file (named, with a percentage:
 *              a phone reading 300 MB must not look stuck)
 *   uploading  the bytes, part by part
 *   finishing  the server proving and storing it
 *   failed     with the reason in the reader’s words, «أعد المحاولة» and «ألغِ»
 *
 * A stored file leaves the list and becomes a source of the request.
 *
 * TWO DOORS, the table’s choice (`pickRequestUpload`): a model, or anything
 * over 8 MiB, through a resumable session; the rest whole-body.
 *
 * A RETRY NEVER STORES A SECOND COPY. A session retry runs the same File for
 * the same request, so `uploadLarge` finds the same resume record and the
 * server continues from the parts it holds; when the last try’s «complete»
 * landed but its answer was lost, the session answers with the file it
 * stored and nothing is sent again (src/lib/uploadSession.ts). A whole-body
 * retry first reads the draft back: a file of the same name and size that
 * arrived after the try began is that try’s file, and is adopted.
 *
 * A picture is drawn from its object URL from the moment it is picked; the
 * URL is revoked when the row leaves (stored, cancelled, hidden) and when the
 * editor closes. Leaving the editor mid-upload keeps a session for a resume
 * (UPLOAD_KEEP_SESSION); «ألغِ» deletes it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../../lib/api';
import { UPLOAD_KEEP_SESSION, pickRequestUpload, resumeKey, uploadLarge, type UploadProgress } from '../../../../lib/uploadSession';
import { REQUEST_FILE_LIMITS, requestFileKind, requestFileProblem, type RequestFileKind } from '../../../../../packages/contracts/src/requestFiles';
import { namedForUpload, requestFileProblemText, requestUploadRefusal } from '../fileRefusals';
import type { DraftFile, ModelAnalysis } from '../api';
import type { EditorLang } from './strings';

export type UploadStatus = 'rejected' | 'queued' | 'checking' | 'uploading' | 'finishing' | 'failed';

export interface UploadRow {
  key: string;
  file: File;
  name: string;
  kind: RequestFileKind | null;
  /** A picture’s device preview (`blob:`), while it is on its way. */
  preview: string | null;
  status: UploadStatus;
  loaded: number;
  total: number;
  part?: number;
  parts?: number;
  /** Why it was refused or did not upload, in the reader’s words. */
  reason: string;
  door: 'session' | 'simple';
}

/** A picture: the one kind a device can preview before the upload. */
const isPicture = (f: Pick<File, 'name' | 'type'>) => requestFileKind(f.name) === 'image' || String(f.type ?? '').startsWith('image/');

/** A device preview for a picture (an object URL), null for anything else. */
export function previewUrl(f: File): string | null {
  if (!isPicture(f) || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    return URL.createObjectURL(f);
  } catch {
    return null;
  }
}

/** Revoke previews: the browser frees the bytes the moment a file leaves. */
export function releasePreviews(rows: ReadonlyArray<Pick<UploadRow, 'preview'>>): void {
  for (const r of rows) {
    if (r.preview && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(r.preview);
  }
}

/**
 * The rows of one pick: every file asked the table in turn, with the files
 * the request already holds or is uploading counted, so a seventh is refused
 * with its reason instead of being dropped.
 */
export function rowsForPick(files: readonly File[], lang: EditorLang, alreadyCounted: number, mintKey: () => string): UploadRow[] {
  let counted = alreadyCounted;
  return files.map((raw) => {
    const file = namedForUpload(raw);
    const problem = requestFileProblem(file, counted);
    const base = {
      key: mintKey(),
      file,
      name: file.name,
      kind: requestFileKind(file.name),
      loaded: 0,
      total: file.size,
      door: pickRequestUpload(file),
    } as const;
    if (problem) return { ...base, preview: null, status: 'rejected' as const, reason: requestFileProblemText(problem, lang) };
    counted += 1;
    return { ...base, preview: previewUrl(file), status: 'queued' as const, reason: '' };
  });
}

/** The rows that still take one of the six places. */
export const countsTowardLimit = (r: Pick<UploadRow, 'status'>) => r.status !== 'rejected';
export const isWorking = (r: Pick<UploadRow, 'status'>) => r.status === 'queued' || r.status === 'checking' || r.status === 'uploading' || r.status === 'finishing';

/** «رُفع 3 من 4 — 1 لم يُرفع»: the numbers, while something is working or failed. */
export function uploadSummary(rows: readonly UploadRow[], storedThisVisit: number): { ok: number; all: number; failed: number } | null {
  const failed = rows.filter((r) => r.status === 'failed').length;
  const working = rows.filter(isWorking).length;
  if (!failed) return null;
  return { ok: storedThisVisit, all: storedThisVisit + failed + working, failed };
}

/**
 * The names of this request’s uploads a reload interrupted: the resume
 * records src/lib/uploadSession.ts keeps under
 * `levonis.upload.request:<id>:<size>:<mtime>:<name>`. A browser cannot keep
 * the File across a reload, so the customer is asked to pick it again.
 */
export function unfinishedUploads(requestId: string, storage: Pick<Storage, 'length' | 'key'> | null | undefined): string[] {
  if (!requestId || !storage) return [];
  const prefix = resumeKey('request', '', requestId);
  const names: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i) ?? '';
      if (!k.startsWith(prefix)) continue;
      const name = k.slice(prefix.length).split(':').slice(2).join(':');
      if (name) names.push(name);
    }
  } catch {
    // a blocked storage only costs the hint
  }
  return names;
}

/** A file the server stored, as the draft lists it. */
export function storedFile(raw: Record<string, unknown> | null | undefined, analysis?: unknown): DraftFile | null {
  if (!raw || typeof raw.id !== 'string') return null;
  const a = analysis && typeof analysis === 'object' ? (analysis as ModelAnalysis) : null;
  return {
    id: raw.id,
    file_name: String(raw.file_name ?? ''),
    content_type: String(raw.content_type ?? ''),
    size_bytes: Number(raw.size_bytes ?? 0),
    kind: String(raw.kind ?? ''),
    inline: raw.inline === true || String(raw.content_type ?? '').startsWith('image/'),
    url: String(raw.url ?? ''),
    analysis: a,
  };
}

/** A whole-body retry: the file a lost answer already stored, if it is there. */
export function landedMeanwhile(files: readonly DraftFile[], known: ReadonlySet<string>, f: Pick<File, 'name' | 'size'>): DraftFile | null {
  return files.find((x) => !known.has(x.id) && x.file_name === f.name && x.size_bytes === f.size) ?? null;
}

const LANES = 2;

export interface UploadsApi {
  rows: UploadRow[];
  add: (files: File[]) => void;
  retry: (key: string) => void;
  cancel: (key: string) => void;
  dismiss: (key: string) => void;
  working: number;
  failed: number;
  storedThisVisit: number;
}

export function useUploads(opts: {
  lang: EditorLang;
  /** The request id, creating the draft first when there is none (its first durable act). */
  ensureRequest: () => Promise<string>;
  /** Called once before a pick starts uploading: the save is flushed so the door revises what the customer sees. */
  beforeUpload: () => Promise<unknown>;
  /** The files the request holds now. */
  storedFiles: () => readonly DraftFile[];
  /** The draft’s files as the server has them now (a whole-body retry asks before sending again). */
  readFiles: (requestId: string) => Promise<DraftFile[]>;
  onStored: (file: DraftFile) => void;
  /** The words for a failure the refusal table cannot name (a dropped connection). */
  failedText: string;
}): UploadsApi {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const rowsRef = useRef<UploadRow[]>([]);
  rowsRef.current = rows;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const controllers = useRef(new Map<string, AbortController>());
  const knownAtStart = useRef(new Map<string, Set<string>>());
  const seq = useRef(0);
  const [storedThisVisit, setStoredThisVisit] = useState(0);
  const running = useRef(0);

  const patch = useCallback((key: string, p: Partial<UploadRow>) => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...p } : r)));
    rowsRef.current = rowsRef.current.map((r) => (r.key === key ? { ...r, ...p } : r));
  }, []);
  const drop = useCallback((key: string) => {
    const gone = rowsRef.current.filter((r) => r.key === key);
    releasePreviews(gone);
    rowsRef.current = rowsRef.current.filter((r) => r.key !== key);
    setRows((list) => list.filter((r) => r.key !== key));
  }, []);

  const run = useCallback(
    async (row: UploadRow) => {
      const o = optsRef.current;
      const controller = new AbortController();
      controllers.current.set(row.key, controller);
      running.current += 1;
      try {
        const requestId = await o.ensureRequest();
        if (!knownAtStart.current.has(row.key)) knownAtStart.current.set(row.key, new Set(o.storedFiles().map((f) => f.id)));
        let stored: DraftFile | null = null;
        if (row.door === 'session') {
          patch(row.key, { status: 'checking', loaded: 0 });
          const result = await uploadLarge(row.file, 'request', {
            entityId: requestId,
            signal: controller.signal,
            onProgress: (p: UploadProgress) => {
              if (!controllers.current.has(row.key)) return;
              patch(row.key, {
                status: p.phase === 'hashing' ? 'checking' : p.phase === 'finishing' ? 'finishing' : 'uploading',
                loaded: p.loaded,
                total: p.total,
                part: p.part,
                parts: p.parts,
              });
            },
          });
          stored = storedFile(result.file, result.analysis);
        } else {
          // A retry of a whole-body upload asks first: the last try may have landed.
          const known = knownAtStart.current.get(row.key) ?? new Set<string>();
          const landed = row.reason ? landedMeanwhile(await o.readFiles(requestId), known, row.file) : null;
          if (landed) stored = landed;
          else {
            patch(row.key, { status: 'uploading', loaded: 0 });
            const form = new FormData();
            form.append('file', row.file);
            const res = await api.post<{ file: Record<string, unknown> }>(`/api/marketplace/requests/${encodeURIComponent(requestId)}/files`, form, {
              signal: controller.signal,
              timeoutMs: 0,
            });
            stored = storedFile(res.file);
          }
        }
        if (!controllers.current.has(row.key)) return;
        if (stored) {
          o.onStored(stored);
          setStoredThisVisit((n) => n + 1);
        }
        knownAtStart.current.delete(row.key);
        drop(row.key);
      } catch (e) {
        if (!controllers.current.has(row.key) || controller.signal.aborted) return;
        patch(row.key, { status: 'failed', reason: requestUploadRefusal(e, o.lang, o.failedText) || o.failedText });
      } finally {
        controllers.current.delete(row.key);
        running.current -= 1;
        pump();
      }
    },
    // `pump` is declared below and stable; the ref keeps the latest options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, drop]
  );

  const pump = useCallback(() => {
    while (running.current < LANES) {
      const next = rowsRef.current.find((r) => r.status === 'queued' && !controllers.current.has(r.key));
      if (!next) return;
      // Marked before it starts, so the next turn of the loop does not take it again.
      controllers.current.set(next.key, new AbortController());
      void run(next);
    }
  }, [run]);

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const o = optsRef.current;
      const already = o.storedFiles().length + rowsRef.current.filter(countsTowardLimit).length;
      const fresh = rowsForPick(files, o.lang, Math.min(already, REQUEST_FILE_LIMITS.maxFiles), () => `up_${++seq.current}`);
      rowsRef.current = [...rowsRef.current, ...fresh];
      setRows((list) => [...list, ...fresh]);
      if (!fresh.some((r) => r.status === 'queued')) return;
      // The draft exists and the server has what the customer typed before a byte is sent.
      void (async () => {
        try {
          await o.ensureRequest();
          await o.beforeUpload();
        } catch {
          // the rows fail on their own, with the reason
        }
        pump();
      })();
    },
    [pump]
  );

  const retry = useCallback(
    (key: string) => {
      const row = rowsRef.current.find((r) => r.key === key);
      if (!row || row.status !== 'failed') return;
      patch(key, { status: 'queued' });
      pump();
    },
    [patch, pump]
  );

  const cancel = useCallback(
    (key: string) => {
      const c = controllers.current.get(key);
      controllers.current.delete(key);
      // No reason: the session is deleted, not kept for a resume.
      c?.abort();
      knownAtStart.current.delete(key);
      drop(key);
    },
    [drop]
  );

  const dismiss = useCallback((key: string) => drop(key), [drop]);

  // Leaving the editor keeps every session for a resume, and frees every preview.
  useEffect(
    () => () => {
      for (const c of controllers.current.values()) c.abort(UPLOAD_KEEP_SESSION);
      controllers.current.clear();
      releasePreviews(rowsRef.current);
    },
    []
  );

  return {
    rows,
    add,
    retry,
    cancel,
    dismiss,
    working: rows.filter(isWorking).length,
    failed: rows.filter((r) => r.status === 'failed').length,
    storedThisVisit,
  };
}
