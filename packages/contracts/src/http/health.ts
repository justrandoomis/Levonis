import type { HealthReport } from '../rpc/common';

/** `GET /api/health` legacy shape (kept) and the deep fan-out (`01-TARGET.md` §11.3). */
export interface HealthResponse {
  success: true;
  status: 'ok';
  version?: string;
}

export interface DeepHealthResponse {
  success: boolean;
  gateway: HealthReport;
  services: Record<string, HealthReport | { ok: false; error: string }>;
}
