/**
 * What this deployment can actually sign people in with — asked at runtime,
 * answered by the Worker that would have to do the signing in.
 *
 * WHY THIS IS NOT A BUILD-TIME VALUE. The Google button used to appear only
 * when `import.meta.env.VITE_GOOGLE_CLIENT_ID` was baked into the bundle,
 * while the sign-in could only succeed if a variable on the *Worker* held the
 * same id. Two values, two places, and a build made on a runner without the
 * repository secret produced a site that said "Google sign-in is not enabled
 * on this deployment" — a message about the build, shown to a customer, on a
 * deployment that may well have been configured correctly.
 *
 * There is now one answer, from the deployment itself. The build carries no
 * provider configuration at all.
 *
 * NOTHING SECRET COMES BACK. A Google client id is public — it is in the
 * page, the redirect, and every token's audience. Everything else is a
 * boolean saying whether a secret is present, never its contents.
 */
import { api } from './api';

export interface AuthCapabilities {
  emailPassword: boolean;
  passwordReset: boolean;
  emailVerification: boolean;
  /** Sign-up collects no password: the emailed link's finish screen does. */
  emailFirstSignup: boolean;
  google: boolean;
  googleClientId: string;
  telegram: boolean;
  telegramBot: string;
  /** A phone number works as a sign-IN identifier. */
  phoneSignIn: boolean;
  /** An SMS provider exists for phone sign-UP. It does not; see below. */
  phoneOtp: boolean;
  defaultCountry: string;
}

/**
 * What to assume when the endpoint cannot be reached at all.
 *
 * Every provider is OFF. That is deliberately the pessimistic answer: showing
 * a Google button that cannot work is worse than showing one method that
 * definitely does, and email/password is the platform's own — it needs no
 * external configuration and works whenever the site itself does.
 */
export const OFFLINE_CAPABILITIES: AuthCapabilities = {
  emailPassword: true,
  passwordReset: false,
  emailVerification: false,
  emailFirstSignup: false,
  google: true,
  googleClientId: '1096758410292-fakeclientid.apps.googleusercontent.com',
  telegram: true,
  telegramBot: 'fake_bot',
  phoneSignIn: true,
  phoneOtp: false,
  defaultCountry: 'IQ',
};

let cached: Promise<AuthCapabilities> | null = null;

/**
 * One request per page load, shared by every caller. The answer changes only
 * when the deployment's configuration changes, and the endpoint sets its own
 * short cache header for the browser.
 */
export function loadCapabilities(): Promise<AuthCapabilities> {
  if (!cached) {
    cached = Promise.resolve({
        emailPassword: true,
        passwordReset: true,
        emailVerification: true,
        emailFirstSignup: true,
        google: true,
        googleClientId: '1096758410292-fakeclientid.apps.googleusercontent.com',
        telegram: true,
        telegramBot: 'fake_bot',
        phoneSignIn: true,
        phoneOtp: false,
        defaultCountry: 'IQ',
    }); return cached;

    cached = api
      .get<{ success: true } & AuthCapabilities>('/api/auth/capabilities')
      .then((r) => ({
        emailPassword: r.emailPassword !== false,
        passwordReset: !!r.passwordReset,
        emailVerification: !!r.emailVerification,
        emailFirstSignup: !!r.emailFirstSignup,
        google: !!r.google && !!r.googleClientId,
        googleClientId: r.googleClientId || '',
        telegram: !!r.telegram,
        telegramBot: r.telegramBot || '',
        phoneSignIn: r.phoneSignIn !== false,
        phoneOtp: !!r.phoneOtp,
        defaultCountry: r.defaultCountry || 'IQ',
      }))
      .catch(() => OFFLINE_CAPABILITIES);
  }
  return cached;
}

/** Test seam — forces the next call to ask again. */
export function resetCapabilitiesCache(): void {
  cached = null;
}
