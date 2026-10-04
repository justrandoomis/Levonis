# Finance and inventory workspace performance

The finance and inventory upgrade adds three scoped stylesheets for operations
screens. They load after an administrator opens the workspace, or after a linked
account opens its protected earnings page. Customer and merchant storefront
pages do not import these screens or stylesheets statically.

The existing CSS budget remains **60 KiB gzip (61,440 bytes)** for the original
stylesheets and every other stylesheet. A separate **7 KiB gzip (7,168 bytes)**
combined budget applies only to these three new sheets:

| Source | Built sheet | Scope |
| --- | --- | --- |
| `src/components/financeWorkspace/finance-workspace.css` | `FinanceWorkspace-*.css` | `.fw` |
| `src/components/adminInventory/inventory-workspace.css` | `AdminInventory-*.css` | `.inventory-workspace` |
| `src/components/financePeople/people.css` | `shared-*.css` | `.fp` |

The baseline was already close to 60 KiB. Raising that threshold would allow
ordinary pages to grow silently. Removing unrelated styles would change existing
screens, and moving CSS into JavaScript would hide its transfer cost. This upgrade
instead bounds the new, separately loaded operations feature while keeping the
original public and merchant budget unchanged. This follows the admin code
splitting requirement in `docs/architecture/01-TARGET.md` §10; the merchant budget
and storefront closure limits in `docs/MERCHANT_PLATFORM_V2.md` stay in force.

The measured build on 2026-10-04, using `gzipSync` at level 9:

| Measurement | Bytes | Limit |
| --- | ---: | ---: |
| Original and other stylesheets | 61,009 | 61,440 |
| New finance workspace sheet | 3,728 | Combined below |
| New inventory workspace sheet | 1,041 | Combined below |
| New linked-account earnings sheet | 1,822 | Combined below |
| Three new sheets together | 6,591 | 7,168 |

The entry stylesheet remains `index-C8GexQY2.css`, 48,112 bytes gzip. The build's
Vite manifest shows only this sheet in the initial static closure. The storefront
adds its existing theme sheet; the storefront product page also adds the existing
swatches sheet. None of the three new operation sheets is present in those
closures. Build hashes and exact sizes can change; the limits and loading guards
are enforced against the current build.

`tests/bundleBudget.test.ts` checks both limits. It requires each exempted sheet
to have the expected filename and scope, requires its owner to be a named dynamic
entry, and proves that the new feature JavaScript and CSS are outside the initial
payload and customer/merchant page static closures. It also checks that every
`/earnings` route is protected. Renaming or merging a sheet does not silently
exempt it: the dedicated-sheet check fails, and any unclassified CSS remains in
the original 60 KiB gate.

The test does not establish visual quality. Local fixtures cover the workspace,
linked-account screens, and inventory without live customer data. Browser visual
verification is reported separately.
