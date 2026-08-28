import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, FileText, ScrollText, ShieldCheck, RefreshCw, Eye, Pencil, UploadCloud } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { api } from '../lib/api';

/**
 * Public trilingual reader for PUBLISHED policy documents, with an honest
 * empty state while none are published, plus an admin-only drafts panel
 * (seed / preview / edit / publish). Drafts are never shown to customers.
 */

const STRINGS = {
  ar: {
    title: 'سياسات المتجر',
    intro: 'الوثائق المنشورة رسميًا أدناه. النسخة المعروضة هي النسخة المنشورة الحالية لكل وثيقة.',
    empty: 'لم تُنشر أي سياسات بعد.',
    emptyHint: 'سياسات المتجر قيد الإعداد والمراجعة وستظهر هنا فور نشرها رسميًا.',
    loadError: 'تعذر تحميل السياسات — حاول مرة أخرى.',
    retry: 'إعادة المحاولة',
    version: 'النسخة',
    requiredBadge: 'مطلوبة عند الشراء',
    langFallback: 'النص التالي بالعربية — الترجمة لهذه اللغة غير منشورة بعد.',
    back: 'رجوع',
    // admin
    adminTitle: 'المسودات (للإدارة فقط)',
    adminNote: 'هذه مسودات غير منشورة ولا يراها الزبائن. النشر إجراء دائم ومدقَّق.',
    seed: 'إدراج مسودات LEVONIS الأصلية',
    seeded: (n: number) => `أُدرجت مسودات ${n} وثيقة.`,
    allSeeded: 'كل الوثائق لديها صفوف بالفعل — لم يُدرج شيء.',
    draft: 'مسودة',
    published: 'منشورة',
    archived: 'مؤرشفة',
    publish: 'نشر…',
    publishPrompt: (k: string, v: number) =>
      `النشر دائم ولا يمكن تعديل النسخة بعده.\nاكتب بالضبط: PUBLISH ${k} v${v}`,
    publishMismatch: 'نص التأكيد غير مطابق — أُلغي النشر.',
    edit: 'تحرير',
    save: 'حفظ المسودة',
    saving: 'جارٍ الحفظ…',
    cancel: 'إلغاء',
    docTitle: 'العنوان',
    docBody: 'النص',
    actionError: 'تعذر تنفيذ الإجراء',
  },
  en: {
    title: 'Store Policies',
    intro: 'Officially published documents are listed below. What you see is the current published version of each document.',
    empty: 'No policies are published yet.',
    emptyHint: 'The store policies are being prepared and reviewed; they will appear here as soon as they are officially published.',
    loadError: 'Could not load the policies — please try again.',
    retry: 'Retry',
    version: 'Version',
    requiredBadge: 'Required at checkout',
    langFallback: 'The text below is in Arabic — the translation for this language is not published yet.',
    back: 'Back',
    adminTitle: 'Drafts (admin only)',
    adminNote: 'These drafts are unpublished and invisible to customers. Publishing is permanent and audited.',
    seed: 'Seed the original LEVONIS drafts',
    seeded: (n: number) => `Seeded drafts for ${n} document(s).`,
    allSeeded: 'Every document already has rows — nothing was seeded.',
    draft: 'Draft',
    published: 'Published',
    archived: 'Archived',
    publish: 'Publish…',
    publishPrompt: (k: string, v: number) =>
      `Publishing is permanent and the version becomes immutable.\nType exactly: PUBLISH ${k} v${v}`,
    publishMismatch: 'Confirmation text did not match — publish cancelled.',
    edit: 'Edit',
    save: 'Save draft',
    saving: 'Saving…',
    cancel: 'Cancel',
    docTitle: 'Title',
    docBody: 'Body',
    actionError: 'The action failed',
  },
  ckb: {
    title: 'سیاسەتەکانی فرۆشگا',
    intro: 'بەڵگەنامە بە فەرمی بڵاوکراوەکان لە خوارەوەن. ئەوەی دەیبینیت وەشانە بڵاوکراوە ئێستاکەیە بۆ هەر بەڵگەنامەیەک.',
    empty: 'هێشتا هیچ سیاسەتێک بڵاونەکراوەتەوە.',
    emptyHint: 'سیاسەتەکانی فرۆشگا لە ئامادەکردن و پێداچوونەوەدان؛ هەر کە بە فەرمی بڵاوکرانەوە لێرە دەردەکەون.',
    loadError: 'سیاسەتەکان بار نەبوون — تکایە دووبارە هەوڵ بدەوە.',
    retry: 'هەوڵدانەوە',
    version: 'وەشان',
    requiredBadge: 'پێویستە لە کاتی کڕیندا',
    langFallback: 'دەقی خوارەوە بە عەرەبییە — وەرگێڕان بۆ ئەم زمانە هێشتا بڵاونەکراوەتەوە.',
    back: 'گەڕانەوە',
    adminTitle: 'ڕەشنووسەکان (تەنها بۆ بەڕێوەبەرایەتی)',
    adminNote: 'ئەم ڕەشنووسانە بڵاونەکراونەتەوە و کڕیاران نایانبینن. بڵاوکردنەوە هەمیشەییە و تۆمار دەکرێت.',
    seed: 'دانانی ڕەشنووسە ڕەسەنەکانی LEVONIS',
    seeded: (n: number) => `ڕەشنووسی ${n} بەڵگەنامە دانرا.`,
    allSeeded: 'هەموو بەڵگەنامەکان پێشتر ڕیزیان هەیە — هیچ دانەنرا.',
    draft: 'ڕەشنووس',
    published: 'بڵاوکراوە',
    archived: 'ئەرشیفکراو',
    publish: 'بڵاوکردنەوە…',
    publishPrompt: (k: string, v: number) =>
      `بڵاوکردنەوە هەمیشەییە و وەشانەکە نەگۆڕ دەبێت.\nبە تەواوی بنووسە: PUBLISH ${k} v${v}`,
    publishMismatch: 'دەقی پشتڕاستکردنەوە یەکسان نەبوو — بڵاوکردنەوە هەڵوەشایەوە.',
    edit: 'دەستکاری',
    save: 'پاشەکەوتی ڕەشنووس',
    saving: 'پاشەکەوت دەکرێت…',
    cancel: 'هەڵوەشاندنەوە',
    docTitle: 'ناونیشان',
    docBody: 'دەق',
    actionError: 'کردارەکە سەرکەوتوو نەبوو',
  },
} as const;

interface PolicyListItem {
  key: string;
  version: number;
  titles: Record<string, string>;
  required_for_checkout: boolean;
}
interface PolicyDoc {
  key: string;
  version: number;
  lang: string;
  lang_requested: string;
  title: string;
  body: string;
  hash: string;
}
interface AdminDocRow {
  id: string;
  key: string;
  version: number;
  lang: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  body_length: number;
}

/** Minimal safe renderer for the policy body ("## " headings, "- " bullets). */
function PolicyBody({ body }: { body: string }) {
  const lines = body.split('\n');
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-zinc-300">
      {lines.map((line, i) => {
        const t = line.trim();
        if (!t) return <div key={i} className="h-1" />;
        if (t.startsWith('## ')) {
          return (
            <h2 key={i} className="text-[16px] font-bold text-gold pt-3">
              {t.slice(3)}
            </h2>
          );
        }
        if (t.startsWith('- ')) {
          return (
            <div key={i} className="flex gap-2">
              <span className="text-gold shrink-0 mt-[2px]">•</span>
              <p>{t.slice(2)}</p>
            </div>
          );
        }
        if (t.startsWith('⚠️')) {
          return (
            <p key={i} className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-xl p-3 text-[13px]">
              {t}
            </p>
          );
        }
        return <p key={i}>{t}</p>;
      })}
    </div>
  );
}

export default function Policies() {
  const navigate = useNavigate();
  const { lang } = useLanguage();
  const { user } = useAuth();
  const t = STRINGS[lang] || STRINGS.ar;

  const [list, setList] = useState<PolicyListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState<PolicyDoc | null>(null);
  const [docLoadingKey, setDocLoadingKey] = useState('');
  const [actionError, setActionError] = useState('');

  // Admin drafts panel
  const isAdmin = !!user?.isAdmin;
  const [adminDocs, setAdminDocs] = useState<AdminDocRow[]>([]);
  const [adminMsg, setAdminMsg] = useState('');
  const [previewDoc, setPreviewDoc] = useState<(AdminDocRow & { body: string }) | null>(null);
  const [editDoc, setEditDoc] = useState<(AdminDocRow & { body: string }) | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setListError('');
    setIsLoading(true);
    try {
      const data = await api.get<{ policies: PolicyListItem[] }>('/api/policies');
      setList(data.policies);
    } catch (err) {
      setListError((err as Error)?.message || 'error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadAdmin = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await api.get<{ documents: AdminDocRow[] }>('/api/policies/admin/list');
      setAdminDocs(data.documents);
    } catch {
      /* admin panel stays empty; public part still works */
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadAdmin();
  }, [loadAdmin]);

  const openDoc = async (key: string) => {
    setActionError('');
    setDocLoadingKey(key);
    try {
      const data = await api.get<{ policy: PolicyDoc }>(`/api/policies/${encodeURIComponent(key)}?lang=${lang}`);
      setSelected(data.policy);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    } finally {
      setDocLoadingKey('');
    }
  };

  const seedDrafts = async () => {
    setAdminMsg('');
    setActionError('');
    try {
      const data = await api.post<{ seeded: string[]; skipped: string[] }>('/api/policies/admin/seed-drafts');
      setAdminMsg(data.seeded.length > 0 ? t.seeded(data.seeded.length) : t.allSeeded);
      await loadAdmin();
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    }
  };

  const openAdminDoc = async (row: AdminDocRow, forEdit: boolean) => {
    setActionError('');
    try {
      const data = await api.get<{ document: AdminDocRow & { body: string } }>(`/api/policies/admin/doc/${row.id}`);
      if (forEdit && data.document.status === 'draft') {
        setEditDoc(data.document);
        setEditTitle(data.document.title);
        setEditBody(data.document.body);
      } else {
        setPreviewDoc(data.document);
      }
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    }
  };

  const saveDraft = async () => {
    if (!editDoc || isSaving) return;
    setActionError('');
    setIsSaving(true);
    try {
      await api.post('/api/policies/admin/draft', {
        key: editDoc.key,
        lang: editDoc.lang,
        title: editTitle,
        body: editBody,
      });
      setEditDoc(null);
      await loadAdmin();
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    } finally {
      setIsSaving(false);
    }
  };

  const publishVersion = async (key: string, version: number) => {
    setActionError('');
    setAdminMsg('');
    const expected = `PUBLISH ${key} v${version}`;
    const typed = window.prompt(t.publishPrompt(key, version));
    if (typed === null) return;
    if (typed.trim() !== expected) {
      setActionError(t.publishMismatch);
      return;
    }
    try {
      await api.post('/api/policies/admin/publish', { key, version, confirm: expected });
      await Promise.all([load(), loadAdmin()]);
    } catch (err) {
      setActionError((err as Error)?.message || t.actionError);
    }
  };

  // Group admin docs by key+version for the drafts panel.
  const draftGroups = React.useMemo(() => {
    const groups = new Map<string, { key: string; version: number; rows: AdminDocRow[] }>();
    for (const d of adminDocs.filter((r) => r.status === 'draft')) {
      const gk = `${d.key}@${d.version}`;
      const g = groups.get(gk) || { key: d.key, version: d.version, rows: [] };
      g.rows.push(d);
      groups.set(gk, g);
    }
    return [...groups.values()];
  }, [adminDocs]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white w-full font-sans flex flex-col">
      <div className="flex items-center justify-between p-4 sticky top-0 bg-[#0a0a0a]/90 backdrop-blur-md z-10 border-b border-zinc-900">
        <button
          onClick={() => (selected ? setSelected(null) : navigate(-1))}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-zinc-900 transition-colors"
          aria-label={t.back}
        >
          <ChevronLeft className="w-6 h-6 rtl:rotate-180" />
        </button>
        <h1 className="text-[17px] font-bold">{selected ? selected.title : t.title}</h1>
        <div className="w-10 h-10" />
      </div>

      <div className="p-4 flex-1 max-w-2xl w-full mx-auto">
        {actionError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-2xl p-3 text-center mb-4">
            {actionError}
          </div>
        )}

        {selected ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5">
            <div className="flex items-center gap-2 text-[12px] text-zinc-500 mb-4">
              <ScrollText className="w-4 h-4" />
              <span>
                {t.version} {selected.version}
              </span>
              <span className="text-zinc-700">·</span>
              <span dir="ltr" className="font-mono">{selected.hash.slice(0, 12)}…</span>
            </div>
            {selected.lang !== selected.lang_requested && (
              <p className="bg-zinc-800/70 border border-zinc-700 text-zinc-300 text-[12px] rounded-xl p-3 mb-4">
                {t.langFallback}
              </p>
            )}
            <PolicyBody body={selected.body} />
          </div>
        ) : (
          <>
            <p className="text-zinc-400 text-[13px] mb-5">{t.intro}</p>

            {isLoading ? (
              <div className="flex justify-center py-16">
                <div className="w-8 h-8 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
              </div>
            ) : listError ? (
              <div className="text-center py-12">
                <p className="text-red-400 text-sm mb-4">{t.loadError}</p>
                <button onClick={load} className="px-6 py-2 bg-zinc-800 rounded-full text-sm font-bold inline-flex items-center gap-2">
                  <RefreshCw className="w-4 h-4" /> {t.retry}
                </button>
              </div>
            ) : list.length === 0 ? (
              <div className="text-center py-12 text-zinc-500">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="font-medium">{t.empty}</p>
                <p className="text-sm mt-1">{t.emptyHint}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {list.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => openDoc(p.key)}
                    disabled={docLoadingKey === p.key}
                    className="w-full text-start bg-zinc-900 border border-zinc-800 hover:border-gold/40 rounded-2xl p-4 flex items-center gap-3 transition-colors disabled:opacity-60"
                  >
                    <FileText className="w-5 h-5 text-gold shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-[15px] truncate">
                        {p.titles[lang] || p.titles.ar || p.key}
                      </p>
                      <p className="text-[12px] text-zinc-500">
                        {t.version} {p.version}
                      </p>
                    </div>
                    {p.required_for_checkout && (
                      <span className="text-[10px] font-bold bg-gold/15 text-gold px-2 py-1 rounded-full shrink-0 inline-flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" /> {t.requiredBadge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* -------------------------------------------- admin drafts panel */}
            {isAdmin && (
              <div className="mt-10 border-t border-zinc-800 pt-6">
                <h2 className="font-bold text-[15px] mb-1 flex items-center gap-2">
                  <Pencil className="w-4 h-4 text-amber-400" /> {t.adminTitle}
                </h2>
                <p className="text-[12px] text-zinc-500 mb-4">{t.adminNote}</p>
                {adminMsg && (
                  <p className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[13px] rounded-xl p-3 mb-3">
                    {adminMsg}
                  </p>
                )}
                <button
                  onClick={seedDrafts}
                  className="mb-4 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-full text-[13px] font-bold inline-flex items-center gap-2"
                >
                  <UploadCloud className="w-4 h-4" /> {t.seed}
                </button>
                <div className="space-y-3">
                  {draftGroups.map((g) => (
                    <div key={`${g.key}@${g.version}`} className="bg-zinc-900 border border-amber-500/20 rounded-2xl p-4">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div>
                          <p className="font-bold text-[14px]">
                            {g.key} <span className="text-zinc-500 font-normal">v{g.version}</span>
                          </p>
                          <p className="text-[11px] text-amber-400 font-bold uppercase">{t.draft}</p>
                        </div>
                        <button
                          onClick={() => publishVersion(g.key, g.version)}
                          className="px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 text-[12px] font-bold hover:bg-amber-500/25"
                        >
                          {t.publish}
                        </button>
                      </div>
                      <div className="flex gap-2 mt-3 flex-wrap">
                        {g.rows.map((r) => (
                          <div key={r.id} className="flex items-center gap-1">
                            <button
                              onClick={() => openAdminDoc(r, false)}
                              className="px-2.5 py-1 rounded-lg border border-zinc-700 text-[12px] text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1"
                            >
                              <Eye className="w-3 h-3" /> {r.lang}
                            </button>
                            <button
                              onClick={() => openAdminDoc(r, true)}
                              className="px-2 py-1 rounded-lg border border-zinc-700 text-[12px] text-zinc-400 hover:bg-zinc-800"
                              aria-label={`${t.edit} ${r.lang}`}
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Admin draft preview modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#0a0a0a] border border-zinc-800 rounded-t-[28px] sm:rounded-[28px] p-5 w-full max-w-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="font-bold">{previewDoc.title}</p>
                <p className="text-[11px] text-amber-400 font-bold uppercase">
                  {t.draft} — {previewDoc.key} v{previewDoc.version} ({previewDoc.lang})
                </p>
              </div>
              <button onClick={() => setPreviewDoc(null)} className="px-3 py-1.5 bg-zinc-800 rounded-full text-[12px] font-bold">
                {t.cancel}
              </button>
            </div>
            <PolicyBody body={previewDoc.body} />
          </div>
        </div>
      )}

      {/* Admin draft edit modal */}
      {editDoc && (
        <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#0a0a0a] border border-zinc-800 rounded-t-[28px] sm:rounded-[28px] p-5 w-full max-w-2xl max-h-[85vh] overflow-y-auto">
            <p className="font-bold mb-3">
              {t.edit}: {editDoc.key} v{editDoc.version} ({editDoc.lang})
            </p>
            <label className="text-[12px] text-zinc-400 block mb-1">{t.docTitle}</label>
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-sm mb-3 outline-none focus:border-gold/50"
            />
            <label className="text-[12px] text-zinc-400 block mb-1">{t.docBody}</label>
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={14}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-gold/50 font-mono"
            />
            <div className="flex gap-3 mt-4">
              <button onClick={() => setEditDoc(null)} className="flex-1 py-3 rounded-2xl bg-zinc-800 font-bold text-sm">
                {t.cancel}
              </button>
              <button
                onClick={saveDraft}
                disabled={isSaving}
                className="flex-1 py-3 rounded-2xl bg-olive hover:bg-[#3b5927] font-bold text-sm disabled:opacity-50"
              >
                {isSaving ? t.saving : t.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
