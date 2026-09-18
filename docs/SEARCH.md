# Search — «مهما كتب يظهر الذي يريده»

The shop's search could not find the shop's own flagship product.

```sql
name LIKE '%q%' OR name_ar LIKE '%q%' OR name_ku LIKE '%q%' OR description LIKE '%q%'
```

Four unindexed substring scans, no tokenisation, no ranking. A customer looking
for the **Bambu Lab X2D Combo** types بامبو، بمبو، اكس تو دي، اكس، تو دي،
طابعه، نوزلين، طبعات — and not one of those is a substring of the product's
name, so every one of them returned nothing.

---

## 1. Four problems, not one

The owner's sentence hides four separate problems. Confusing them is why naive
search fails on Arabic, so each gets its own tool and the tools never overlap.

| # | Problem | Example | Tool |
|---|---|---|---|
| 1 | **Orthography** — one word, several spellings | «طابعة» / «طابعه»، أ إ آ ا | `search/normalize.ts` |
| 2 | **Phonetic spelling across scripts** | «بامبو» *is* "bambu" | `search/translit.ts` |
| 3 | **Vocabulary** — different words, same meaning | «طابعة» *means* "printer" | `search/vocabulary.ts` + `search_synonyms` |
| 4 | **Typos** | «بمبو» is «بامبو» minus a letter | `search/match.ts` |

The separation is load-bearing. Romanising «طابعة» gives `tabah`, which is
nothing like `printer` — because it is not a *spelling* of "printer", it is the
Arabic *word* for it. Letting romanisation answer a vocabulary question would
produce confident nonsense, and a shopper who searches «نوزل» and is shown
resin has been actively misled by the shop.

---

## 2. Why not FTS5

SQLite's full-text extension gives tokenisation and ranking for free and does
not touch the actual problem: its tokenizers do no Arabic normalisation, no
romanisation and no typo tolerance, so every hard part above would still be
built beside it.

Against that: a virtual table is a hard dependency on an extension being
present in D1 **at migration time**, and a migration that cannot apply is a
failed deploy on a live shop. Two ordinary tables and one index cost nothing to
be certain about.

---

## 3. The shape

```
search_tokens(product_id, token, weight)     PRIMARY KEY (product_id, token)
  idx_search_tokens_token (token, product_id, weight)   ← covering

search_synonyms(term, canonical, owner_added, created_at)
```

**Every token is stored twice**: as itself, and as its romanised skeleton. That
is the one line that lets «بامبو» and "bambu" meet.

### What is indexed, and how heavily

| Field | Weight | Why |
|---|---|---|
| name (en / ar / ckb / sku) | 10 | The shopper naming the product |
| brand | 8 | |
| model & colour names | 6 | "Combo" is an OPTION name here, not part of the product name |
| **hashtags** | 5 | The best signal in this database — see below |
| section names | 4 | «طابعات» is a word about the section |
| description | 1 | |

The **hashtags** are not an afterthought. The owner tags richly — the X2D
carries `#x2d`, `#x2d-combo`, `#bambu-lab`, `#dual-nozzle`, `#ams-2-pro`,
`#multi-material`, `#fdm`, `#3d-printer` — which is a hand-written list of the
exact words a customer would search for, already attached to the right product.

The **description is weighted almost to nothing** on purpose. Half the
accessory catalogue says "compatible with Bambu Lab" somewhere. At an equal
weight, «بامبو» would bury the Bambu printer under everything that mentions
one — the classic failure of a naive index, and the reason weights exist.

---

## 4. A query, end to end

```
«بمبو اكس تو دي»
  → normalize    فold hamza/ta-marbuta, strip diacritics + tatweel
  → tokenize     [بمبو, اكس, تو, دي]
  → expand       synonyms  (بمبو → bambu)
                 romanise  (بمبو → bmbw)
                 collapse spelled-out Latin letters (اكس تو دي → x2d)
  → candidates   ONE indexed range scan per 2-char prefix
  → match        exact > prefix > bounded edit distance, over that set only
  → score        Σ (field weight × match quality), × coverage
```

**Coverage is a multiplier, not a bonus.** A product matching both query words
beats one matching either, however heavily weighted. Without it, "bambu x2d"
ranks every Bambu product above the X2D — which is the single most important
line in `scoreProducts`.

### The cost

Two reads, whatever the query, neither growing with the catalogue the way a
`LIKE '%…%'` scan does:

1. the candidate vocabulary — tokens sharing a query token's first two
   characters, an index range scan returning tens of rows;
2. the postings for the tokens that actually matched.

The fuzzy pass runs in the Worker over (1), not over the catalogue. That is
what makes typo tolerance affordable at all.

---

## 5. What is deliberately *not* forgiven

`editBudget` gives a three-letter token **no** typo budget. `abs` and `ams` are
one edit apart and are a plastic and a filament changer. A shopper shown an AMS
when they searched for ABS has been misled; being wrong is worse than finding
nothing.

And a query that matches nothing returns nothing. There is no substring
fallback — one would quietly hand back whatever happened to contain the
letters, which is how a search engine starts showing people things they did not
ask for. The one exception is a **missing index table**, i.e. a Worker that
reached production before migration 0089: answering "no results" for every
search on a live shop is worse than the scan it replaces, and a missing TABLE
is the sanctioned degrade in `worker/lib/membershipBenefits.ts`.

---

## 6. Keeping the index true

* **Written in the same batch as the product.** An index maintained in a second
  transaction disagrees with the catalogue every time the second one fails —
  a product that exists and cannot be found, or one renamed and still findable
  under its old name. `planSearchIndex` returns statements, not writes.
* **REPLACE, not merge.** A rename loses the old name; `tests/search.test.ts`
  pins that directly.
* **`ON DELETE CASCADE`**, and registered in `OWNED_TABLES`
  (`worker/lib/productDeletion.ts`) besides. The index holds the product's
  *name*: leave it behind and the shop keeps answering searches with a product
  that no longer exists. `tests/productDeletionRegistry.test.ts` walks the live
  schema and would have named the table anyway.
* **The write path checks the table is there.** This shop has two deploy paths
  and only one applies migrations, so a Worker that feeds the index can be live
  on a database that does not have it — and a save that names a missing table is
  an owner who cannot correct a price because of a search index they never asked
  about. `searchIndexInstalled` costs one `PRAGMA` on the admin write path; the
  backfill indexes the product as soon as the table lands.
  `tests/deployAheadOfMigrations.test.ts` pins both halves.
* **The backfill is a cron job, not the migration.** Indexing needs the brand
  and section *names* and the tokeniser — work SQL cannot do — and a shop with
  thousands of products cannot be indexed inside one invocation. `runDurableJobs`
  takes fifty unindexed products per run and reports `search_indexed`.

---

## 7. The vocabulary is the owner's

The seed in `worker/lib/search/vocabulary.ts` covers this shop's catalogue and
the owner's own examples. It will be wrong the first time somebody searches in
a way nobody predicted, which for a shop in Iraq selling foreign hardware is
constantly. So it is a **table**, with a door:

```
GET    /api/admin/taxonomy/search-vocabulary
POST   /api/admin/taxonomy/search-vocabulary     { term, canonical }
DELETE /api/admin/taxonomy/search-vocabulary/:term
```

A word added there works on the next search, with no deploy. Rows the owner
adds carry `owner_added = 1`, and the migration's re-seed is `INSERT OR IGNORE`,
so a correction is never reset to the seed's meaning.

Both sides are stored **normalised**, which is why one row covers «طابعة» and
«طابعه» at once and the owner never has to think about spelling variants.

---

## 8. Files

| File | What it is |
|---|---|
| `worker/lib/search/normalize.ts` | Orthography: folding, diacritics, tokenisation |
| `worker/lib/search/translit.ts` | Romanisation, and Latin letters spelled out in Arabic |
| `worker/lib/search/vocabulary.ts` | The seed dictionary |
| `worker/lib/search/match.ts` | Bounded edit distance and the budget |
| `worker/lib/search/index.ts` | Index rows, query expansion, scoring |
| `worker/lib/search/document.ts` | What of a product is searchable |
| `worker/lib/search/store.ts` | The only part that touches D1 |
| `migrations/0089_search_index.sql` | The two tables and the seed |
| `tests/search.test.ts` | The owner's own examples, as acceptance criteria |
