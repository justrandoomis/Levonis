/**
 * The store theme stylesheet (theme.css), as its own module.
 *
 * Every PAGE that renders a store imports this — the storefront, the product
 * page, the design panel (and the builder in wave 4). The renderer and the
 * theme wrapper do not, so they stay importable where no bundler runs (the
 * node test suite renders blocks for real). tests/storefrontBlocks.test.ts
 * fails when a page renders a store without it.
 */
import './theme.css';
