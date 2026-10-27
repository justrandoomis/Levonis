import type { Driver } from './common.mjs';

export function createMoonraker(
  options: { base_url: string; api_key?: string; timeout_seconds?: number; upload_timeout_seconds?: number; camera_stream_id?: string },
  deps?: { fetch?: (input: string, init?: RequestInit) => Promise<Response> }
): Driver;
