/**
 * The merchant workspace's addresses, for the SPA. The one spelling lives in
 * packages/contracts/src/merchantRoutes.ts, which the Worker also uses to
 * write notification links — so a stored link and the router can never drift.
 */
export * from '../../packages/contracts/src/merchantRoutes';
