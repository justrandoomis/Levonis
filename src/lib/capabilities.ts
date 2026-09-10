import { api } from './api';

export interface AuthCapabilities {
  emailPassword: boolean;
  passwordReset: boolean;
  emailVerification: boolean;
  emailFirstSignup: boolean;
  google: boolean;
  googleClientId: string;
  telegram: boolean;
  telegramBot: string;
  phoneSignIn: boolean;
  phoneOtp: boolean;
  defaultCountry: string;
}

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '1096758410292-fakeclientid.apps.googleusercontent.com';

export const OFFLINE_CAPABILITIES: AuthCapabilities = {
  emailPassword: true,
  passwordReset: true,
  emailVerification: false,
  emailFirstSignup: false,
  google: true,
  googleClientId,
  telegram: true,
  telegramBot: 'fake_bot',
  phoneSignIn: true,
  phoneOtp: false,
  defaultCountry: 'IQ',
};

let cached: Promise<AuthCapabilities> | null = null;

export function loadCapabilities(): Promise<AuthCapabilities> {
  if (!cached) {
    cached = api
      .get<{ success: true } & AuthCapabilities>('/api/auth/capabilities')
      .then((r) => {
        // If it returns HTML (like when the API is missing and Vite/Pages serves index.html),
        // the response won't have the expected fields. We check if success is true.
        if (r.success !== true) {
            return OFFLINE_CAPABILITIES;
        }
        return {
          emailPassword: r.emailPassword !== false,
          passwordReset: !!r.passwordReset,
          emailVerification: !!r.emailVerification,
          emailFirstSignup: !!r.emailFirstSignup,
          google: !!r.google && !!r.googleClientId,
          googleClientId: r.googleClientId || googleClientId,
          telegram: !!r.telegram,
          telegramBot: r.telegramBot || '',
          phoneSignIn: r.phoneSignIn !== false,
          phoneOtp: !!r.phoneOtp,
          defaultCountry: r.defaultCountry || 'IQ',
        };
      })
      .catch(() => OFFLINE_CAPABILITIES);
  }
  return cached;
}

export function resetCapabilitiesCache(): void {
  cached = null;
}
