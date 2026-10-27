import type { Driver } from './common.mjs';

export const DRIVERS: Array<'simulator' | 'octoprint' | 'moonraker' | 'bambu'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDriver(printer: Record<string, any>, deps?: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; clock?: () => number; log?: unknown }): Driver;
