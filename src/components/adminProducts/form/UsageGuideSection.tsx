/**
 * The structured usage & setup guide editor — the owner's expansion of
 * «طريقة الاستخدام»: real steps instead of one text blob. Each step carries
 * a kind (تركيب/استخدام), a title, a description, up to six photos, an
 * optional video URL and an optional link to the official documentation
 * (e.g. https://wiki.bambulab.com/en/a1), plus ONE official-manual URL for
 * the whole product. The server sanitizes every URL to http(s)/relative on
 * save; this editor is plain state over doc.usage_guide.
 */

import React from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { UsageGuideV2, UsageStepV2 } from '../../../lib/productTypes';
import { Field, Grid, ImgSlot, TextArea, TextInput, btnGhost, iconBtn } from './formUi';
import { localId } from './model';

const KINDS: Array<{ id: UsageStepV2['kind']; ar: string; en: string }> = [
  { id: 'setup', ar: 'تركيب وتنصيب', en: 'Setup' },
  { id: 'usage', ar: 'استخدام', en: 'Usage' },
];

export function UsageGuideSection({
  guide,
  onChange,
}: {
  guide: UsageGuideV2;
  onChange: (next: UsageGuideV2) => void;
}) {
  const steps = guide.steps;

  const addStep = (kind: UsageStepV2['kind']) =>
    onChange({
      ...guide,
      steps: [
        ...steps,
        {
          id: localId('ustep'),
          kind,
          title: '',
          body: '',
          // 0079. The localiser fills these on save; a new step starts with
          // nothing authored, which every reader treats as "show the source".
          title_ar: '',
          title_ckb: '',
          body_ar: '',
          body_ckb: '',
          images: [],
          video_url: '',
          link_url: '',
          order: steps.length,
        },
      ],
    });

  const patch = (id: string, p: Partial<UsageStepV2>) =>
    onChange({ ...guide, steps: steps.map((st) => (st.id === id ? { ...st, ...p } : st)) });

  const remove = (id: string) =>
    onChange({ ...guide, steps: steps.filter((st) => st.id !== id).map((st, i) => ({ ...st, order: i })) });

  const move = (id: string, dir: -1 | 1) => {
    const i = steps.findIndex((st) => st.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...guide, steps: next.map((st, k) => ({ ...st, order: k })) });
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <h4 className="text-[12px] font-bold text-zinc-300">
          دليل التركيب والاستخدام{' '}
          <span className="text-[10px] font-medium text-zinc-500">Setup & usage guide</span>
        </h4>
        <div className="flex gap-1.5 shrink-0">
          {KINDS.map((k) => (
            <button key={k.id} type="button" onClick={() => addStep(k.id)} className={`${btnGhost} h-8 px-2.5 text-[12px]`}>
              + خطوة {k.ar}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-zinc-600 -mt-1">
        كل خطوة: عنوان ووصف وصور وفيديو ورابط للدليل الرسمي. تُعرض خطوات التركيب أولًا ثم الاستخدام.
      </p>

      <Field
        ar="رابط الدليل الرسمي للمنتج"
        en="Official guide URL"
        hint="مثال: https://wiki.bambulab.com/en/a1 — يظهر كزر أعلى الدليل"
      >
        <TextInput
          value={guide.official_url}
          onChange={(e) => onChange({ ...guide, official_url: e.target.value })}
          placeholder="https://…"
          inputMode="url"
        />
      </Field>

      {steps.length === 0 ? (
        <p className="text-[12px] text-zinc-500">
          لا خطوات بعد — أضف خطوة تركيب أو استخدام. (نص «طريقة الاستخدام» الحر أدناه يبقى يُعرض إن لم توجد خطوات.)
        </p>
      ) : (
        <div className="space-y-2">
          {steps.map((st, i) => (
            <div key={st.id} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
              <div className="flex items-center gap-2 min-w-0 mb-2">
                <span
                  className={`shrink-0 w-6 h-6 rounded-md grid place-items-center text-[10px] font-black ${
                    st.kind === 'setup' ? 'bg-amber-500/15 text-amber-300' : 'bg-[#6B46FF]/15 text-[#b9a5ff]'
                  }`}
                >
                  {i + 1}
                </span>
                <div className="flex rounded-lg border border-zinc-700 overflow-hidden shrink-0">
                  {KINDS.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      onClick={() => patch(st.id, { kind: k.id })}
                      className={`h-8 px-2 text-[11px] font-bold transition-colors ${
                        st.kind === k.id ? 'bg-[#6B46FF]/20 text-white' : 'bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {k.ar}
                    </button>
                  ))}
                </div>
                <div className="flex-1" />
                <button type="button" onClick={() => move(st.id, -1)} className={iconBtn} aria-label="للأعلى">
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => move(st.id, 1)} className={iconBtn} aria-label="للأسفل">
                  <ArrowDown className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(st.id)}
                  className={`${iconBtn} hover:text-red-400`}
                  aria-label="حذف الخطوة"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/*
                A STEP WITH NO TITLE AND NO BODY IS DROPPED ON SAVE.
                `upgradeUsageGuide` (worker/lib/productModel.ts) keeps a step
                only when it has one or the other — a rule worth keeping, since
                a blank row would otherwise render as an empty card on the
                product page. What was wrong is that the FORM never said so, so
                an admin could upload three photos and a video, save, and find
                the whole step gone with a 200 and no word.
                The filter is not widened: the step is not the media, and
                keeping a titleless card would move the problem to the
                storefront. The form warns instead, while there is still
                something to type.
              */}
              {!st.title.trim() && !st.body.trim() && (st.images.length > 0 || st.video_url || st.link_url) && (
                <p
                  className="mb-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-300 leading-snug"
                  data-usage-step-warning={st.id}
                >
                  هذه الخطوة تحمل وسائط بلا عنوان ولا وصف — لن تُحفَظ. أضف عنوانًا أو وصفًا حتى لا تضيع الصور والفيديو.
                  <span className="text-zinc-500"> A step with neither a title nor a description is not saved.</span>
                </p>
              )}

              <Grid cols={2}>
                <Field ar="العنوان" en="Title" span>
                  <TextInput
                    value={st.title}
                    onChange={(e) => patch(st.id, { title: e.target.value })}
                    placeholder="Unbox and remove the clips"
                  />
                </Field>
                <Field ar="الوصف" en="Description" span>
                  <TextArea
                    rows={3}
                    value={st.body}
                    onChange={(e) => patch(st.id, { body: e.target.value })}
                  />
                </Field>
                <Field ar="فيديو" en="Video URL" hint="رابط ملف فيديو مباشر أو يوتيوب">
                  <TextInput
                    value={st.video_url}
                    onChange={(e) => patch(st.id, { video_url: e.target.value })}
                    placeholder="https://…"
                    inputMode="url"
                  />
                </Field>
                <Field ar="رابط الدليل الرسمي لهذه الخطوة" en="Official link">
                  <TextInput
                    value={st.link_url}
                    onChange={(e) => patch(st.id, { link_url: e.target.value })}
                    placeholder="https://wiki.…"
                    inputMode="url"
                  />
                </Field>
              </Grid>

              <div className="mt-2">
                <div className="text-[11px] font-bold text-zinc-400 mb-1">
                  صور الخطوة <span className="text-[10px] font-medium text-zinc-600">حتى ٦ صور</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {st.images.map((url, idx) => (
                    <ImgSlot
                      key={`${st.id}:${idx}`}
                      url={url}
                      label={`صورة ${idx + 1}`}
                      onChange={(next) =>
                        patch(st.id, {
                          images:
                            next === null
                              ? st.images.filter((_, k) => k !== idx)
                              : st.images.map((u, k) => (k === idx ? next : u)),
                        })
                      }
                    />
                  ))}
                  {st.images.length < 6 && (
                    <ImgSlot
                      key={`${st.id}:add:${st.images.length}`}
                      url=""
                      label="إضافة صورة للخطوة"
                      onChange={(next) => {
                        if (next) patch(st.id, { images: [...st.images, next] });
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
