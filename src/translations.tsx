export type Language = 'en' | 'ar' | 'ckb';
export const translations = {
  en: new Proxy({}, { get: (_, prop) => String(prop) }),
  ar: new Proxy({}, { get: (_, prop) => String(prop) }),
  ckb: new Proxy({}, { get: (_, prop) => String(prop) })
} as any;
export const STUDIO_URL = 'http://localhost:3000';
