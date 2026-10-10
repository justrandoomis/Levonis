/**
 * «تحديث البيانات» — THE PRODUCT DATA FILE, BOTH WAYS (owner brief 2026-10-10:
 * «عند تحديث البيانات يتم تنزيل ملف معلومات بيانات المنتج وعند ارفاق الملف
 * يقارن التغييرات فقط ويطبقها اذا حقل تغير … ليس استيراد من جديد»).
 *
 *   1. download — the product's data file as it is now (TXT, or CSV for a
 *      spreadsheet): every field, the owner's costs and USD pricing included
 *      for the owner alone (GET /api/admin/template/data-export/…);
 *   2. attach — the edited file;
 *   3. the comparison — per product, every changed line old → new, every
 *      refused line with its reason, what the save derives, the engine's price
 *      preview when the pricing would write prices (POST …/data-preview, which
 *      writes nothing);
 *   4. «تطبيق التغييرات» — one call per product (POST …/data-apply), each its
 *      own atomic, fenced, audited batch holding the token of the comparison
 *      the admin read. A product whose changes are too many for one batch
 *      (DATA_FILE_TOO_LARGE, docs/DECISIONS.md row 207) is applied in two:
 *      the product part, a fresh comparison of that product alone, then the
 *      pricing part — only when the fresh comparison writes exactly the
 *      pricing lines the owner read; anything else stops with the fresh card.
 *
 * Every row is titled «item · field» in the reader's language
 * (`rowTitle`, ../dataFileStrings.ts): the model, colour, combination or
 * pricing scope by the name the server sends, the field from the tables —
 * never a raw key (the key and its line stay in the small grey caption).
 *
 * The same sheet serves the product form (one product) and the products list
 * (`productIds`: the page's products, 25 to a file). The comparison is the
 * server's; this only lays it out. Every word is ar / en / ckb
 * (../dataFileStrings.ts); a refusal by code is rendered from the contract.
 */
import { COMPLETENESS_UI, completenessLabel, tri, type CompletenessItemDto } from '../completeness';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, FileUp, RefreshCw } from 'lucide-react';
import { Modal } from '../ui';
import { api, ApiError } from '../../../lib/api';
import { contractRefusal, refusalLang } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { downloadAdminFile, DownloadError } from '../download';
import { btnGhost, btnPrimary } from './formUi';
import {
  DATA_FILE_SECTIONS,
  DATA_FILE_STATUS,
  DATA_FILE_STRINGS as S,
  fill,
  itemOfNkey,
  pick,
  rowTitle,
  type DataFileLabels,
  type Tri,
} from '../dataFileStrings';

interface FieldLine {
  key: string;
  nkey?: string;
  line: number;
  status: string;
  section: string;
  item: { group: string; id: string; isNew: boolean } | null;
  field: string;
  before: string | null;
  after: string | null;
  message?: string;
  private: boolean;
}

interface PricingRow {
  channel: string;
  name_ar?: string;
  name_en?: string;
  name_ckb?: string;
  today_prepaid_iqd: number | null;
  computed_price_iqd: number | null;
}

interface ProductCard {
  product_id: string;
  name: string | null;
  slug: string | null;
  pricing_mode: 'manual' | 'engine' | null;
  error: { code: string; message: string } | null;
  counts: { changes: number; refused: number; stale: number; derived: number };
  fields: FieldLine[];
  derived: Array<{ key: string; nkey: string; section: string; before: string | null; after: string | null }>;
  gone_items: string[];
  pricing: { kind: 'data' | 'price' | 'none'; preview_hash: string | null; large_change: boolean; adoption: { kind: string | null; rows: PricingRow[] } | null } | null;
  token: string | null;
  /** The central required-field list on the product now and after this apply (codes only; owner-projected). */
  completeness?: { before: CompletenessItemDto[]; after: CompletenessItemDto[] } | null;
  /** The names the rows are titled with: each item (`group:id`) and each spec field (row 207). */
  labels?: DataFileLabels;
}

interface Preview {
  viewer: 'owner' | 'staff';
  errors: Array<{ line: number; message: string; code: string }>;
  products: ProductCard[];
}

type Outcome = {
  ok: boolean;
  /** The product part landed, the pricing part did not (yet): amber, and Apply continues. */
  partial?: boolean;
  text: string;
  /** The product part is too large on its own: the pricing part may still be applied alone. */
  pricingOnly?: { token: string; hash: string | null };
};

/** A part of an apply too large for one batch, as the server names it (counts and a token only). */
interface PartDto {
  token: string;
  statements: number;
  fits: boolean;
}
interface SizeDetails {
  needed?: number;
  allowance?: number;
  parts?: { document?: PartDto; pricing?: PartDto };
}
interface ApplyAnswer {
  already?: boolean;
  applied?: string[];
  not_persisted?: string[];
}

const CHUNK = 25;
/** Products compared per preview call in the products list (each call one invocation of D1's 1,000 queries). */
const COMPARE_CHUNK = 5;
/** The product ids of a bulk file, in its order (its `=== product <id> ===` lines). */
const fileProductIds = (text: string): string[] => [...new Set([...text.matchAll(/^===\s*product\s+([A-Za-z0-9_-]{1,80})\s*===\s*$/gm)].map((m) => m[1]))];
/** The pricing lines a card will write, as `key=after` (what a second step must write, no more, no less). */
const pricingIntent = (card: ProductCard): string[] =>
  card.fields
    .filter((f) => f.status === 'change' && f.key.startsWith('pricing.'))
    .map((f) => `${f.key}=${f.after ?? ''}`)
    .sort();
const samePricingIntent = (card: ProductCard, fresh: ProductCard): boolean => {
  const want = pricingIntent(card);
  const got = fresh.fields
    .filter((f) => f.status === 'change')
    .map((f) => `${f.key}=${f.after ?? ''}`)
    .sort();
  return want.length > 0 && want.length === got.length && want.every((x, i) => x === got[i]);
};
const shown = (v: string | null) => (v === null || v === '' || v === '__NULL__' ? '—' : v);
const iqd = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

export default function DataFileSheet({
  productId,
  productIds,
  formDirty = false,
  onClose,
  onApplied,
}: {
  /** The form's product: one block, its own file. */
  productId?: string;
  /** The products list: the products offered for download, 25 to a file. */
  productIds?: readonly string[];
  /** The editor holds unsaved edits — they are kept; the file's changes are applied to the saved product. */
  formDirty?: boolean;
  onClose: () => void;
  /** After at least one product was applied: a note for the caller, and which products changed. */
  onApplied: (note: string, applied: string[]) => void;
}) {
  const { lang } = useLanguage();
  const t = useCallback((x: Tri) => pick(x, lang), [lang]);
  const rl = refusalLang(lang);
  const said = useCallback((e: unknown, fallback: string) => contractRefusal(e, rl, e instanceof Error ? e.message : fallback), [rl]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<Outcome | null>(null);
  const [file, setFile] = useState<{ name: string; text: string; format: 'txt' | 'csv' } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** What the apply is doing now, when it is more than one call (a product applied in two steps). */
  const [note, setNote] = useState<string | null>(null);
  const [confirmLarge, setConfirmLarge] = useState<Record<string, boolean>>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const bulk = !productId;
  const chunks = useMemo(() => {
    const ids = productIds ?? [];
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
    return out;
  }, [productIds]);

  const download = async (key: string, path: string, name: string, csv: boolean) => {
    setDownloading(key);
    setDownloadNote(null);
    try {
      const out = await downloadAdminFile(
        path,
        name,
        csv ? { accept: 'text/csv', ext: 'csv', type: 'text/csv;charset=utf-8' } : { accept: 'text/plain', ext: 'txt', type: 'text/plain;charset=utf-8' }
      );
      setDownloadNote({ ok: true, text: fill(t(S.downloadStarted), { name: out.filename }) });
    } catch (e) {
      setDownloadNote({ ok: false, text: e instanceof DownloadError ? e.message : t(S.downloadFailed) });
    } finally {
      setDownloading(null);
    }
  };

  const compare = useCallback(
    async (next: { name: string; text: string; format: 'txt' | 'csv' }) => {
      setChecking(true);
      setProblem(null);
      setPreview(null);
      setOutcomes({});
      try {
        if (productId) {
          setPreview(await api.post<Preview>('/api/admin/template/data-preview', { text: next.text, format: next.format, product_id: productId }));
          return;
        }
        // The products list: a few products a call (each call is one invocation of D1's budget), in the file's order.
        const ids = next.format === 'txt' ? fileProductIds(next.text) : [];
        if (ids.length <= COMPARE_CHUNK) {
          setPreview(await api.post<Preview>('/api/admin/template/data-preview', { text: next.text, format: next.format }));
          return;
        }
        let first: Preview | null = null;
        const products: ProductCard[] = [];
        try {
          for (let i = 0; i < ids.length; i += COMPARE_CHUNK) {
            const part = await api.post<Preview>('/api/admin/template/data-preview', { text: next.text, format: next.format, product_ids: ids.slice(i, i + COMPARE_CHUNK) });
            first ??= part;
            products.push(...part.products);
          }
        } catch (e) {
          // A block the server does not take as a product (a malformed block): the whole file in one call, as before.
          if (!(e instanceof ApiError) || e.code !== 'DATA_FILE_WRONG_PRODUCT') throw e;
          setPreview(await api.post<Preview>('/api/admin/template/data-preview', { text: next.text, format: next.format }));
          return;
        }
        setPreview({ ...first!, products });
      } catch (e) {
        setProblem(e instanceof ApiError ? said(e, e.message) : t(S.compareFailed));
      } finally {
        setChecking(false);
      }
    },
    [productId, said, t]
  );

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    const format: 'txt' | 'csv' = /\.csv$/i.test(f.name) || /^\uFEFF?key,value\s*$/im.test(text.split('\n', 1)[0] ?? '') ? 'csv' : 'txt';
    const next = { name: f.name, text, format };
    setFile(next);
    void compare(next);
  };

  const ready = (preview?.products ?? []).filter((p) => p.token && !outcomes[p.product_id]?.ok);
  const blockedByTick = ready.some((p) => p.pricing?.kind === 'price' && p.pricing.large_change && !confirmLarge[p.product_id]);

  /** One apply call: everything, the product part, or the pricing part (each its own fenced batch). */
  const applyCall = (card: ProductCard, o: { part: 'all' | 'document' | 'pricing'; token: string; hash?: string | null }) =>
    api.post<ApplyAnswer>('/api/admin/template/data-apply', {
      text: file!.text,
      format: file!.format,
      product_id: card.product_id,
      token: o.token,
      ...(o.part === 'all' ? {} : { part: o.part }),
      ...(o.hash ? { pricing_hash: o.hash } : {}),
      ...(o.part !== 'document' && card.pricing?.large_change ? { confirm_large_change: confirmLarge[card.product_id] === true } : {}),
    });
  /** A fresh comparison of one product of the attached file. */
  const previewOne = async (id: string): Promise<ProductCard | null> => {
    const res = await api.post<Preview>('/api/admin/template/data-preview', { text: file!.text, format: file!.format, product_ids: [id] });
    return res.products[0] ?? null;
  };
  const sizeNote = (d: SizeDetails | undefined) =>
    d?.needed !== undefined && d.allowance !== undefined ? ` ${fill(t(S.sizeNote), { needed: d.needed, allowance: d.allowance })}` : '';
  const finished = (r: ApplyAnswer): Outcome => {
    const missing = r.not_persisted ?? [];
    return r.already
      ? { ok: true, text: t(S.alreadyApplied) }
      : missing.length
        ? { ok: false, text: fill(t(S.notPersisted), { list: missing.join(', ') }) }
        : { ok: true, text: fill(t(S.applied), { n: r.applied?.length ?? 0 }) };
  };

  const applyAll = async () => {
    if (!file || !preview || applying) return;
    setApplying(true);
    setProblem(null);
    const applied: string[] = [];
    let total = 0;
    const next: Record<string, Outcome> = { ...outcomes };
    const cards = [...preview.products];
    const replace = (fresh: ProductCard) => {
      const at = cards.findIndex((c) => c.product_id === fresh.product_id);
      if (at >= 0) cards[at] = fresh;
    };
    for (const card of ready) {
      try {
        const res = await applyCall(card, { part: 'all', token: card.token!, hash: card.pricing?.preview_hash });
        total += res.applied?.length ?? 0;
        applied.push(card.product_id);
        next[card.product_id] = finished(res);
      } catch (e) {
        const d = e instanceof ApiError ? (e.details as SizeDetails | undefined) : undefined;
        const doc = d?.parts?.document;
        const priced = d?.parts?.pricing;
        if (e instanceof ApiError && e.code === 'DATA_FILE_TOO_LARGE' && doc?.fits && priced) {
          // Too many for one batch: the product part first (its own batch), then the pricing part after a fresh comparison.
          setNote(t(S.applyingInParts));
          let landed = 0;
          try {
            const r1 = await applyCall(card, { part: 'document', token: doc.token });
            landed = r1.applied?.length ?? 0;
            applied.push(card.product_id);
            total += landed;
            const fresh = await previewOne(card.product_id);
            if (fresh?.token && fresh.pricing?.kind === 'data' && !fresh.pricing.large_change && samePricingIntent(card, fresh)) {
              const r2 = await applyCall(fresh, { part: 'all', token: fresh.token, hash: fresh.pricing.preview_hash });
              total += r2.applied?.length ?? 0;
              const missing = [...(r1.not_persisted ?? []), ...(r2.not_persisted ?? [])];
              next[card.product_id] = missing.length
                ? { ok: false, text: fill(t(S.notPersisted), { list: missing.join(', ') }) }
                : { ok: true, text: fill(t(S.appliedInParts), { n: landed + (r2.applied?.length ?? 0) }) };
            } else {
              // The pricing comparison moved after the product part: the owner reads it and presses Apply again.
              if (fresh) replace(fresh);
              next[card.product_id] = { ok: false, partial: true, text: t(S.partStopped) };
            }
          } catch (e2) {
            const fresh2 = e2 instanceof ApiError ? (e2.details?.preview as ProductCard | undefined) : undefined;
            if (fresh2) replace(fresh2);
            next[card.product_id] = landed || applied.includes(card.product_id)
              ? { ok: false, partial: true, text: `${t(S.partStopped)} ${e2 instanceof ApiError ? said(e2, e2.message) : t(S.applyFailed)}` }
              : { ok: false, text: e2 instanceof ApiError ? said(e2, e2.message) : t(S.applyFailed) };
          } finally {
            setNote(null);
          }
          continue;
        }
        const fresh = e instanceof ApiError ? (e.details?.preview as ProductCard | undefined) : undefined;
        if (fresh) replace(fresh);
        if (e instanceof ApiError && e.code === 'DATA_FILE_PRODUCT_TOO_LARGE' && priced?.fits) {
          next[card.product_id] = { ok: false, text: `${said(e, e.message)}${sizeNote(d)}`, pricingOnly: { token: priced.token, hash: card.pricing?.preview_hash ?? null } };
          continue;
        }
        next[card.product_id] = { ok: false, text: e instanceof ApiError ? `${said(e, e.message)}${sizeNote(d)}` : t(S.applyFailed) };
      }
    }
    setPreview({ ...preview, products: cards });
    setOutcomes(next);
    setApplying(false);
    if (applied.length) onApplied(fill(t(S.applied), { n: total }), applied);
  };

  /** «طبّق أسطر التسعير وحدها»: the pricing part of a product whose product part is too large for one batch. */
  const applyPricingOnly = async (card: ProductCard) => {
    const only = outcomes[card.product_id]?.pricingOnly;
    if (!file || !only || applying) return;
    setApplying(true);
    try {
      const res = await applyCall(card, { part: 'pricing', token: only.token, hash: only.hash });
      setOutcomes((m) => ({ ...m, [card.product_id]: { ok: false, partial: true, text: fill(t(S.pricingOnlyApplied), { n: res.applied?.length ?? 0 }) } }));
      onApplied(fill(t(S.applied), { n: res.applied?.length ?? 0 }), [card.product_id]);
    } catch (e) {
      setOutcomes((m) => ({ ...m, [card.product_id]: { ok: false, text: e instanceof ApiError ? said(e, e.message) : t(S.applyFailed) } }));
    } finally {
      setApplying(false);
    }
  };

  /** «item · field», in the reader's language (never the raw key: that stays in the grey caption). */
  const titleOf = (card: ProductCard) => (key: string, item: { group: string; id: string } | null) => rowTitle(key, item, card.labels, lang);
  const reason = (f: FieldLine): string => {
    const base = f.message === 'NEW_IMAGE' ? DATA_FILE_STATUS.NEW_IMAGE : DATA_FILE_STATUS[f.status];
    const head = base ? t(base) : f.status;
    return f.status === 'INVALID_VALUE' && f.message ? `${head}: ${f.message}` : head;
  };

  const canApply = ready.length > 0 && !applying && !checking && !blockedByTick;

  return (
    <Modal
      titleAr={t(bulk ? S.bulkTitle : S.title)}
      titleEn={bulk ? S.bulkTitle.en : S.title.en}
      wide
      dirty={!!preview && ready.length > 0}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-[11px] text-text-muted flex-1 min-w-[140px]">
            {preview
              ? fill(t(S.summary), {
                  n: preview.products.reduce((s, p) => s + p.counts.changes, 0),
                  m: preview.products.reduce((s, p) => s + p.counts.refused, 0),
                })
              : ''}
            {formDirty ? ` — ${t(S.formDirty)}` : ''}
          </span>
          <button type="button" className={btnGhost} onClick={onClose}>
            {Object.values(outcomes).some((o) => o.ok) ? t(S.close) : t(S.cancel)}
          </button>
          <button type="button" className={btnPrimary} disabled={!canApply} onClick={() => void applyAll()} data-data-file-apply>
            {applying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {applying ? t(S.applying) : t(S.apply)}
          </button>
        </div>
      }
    >
      <p className="text-[12px] leading-relaxed text-text-secondary mb-3">{t(S.intro)}</p>

      <div className="space-y-2.5 min-w-0">
        {/* 1 — the file */}
        <div className="min-w-0 rounded-lg border border-border-subtle bg-surface p-2.5 space-y-2" data-data-file-step="download">
          <h4 className="text-[12px] font-bold text-text-primary">{t(bulk ? S.stepDownloadBulk : S.stepDownload)}</h4>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            {productId ? (
              <>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={!!downloading}
                  onClick={() => void download('txt', `/api/admin/template/data-export/${encodeURIComponent(productId)}`, `levonis-product-data-${productId}.txt`, false)}
                >
                  {downloading === 'txt' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} TXT
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={!!downloading}
                  onClick={() => void download('csv', `/api/admin/template/data-export/${encodeURIComponent(productId)}?format=csv`, `levonis-product-data-${productId}.csv`, true)}
                >
                  {downloading === 'csv' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CSV (Excel / Numbers)
                </button>
              </>
            ) : chunks.length === 0 ? (
              <span className="text-[11px] text-text-muted">{t(S.noProducts)}</span>
            ) : (
              chunks.map((ids, i) => {
                const key = `chunk-${i}`;
                const from = i * CHUNK + 1;
                const to = i * CHUNK + ids.length;
                return (
                  <button
                    key={key}
                    type="button"
                    className={btnGhost}
                    disabled={!!downloading}
                    onClick={() =>
                      void download(key, `/api/admin/template/data-export?ids=${ids.map(encodeURIComponent).join(',')}`, `levonis-products-data-${from}-${to}.txt`, false)
                    }
                  >
                    {downloading === key ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    {fill(t(S.chunk), { from, to })}
                  </button>
                );
              })
            )}
          </div>
          {downloadNote && (
            <p className={`text-[11px] ${downloadNote.ok ? 'text-emerald-300' : 'text-red-400'}`} role="status">
              {downloadNote.text}
            </p>
          )}
        </div>

        {/* 2 — the edited file */}
        <div className="min-w-0 rounded-lg border border-border-subtle bg-surface p-2.5 space-y-2" data-data-file-step="upload">
          <h4 className="text-[12px] font-bold text-text-primary">{t(S.stepUpload)}</h4>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            className="sr-only"
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
            data-data-file-input
          />
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button type="button" className={btnGhost} onClick={() => fileRef.current?.click()}>
              <FileUp className="w-4 h-4" /> {file ? t(S.chooseOther) : t(S.chooseFile)}
            </button>
            {file && (
              <span className="text-[11px] text-text-secondary truncate min-w-0" dir="ltr">
                {file.name}
              </span>
            )}
          </div>
        </div>

        {/* 3 — the comparison */}
        {(checking || preview || problem) && (
          <div className="min-w-0 rounded-lg border border-border-subtle bg-surface p-2.5 space-y-2" data-data-file-step="compare">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <h4 className="text-[12px] font-bold text-text-primary flex-1 min-w-0">{t(S.stepChanges)}</h4>
              {file && !checking && (
                <button type="button" className={btnGhost} onClick={() => void compare(file)}>
                  <RefreshCw className="w-4 h-4" /> {t(S.compareAgain)}
                </button>
              )}
            </div>
            {checking && <p className="text-[11px] text-text-muted">{t(S.comparing)}</p>}
            {note && (
              <p className="text-[11px] text-amber-300" role="status">
                {note}
              </p>
            )}
            {problem && (
              <p className="text-[12px] text-red-400 inline-flex items-center gap-1" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {problem}
              </p>
            )}
            {preview?.viewer === 'staff' && <p className="text-[11px] text-text-muted">{t(S.staffFile)}</p>}
            {preview?.products.map((card) => (
              <ProductBlock
                key={card.product_id}
                card={card}
                bulk={bulk}
                lang={lang}
                t={t}
                title={titleOf(card)}
                reason={reason}
                outcome={outcomes[card.product_id]}
                busy={applying}
                onPricingOnly={() => void applyPricingOnly(card)}
                confirmed={confirmLarge[card.product_id] === true}
                onConfirm={(v) => setConfirmLarge((m) => ({ ...m, [card.product_id]: v }))}
                errorText={card.error ? contractRefusal({ code: card.error.code, message: card.error.message }, rl) : null}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ProductBlock({
  card,
  bulk,
  lang,
  t,
  title,
  reason,
  outcome,
  busy,
  onPricingOnly,
  confirmed,
  onConfirm,
  errorText,
}: {
  card: ProductCard;
  bulk: boolean;
  lang: string;
  t: (x: Tri) => string;
  title: (key: string, item: { group: string; id: string } | null) => string;
  reason: (f: FieldLine) => string;
  outcome: Outcome | undefined;
  busy: boolean;
  onPricingOnly: () => void;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  errorText: string | null;
}) {
  const changes = card.fields.filter((f) => f.status === 'change');
  const refused = card.fields.filter((f) => f.status !== 'change' && f.status !== 'STALE_IN_FILE');
  const stale = card.fields.filter((f) => f.status === 'STALE_IN_FILE');
  const bySection = (list: FieldLine[]) => {
    const groups = new Map<string, FieldLine[]>();
    for (const f of list) groups.set(f.section, [...(groups.get(f.section) ?? []), f]);
    return [...groups.entries()];
  };
  const sectionName = (s: string) => (DATA_FILE_SECTIONS[s] ? t(DATA_FILE_SECTIONS[s]) : s);
  const rows = card.pricing?.adoption?.rows ?? [];
  const rowName = (r: PricingRow) => (lang === 'en' ? r.name_en : lang === 'ckb' ? r.name_ckb || r.name_ar : r.name_ar) || r.name_en || '';

  return (
    <div className="min-w-0 rounded-md border border-border-subtle p-2 space-y-2" data-data-file-product={card.product_id}>
      {bulk && (
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-[12px] font-bold text-text-primary truncate min-w-0 flex-1">{card.name ?? card.product_id}</span>
          <span className="text-[10px] text-text-muted truncate" dir="ltr">
            {card.slug ?? card.product_id}
          </span>
        </div>
      )}
      {errorText && (
        <p className="text-[12px] text-red-400" role="alert">
          {t(S.productError)}: {errorText}
        </p>
      )}
      {!card.error && changes.length === 0 && refused.length === 0 && <p className="text-[12px] text-text-secondary">{t(S.noChanges)}</p>}

      {bySection(changes).map(([section, list]) => (
        <div key={`c-${section}`} className="space-y-1.5 min-w-0">
          <h5 className="text-[11px] font-bold text-text-secondary">{sectionName(section)}</h5>
          {list.map((f) => (
            <div key={f.key} className="lv-well rounded-md px-2 py-1.5 min-w-0" data-data-file-change={f.key}>
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="text-[12px] font-bold text-text-primary truncate min-w-0 flex-1">{title(f.key, f.item)}</span>
                <span className="text-[10px] text-text-muted truncate" dir="ltr">
                  {f.key} · {t(S.line)} {f.line}
                </span>
              </div>
              <p className="text-[11px] text-text-muted whitespace-pre-wrap break-words" dir="auto">
                {t(S.before)}: {shown(f.before)}
              </p>
              <p className="text-[11px] text-emerald-300 whitespace-pre-wrap break-words" dir="auto">
                {t(S.after)}: {shown(f.after)}
              </p>
            </div>
          ))}
        </div>
      ))}

      {refused.length > 0 && (
        <div className="space-y-1.5 min-w-0">
          {refused.map((f) => (
            <div key={`r-${f.key}-${f.line}`} className="lv-alert lv-alert-danger px-2 py-1.5 min-w-0" data-data-file-refused={f.status}>
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-400" />
                <span className="text-[12px] font-bold text-red-300 truncate min-w-0 flex-1">{title(f.key, f.item)}</span>
                <span className="text-[10px] text-text-muted truncate" dir="ltr">
                  {f.key} · {t(S.line)} {f.line}
                </span>
              </div>
              <p className="text-[11px] text-red-300 break-words">{reason(f)}</p>
              {(f.before !== null || f.after !== null) && (
                <p className="text-[11px] text-text-muted whitespace-pre-wrap break-words" dir="auto">
                  {shown(f.before)} → {shown(f.after)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {card.derived.length > 0 && (
        <details className="lv-alert lv-alert-warning px-2 py-1.5 min-w-0">
          <summary className="text-[11px] text-amber-300 cursor-pointer">{fill(t(S.derived), { n: card.derived.length })}</summary>
          <ul className="mt-1 space-y-0.5 text-[11px] text-amber-200/80">
            {card.derived.map((d) => (
              <li key={d.key} className="break-words" dir="auto">
                {title(d.key, itemOfNkey(d.nkey ?? ''))}: {shown(d.before)} → {shown(d.after)}{' '}
                <span className="text-[10px] text-text-muted" dir="ltr">
                  {d.key}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {stale.length > 0 && (
        <details className="rounded-md bg-surface-raised px-2 py-1.5 min-w-0">
          <summary className="text-[11px] text-text-secondary cursor-pointer">{fill(t(S.stale), { n: stale.length })}</summary>
          <ul className="mt-1 space-y-0.5 text-[11px] text-text-muted">
            {stale.map((f) => (
              <li key={f.key} className="break-words" dir="auto">
                {title(f.key, f.item)} — {reason(f)}{' '}
                <span className="text-[10px] text-text-muted" dir="ltr">
                  {f.key} · {t(S.line)} {f.line}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {card.gone_items.length > 0 && <p className="text-[11px] text-text-muted break-words">{fill(t(S.gone), { list: card.gone_items.join(', ') })}</p>}

      {/* The missing flags (owner brief 2026-10-10): which required fields the product
          would still miss once these changes are applied. */}
      {card.completeness && (card.completeness.before.length > 0 || card.completeness.after.length > 0) && (
        card.completeness.after.length === 0 ? (
          <p className="lv-alert lv-alert-success px-2 py-1.5 text-[11px] text-text-primary" data-data-file-complete>
            {tri(COMPLETENESS_UI.afterApplyComplete, lang)}
          </p>
        ) : (
          <div className="lv-alert lv-alert-danger px-2 py-1.5 min-w-0" data-data-file-missing={card.completeness.after.length}>
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-400" aria-hidden="true" />
              {fill(tri(COMPLETENESS_UI.afterApplyMissing, lang), { n: card.completeness.after.length })}
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {[...new Map(card.completeness.after.map((i) => [i.code, i])).values()].map((i) => (
                <li key={i.code} className="lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)] rounded px-1.5 py-0.5 text-[11px]" data-missing={i.code}>
                  {completenessLabel(i.code, lang)}
                </li>
              ))}
            </ul>
            {card.completeness.before.length !== card.completeness.after.length && (
              <p className="mt-1 text-[10px] text-text-muted">{fill(tri(COMPLETENESS_UI.nowMissing, lang), { n: card.completeness.before.length })}</p>
            )}
          </div>
        )
      )}

      {card.pricing && card.pricing.kind !== 'none' && (
        <div className="lv-alert lv-alert-info px-2 py-1.5 space-y-1 min-w-0" data-data-file-pricing={card.pricing.kind}>
          <p className="text-[11px] text-sky-200">
            {card.pricing.kind === 'data' ? t(S.pricingData) : card.pricing.adoption?.kind === 'adopt' ? t(S.pricingAdopt) : t(S.pricingReprice)}
          </p>
          {rows.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-sky-200">
              {rows.slice(0, 40).map((r, i) => (
                <li key={`${r.channel}-${i}`} dir="auto">
                  {rowName(r)} · {fill(t(S.pricingRow), { channel: r.channel, old: iqd(r.today_prepaid_iqd), new: iqd(r.computed_price_iqd) })}
                </li>
              ))}
            </ul>
          )}
          {card.pricing.large_change && (
            <label className="flex items-center gap-2 text-[11px] text-amber-300">
              <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
              {t(S.largeChange)}
            </label>
          )}
        </div>
      )}

      {outcome && (
        <p className={`text-[12px] ${outcome.ok ? 'text-emerald-300' : outcome.partial ? 'text-amber-300' : 'text-red-400'}`} role="status">
          {outcome.ok ? `${t(S.resultApplied)} — ` : ''}
          {outcome.text}
        </p>
      )}
      {outcome?.pricingOnly && (
        <button type="button" className={btnGhost} disabled={busy} onClick={onPricingOnly} data-data-file-pricing-only>
          <Check className="w-4 h-4" /> {t(S.applyPricingOnly)}
        </button>
      )}
      {!outcome && !card.token && !card.error && changes.length === 0 && refused.length > 0 && (
        <p className="text-[11px] text-text-muted">{t(S.resultNothing)}</p>
      )}
    </div>
  );
}
