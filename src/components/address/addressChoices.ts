// Lucian UX/UI Prompt #304 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#304
import type { ApiAddress } from '../../lib/api';
import { GOVERNORATES } from '../../lib/governorates';

export type AddressChoice = { id: string; label: string; detail: string; governorate: string; saved?: ApiAddress };
export const addressSearchText = (text: string) => text.toLowerCase().normalize('NFKC').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[\u064b-\u065f\u0640]/g, '').trim();

export function addressChoices(addresses: ApiAddress[], query: string, lang: 'ar' | 'en' | 'ckb'): AddressChoice[] {
  const needle = addressSearchText(query);
  if (needle.length < 2) return [];
  const saved = addresses.filter((a) => addressSearchText([a.label, a.address, a.area, a.landmark].join(' ')).includes(needle))
    .map((a) => ({ id: a.id, label: a.label, detail: [a.area, a.address, a.landmark].filter(Boolean).join(' · '), governorate: a.governorate, saved: a }));
  const regions = GOVERNORATES.filter((g) => addressSearchText([g.ar, g.en, g.ckb].join(' ')).includes(needle))
    .map((g) => ({ id: `gov-${g.id}`, label: g[lang], detail: '', governorate: g.id }));
  return [...saved, ...regions].slice(0, 6);
}
