/**
 * THE STORE SETTINGS FORM, AS DATA — no React, so every rule here is tested
 * directly (tests/storeSettingsModel.test.ts).
 *
 * WHY IT EXISTS (review of the settings screen, 2026-09-28). The screen used
 * to send whatever the merchant typed and say «تم الحفظ» whatever the server
 * kept: a social link typed as `instagram.com/x` was dropped, a policy past
 * the twelfth vanished, two links both called «Instagram» merged into one, a
 * too-short name came back as «تعذّر الحفظ» with no field named. Now:
 *
 *   - the LIMITS are the server's own (worker/routes/merchant.ts PATCH
 *     /store), drawn on the fields and checked before sending;
 *   - links go through the ONE rule the server applies
 *     (`profileHref`, packages/storeLayout/src/refs.ts), so what the form
 *     accepts is what the page shows;
 *   - every problem is a FieldError that names its field (and its row), so
 *     the screen draws it where it is;
 *   - after a save the form is rebuilt from the store the SERVER returned, so
 *     it shows what was kept, not what was typed.
 */
import { profileHref } from '../../../../packages/storeLayout/src/refs';
import type { MerchantStore, ProfileWidget } from '../../../lib/merchant';

/** The server's ceilings (worker/routes/merchant.ts) — keep the two in step. */
export const LIMITS = {
  name: { min: 2, max: 60 },
  tagline: { max: 140 },
  description: { max: 4000 },
  phone: { max: 32 },
  policies: 12,
  policyTitle: 40,
  policyText: 2000,
  social: 10,
  socialKey: 40,
  hours: 14,
  day: 60,
  widgets: 3,
  widgetTitle: 30,
  widgetSubtitle: 40,
  list: 40,
  listItem: 60,
} as const;

/** The networks «+ إضافة رابط» offers, in order; a new row takes the first one not yet used. */
export const SOCIAL_NETWORKS = ['Instagram', 'Facebook', 'TikTok', 'YouTube', 'Telegram', 'WhatsApp', 'X', 'Website'] as const;

export interface HoursRow {
  day: string;
  open: string;
  close: string;
  /** «مغلق» — the day is listed as closed rather than as a stray dash. */
  closed: boolean;
}

export interface SettingsForm {
  name: string;
  tagline: string;
  description: string;
  logo_key: string | null;
  banner_key: string | null;
  accent: string;
  governorate: string;
  contact_phone: string;
  contact_phone_public: boolean;
  accepts_custom_requests: boolean;
  sells_direct_products: boolean;
  categories: string[];
  service_areas: string[];
  business_hours: HoursRow[];
  profile_links: ProfileWidget[];
  profile_facts: ProfileWidget[];
  policies: Array<[string, string]>;
  social_links: Array<[string, string]>;
  open: boolean;
}

export type FieldErrorKind = 'short' | 'long' | 'invalid_url' | 'duplicate' | 'untitled' | 'too_many' | 'invalid' | 'not_owned';

export interface FieldError {
  /** The form field: `name`, `social_links`, `profile_links`, `policies`, `logo_key` … */
  field: string;
  kind: FieldErrorKind;
  /** The row, for list fields. */
  index?: number;
  min?: number;
  max?: number;
}

type HoursValue = { day: string; open: string; close: string; closed?: boolean } | string;

export function formFromStore(store: MerchantStore): SettingsForm {
  const hours = (store.business_hours ?? []) as HoursValue[];
  return {
    name: store.name ?? '',
    tagline: store.tagline ?? '',
    description: store.description ?? '',
    logo_key: store.logoUrl ?? null,
    banner_key: store.bannerUrl ?? null,
    accent: store.accent ?? 'default',
    governorate: store.governorate ?? '',
    contact_phone: store.contact_phone ?? '',
    contact_phone_public: !!store.contact_phone_public,
    accepts_custom_requests: !!store.accepts_custom_requests,
    sells_direct_products: !!store.sells_direct_products,
    categories: [...(store.categories ?? [])],
    service_areas: [...(store.service_areas ?? [])],
    business_hours: hours.map((h) =>
      typeof h === 'string'
        ? { day: h, open: '', close: '', closed: false }
        : { day: h.day ?? '', open: h.open ?? '', close: h.close ?? '', closed: h.closed === true }
    ),
    profile_links: ((store.profile_links ?? []) as ProfileWidget[]).map((w) => ({ ...w })),
    profile_facts: ((store.profile_facts ?? []) as ProfileWidget[]).map((w) => ({ ...w })),
    policies: Object.entries(store.policies ?? {}),
    social_links: Object.entries(store.social_links ?? {}),
    open: store.status === 'active',
  };
}

/** A string the dirty check compares — the form as the server would receive it. */
export function formSignature(f: SettingsForm): string {
  return JSON.stringify(f);
}

/** The first network the merchant has not used yet, for a new social row. */
export function nextNetwork(rows: ReadonlyArray<[string, string]>): string {
  const used = new Set(rows.map(([k]) => k.trim().toLowerCase()));
  return SOCIAL_NETWORKS.find((n) => !used.has(n.toLowerCase())) ?? '';
}

const trimmed = (s: string) => s.trim();

/** Every problem the form can see before sending, in reading order. */
export function validateForm(f: SettingsForm): FieldError[] {
  const errors: FieldError[] = [];
  const name = trimmed(f.name);
  if (name.length < LIMITS.name.min) errors.push({ field: 'name', kind: 'short', min: LIMITS.name.min, max: LIMITS.name.max });
  if (name.length > LIMITS.name.max) errors.push({ field: 'name', kind: 'long', min: LIMITS.name.min, max: LIMITS.name.max });
  if (trimmed(f.tagline).length > LIMITS.tagline.max) errors.push({ field: 'tagline', kind: 'long', max: LIMITS.tagline.max });
  if (trimmed(f.description).length > LIMITS.description.max) errors.push({ field: 'description', kind: 'long', max: LIMITS.description.max });
  if (trimmed(f.contact_phone).length > LIMITS.phone.max) errors.push({ field: 'contact_phone', kind: 'long', max: LIMITS.phone.max });

  // Header rows: a titled row may be sent; a row with a value but no title
  // would be dropped by the server, so it is named here instead.
  for (const [field, rows] of [
    ['profile_links', f.profile_links],
    ['profile_facts', f.profile_facts],
  ] as const) {
    rows.forEach((w, index) => {
      const title = trimmed(w.title ?? '');
      const value = trimmed((field === 'profile_links' ? w.url : w.subtitle) ?? '');
      if (!title && value) errors.push({ field, kind: 'untitled', index });
      if (title.length > LIMITS.widgetTitle) errors.push({ field, kind: 'long', index, max: LIMITS.widgetTitle });
      if (field === 'profile_links' && title && value && !profileHref(value)) errors.push({ field, kind: 'invalid_url', index });
      if (field === 'profile_facts' && value.length > LIMITS.widgetSubtitle) errors.push({ field, kind: 'long', index, max: LIMITS.widgetSubtitle });
    });
  }

  // Social links: each non-empty row is an address, and each network appears once.
  const seenNetworks = new Map<string, number>();
  f.social_links.forEach(([k, v], index) => {
    const key = trimmed(k);
    const url = trimmed(v);
    if (!key && !url) return;
    if (!key) errors.push({ field: 'social_links', kind: 'untitled', index });
    if (key.length > LIMITS.socialKey) errors.push({ field: 'social_links', kind: 'long', index, max: LIMITS.socialKey });
    if (url && !profileHref(url)) errors.push({ field: 'social_links', kind: 'invalid_url', index });
    const low = key.toLowerCase();
    if (key && seenNetworks.has(low)) errors.push({ field: 'social_links', kind: 'duplicate', index });
    else if (key) seenNetworks.set(low, index);
  });
  if (f.social_links.filter(([k, v]) => trimmed(k) && trimmed(v)).length > LIMITS.social) {
    errors.push({ field: 'social_links', kind: 'too_many', max: LIMITS.social });
  }

  // Policies: titled, once each, within the server's lengths and count.
  const seenPolicies = new Map<string, number>();
  f.policies.forEach(([k, v], index) => {
    const key = trimmed(k);
    const text = trimmed(v);
    if (!key && !text) return;
    if (!key) errors.push({ field: 'policies', kind: 'untitled', index });
    if (key.length > LIMITS.policyTitle) errors.push({ field: 'policies', kind: 'long', index, max: LIMITS.policyTitle });
    if (text.length > LIMITS.policyText) errors.push({ field: 'policies', kind: 'long', index, max: LIMITS.policyText });
    const low = key.toLowerCase();
    if (key && seenPolicies.has(low)) errors.push({ field: 'policies', kind: 'duplicate', index });
    else if (key) seenPolicies.set(low, index);
  });
  if (f.policies.filter(([k, v]) => trimmed(k) && trimmed(v)).length > LIMITS.policies) {
    errors.push({ field: 'policies', kind: 'too_many', max: LIMITS.policies });
  }

  if (f.business_hours.filter((h) => trimmed(h.day)).length > LIMITS.hours) {
    errors.push({ field: 'business_hours', kind: 'too_many', max: LIMITS.hours });
  }
  f.business_hours.forEach((h, index) => {
    if (trimmed(h.day).length > LIMITS.day) errors.push({ field: 'business_hours', kind: 'long', index, max: LIMITS.day });
  });
  return errors;
}

/**
 * The PATCH body. Links travel NORMALISED (`instagram.com/x` →
 * `https://instagram.com/x`), empty rows are not sent, a closed day travels
 * with no times, and `open` only when it changed (audit 01 B4).
 */
export function patchFromForm(f: SettingsForm, store: Pick<MerchantStore, 'status'>): Record<string, unknown> {
  const suspended = store.status === 'suspended';
  return {
    name: trimmed(f.name),
    tagline: trimmed(f.tagline),
    description: trimmed(f.description),
    logo_key: f.logo_key ?? '',
    banner_key: f.banner_key ?? '',
    accent: f.accent,
    governorate: f.governorate,
    contact_phone: trimmed(f.contact_phone),
    contact_phone_public: f.contact_phone_public,
    accepts_custom_requests: f.accepts_custom_requests,
    sells_direct_products: f.sells_direct_products,
    categories: f.categories,
    service_areas: f.service_areas,
    business_hours: f.business_hours
      .filter((h) => trimmed(h.day))
      .map((h) => (h.closed ? { day: trimmed(h.day), open: '', close: '', closed: true } : { day: trimmed(h.day), open: h.open, close: h.close })),
    policies: Object.fromEntries(f.policies.map(([k, v]) => [trimmed(k), trimmed(v)] as const).filter(([k, v]) => k && v)),
    social_links: Object.fromEntries(
      f.social_links
        .map(([k, v]) => [trimmed(k), trimmed(v)] as const)
        .filter(([k, v]) => k && v)
        .map(([k, v]) => [k, profileHref(v) ?? v] as const)
    ),
    profile_links: f.profile_links
      .filter((w) => trimmed(w.title ?? ''))
      .map((w) => {
        const url = trimmed(w.url ?? '');
        return { ...w, title: trimmed(w.title), url: url ? profileHref(url) ?? url : '' };
      }),
    profile_facts: f.profile_facts
      .filter((w) => trimmed(w.title ?? ''))
      .map((w) => ({ ...w, title: trimmed(w.title), subtitle: trimmed(w.subtitle ?? '') })),
    ...(!suspended && f.open !== (store.status === 'active') ? { open: f.open } : {}),
  };
}

/** A refusal the server named, as the field it is about — or null. */
export function fieldErrorFromRefusal(code: string, details: Record<string, unknown> | undefined): FieldError | null {
  const field = typeof details?.field === 'string' ? details.field : '';
  if (code === 'MEDIA_NOT_OWNED' && field) return { field, kind: 'not_owned' };
  if (code !== 'STORE_FIELD_INVALID' || !field) return null;
  const index = typeof details?.index === 'number' ? details.index : undefined;
  const min = typeof details?.min === 'number' ? details.min : undefined;
  const max = typeof details?.max === 'number' ? details.max : undefined;
  if (field === 'social_links' || field === 'profile_links') return { field, kind: 'invalid_url', index };
  if (field === 'accent') return { field, kind: 'invalid' };
  const reason = details?.reason;
  return { field, kind: reason === 'short' ? 'short' : reason === 'invalid' ? 'invalid' : 'long', min, max };
}

/**
 * Which form row a header-links refusal is about. The server names the row's
 * place in the list AS SENT, and `patchFromForm` sends only the titled rows —
 * so the n-th SENT row is the n-th titled row of the form.
 */
export function widgetRowForSentIndex(rows: ReadonlyArray<ProfileWidget>, sent: unknown): number | undefined {
  if (typeof sent !== 'number') return undefined;
  let n = -1;
  for (let i = 0; i < rows.length; i++) {
    if (trimmed(rows[i].title ?? '')) n++;
    if (n === sent) return i;
  }
  return undefined;
}

/** Which row of a social-links refusal the server named (it names the KEY). */
export function socialRowForKey(rows: ReadonlyArray<[string, string]>, key: unknown): number | undefined {
  if (typeof key !== 'string') return undefined;
  const i = rows.findIndex(([k]) => k.trim() === key.trim());
  return i >= 0 ? i : undefined;
}
