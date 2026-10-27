/**
 * STORE — printing hours, filament and accessories, the cart, the quote and
 * the customer's orders: every address under /store and /orders
 * (src/cloud/routes.ts). Prices, stock and every rule of a purchase are the
 * server's (worker/lib/printCloud/pricing.ts, orders.ts, wallet.ts); these
 * screens show them and ask for them, never compute them.
 *
 *   /store                       the catalogue: ?tab=hours|materials|accessories,
 *                                ?tier=<tier id> (hours of one class), ?cat=<category>
 *   /store/product/:productId    one product: its variants, a quantity, the
 *                                server's price for it (?variant=<id>&qty=<n>)
 *   /store/variant/:variantId    the same page opened from a variant id — the
 *                                way in for a reorder suggestion (?qty=<n>)
 *   /store/cart                  the cart (signed in), priced by the server
 *   /store/checkout/:quoteId     a stored quote: its frozen lines and expiry,
 *                                the payment method, «Place order». The way in
 *                                for a quote made elsewhere too, e.g. the
 *                                account's «top up to N» (POST
 *                                /me/inventory/top-up-quote answers a stored quote)
 *   /orders, /orders/:orderId    the customer's orders: pay from the Levonis
 *                                wallet or at the workshop, cancel an unpaid
 *                                one, see what was received
 *
 * The shell mounts this module WITHOUT a sign-in gate (a visitor may browse
 * the catalogue, and an admin previews it while the service is closed): the
 * cart, the quote and the orders ask for an account here, with <RequireSignIn>.
 *
 * The catalogue is part of this chunk (the store's front opens with one
 * request after the shell); every other screen is a lazy chunk of its own.
 */
import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import { RequireSignIn } from '../../auth';
import { useCloud } from '../../CloudContext';
import { CloudNotFound } from '../../shell/Notices';
import { adoptCartOwner } from './cart';
import Catalogue from './Catalogue';
import { CartPage, CheckoutPage, OrderPage, OrdersPage, ProductPage } from './pages';

export default function StoreRoutes() {
  const { user } = useCloud();
  const owner = user?.id ?? null;
  // A cart belongs to the account that filled it: a sign-out or another
  // account empties it here, before any screen of the section reads it.
  useEffect(() => adoptCartOwner(owner), [owner]);

  return (
    <Routes>
      <Route path="/store" element={<Catalogue />} />
      <Route path="/store/product/:productId" element={<ProductPage />} />
      <Route path="/store/variant/:variantId" element={<ProductPage />} />
      <Route
        path="/store/cart"
        element={
          <RequireSignIn>
            <CartPage />
          </RequireSignIn>
        }
      />
      <Route
        path="/store/checkout/:quoteId"
        element={
          <RequireSignIn>
            <CheckoutPage />
          </RequireSignIn>
        }
      />
      <Route
        path="/orders"
        element={
          <RequireSignIn>
            <OrdersPage />
          </RequireSignIn>
        }
      />
      <Route
        path="/orders/:orderId"
        element={
          <RequireSignIn>
            <OrderPage />
          </RequireSignIn>
        }
      />
      <Route path="*" element={<CloudNotFound />} />
    </Routes>
  );
}
