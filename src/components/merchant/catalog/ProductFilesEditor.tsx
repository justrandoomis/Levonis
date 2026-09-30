/**
 * THE PRODUCT'S FILES — the merchant side of docs/COMMUNITY_ECOSYSTEM.md §9.4
 * «Files on products», opened from the product editor's «الملفات» section
 * (ProductEditorSheet.tsx mounts it lazily, so it is a chunk of its own).
 *
 *   ADD     a picked file goes up through the shared UploadTile (purpose
 *           `product_file`, entity = this product): resumable session,
 *           checksum step named, «إلغاء» / «إعادة المحاولة». When the tile
 *           answers with a key, the row is attached with
 *           POST /api/merchant/products/:id/files — the server checks the key
 *           is this owner's own PRIVATE upload; the client never decides that.
 *   ROLE    one Menu per row (معاينة / تنزيل بعد الشراء / مرجع / تعليمات /
 *           ملف المصدر), each item saying what the role means to a shopper.
 *   NAME    edited in place, saved when the field is left.
 *   ORDER   two buttons per row (up / down) — no drag-only affordance.
 *   REMOVE  after a confirmation that names the consequence (a buyer's grant
 *           goes with the row).
 *
 * Every refusal reads as a sentence in the merchant's language
 * (src/lib/refusalStrings.ts). What is on screen is what the server has: a
 * row appears when its attach answered, never from a local object URL. It
 * sits inside the product form, so every control is a plain button and Enter
 * in a name field blurs it instead of saving the product.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Box, ChevronDown, FileArchive, FileText, Image as ImageIcon, Plus, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { apiRefusal } from '../../../lib/refusalStrings';
import type { UploadLargeResult } from '../../../lib/uploadSession';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Menu } from '../../ui/Menu';
import { Skeleton } from '../../ui/Skeleton';
import { useConfirm } from '../../ui/ConfirmDialog';
import { UploadTile } from '../../upload/UploadTile';
import {
  PRODUCT_FILES_MAX,
  PRODUCT_FILE_ROLES,
  formatBytes,
  productFilesApi,
  type ProductFileOwned,
  type ProductFileRole,
} from '../../community/files/api';
import { productFilesStrings } from './strings';

/** What the picker offers: the model formats the server sniffs, and PDF. Archives wait for the allow-list. */
export const ACCEPTED_EXTENSIONS = ['stl', 'obj', '3mf', 'amf', 'glb', 'gltf', 'step', 'stp', 'pdf'] as const;
const MODEL_EXTENSIONS = new Set<string>(['stl', 'obj', '3mf', 'amf', 'glb', 'gltf', 'step', 'stp']);

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

export function acceptsFile(name: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/**
 * The role a new file starts with — the merchant changes it in one tap. The
 * first model becomes the product's 3D preview; every later model is the
 * printable a buyer gets; a document is instructions.
 */
export function defaultRole(name: string, existing: readonly Pick<ProductFileOwned, 'role'>[]): ProductFileRole {
  if (!MODEL_EXTENSIONS.has(extensionOf(name))) return 'instruction';
  return existing.some((f) => f.role === 'preview') ? 'download_after_purchase' : 'preview';
}

/** The list with row `i` moved one step, or the same list at an edge. */
export function moved<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

interface Pending {
  id: string;
  file: File;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = 'h-5 w-5 shrink-0 text-text-muted';
  if (kind === 'model') return <Box className={cls} strokeWidth={1.75} aria-hidden="true" />;
  if (kind === 'archive') return <FileArchive className={cls} strokeWidth={1.75} aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon className={cls} strokeWidth={1.75} aria-hidden="true" />;
  return <FileText className={cls} strokeWidth={1.75} aria-hidden="true" />;
}

let pendingSeq = 0;

export default function ProductFilesEditor({ productId, disabled = false }: { productId: string; disabled?: boolean }) {
  const { lang } = useLanguage();
  const s = productFilesStrings(lang);
  const [files, setFiles] = useState<ProductFileOwned[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const input = useRef<HTMLInputElement | null>(null);
  // The newest list, for uploads that answer one after another.
  const latest = useRef<ProductFileOwned[]>([]);
  latest.current = files ?? [];

  useEffect(() => {
    let alive = true;
    setLoadError('');
    productFilesApi
      .list(productId)
      .then((d) => alive && setFiles(d.files))
      .catch((e: unknown) => alive && setLoadError(apiRefusal(e, lang, s.loadFailed)));
    return () => {
      alive = false;
    };
    // The words follow the language on the next render; only the product decides the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, reload]);

  const commit = (next: ProductFileOwned[]) => {
    latest.current = next;
    setFiles(next);
  };

  function pick(list: FileList | null) {
    if (!list?.length) return;
    setError('');
    const room = Math.max(0, PRODUCT_FILES_MAX - latest.current.length - pending.length);
    const chosen = Array.from(list).slice(0, room);
    if (chosen.some((f) => !acceptsFile(f.name))) setError(s.kindWrong);
    const ok = chosen.filter((f) => acceptsFile(f.name)).map((file) => ({ id: `pending-${++pendingSeq}`, file }));
    if (ok.length) setPending((p) => [...p, ...ok]);
    if (input.current) input.current.value = '';
  }

  const drop = (id: string) => setPending((p) => p.filter((x) => x.id !== id));

  async function attach(p: Pending, result: UploadLargeResult) {
    if (!result.key) {
      drop(p.id);
      setError(s.addFailed);
      return;
    }
    try {
      const file = await productFilesApi.add(productId, { file_key: result.key, role: defaultRole(p.file.name, latest.current), name: p.file.name });
      if (!latest.current.some((f) => f.id === file.id)) commit([...latest.current, file]);
    } catch (e) {
      setError(apiRefusal(e, lang, s.addFailed));
    } finally {
      drop(p.id);
    }
  }

  async function patch(f: ProductFileOwned, change: { role?: ProductFileRole; name?: string }) {
    setError('');
    setBusy(f.id);
    try {
      const saved = await productFilesApi.update(productId, f.id, change);
      commit(latest.current.map((x) => (x.id === saved.id ? saved : x)));
    } catch (e) {
      setError(apiRefusal(e, lang, s.saveFailed));
    } finally {
      setBusy(null);
    }
  }

  async function move(i: number, dir: -1 | 1) {
    const next = moved(latest.current, i, dir);
    if (next.every((f, k) => f.id === latest.current[k]?.id)) return;
    setError('');
    setBusy(next[i + dir].id);
    commit(next);
    try {
      commit(await productFilesApi.reorder(productId, next.map((f) => f.id)));
    } catch (e) {
      setError(apiRefusal(e, lang, s.saveFailed));
      setReload((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  async function remove(f: ProductFileOwned) {
    const ok = await confirm({ title: s.removeTitle, consequence: s.removeConsequence, confirmLabel: s.removeConfirm, cancelLabel: s.cancel, destructive: true });
    if (!ok) return;
    setError('');
    setBusy(f.id);
    try {
      await productFilesApi.remove(productId, f.id);
      commit(latest.current.filter((x) => x.id !== f.id));
    } catch (e) {
      setError(apiRefusal(e, lang, s.saveFailed));
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-2" data-product-files-editor="error">
        <p role="alert" className="lv-field-error">
          {loadError}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
          {s.retry}
        </Button>
      </div>
    );
  }
  if (!files) {
    return (
      <div className="space-y-2" aria-busy="true" data-product-files-editor="loading">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-2/3" />
      </div>
    );
  }

  const room = PRODUCT_FILES_MAX - files.length - pending.length;
  const accept = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(',');

  return (
    <div className="space-y-3" data-product-files-editor="ready">
      {files.length > 0 && (
        <ul className="space-y-2" data-product-file-list>
          {files.map((f, i) => (
            <li key={f.id} className="rounded-xl border border-border-subtle bg-surface p-3" data-product-file-row={f.id} data-file-role={f.role}>
              <div className="flex items-center gap-2">
                <KindIcon kind={f.kind} />
                <Input
                  key={`${f.id}:${f.name}`}
                  defaultValue={f.name}
                  maxLength={120}
                  aria-label={s.name}
                  dir="auto"
                  className="min-w-0 flex-1"
                  disabled={disabled || busy === f.id}
                  onBlur={(e) => {
                    const name = e.currentTarget.value.trim();
                    if (name && name !== f.name) void patch(f, { name });
                    else e.currentTarget.value = f.name;
                  }}
                  onKeyDown={(e) => {
                    // Inside the product form: Enter finishes the name, it does not save the product.
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
                <IconButton label={s.remove} variant="danger" icon={<X className="h-4 w-4" />} disabled={disabled || busy === f.id} onClick={() => remove(f)} />
              </div>
              {/* The size, and for a model whether the shopper gets the viewer — a caption under the name, never truncated. */}
              <p className="mt-1 text-[11.5px] tabular-nums text-text-muted" style={{ paddingInlineStart: 28 }} dir="auto">
                {formatBytes(f.bytes, lang)}
                {f.kind === 'model' ? ` · ${f.has_preview ? s.hasPreview : s.noPreview}` : ''}
              </p>
              {/* One line of controls that fits 264px: the role at the start, the two move buttons at the end. */}
              <div className="mt-1.5 flex items-center gap-2">
                <Menu
                  label={s.role}
                  items={PRODUCT_FILE_ROLES.map((r) => ({ id: r, label: s.roles[r], hint: s.roleHints[r], onSelect: () => void patch(f, { role: r }) }))}
                  trigger={(props) => (
                    <Button {...props} size="sm" variant="secondary" iconEnd={<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />} disabled={disabled || busy === f.id} className="min-w-0" data-file-role-menu={f.id}>
                      <span className="truncate">{s.roles[f.role]}</span>
                    </Button>
                  )}
                />
                <span className="ms-auto flex shrink-0 items-center">
                  <IconButton label={s.moveUp} icon={<ArrowUp className="h-4 w-4" />} disabled={disabled || i === 0 || busy !== null} onClick={() => move(i, -1)} />
                  <IconButton label={s.moveDown} icon={<ArrowDown className="h-4 w-4" />} disabled={disabled || i === files.length - 1 || busy !== null} onClick={() => move(i, 1)} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <ul className="space-y-2" data-product-file-uploads>
          {pending.map((p) => (
            <li key={p.id}>
              <UploadTile file={p.file} purpose="product_file" entityId={productId} onDone={(result) => void attach(p, result)} onCancel={() => drop(p.id)} />
            </li>
          ))}
        </ul>
      )}

      {files.length === 0 && pending.length === 0 && <p className="text-[12.5px] leading-relaxed text-text-muted">{s.empty}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={accept} multiple className="sr-only" tabIndex={-1} onChange={(e) => pick(e.target.files)} data-product-file-input />
        <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} disabled={disabled || room <= 0} onClick={() => input.current?.click()} data-add-product-file>
          {s.add}
        </Button>
        <span className="text-[12px] tabular-nums text-text-muted">{s.count(files.length, PRODUCT_FILES_MAX)}</span>
      </div>
      <p className="text-[12px] leading-relaxed text-text-muted">{s.hint}</p>
      {error && (
        <p role="alert" className="lv-field-error" data-product-files-error>
          {error}
        </p>
      )}
      {confirmDialog}
    </div>
  );
}
