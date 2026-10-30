// Lucian UX/UI Prompt #264 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#264
import React, { useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { emailSuggestions } from './emailDomainSuggestions';
import './emailSuggestions.css';

export default function EmailSuggestions({ value, onChange, inputId, disabled }: { value: string; onChange: (v: string) => void; inputId: string; disabled?: boolean }) {
  const { loc } = useLanguage();
  const { domains, correction } = emailSuggestions(value);
  const [accepted, setAccepted] = useState('');
  const pick = (next: string) => { onChange(next); setAccepted(next); document.getElementById(inputId)?.focus({ preventScroll: true }); };
  if (disabled) return null;
  return <div className="u264">
    {!!domains.length && <div className="u264-dms" role="group" aria-label={loc('اقتراحات البريد', 'Email suggestions', 'پێشنیارەکانی ئیمەیل')}>
      {domains.map((email, i) => <button key={email} type="button" className="u264-dm" style={{ animationDelay: `${i * 40}ms` }} onClick={() => pick(email)}><bdi>@{email.split('@')[1]}</bdi></button>)}
    </div>}
    {correction && <button type="button" className="u264-fx" onClick={() => pick(correction)}><Sparkles size={16} aria-hidden="true" />{loc('هل تقصد', 'Did you mean', 'مەبەستت ئەمەیە')} <bdi><Correction typed={value.trim()} corrected={correction} /></bdi>؟</button>}
    {accepted === value && accepted && <span className="u264-ok" role="status"><Check size={16} aria-hidden="true" />{loc('تم تحديث البريد', 'Email updated', 'ئیمەیل نوێ کرایەوە')}</span>}
  </div>;
}

function Correction({ typed, corrected }: { typed: string; corrected: string }) {
  let start = 0, end = 0;
  while (start < corrected.length && corrected[start] === typed[start]) start++;
  while (end < corrected.length - start && corrected[corrected.length - 1 - end] === typed[typed.length - 1 - end]) end++;
  return <>{corrected.slice(0, start)}<mark>{corrected.slice(start, corrected.length - end)}</mark>{corrected.slice(corrected.length - end)}</>;
}
