/**
 * ROUTE CLASSIFICATION — the finance routers (owner decision 2, step S1; the
 * vocabulary is in ./_types.ts, the test is tests/costRouteClassification.test.ts).
 *
 * Expenses, the profit report, the finance workspace, payroll and withdrawals,
 * compensation rules, journals, period close and investor contracts: COST, the
 * owner's alone. Each router has a door — the rate limit, then
 * `requireCostRead` — on a `use()` line above its first route
 * (tests/costPredicateUsage.test.ts), so every non-owner is refused before an
 * id is read. Investor contract voiding is the owner's act by identity. The
 * lot list of investment-finance stays open: a receiving assistant reads lots,
 * with every cost stripped.
 */
import type { RouteClassFile } from './_types';
import { adminFinanceRoutes } from '../../worker/routes/adminFinance';
import { adminFinanceOperationsRoutes } from '../../worker/routes/adminFinanceOperations';
import { adminFinancePeopleRoutes } from '../../worker/routes/adminFinancePeople';
import { adminFinanceReportRoutes } from '../../worker/routes/adminFinanceReport';
import { adminFinanceWorkspaceRoutes } from '../../worker/routes/adminFinanceWorkspace';
import { adminInvestmentFinanceRoutes } from '../../worker/routes/adminInvestmentFinance';

export default {
  family: 'finance',
  mounts: [
    {
      prefix: '/api/admin/finance',
      name: 'adminFinanceRoutes',
      router: adminFinanceRoutes,
      routes: {
        'GET /expense-categories': 'cost_read',
        'POST /expense-categories': 'cost_write',
        'PATCH /expense-categories/:id': 'cost_write',
        'GET /expenses': 'cost_read',
        'POST /expenses': 'cost_write',
        'PATCH /expenses/:id': 'cost_write',
        'DELETE /expenses/:id': 'cost_write',
        'POST /expenses/:id/restore': 'cost_write',
      },
    },
    {
      prefix: '/api/admin/finance/report',
      name: 'adminFinanceReportRoutes',
      router: adminFinanceReportRoutes,
      routes: {
        'GET /summary': 'cost_read',
        'GET /products': 'cost_read',
        'GET /categories': 'cost_read',
      },
    },
    {
      prefix: '/api/admin/finance-operations',
      name: 'adminFinanceOperationsRoutes',
      router: adminFinanceOperationsRoutes,
      routes: {
        'GET /config': 'cost_read',
        'POST /staff': 'cost_write',
        'PATCH /staff/:id': 'cost_write',
        'POST /centers': 'cost_write',
        'PATCH /centers/:id': 'cost_write',
        'GET /rules': 'cost_read',
        'POST /rules': 'cost_write',
        'PUT /rules/:id': 'cost_write',
        'GET /costs': 'cost_read',
        'POST /orders/:id/reconcile': 'cost_write',
        'POST /orders/:id/assignment': 'cost_write',
        'POST /costs/:id/approve': 'cost_write',
        'POST /costs/:id/reverse': 'cost_write',
        'GET /payroll': 'cost_read',
        'POST /staff/:id/payments': 'cost_write',
        'POST /staff/:id/advance-settlements': 'cost_write',
        'GET /expenses': 'cost_read',
        'POST /expense-links': 'cost_write',
        'POST /collections': 'cost_write',
        'GET /receivables': 'cost_read',
        'GET /journal': 'cost_read',
        'POST /journal': 'cost_write',
        'POST /journal/:id/reverse': 'cost_write',
        'POST /periods/close': 'cost_write',
        'PUT /permissions': 'cost_write',
        'GET /orders/:id/profit': 'cost_read',
        'GET /posting-errors': 'cost_read',
        'POST /orders/:id/retry-posting': 'cost_write',
        'GET /report': 'cost_read',
      },
    },
    {
      prefix: '/api/admin/finance-workspace',
      name: 'adminFinanceWorkspaceRoutes',
      router: adminFinanceWorkspaceRoutes,
      routes: {
        'GET /participant-report': 'cost_read',
        'GET /summary': 'cost_read',
        'GET /orders': 'cost_read',
        'GET /orders/:id': 'cost_read',
        'POST /orders/:id/adjustments': 'cost_write',
        'GET /promotions': 'cost_read',
        'POST /promotions': 'cost_write',
        'PATCH /promotions/:id': 'cost_write',
        'DELETE /promotions/:id': 'cost_write',
        'GET /export.csv': 'cost_read',
      },
    },
    {
      prefix: '/api/admin/finance-people',
      name: 'adminFinancePeopleRoutes',
      router: adminFinancePeopleRoutes,
      routes: {
        'POST /rules/:id/preview': 'cost_write',
        'POST /rules/:id/apply': 'cost_write',
        'GET /staff/:id/history': 'cost_read',
        'GET /accounts': 'cost_read',
        'GET /staff': 'cost_read',
        'POST /staff': 'cost_write',
        'PATCH /staff/:id': 'cost_write',
        'DELETE /staff/:id': 'cost_write',
        'GET /staff/:id/reconcile': 'cost_read',
        'POST /staff/:id/reconcile': 'cost_write',
        'POST /staff/:id/recheck': 'cost_write',
        'GET /accounts/:id/earnings': 'cost_read',
        'GET /withdrawals': 'cost_read',
        'POST /withdrawals/:id/approve': 'cost_write',
        'POST /withdrawals/:id/reject': 'cost_write',
        'POST /withdrawals/:id/pay': 'cost_write',
        'PATCH /costs/:id': 'cost_write',
      },
    },
    {
      prefix: '/api/admin/investment-finance',
      name: 'adminInvestmentFinanceRoutes',
      router: adminInvestmentFinanceRoutes,
      routes: {
        'GET /profiles': 'cost_read',
        'POST /profiles': 'cost_write',
        'GET /profiles/:id': 'cost_read',
        'GET /legacy': 'cost_read',
        'POST /legacy/:id/link': 'cost_write',
        'GET /config': 'cost_read',
        'GET /contracts': 'cost_read',
        'POST /contracts': 'cost_write',
        'POST /contracts/:id/funding': 'cost_write',
        // Voiding a contract is decided by identity (isOwner) inside the handler.
        'POST /contracts/:id/void': { cls: 'owner', refusal: { status: 403, code: 'FORBIDDEN' } },
        'GET /contracts/:id': 'cost_read',
        'GET /orders/:id': 'cost_read',
        // A receiving assistant's lot list: cost stripped, quantities kept (§52).
        'GET /lots': 'op',
        'GET /lots/:id': 'op',
        'POST /lot-cost-adjustments': 'cost_write',
      },
    },
  ],
} satisfies RouteClassFile;
