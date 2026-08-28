import { Hono } from 'hono';
import type { AppContext } from '../lib/types';

// Filled by the implementation pass — mounted in worker/index.ts.
export const templateRoutes = new Hono<AppContext>();
