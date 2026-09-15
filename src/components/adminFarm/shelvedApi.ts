/**
 * The console's view of the shelving switch — `PUT /api/admin/farm/shelved`,
 * the one write path for `admin_settings.printerFarmShelved`
 * (worker/routes/farm.ts, "the shelving switch").
 *
 * Its own module, beside the console, because `farmAdminApi` describes the
 * balancing DOCUMENT: this row is not part of it, has no version to race on,
 * and is deliberately reachable while the game is closed.
 *
 * Nothing here touches Levonis Points or the wallet; the switch moves no
 * money and deletes nothing — it only decides who may open the game.
 */
import { api } from '../../lib/api';

export interface FarmShelvedRead {
  success: true;
  /** True while the game is closed to players. */
  shelved: boolean;
  /** The settings key the server reads, echoed so the console can name it. */
  key: string;
}

export interface FarmShelvedWrite {
  success: true;
  shelved: boolean;
  /** False when the switch already stood where it was asked to stand. */
  changed: boolean;
}

export const farmShelvedApi = {
  read: () => api.get<FarmShelvedRead>('/api/admin/farm/shelved'),
  /** `open: true` opens the game to players; the server audits every flip. */
  set: (open: boolean) => api.put<FarmShelvedWrite>('/api/admin/farm/shelved', { open }),
};
