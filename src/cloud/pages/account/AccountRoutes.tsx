/**
 * ACCOUNT — THE CUSTOMER'S OWN RECORDS: every address under /account
 * (src/cloud/routes.ts). The shell mounts this module behind
 * `<RequireSignIn>`, so whoever reaches it is signed in.
 *
 *   /account                         the profile, the two balances, the menu
 *   /account/hours                   hours per printer class, purchases and expiry, holds, movements, conversion
 *   /account/materials               material owned at the workshop, reorder suggestions
 *   /account/materials/:variantId    one material: reminder, top-up, movements
 *   /account/shipments               pickups and deliveries
 *   /account/shipments/new           ask for one
 *   /account/shipments/:id           one shipment, its road, cancel
 *   /account/buyback                 sell unused material back
 *   /account/transactions            every movement, paged on the server's cursor
 *   /account/settings                language and appearance
 *
 * Every screen is a lazy chunk of its own. Every screen imports the
 * section's shared pieces (shared.tsx, logic.ts) and its words
 * (strings/account.ts), so Rollup keeps the three together as ONE chunk the
 * screens share — never a scatter of small ones by importer set
 * (tests/motionLazy.test.ts counts those). The rest of Print Cloud is reached
 * by its own routes: prints /jobs, orders /orders, files /files, the store
 * /store?tab=….
 */
import { Route, Routes } from 'react-router-dom';
import { prefetchable } from '../../../lib/routeReveal';
import { CloudNotFound } from '../../shell/Notices';

const AccountHome = prefetchable(() => import('./AccountHome'));
const AccountHours = prefetchable(() => import('./AccountHours'));
const AccountMaterials = prefetchable(() => import('./AccountMaterials'));
const AccountMaterial = prefetchable(() => import('./AccountMaterial'));
const AccountShipments = prefetchable(() => import('./AccountShipments'));
const AccountShipmentNew = prefetchable(() => import('./AccountShipmentNew'));
const AccountShipment = prefetchable(() => import('./AccountShipment'));
const AccountBuyback = prefetchable(() => import('./AccountBuyback'));
const AccountTransactions = prefetchable(() => import('./AccountTransactions'));
const AccountSettings = prefetchable(() => import('./AccountSettings'));

export default function AccountRoutes() {
  return (
    <Routes>
      <Route path="/account" element={<AccountHome />} />
      <Route path="/account/hours" element={<AccountHours />} />
      <Route path="/account/materials" element={<AccountMaterials />} />
      <Route path="/account/materials/:variantId" element={<AccountMaterial />} />
      <Route path="/account/shipments" element={<AccountShipments />} />
      <Route path="/account/shipments/new" element={<AccountShipmentNew />} />
      <Route path="/account/shipments/:id" element={<AccountShipment />} />
      <Route path="/account/buyback" element={<AccountBuyback />} />
      <Route path="/account/transactions" element={<AccountTransactions />} />
      <Route path="/account/settings" element={<AccountSettings />} />
      <Route path="*" element={<CloudNotFound />} />
    </Routes>
  );
}
