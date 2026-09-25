/**
 * PROMPTDIALOG — the replacement for `window.prompt`, and `usePrompt`, the
 * one-line way to ask for a piece of text.
 *
 * A native prompt cannot be read in the admin's language chrome (its buttons
 * are the browser's), cannot say WHY a value is refused (a blank reason just
 * silently did nothing), cannot validate a number, freezes every timer on the
 * page, and on iOS may be suppressed outright.
 *
 * WHAT IT DOES (apple-design §10, §11):
 *   a title that names what is being asked, an optional sentence of context,
 *   a VISIBLE label bound to the field (never a placeholder standing in for
 *   one), the error next to the field in words (`aria-invalid`, described by
 *   the error), a confirm button whose label is the verb, and an obvious way
 *   out. Enter submits a one-line field; a multi-line field submits with
 *   Ctrl/⌘+Enter so Enter can make a new line. Focus lands IN the field.
 *   The field's direction follows what is typed (`dir="auto"`), so an English
 *   reason in an Arabic panel reads left to right; a number is an LTR island.
 *
 * It is a `dialog` on the shared `Overlay`: the stack (Escape answers
 * «cancel» for this dialog only), the focus trap and the return of focus to
 * the control that asked. On a phone it rises from the bottom.
 *
 *   const [prompt, promptDialog] = usePrompt();
 *   …
 *   const reason = await prompt({ title, label, required: true, confirmLabel });
 *   if (reason === null) return;           // cancelled — never an empty string
 *   …
 *   return <>{…}{promptDialog}</>;
 *
 * The answer is TRIMMED. `required` refuses an empty answer in place;
 * `validate` returns the sentence to show, or null to accept.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Overlay } from './Overlay';
import { Button } from './Button';
import { Field, Input, Textarea } from './Field';

export interface PromptOptions {
  /** What is being asked: «سبب رفض العرض». */
  title: React.ReactNode;
  /** One sentence of context: what the answer is used for. */
  description?: React.ReactNode;
  /** The field's visible label. */
  label: React.ReactNode;
  /** An example, never the label. */
  placeholder?: string;
  initialValue?: string;
  /** Refuse an empty (after trimming) answer with a message beside the field. */
  required?: boolean;
  /** A sentence to show when the answer is not acceptable, or null to accept it. */
  validate?: (value: string) => string | null;
  /** A reason or a note: several lines. */
  multiline?: boolean;
  maxLength?: number;
  /** Numeric keyboard on phones, and a left-to-right field. */
  inputMode?: 'text' | 'numeric' | 'decimal';
  /** The verb on the button: «رفض العرض». Defaults to «تأكيد». */
  confirmLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** The action it leads to loses something: the button is drawn destructive. */
  destructive?: boolean;
}

export interface PromptDialogProps extends PromptOptions {
  open: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  testId?: string;
}

/** The answer a prompt accepts, or the sentence refusing it — pure, for the tests. */
export function checkPromptValue(
  raw: string,
  opts: Pick<PromptOptions, 'required' | 'validate'>,
  requiredText: string
): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? '').trim();
  if (opts.required && !value) return { ok: false, error: requiredText };
  const problem = opts.validate?.(value) ?? null;
  if (problem) return { ok: false, error: problem };
  return { ok: true, value };
}

export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  initialValue = '',
  required = false,
  validate,
  multiline = false,
  maxLength,
  inputMode = 'text',
  confirmLabel,
  cancelLabel,
  destructive = false,
  onSubmit,
  onCancel,
  testId,
}: PromptDialogProps) {
  const { loc } = useLanguage();
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');

  // A new question starts from its own initial value, with no stale error.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setError('');
    }
  }, [open, initialValue]);

  const submit = () => {
    const res = checkPromptValue(value, { required, validate }, loc('هذا الحقل مطلوب', 'This field is required', 'ئەم خانەیە پێویستە'));
    if ('error' in res) {
      setError(res.error);
      fieldRef.current?.focus();
      return;
    }
    onSubmit(res.value);
  };

  const numeric = inputMode !== 'text';
  const common = {
    ref: fieldRef,
    value,
    placeholder,
    maxLength,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      setValue(e.target.value);
      if (error) setError('');
    },
    'data-prompt-input': true,
  };

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      labelledBy={titleId}
      describedBy={description ? descId : undefined}
      placement="bottom"
      initialFocus={fieldRef}
      testId={testId ?? 'prompt-dialog'}
      panelClassName="w-full sm:max-w-md"
      dirty={value.trim() !== initialValue.trim()}
    >
      <form
        className="p-5"
        style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id={titleId} className="text-[17px] font-bold leading-snug text-text-primary">
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-1.5 text-sm leading-relaxed text-text-secondary">
            {description}
          </p>
        )}
        <Field label={label} error={error || undefined} required={required} className="mt-4">
          {multiline ? (
            <Textarea
              {...common}
              rows={3}
              dir="auto"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          ) : (
            <Input {...common} dir={numeric ? 'ltr' : 'auto'} inputMode={numeric ? inputMode : undefined} enterKeyHint="done" autoComplete="off" />
          )}
        </Field>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel} className="sm:min-w-24">
            {cancelLabel ?? loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
          </Button>
          <Button type="submit" variant={destructive ? 'danger' : 'primary'} className="sm:min-w-24" data-prompt-submit>
            {confirmLabel ?? loc('تأكيد', 'Confirm', 'دڵنیاکردنەوە')}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}

/**
 * `const [prompt, dialog] = usePrompt()` — render `dialog` once, then
 * `await prompt({...})` resolves the trimmed answer, or null when the person
 * cancelled, dismissed it, a newer question replaced it, or the component
 * went away. Null is never confused with an empty answer.
 */
export function usePrompt(): [(options: PromptOptions) => Promise<string | null>, React.ReactElement] {
  const [asking, setAsking] = useState<PromptOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((answer: string | null) => void) | null>(null);

  const answer = useCallback((value: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const prompt = useCallback((options: PromptOptions) => {
    resolver.current?.(null);
    setAsking(options);
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  useEffect(() => () => resolver.current?.(null), []);

  const dialog = (
    <PromptDialog
      open={open}
      title={asking?.title ?? ''}
      label={asking?.label ?? ''}
      description={asking?.description}
      placeholder={asking?.placeholder}
      initialValue={asking?.initialValue}
      required={asking?.required}
      validate={asking?.validate}
      multiline={asking?.multiline}
      maxLength={asking?.maxLength}
      inputMode={asking?.inputMode}
      confirmLabel={asking?.confirmLabel}
      cancelLabel={asking?.cancelLabel}
      destructive={asking?.destructive}
      onSubmit={(v) => answer(v)}
      onCancel={() => answer(null)}
    />
  );
  return [prompt, dialog];
}
