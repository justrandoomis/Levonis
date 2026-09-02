/**
 * The QR encoder moved to worker/lib/qr.ts when the printed warranty receipt
 * needed the same codes: the document is rendered on the server, the profile
 * modal in the browser, and two copies of a Reed–Solomon implementation is
 * exactly the kind of duplication that drifts silently. The module is pure
 * TypeScript with no DOM or Worker API, so both sides import the one file.
 *
 * This re-export keeps every existing importer (and tests/qr.test.ts) working
 * against the path they already use.
 */
export * from '../../../worker/lib/qr';
