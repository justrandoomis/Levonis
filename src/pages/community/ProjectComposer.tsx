/**
 * THE COMPOSER — /community/projects/new and /community/projects/:id/edit.
 * One page, one form: the pictures first (they are the project), then the
 * title and the kind, then the facts a maker records, then the doors — a
 * store owner may link the piece to their store and one of its products.
 *
 * WHAT IS SAVED IS WHAT THE SERVER ACCEPTED. «احفظ مسودة» creates or updates
 * the draft; «انشر» saves and then publishes, and the refusal that comes back
 * (a picture that is not yours, a link that is not yours, a consent still
 * pending) is shown in the reader's language beside the field it names.
 * Every id sent is checked again on the server (docs/COMMUNITY_ECOSYSTEM.md).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Search, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useGoBack } from '../../lib/useGoBack';
import { api, ApiError, type ApiProduct } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { merchantApi, type MerchantMe, type MerchantProduct } from '../../lib/merchant';
import { productName } from '../../lib/productText';
import { Button } from '../../components/ui/Button';
import { Field, Input, Textarea, focusFirstInvalid } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { Switch } from '../../components/ui/Switch';
import { ErrorState } from '../../components/ui/AsyncStates';
import { toast } from '../../components/ui/Toast';
import { ProjectMediaPicker, type PickedMedia } from '../../components/community/projects/MediaPicker';
import { FileComposer, type ComposerFile } from '../../components/community/projects/FileComposer';
import type { PostFile, PostFileInput } from '../../components/community/files/api';
import { POST_KINDS, projectsApi, type Post, type PostInput, type PostKind, type PostVisibility } from '../../components/community/projects/api';
import { useProjectStrings } from '../../components/community/projects/strings';
import { warmLinksOnPaste } from '../../components/community/links/useLinkCard';
// Moderation V2 (docs/COMMUNITY_ECOSYSTEM.md §9.6): a restricted, suspended or
// banned account is told at the door, before it writes a post the server will
// refuse (USER_RESTRICTED …) — a lazy chunk only such an account fetches.
const StatusBanner = React.lazy(() => import('../../components/community/moderation/StatusBanner'));

type Draft = {
  title: string;
  body: string;
  kind: PostKind;
  visibility: PostVisibility;
  printer: { id: string | null; name: string };
  material: { id: string | null; name: string };
  color: string;
  hours: string;
  minutes: string;
  x: string;
  y: string;
  z: string;
  layer: string;
  infill: string;
  nozzle: string;
  supports: boolean | null;
  tags: string;
  store_id: string | null;
  product_id: string | null;
  media: PickedMedia[];
  /** The models and documents (§9.4): keys from purpose=post sessions, ≤ 3. */
  files: ComposerFile[];
};

const EMPTY: Draft = {
  title: '',
  body: '',
  kind: 'project',
  visibility: 'public',
  printer: { id: null, name: '' },
  material: { id: null, name: '' },
  color: '',
  hours: '',
  minutes: '',
  x: '',
  y: '',
  z: '',
  layer: '',
  infill: '',
  nozzle: '',
  supports: null,
  tags: '',
  store_id: null,
  product_id: null,
  media: [],
  files: [],
};

/** GET /posts/:id answers `files[]` (§9.4) — the projects api type predates it. */
type PostWithFiles = Post & { files?: PostFile[] };

function fromPost(p: PostWithFiles): Draft {
  const t = p.print_time_minutes ?? 0;
  return {
    title: p.title,
    body: p.body,
    kind: p.kind,
    visibility: p.visibility,
    printer: { id: p.printer.product?.id ?? null, name: p.printer.product ? '' : p.printer.name },
    material: { id: p.material.product?.id ?? null, name: p.material.product ? '' : p.material.name },
    color: p.color,
    hours: t ? String(Math.floor(t / 60)) : '',
    minutes: t ? String(t % 60) : '',
    x: p.dimensions.x_mm ? String(p.dimensions.x_mm) : '',
    y: p.dimensions.y_mm ? String(p.dimensions.y_mm) : '',
    z: p.dimensions.z_mm ? String(p.dimensions.z_mm) : '',
    layer: p.print_settings.layer_height_mm != null ? String(p.print_settings.layer_height_mm) : '',
    infill: p.print_settings.infill_percent != null ? String(p.print_settings.infill_percent) : '',
    nozzle: p.print_settings.nozzle_mm != null ? String(p.print_settings.nozzle_mm) : '',
    supports: typeof p.print_settings.supports === 'boolean' ? p.print_settings.supports : null,
    tags: p.tags.join(', '),
    store_id: p.store?.id ?? null,
    product_id: p.product?.id ?? null,
    media: p.media.filter((m): m is typeof m & { key: string } => typeof m.key === 'string').map((m) => ({ key: m.key, url: m.url, kind: m.kind, width: m.width, height: m.height, duration_s: m.duration_s })),
    // The author's own read carries each file's key; a row without one cannot be sent back and is dropped.
    files: (p.files ?? [])
      .filter((f): f is PostFile & { key: string } => typeof f.key === 'string')
      .map((f) => ({ key: f.key, name: f.name, bytes: f.bytes, kind: f.kind, downloadable: f.downloadable })),
  };
}

const num = (v: string): number | undefined => {
  const n = Number(String(v).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim());
  return v.trim() === '' || !Number.isFinite(n) ? undefined : n;
};

function toInput(d: Draft): Partial<PostInput> & { files: PostFileInput[] } {
  const h = num(d.hours) ?? 0;
  const mnt = num(d.minutes) ?? 0;
  const time = d.hours.trim() === '' && d.minutes.trim() === '' ? null : Math.round(h * 60 + mnt);
  const dims: Partial<Record<'x_mm' | 'y_mm' | 'z_mm', number>> = {};
  const x = num(d.x), y = num(d.y), z = num(d.z);
  if (x) dims.x_mm = x;
  if (y) dims.y_mm = y;
  if (z) dims.z_mm = z;
  const settings: PostInput['print_settings'] = {};
  const layer = num(d.layer), infill = num(d.infill), nozzle = num(d.nozzle);
  if (layer !== undefined) settings.layer_height_mm = layer;
  if (infill !== undefined) settings.infill_percent = infill;
  if (nozzle !== undefined) settings.nozzle_mm = nozzle;
  if (d.supports !== null) settings.supports = d.supports;
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    kind: d.kind,
    visibility: d.visibility,
    printer_product_id: d.printer.id,
    printer_name: d.printer.id ? '' : d.printer.name.trim(),
    material_product_id: d.material.id,
    material: d.material.id ? '' : d.material.name.trim(),
    color: d.color.trim(),
    print_time_minutes: time,
    dimensions: dims,
    print_settings: settings,
    tags: d.tags.split(/[,،]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 10),
    store_id: d.store_id,
    product_id: d.store_id ? d.product_id : null,
    media: d.media.map((m) => ({ key: m.key, kind: m.kind, width: m.width, height: m.height, duration_s: m.duration_s })),
    files: d.files.map((f) => ({ file_key: f.key, name: f.name.trim(), downloadable: f.downloadable })),
  };
}

export default function ProjectComposer() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const goBack = useGoBack('/community');
  const { loc, lang, dir } = useLanguage();
  const { user } = useAuth();
  const s = useProjectStrings();
  const refusalLang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [postId, setPostId] = useState<string | null>(id ?? null);
  const [loaded, setLoaded] = useState(!editing);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [storeProducts, setStoreProducts] = useState<MerchantProduct[] | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // An existing project is loaded into the form; only its author gets here
  // (the server answers 404 to anyone else, which reads as «not found»).
  useEffect(() => {
    if (!editing) return;
    let alive = true;
    projectsApi
      .get(id)
      .then((p) => {
        if (!alive) return;
        if (!p.viewer.mine) throw new ApiError(404, 'Not yours', 'NOT_FOUND');
        setDraft(fromPost(p));
        setLoaded(true);
      })
      .catch((e: unknown) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [editing, id]);

  // A store owner may link the piece to their store; the products list is
  // read only once they turn that on.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    merchantApi.me().then((d) => alive && setMe(d)).catch(() => alive && setMe(null));
    return () => {
      alive = false;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!draft.store_id || storeProducts) return;
    let alive = true;
    merchantApi
      .products()
      .then((d) => alive && setStoreProducts(d.products))
      .catch(() => alive && setStoreProducts([]));
    return () => {
      alive = false;
    };
  }, [draft.store_id, storeProducts]);

  const validate = (publishing: boolean): boolean => {
    const e: Record<string, string> = {};
    if (draft.title.trim().length < 3) e.title = loc('اكتب عنوانًا من 3 أحرف على الأقل.', 'Write a title of at least 3 characters.', 'ناونیشانێک بنووسە لانیکەم ٣ پیت.');
    if (publishing && draft.media.length === 0) e.media = loc('أضف صورة واحدة على الأقل قبل النشر.', 'Add at least one picture before publishing.', 'پێش بڵاوکردنەوە لانیکەم یەک وێنە زیاد بکە.');
    setErrors(e);
    if (Object.keys(e).length) {
      focusFirstInvalid(formRef.current);
      return false;
    }
    return true;
  };

  const save = async (): Promise<Post | null> => {
    const input = toInput(draft);
    return postId ? projectsApi.update(postId, input) : projectsApi.create(input);
  };

  const fieldOf = (code: string | undefined): string => {
    if (!code) return 'form';
    if (code.startsWith('POST_MEDIA')) return 'media';
    if (code.startsWith('POST_FILE')) return 'files';
    if (code.startsWith('POST_LINK')) return 'links';
    if (code === 'POST_SETTING_INVALID') return 'settings';
    if (code.startsWith('CONSENT')) return 'links';
    return 'form';
  };

  const onSave = async (publish: boolean) => {
    if (busy || !validate(publish)) return;
    setBusy(publish ? 'publish' : 'save');
    setErrors({});
    try {
      let p = await save();
      if (!p) return;
      setPostId(p.id);
      if (publish) {
        p = await projectsApi.publish(p.id);
        toast.success(s.published);
      } else {
        toast.success(s.saved);
      }
      navigate(p.url, { replace: true });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const msg = apiRefusal(e, refusalLang, loc('تعذّر الحفظ. حاول مرة أخرى.', 'Could not save. Try again.', 'نەتوانرا پاشەکەوت بکرێت. دووبارە هەوڵ بدە.'));
      setErrors({ [fieldOf(code)]: msg });
      if (fieldOf(code) === 'form') toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const kindItems = useMemo(() => POST_KINDS.map((k) => ({ id: k, label: s.kinds[k] })), [s]);
  const canLinkStore = !!me?.store;

  return (
    <div className="min-h-screen bg-canvas pb-28 text-text-primary">
      <div className="material scroll-edge sticky top-0 z-40 h-14 px-4">
        <div className="mx-auto flex h-full max-w-2xl items-center gap-2">
          <button
            type="button"
            aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
            onClick={goBack}
            className="press-scale -ms-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Back className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold">{editing ? s.editProject : s.shareWhatYouPrinted}</h1>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 pt-4">
        {loadError ? (
          <ErrorState error={loadError} />
        ) : !loaded ? (
          <div aria-hidden="true" className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="aspect-square animate-pulse rounded-2xl bg-surface-selected motion-reduce:animate-none" />
              ))}
            </div>
            <div className="h-12 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
            <div className="h-28 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
          </div>
        ) : (
          <form ref={formRef} onSubmit={(e) => { e.preventDefault(); void onSave(!editing || draft.visibility !== 'private'); }} className="flex flex-col gap-6" data-project-composer>
            {['restricted', 'suspended', 'banned'].includes(String((user as { moderation?: { status?: unknown } } | null)?.moderation?.status ?? '')) && (
              <React.Suspense fallback={null}>
                <StatusBanner />
              </React.Suspense>
            )}
            <section aria-labelledby="c-pictures">
              <h2 id="c-pictures" className="mb-2 text-[13px] font-semibold text-text-secondary">
                {s.pictures}
              </h2>
              <ProjectMediaPicker value={draft.media} onChange={(m) => set('media', m)} disabled={!!busy} error={errors.media} />
            </section>

            <Field label={s.title} required error={errors.title}>
              <Input value={draft.title} maxLength={120} onChange={(e) => set('title', e.target.value)} placeholder={s.titlePh} data-composer="title" />
            </Field>

            <div role="group" aria-label={s.kind}>
              <p className="mb-2 text-[13px] font-semibold text-text-secondary">{s.kind}</p>
              <div className="flex flex-wrap gap-2">
                {kindItems.map((k) => (
                  <button key={k.id} type="button" className="lv-choice" aria-pressed={draft.kind === k.id} onClick={() => set('kind', k.id)} data-composer-kind={k.id}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>

            <Field label={s.body} optional>
              {/* a pasted address is resolved now (§9.4), so the card is warm the moment the post is published */}
              <Textarea value={draft.body} rows={5} maxLength={4000} onChange={(e) => set('body', e.target.value)} onPaste={warmLinksOnPaste} placeholder={s.bodyPh} />
            </Field>

            {/* THE FILES (§9.4) — the model behind the pictures, or a PDF of the
                instructions; each goes up through a resumable session. */}
            <section aria-labelledby="c-files">
              <h2 id="c-files" className="mb-2 text-[13px] font-semibold text-text-secondary">
                {s.modelFile}
              </h2>
              <FileComposer value={draft.files} onChange={(f) => set('files', f)} disabled={!!busy} error={errors.files} />
            </section>

            {/* THE FACTS */}
            <section aria-labelledby="c-facts" className="flex flex-col gap-4 rounded-2xl border border-border-subtle/60 bg-surface p-4">
              <h2 id="c-facts" className="text-[13px] font-semibold text-text-secondary">
                {s.settings}
              </h2>
              <CataloguePick label={s.printer} category="cat_printers" value={draft.printer} onChange={(v) => set('printer', v)} placeholder={s.printerPh} />
              <CataloguePick label={s.material} category="cat_materials" value={draft.material} onChange={(v) => set('material', v)} placeholder={s.materialPh} />
              <div className="grid grid-cols-2 gap-3">
                <Field label={s.color} optional>
                  <Input value={draft.color} maxLength={40} onChange={(e) => set('color', e.target.value)} placeholder={s.colorPh} />
                </Field>
                <Field label={s.printTime} optional>
                  <div className="flex gap-2" dir="ltr">
                    <Input inputMode="numeric" value={draft.hours} onChange={(e) => set('hours', e.target.value)} placeholder={s.hours} aria-label={s.hours} className="text-center" />
                    <Input inputMode="numeric" value={draft.minutes} onChange={(e) => set('minutes', e.target.value)} placeholder={s.minutes} aria-label={s.minutes} className="text-center" />
                  </div>
                </Field>
              </div>
              <Field label={`${s.size} (${s.mm})`} optional>
                <div className="grid grid-cols-3 gap-2" dir="ltr">
                  <Input inputMode="decimal" value={draft.x} onChange={(e) => set('x', e.target.value)} placeholder="X" aria-label="X" className="text-center" />
                  <Input inputMode="decimal" value={draft.y} onChange={(e) => set('y', e.target.value)} placeholder="Y" aria-label="Y" className="text-center" />
                  <Input inputMode="decimal" value={draft.z} onChange={(e) => set('z', e.target.value)} placeholder="Z" aria-label="Z" className="text-center" />
                </div>
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label={`${s.layer} (${s.mm})`} optional error={errors.settings}>
                  <Input inputMode="decimal" value={draft.layer} onChange={(e) => set('layer', e.target.value)} placeholder="0.2" dir="ltr" className="text-center" />
                </Field>
                <Field label={`${s.infill} %`} optional>
                  <Input inputMode="numeric" value={draft.infill} onChange={(e) => set('infill', e.target.value)} placeholder="15" dir="ltr" className="text-center" />
                </Field>
                <Field label={`${s.nozzle} (${s.mm})`} optional>
                  <Input inputMode="decimal" value={draft.nozzle} onChange={(e) => set('nozzle', e.target.value)} placeholder="0.4" dir="ltr" className="text-center" />
                </Field>
              </div>
              <Segmented
                group="supports"
                label={s.supports}
                size="sm"
                items={[
                  { id: 'none', label: '—' },
                  { id: 'yes', label: s.withSupports },
                  { id: 'no', label: s.noSupports },
                ]}
                value={draft.supports === null ? 'none' : draft.supports ? 'yes' : 'no'}
                onChange={(v) => set('supports', v === 'none' ? null : v === 'yes')}
              />
            </section>

            <Field label={s.tags} optional hint={s.tagsHint}>
              <Input value={draft.tags} maxLength={200} onChange={(e) => set('tags', e.target.value)} placeholder="dragon, articulated, PLA" />
            </Field>

            {/* THE DOORS — only for a store owner */}
            {canLinkStore && me?.store && (
              <section className="flex flex-col gap-3 rounded-2xl border border-border-subtle/60 bg-surface p-4">
                <Switch
                  checked={!!draft.store_id}
                  onChange={(on) => set('store_id', on ? me.store!.id : null)}
                  label={s.linkToStore}
                  description={s.linkToStoreHint}
                />
                {draft.store_id && (
                  <Field label={s.linkedProduct} optional error={errors.links}>
                    <select
                      className="lv-input"
                      value={draft.product_id ?? ''}
                      onChange={(e) => set('product_id', e.target.value || null)}
                      data-composer="product"
                    >
                      <option value="">{s.noProduct}</option>
                      {(storeProducts ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {productName(p, lang)}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {!draft.store_id && errors.links && <p className="lv-field-error" role="alert">{errors.links}</p>}
              </section>
            )}
            {!canLinkStore && errors.links && <p className="lv-field-error" role="alert">{errors.links}</p>}

            <div>
              <p className="mb-2 text-[13px] font-semibold text-text-secondary">{loc('من يرى المشروع', 'Who can see it', 'کێ دەیبینێت')}</p>
              <Segmented
                group="visibility"
                label={loc('من يرى المشروع', 'Who can see it', 'کێ دەیبینێت')}
                size="sm"
                items={(['public', 'unlisted', 'private'] as const).map((v) => ({ id: v, label: s.visibility[v] }))}
                value={draft.visibility}
                onChange={(v) => set('visibility', v as PostVisibility)}
              />
              <p className="mt-1.5 text-[12px] text-text-muted">{s.visibilityHint[draft.visibility]}</p>
            </div>

            {!editing && user?.username && !user.creator_public && (
              <p className="text-[12px] leading-relaxed text-text-muted">{s.creatorPageOn.replace('{username}', user.username)}</p>
            )}
            {errors.form && (
              <p className="lv-field-error" role="alert">
                {errors.form}
              </p>
            )}
          </form>
        )}
      </div>

      {loaded && !loadError && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle/60 bg-canvas/95 px-4 pt-3 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-2xl items-center gap-2">
            <Button variant="secondary" onClick={goBack} disabled={!!busy}>
              {loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}
            </Button>
            <div className="ms-auto" />
            <Button variant="ghost" onClick={() => onSave(false)} loading={busy === 'save'} loadingLabel={s.saving} data-composer="save">
              {editing ? s.saveChanges : s.saveDraft}
            </Button>
            <Button variant="primary" onClick={() => onSave(true)} loading={busy === 'publish'} loadingLabel={s.publishing} data-composer="publish">
              {s.publish}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- catalogue pick

/**
 * A printer or a material: pick one from the catalogue (its id travels, and
 * the project links to its page) or just write its name. The catalogue is
 * searched on the server as the person types; nothing is loaded up front.
 */
function CataloguePick({
  label,
  category,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  category: string;
  value: { id: string | null; name: string };
  onChange: (v: { id: string | null; name: string }) => void;
  placeholder: string;
}) {
  const { lang } = useLanguage();
  const s = useProjectStrings();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ApiProduct[]>([]);
  const [picked, setPicked] = useState<ApiProduct | null>(null);
  const [open, setOpen] = useState(false);

  // The picked product's name, when the form was opened on an existing
  // project that links one and we only have its id.
  useEffect(() => {
    if (!value.id || picked?.id === value.id) return;
    let alive = true;
    api
      .get<{ products: ApiProduct[] }>(`/api/products?category=${encodeURIComponent(category)}&limit=1&search=${encodeURIComponent(value.id)}`)
      .then((d) => {
        if (alive && d.products?.[0]?.id === value.id) setPicked(d.products[0]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [value.id, category, picked?.id]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      api
        .get<{ products: ApiProduct[] }>(`/api/products?category=${encodeURIComponent(category)}&search=${encodeURIComponent(term)}&limit=6`)
        .then((d) => alive && setHits(d.products ?? []))
        .catch(() => alive && setHits([]));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q, category]);

  if (value.id) {
    return (
      <Field label={label} optional>
        <div className="flex items-center gap-2 rounded-xl border border-border-subtle/60 bg-surface-raised px-3 py-2">
          {picked?.images?.[0] && <img src={picked.images[0]} alt="" className="size-8 rounded-lg object-cover" />}
          <span className="min-w-0 flex-1 truncate text-[13.5px]" dir="auto">
            {picked ? productName(picked, lang) : value.id}
          </span>
          <span className="rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold">{s.fromCatalogue}</span>
          <button
            type="button"
            aria-label={`${s.typeName}`}
            onClick={() => {
              onChange({ id: null, name: '' });
              setPicked(null);
            }}
            className="flex size-9 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </Field>
    );
  }

  return (
    <Field label={label} optional>
      <div className="relative">
        <Input
          value={value.name || q}
          onChange={(e) => {
            setQ(e.target.value);
            onChange({ id: null, name: e.target.value });
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          maxLength={80}
          autoComplete="off"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-autocomplete="list"
        />
        {open && hits.length > 0 && (
          <ul role="listbox" style={{ maxHeight: '16rem' }} className="material material-thick absolute inset-x-0 top-full z-20 mt-1 overflow-y-auto rounded-xl border border-border-subtle/60 py-1 shadow-lg">
            {hits.map((h) => (
              <li key={h.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setPicked(h);
                    onChange({ id: h.id, name: '' });
                    setQ('');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-start text-[13.5px] hover:bg-surface-raised focus-visible:outline-none focus-visible:bg-surface-raised"
                >
                  <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {productName(h, lang)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}
