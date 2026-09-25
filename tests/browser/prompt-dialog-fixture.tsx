/**
 * THE PROMPT DIALOG (W3-B), as the community admin uses it: a required
 * reason, and a signed whole number. Served only by a local vite dev server
 * for scripts/e2e-merchant-w3b.mjs.   /tests/browser/prompt-dialog.html?lang=ar|en
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider, useLanguage } from '../../src/LanguageContext';
import { Button } from '../../src/components/ui/Button';
import { usePrompt } from '../../src/components/ui/PromptDialog';
import '../../src/index.css';

const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'ar';
try {
  localStorage.setItem('levo_lang', lang);
} catch {
  /* Arabic by default */
}

function Demo() {
  const { loc } = useLanguage();
  const [prompt, dialog] = usePrompt();
  const [answer, setAnswer] = useState('');
  return (
    <div className="p-6 space-y-3">
      <Button
        variant="danger"
        data-open="reason"
        onClick={async () => {
          const r = await prompt({
            title: loc('رفض العرض؟', 'Reject this offer?'),
            label: loc('سبب الرفض', 'Reason for rejecting'),
            required: true,
            multiline: true,
            maxLength: 500,
            confirmLabel: loc('رفض العرض', 'Reject offer'),
            destructive: true,
          });
          setAnswer(r === null ? 'cancelled' : `reason:${r}`);
        }}
      >
        {loc('رفض العرض', 'Reject offer')}
      </Button>
      <Button
        data-open="points"
        onClick={async () => {
          const r = await prompt({
            title: loc('تعديل إداري على السمعة', 'An admin reputation adjustment'),
            label: loc('النقاط (موجبة أو سالبة)', 'Points (positive or negative)'),
            inputMode: 'numeric',
            required: true,
            validate: (v) => (/^[-+]?\d{1,6}$/.test(v) && Number(v) !== 0 ? null : loc('أدخل عددًا صحيحًا غير الصفر، مثل 10 أو ‎-5.', 'Enter a whole number other than zero, like 10 or -5.')),
            confirmLabel: loc('التالي', 'Next'),
          });
          setAnswer(r === null ? 'cancelled' : `points:${r}`);
        }}
      >
        {loc('تعديل النقاط', 'Adjust points')}
      </Button>
      <p data-answer className="text-text-secondary">{answer}</p>
      {dialog}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <Demo />
  </LanguageProvider>
);
