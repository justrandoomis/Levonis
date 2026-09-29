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
import { ApiError } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { chatCommerceApi } from '../../../lib/chatCommerceApi';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,application/pdf,.stl,.3mf,.obj';
const MAX_FILES = 6;

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
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
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
        setStage(loc(`جارٍ رفع الملف ${i + 1} من ${files.length}…`, `Uploading file ${i + 1} of ${files.length}…`));
        await chatCommerceApi.uploadRequestFile(request.id, files[i]);
      }
      setStage(loc('جارٍ الإرسال…', 'Sending…'));
      await chatCommerceApi.sendPrintRequest(chatId, request.id);
      toast.success(loc('أُرسل طلب الطباعة إلى المتجر', 'The print request was sent to the store'));
      setF(EMPTY);
      setFiles([]);
      onSent();
      onClose();
    } catch (err) {
      const fallback = loc('تعذّر إرسال الطلب', 'The request could not be sent');
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      toast.error(err instanceof ApiError ? apiRefusal(err, lang, fallback) : fallback);
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
              setFiles((prev) => [...prev, ...picked].slice(0, MAX_FILES));
            }}
          />
          <Button variant="secondary" size="sm" icon={<Paperclip className="w-4 h-4" aria-hidden="true" />} onClick={() => fileRef.current?.click()} disabled={busy || files.length >= MAX_FILES}>
            {loc('أرفق صورًا أو ملف النموذج', 'Attach pictures or the model file')}
          </Button>
          <p className="mt-1.5 text-[12px] text-text-muted">
            {loc('صور، PDF، أو STL/3MF/OBJ — حتى 6 ملفات. ملف النموذج لا يُسلَّم للمتجر قبل قبولك عرضه.', 'Pictures, PDF, or STL/3MF/OBJ — up to 6 files. The model file is not handed to the store before you accept its quote.')}
          </p>
          {files.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {files.map((file, i) => (
                <li key={`${file.name}-${i}`} className="flex items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-[13px]">
                  <span dir="auto" className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
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
