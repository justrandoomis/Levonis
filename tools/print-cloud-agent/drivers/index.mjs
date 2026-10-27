/**
 * The driver registry: a printer entry of the configuration → its driver.
 * The interface every driver implements is documented in ./common.mjs.
 */
import { createBambu } from './bambu.mjs';
import { createMoonraker } from './moonraker.mjs';
import { createOctoPrint } from './octoprint.mjs';
import { createSimulator } from './simulator.mjs';

export const DRIVERS = ['simulator', 'octoprint', 'moonraker', 'bambu'];

/**
 * @param {Record<string, any>} printer  a normalised printer entry (config.mjs)
 * @param {{ fetch?: typeof fetch, clock?: () => number, log?: any }} [deps]
 */
export function createDriver(printer, deps = {}) {
  switch (printer.driver) {
    case 'simulator':
      return createSimulator(printer, deps);
    case 'octoprint':
      return createOctoPrint(/** @type {any} */ (printer), deps);
    case 'moonraker':
      return createMoonraker(/** @type {any} */ (printer), deps);
    case 'bambu':
      return createBambu(/** @type {any} */ (printer), deps);
    default:
      throw new Error(`unknown driver ${String(printer.driver)}`);
  }
}
