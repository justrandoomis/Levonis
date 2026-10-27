/**
 * The store's lazy screens, declared once: StoreRoutes renders them, and a
 * screen warms the one a customer is most likely to open next (the catalogue
 * the product page, the cart the quote, the quote the order) so the step
 * between them waits on data, not on code.
 */
import { prefetchable } from '../../../lib/routeReveal';

export const ProductPage = prefetchable(() => import('./ProductPage'));
export const CartPage = prefetchable(() => import('./CartPage'));
export const CheckoutPage = prefetchable(() => import('./CheckoutPage'));
export const OrdersPage = prefetchable(() => import('./OrdersPage'));
export const OrderPage = prefetchable(() => import('./OrderPage'));

/** Start fetching a screen's code without rendering it (a no-op once it is here). */
export const warm = (page: unknown): void => (page as { preload?: () => void }).preload?.();
