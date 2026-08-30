import { Hono } from 'hono';
import type { AppContext, Env } from './lib/types';
import { HttpError, originCheck, securityHeaders } from './lib/http';
import { loadSessionUser } from './lib/session';
import { runDurableJobs } from './lib/jobs';
import { authRoutes } from './routes/auth';
import { productRoutes, homeRoutes } from './routes/products';
import { cartRoutes } from './routes/cart';
import { orderRoutes } from './routes/orders';
import { addressRoutes } from './routes/addresses';
import { walletRoutes } from './routes/wallet';
import { rewardRoutes } from './routes/rewards';
import { subscriptionRoutes } from './routes/subscription';
import { investRoutes } from './routes/invest';
import { communityRoutes } from './routes/community';
import { chatRoutes } from './routes/chats';
import { profileRoutes } from './routes/profile';
import { uploadRoutes, fileRoutes } from './routes/uploads';
import { miscRoutes } from './routes/misc';
import { adminRoutes } from './routes/admin';
import { adminProductsRoutes } from './routes/adminProducts';
import { templateRoutes } from './routes/template';
import { mediaRoutes } from './routes/media';
import { adminTaxonomyRoutes } from './routes/adminTaxonomy';
import { adminProductRelationsRoutes } from './routes/adminProductRelations';
import { membershipsRoutes } from './routes/memberships';
import { telegramRoutes } from './routes/telegram';
import { invoiceRoutes } from './routes/invoices';
import { deviceRoutes } from './routes/devices';
import { reviewRoutes } from './routes/reviews';
import { returnRoutes, priceProtectionRoutes } from './routes/returns';
import { policiesRoutes } from './routes/policies';
import { kycRoutes } from './routes/kyc';
import { supportRoutes } from './routes/support';
import { referralRoutes } from './routes/referrals';
import { studioRoutes } from './routes/studio';

const app = new Hono<AppContext>();

app.use('*', securityHeaders());
app.use('*', originCheck());
app.use('*', async (c, next) => {
  await loadSessionUser(c);
  await next();
});

app.route('/api/auth', authRoutes);
app.route('/api/products', productRoutes);
app.route('/api/home', homeRoutes);
app.route('/api/cart', cartRoutes);
app.route('/api/orders', orderRoutes);
app.route('/api/addresses', addressRoutes);
app.route('/api/wallet', walletRoutes);
app.route('/api/rewards', rewardRoutes);
app.route('/api/subscription', subscriptionRoutes);
app.route('/api/invest', investRoutes);
app.route('/api/community', communityRoutes);
app.route('/api/chats', chatRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/uploads', uploadRoutes);
app.route('/api', miscRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin/products-v2', adminProductsRoutes);
app.route('/api/admin/template', templateRoutes);
app.route('/api/admin/media', mediaRoutes);
app.route('/api/admin/taxonomy', adminTaxonomyRoutes);
// Mounted on the same prefix as adminProductsRoutes; the paths are distinct
// (/:id/relations, /:id/stock) so neither router shadows the other.
app.route('/api/admin/products', adminProductRelationsRoutes);
app.route('/api/memberships', membershipsRoutes);
app.route('/api/telegram', telegramRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/devices', deviceRoutes);
app.route('/api/reviews', reviewRoutes);
app.route('/api/returns', returnRoutes);
app.route('/api/price-protection', priceProtectionRoutes);
app.route('/api/policies', policiesRoutes);
app.route('/api/kyc', kycRoutes);
app.route('/api/support', supportRoutes);
// Referrals & support codes (integrated mandate §3). Signup invites and
// purchase support codes live behind /api/referrals; the module itself keeps
// them separate and never lets a support code touch pricing.
app.route('/api/referrals', referralRoutes);
app.route('/api/studio', studioRoutes);
app.route('/files', fileRoutes);

// The previous architecture exposed raw SQL and schema management over HTTP.
// Those endpoints are gone; explicit 410s make the removal visible to any
// stale client instead of a confusing 404/SPA response.
app.all('/api/d1/query', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/d1/init', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/make-all-investors', (c) => c.json({ success: false, error: 'This endpoint has been removed.' }, 410));
app.all('/api/upload', (c) => c.json({ success: false, error: 'Use POST /api/uploads.' }, 410));

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/')) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  // Anything else falls through to the static assets (SPA).
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
  }
  // Detailed diagnostics stay server-side; clients get a safe generic error.
  console.error('Unhandled error', c.req.method, c.req.path, err);
  return c.json({ success: false, error: 'Something went wrong. Please try again.' }, 500);
});

export default {
  fetch: app.fetch,
  // Durable jobs: outbox delivery (email/telegram), stale-challenge expiry,
  // gated BNPL overdue stub. Idempotent — safe under overlapping runs.
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDurableJobs(env));
  },
};
