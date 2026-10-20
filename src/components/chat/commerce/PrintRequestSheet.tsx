/**
 * «طلب طباعة» — THE CUSTOMER'S JOB, SENT TO THIS STORE ALONE.
 *
 * Three steps behind one button: the request is drafted (invisible to
 * everyone), its files are uploaded through the request's own file door (the
 * server sniffs the bytes and keeps them private — a model is never handed to
 * the store before acceptance, only its preview), then it is sent and its card
 * lands in the conversation.
 *
 * THE OTHER WAY, SAID PLAINLY: a request posted on Levo Community's board is
 * seen by every workshop that can make it, and they compete with quotes. This
 * one goes to the store of this conversation only.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Paperclip, X } from 'lucide-react';
import { Sheet } from '../../ui/Sheet';
import { Field, Input, Textarea, focusFirstInvalid } from '../../ui/Field';
import { Button } from '../../ui/Button';
import { useLanguage } from '../../../LanguageContext';
import { toast } from '../../../lib/toastStore';
import { chatCommerceApi } from '../../../lib/chatCommerceApi';
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, uploadRequestFiles } from '../../media/RequestAttachments';
import { requestFilesCheck, requestUploadRefusal } from '../../community/requests/fileRefusals';
import { REQUEST_FILE_EXTENSIONS } from '../../../../packages/contracts/src/requestFiles';

/**
 * THE SAME TABLE AS EVERY OTHER DOOR (packages/contracts/src/requestFiles.ts,
 * R5): what the picker offers, how many, and each file asked the count, kind
 * and size before the request is drafted. Each file then takes the door the
 * table picks (`uploadRequestFiles`): a model or anything above 8 MiB goes
 * through the resumable session, up to 300 MB, never the whole-body route.
 */
const ACCEPT = ATTACHMENT_ACCEPT;
const MAX_FILES = MAX_ATTACHMENTS;
const MODEL_FORMATS = REQUEST_FILE_EXTENSIONS.model
  .filter((e) => e !== 'stp')
  .map((e) => (e === 'gltf' ? 'glTF' : e.toUpperCase()))
  .join(' · ');

interface Form {
  title: string;
  description: string;
  quantity: string;
  material: string;
  color: string;
  dimensions: string;
  budget: string;
  deadline: string;
  notes: string;
}
const EMPTY: Form = { title: '', description: '', quantity: '1', material: '', color: '', dimensions: '', budget: '', deadline: '', notes: '' };

export default function PrintRequestSheet({
  open,
  onClose,
  chatId,
  storeName,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  storeName: string;
  onSent: () => void;
}) {
  const { lang, loc } = useLanguage();
  const L = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');

  useEffect(() => {
    if (open) {
      setErrors({});
      setStage('');
    }
  }, [open]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  function validate(): boolean {
    const next: Partial<Record<keyof Form, string>> = {};
    if (f.title.trim().length < 4) next.title = loc('اكتب عنوانًا للطلب (4 أحرف على الأقل)', 'Give the request a title (at least 4 characters)');
    if (f.description.trim().length < 10) next.description = loc('صف ما تريد طباعته (10 أحرف على الأقل)', 'Describe what you want printed (at least 10 characters)');
    const q = Number(f.quantity);
    if (!Number.isInteger(q) || q < 1) next.quantity = loc('عدد صحيح من 1', 'A whole number from 1');
    if (f.budget && (!Number.isInteger(Number(f.budget)) || Number(f.budget) < 0)) next.budget = loc('بالدينار، أرقام فقط', 'In dinars, digits only');
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    try {
      setStage(loc('جارٍ تجهيز الطلب…', 'Preparing the request…'));
      const { request } = await chatCommerceApi.draftPrintRequest(chatId, {
        title: f.title.trim(),
        description: f.description.trim(),
        quantity: Math.max(1, Number(f.quantity) || 1),
        material: f.material.trim(),
        color: f.color.trim(),
        dimensions: f.dimensions.trim(),
        budget_iqd: f.budget ? Number(f.budget) : null,
        deadline: f.deadline,
        customer_notes: f.notes.trim(),
      });
      for (let i = 0; i < files.length; i++) {
        const uploading = (pct: number | null) => {
          const n = pct === null ? '' : ` ${pct}%`;
          setStage(loc(`جارٍ رفع الملف ${i + 1} من ${files.length}…${n}`, `Uploading file ${i + 1} of ${files.length}…${n}`, `بارکردنی فایلی ${i + 1} لە ${files.length}…${n}`));
        };
        uploading(null);
        const { reasons } = await uploadRequestFiles(request.id, [files[i]], (_file, p) => {
          if (p.phase === 'uploading' && p.total > 0) uploading(Math.min(100, Math.round((100 * p.loaded) / p.total)));
        });
        if (reasons.length) throw reasons[0];
      }
      setStage(loc('جارٍ الإرسال…', 'Sending…'));
      await chatCommerceApi.sendPrintRequest(chatId, request.id);
      toast.success(loc('أُرسل طلب الطباعة إلى المتجر', 'The print request was sent to the store'));
      setF(EMPTY);
      setFiles([]);
      onSent();
      onClose();
    } catch (err) {
      // A refused file says why, in the words of every other door (R5).
      toast.error(requestUploadRefusal(err, L, loc('تعذّر إرسال الطلب', 'The request could not be sent', 'داواکارییەکە نەنێردرا')));
    } finally {
      setBusy(false);
      setStage('');
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="sm:max-w-[520px] sm:w-[92vw]"
      testId="chat-print-request-sheet"
      dirty={!busy && (f.title !== '' || f.description !== '' || files.length > 0)}
      header={
        <div className="border-b border-border-subtle px-4 pb-3 pt-1">
          <h2 id={titleId} className="text-center text-[16px] font-extrabold text-text-primary">{loc('طلب طباعة', 'Print request')}</h2>
          <p className="mt-1 text-center text-[12px] text-text-muted">
            {loc(`يصل إلى ${storeName} وحده، ويرد عليك بعرض سعر هنا.`, `Goes to ${storeName} only, who answers with a quote here.`)}
          </p>
          {/* OWNER: Sorani to be written by hand (this sheet). */}
        </div>
      }
      footer={
        <div className="flex flex-col gap-2 px-4 py-3">
          {stage && <p role="status" className="text-center text-[12px] text-text-muted">{stage}</p>}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>{loc('إلغاء', 'Cancel')}</Button>
            <Button variant="primary" block loading={busy} onClick={() => formRef.current?.requestSubmit()} data-print-request-submit>
              {loc('أرسل الطلب', 'Send the request')}
            </Button>
          </div>
        </div>
      }
    >
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4 px-4 py-4">
        <Field label={loc('العنوان', 'Title')} error={errors.title} required>
          <Input value={f.title} onChange={set('title')} maxLength={140} placeholder={loc('مثلًا: قطعة غيار لمروحة', 'e.g. A spare part for a fan')} />
        </Field>
        <Field label={loc('الوصف', 'Description')} error={errors.description} required>
          <Textarea value={f.description} onChange={set('description')} rows={4} maxLength={6000} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={loc('الكمية', 'Quantity')} error={errors.quantity}>
            <Input value={f.quantity} onChange={set('quantity')} inputMode="numeric" ltr />
          </Field>
          <Field label={loc('المادة', 'Material')} optional>
            <Input value={f.material} onChange={set('material')} maxLength={60} placeholder="PLA" />
          </Field>
          <Field label={loc('اللون', 'Colour')} optional>
            <Input value={f.color} onChange={set('color')} maxLength={60} />
          </Field>
        </div>
        <Field label={loc('المقاسات', 'Dimensions')} optional>
          <Input value={f.dimensions} onChange={set('dimensions')} maxLength={120} placeholder={loc('مثلًا: 10 × 5 × 3 سم', 'e.g. 10 × 5 × 3 cm')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={loc('الميزانية (د.ع)', 'Budget (IQD)')} error={errors.budget} optional>
            <Input value={f.budget} onChange={set('budget')} inputMode="numeric" ltr />
          </Field>
          <Field label={loc('مطلوب قبل', 'Needed by')} optional>
            <Input type="date" value={f.deadline} onChange={set('deadline')} ltr />
          </Field>
        </div>
        <Field label={loc('ملاحظات للمتجر', 'Notes for the store')} optional>
          <Textarea value={f.notes} onChange={set('notes')} rows={2} maxLength={1000} />
        </Field>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = '';
              // Every file asked the table in turn: none dropped without its reason.
              const { accepted, refusal } = requestFilesCheck(picked, L, files.length);
              if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
              setFileError(refusal);
            }}
          />
          <Button variant="secondary" size="sm" icon={<Paperclip className="w-4 h-4" aria-hidden="true" />} onClick={() => fileRef.current?.click()} disabled={busy || files.length >= MAX_FILES}>
            {loc('أرفق صورًا أو ملف النموذج', 'Attach pictures or the model file')}
          </Button>
          <p className="mt-1.5 text-[12px] text-text-muted">
            {loc(
              `صور، مخططات PDF، أو مجسمات ثلاثية الأبعاد (${MODEL_FORMATS}) — حتى ${MAX_FILES} ملفات. ملف النموذج لا يُسلَّم للمتجر قبل قبولك عرضه.`,
              `Pictures, PDF drawings, or 3D models (${MODEL_FORMATS}) — up to ${MAX_FILES} files. The model file is not handed to the store before you accept its quote.`,
              `وێنە، نەخشەی PDF، یان مۆدێلی سێ ڕەهەندی (${MODEL_FORMATS}) — تا ${MAX_FILES} فایل. فایلی مۆدێلەکە پێش ئەوەی نرخەکەی قبوڵ بکەیت نادرێتە فرۆشگاکە.`
            )}
          </p>
          {fileError && <p className="lv-field-error mt-1.5" role="alert">{fileError}</p>}
          {files.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {files.map((file, i) => (
                <li key={`${file.name}-${i}`} className="flex items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-[13px]">
                  <span dir="auto" className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFiles((prev) => prev.filter((_, j) => j !== i));
                      setFileError('');
                    }}
                    aria-label={loc(`إزالة ${file.name}`, `Remove ${file.name}`)}
                    className="min-w-9 min-h-9 inline-flex items-center justify-center rounded-md text-text-secondary hover:bg-surface-selected"
                    disabled={busy}
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="rounded-lg bg-surface-raised px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
          {loc('تريد عروضًا من عدة ورش تتنافس على طلبك؟', 'Want quotes from several workshops competing for your job?')}{' '}
          <Link to="/requests?view=new" className="font-semibold underline underline-offset-2">
            {loc('انشره في مجتمع ليفو', 'Post it on Levo Community')}
          </Link>
        </p>
      </form>
    </Sheet>
  );
}
