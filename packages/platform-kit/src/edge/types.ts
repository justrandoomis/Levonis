/**
 * The Hono context the edge copies run in. The core's `AppContext`
 * (`worker/lib/types.ts`) sets `host` once per request; the gateway and every
 * service use this structural equivalent, so the copied middleware bodies stay
 * byte-identical to the core's while the import differs.
 */
import type { HostInfo } from './hosts';

export interface EdgeEnv {
  EXTRA_ALLOWED_ORIGINS?: string;
  STORE_ROOT_DOMAIN?: string;
  APP_ORIGIN?: string;
  GATEWAY_ONLY?: string;
  ALLOWED_CALLER_KIDS?: string;
  HEALTH_PROBE_TOKEN?: string;
}

export type AppContext = {
  Bindings: EdgeEnv;
  Variables: {
    host: HostInfo;
    cid?: string;
    /** the verified inbound hop issuer (`gateway`), when `GATEWAY_ONLY` is not `off` */
    hopIss?: string | null;
  };
};
