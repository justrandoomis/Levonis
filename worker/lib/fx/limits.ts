/**
 * THE REFRESH LIMITS (FX programme plan §8, critique F4). Both routes that can
 * make a provider call — `POST /rates/fx/refresh` and `PUT /rates/fx/:pair/settings`
 * when it returns a pair to automatic — charge BOTH buckets: 10 an hour per
 * user, and 40 a day for the whole shop under one explicit key. The provider's
 * own day cap (schedule.ts) applies on top.
 */
export const FX_REFRESH_BUCKET = 'fx-refresh';
export const FX_REFRESH_LIMIT = 10;
export const FX_REFRESH_WINDOW_S = 3600;
export const FX_REFRESH_GLOBAL_BUCKET = 'fx-refresh-global';
export const FX_REFRESH_GLOBAL_LIMIT = 40;
export const FX_REFRESH_GLOBAL_WINDOW_S = 86_400;
export const FX_REFRESH_GLOBAL_KEY = 'global';
