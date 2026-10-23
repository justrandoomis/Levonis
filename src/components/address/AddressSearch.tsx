// Lucian UX/UI Prompt #304 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#304
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, MapPin } from 'lucide-react';
import type { ApiAddress } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import './addressSearch.css';

import { addressChoices, type AddressChoice } from './addressChoices';

function Match({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<b>{text.slice(at, at + query.trim().length)}</b>{text.slice(at + query.trim().length)}</>;
}

/** Searches only the caller's saved addresses and the existing governorate catalogue.
 * No invented street results, postal codes, coordinates, or external geocoding requests. */
export default function AddressSearch({ addresses, onPick }: { addresses: ApiAddress[]; onPick: (choice: AddressChoice) => void }) {
  const { loc, lang } = useLanguage();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [picked, setPicked] = useState('');
  const results = useMemo(() => addressChoices(addresses, query, lang), [addresses, query, lang]);
  const shown = open && query.trim().length >= 2;
  useEffect(() => { if (shown && active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, shown, id]);
  const choose = (choice: AddressChoice) => { setQuery(choice.label); setPicked(choice.detail || choice.label); setOpen(false); setActive(-1); onPick(choice); };
  return <div className="u304" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOpen(false); setActive(-1); } }}>
    <label htmlFor={id} className="u304-label">{loc('ابحث في عناوينك أو المحافظة', 'Find a saved address or governorate', 'گەڕان لە ناونیشانەکانت یان پارێزگا')}</label>
    <div className="u304-field"><Search size={16} aria-hidden="true" /><input id={id} ref={input} className="lv-input" type="search" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={shown} aria-controls={shown ? `${id}-results` : undefined} aria-activedescendant={shown && active >= 0 && results[active] ? `${id}-${active}` : undefined} value={query}
      placeholder={loc('الشارع، نقطة دالة محفوظة، أو المحافظة', 'Saved street, landmark, or governorate', 'شەقام، نیشانەی پاشەکەوتکراو، یان پارێزگا')}
      onFocus={() => setOpen(true)} onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(-1); setPicked(''); }} onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive((i) => results.length ? (i < 0 ? (e.key === 'ArrowDown' ? 0 : results.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length) : -1); }
        if (e.key === 'Enter') { e.preventDefault(); if (shown && results[active]) choose(results[active]); }
      }} /></div>
    {shown && <div className="u304-results" id={`${id}-results`} role="listbox" aria-label={loc('نتائج العناوين', 'Address results', 'ئەنجامەکانی ناونیشان')}>
      {results.map((choice, i) => <button type="button" role="option" aria-selected={i === active} id={`${id}-${i}`} key={choice.id} tabIndex={-1} className="u304-result" onPointerDown={(e) => e.preventDefault()} onClick={() => choose(choice)}>
        <MapPin size={16} aria-hidden="true" /><span><Match text={choice.label} query={query} /><small><Match text={choice.detail || loc('المحافظة — أكمل الشارع والتفاصيل', 'Governorate — add street and details', 'پارێزگا — شەقام و وردەکاری زیاد بکە')} query={query} /></small></span>
      </button>)}
      {!results.length && <p className="u304-empty">{loc('لا يوجد عنوان محفوظ مطابق. يمكنك إدخاله يدوياً أدناه.', 'No matching saved address. Enter it manually below.', 'ناونیشانی گونجاو نییە. لە خوارەوە بە دەست بینووسە.')}</p>}
    </div>}
    {picked && <p className="u304-picked" role="status"><MapPin size={16} aria-hidden="true" />{picked}</p>}
  </div>;
}
