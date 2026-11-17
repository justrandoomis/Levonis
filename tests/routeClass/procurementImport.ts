/**
 * ROUTE CLASSIFICATION — «استيراد فاتورة الشراء من الصور»
 * (worker/routes/adminProcurementImport.ts, mounted beside the procurement
 * router). Both routes read and propose purchase costs and spend the owner's
 * AI budget: cost class, the owner alone (a delegated `purchase` grantee is
 * refused too).
 */
import type { RouteClassFile } from './_types';
import { adminProcurementImportRoutes } from '../../worker/routes/adminProcurementImport';

export default {
  family: 'procurementImport',
  mounts: [
    {
      prefix: '/api/admin/procurement',
      name: 'adminProcurementImportRoutes',
      router: adminProcurementImportRoutes,
      routes: {
        'POST /import/extract': 'cost_write',
        'POST /import/match': 'cost_write',
      },
    },
  ],
} satisfies RouteClassFile;
