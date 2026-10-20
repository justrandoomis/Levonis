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

**Every Arabic-script token in a name is stored twice**: as itself, and as its
romanised skeleton. That is the one line that lets «بامبو» and "bambu" meet. A
LATIN token's skeleton is stored under a `~` mark (`~alaga` for "elegoo") that
only a query typed in Arabic letters looks up: bare, it made Latin words
collide ("heat" and "hot" were both `hat`, "plate" was `plata` beside "pla");
without it, «اليجو» and «سونلو» found nothing unless the brand was in the
synonym dictionary. `~` never survives `normalizeText`, and no range a Latin
query opens reaches it.

**Prose and measures carry no skeleton** (since `#doc:6`). A skeleton bridges a
NAME across scripts; a description word at weight 1 needs no bridge, and with
the Arabic and Sorani descriptions indexed their skeletons would fill every
Latin range — `al…` would hold every Arabic word with the article.

### What is indexed, and how heavily

| Field | Weight | Why |
|---|---|---|
| name (en / ar / ckb / sku) | 10 | The shopper naming the product |
| brand, in every language it is written in | 8 | |
| model & colour names, variant SKUs, aliases (colour / part / SKU codes, identity model and series) | 6 | "Combo" is an OPTION name here, not part of the product name; a variant SKU is the code on one colour's box |
| **hashtags** | 5 | The best signal in this database — see below |
| section names, in every language | 4 | «طابعات» is a word about the section |
| description (en / ar / ckb) | 1 | |

The brand and section names used to be read in ONE language (English, or
Arabic when there was none), and only the English description was indexed;
`#doc:6` reads all three, so a shopper's Sorani word for a section or an
Arabic word from a translated description finds the product. Variant SKUs come
from `product_variants.sku` (active variants only), read by the backfill's own
selection as `variant_skus` — no statement of its own.

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
  → normalize    fold hamza/ta-marbuta, strip diacritics + tatweel,
                 Arabic-Indic and Eastern digits (٤ ۴ → 4, ٫ → .)
  → tokenize     measures first (§4a), then the words: [بمبو, اكس, تو, دي]
  → grammar      stopwords and a measure's unit dropped (§4b)
  → expand       synonyms  (بمبو → bambu)
                 romanise  (بمبو → bmbw)
                 collapse spelled-out Latin letters (اكس تو دي → x2d)
                 a LONE spelled letter becomes a one-character prefix
                   (اكس → x → x2d, x1c) — only for the words that are not
                   also Arabic words, since «في» is "in" and «ال» is "the"
  → candidates   ONE indexed range scan per 2-char prefix
  → match        exact > prefix > bounded edit distance, over that set only;
                 the LAST word (unless a space follows it) keeps its exact hit
                 AND its completions, ranked by field weight — "hot" is on its
                 way to "Hotend", and the description word "hot" must not stop it
  → score        Σ over typed words of the BEST (field weight × match quality)
                 per product, × coverage
```

**Coverage is a multiplier, not a bonus.** A product matching both query words
beats one matching either, however heavily weighted. Without it, "bambu x2d"
ranks every Bambu product above the X2D — which is the single most important
line in `scoreProducts`. A typed word whose every range was cut by
`MAX_PREFIXES` is not counted: it could not have been found.

### 4a. Measures: «0.4», «1.75», «6×2»

'.' and '×' were separators like any other punctuation, and a token needs two
characters, so «0.4» tokenised to nothing, «0.4mm» to `4mm`, «1.75» to `75` and
«6×2» to nothing at all: the live search for «0.2» returned nothing and «nozzle
0.4» returned every nozzle and wiper. A pass over the folded text now lifts the
measures out whole, before the punctuation goes, and writes them one way:

| Typed | Token(s) |
|---|---|
| «0.4», «0.40», «.4», «٠٫٤», «۰.۴» | `0.4` |
| «1.75mm», «PLA1.75» | `1.75` (and `mm`, `pla` as words) |
| «6×2», «6x2», «6*2», «6 x 2», «٦x٢» | `6x2` |
| «Ø6×2mm», «D6x2 mm», «Φ6x2», «مغناطيس6×2» | `6x2` — a diameter mark, a lone D or an Arabic word glued in front is not part of the size |
| «0,4», «٠،٤», «1,75mm» | `0.4`, `1.75` — a decimal comma (a comma before three digits, «27,000», stays a thousands separator) |
| «20×20×2», «256×256×256» | `20x20x2` and its footprint `20x20` (index side) |
| «2.0» | `2` — an ordinary number again |
| «m3x8» | `m3x8` — a dimension glued to a Latin word stays the word |

A three-part size also writes its **footprint** on the index side: a printer's
«256×256×256» build volume answers «256x256» beside the plate written
«256x256»; «256x256x256» typed still asks for all three parts (the query does
not count the footprint as a second word).

On the query side a measure is **exact and required**: never forgiven a typo
(`6x3` is one edit away), and a product that does not carry it is not an
answer, however well it matches the other words. «nozzle 0.3», where nobody
sells a 0.3, answers nothing. Two exceptions, both about what counts as
carrying it:

* **The size still being typed** (it ends the query, no space or unit after
  it) is completed to the sizes that begin with it — only when no product
  carries it whole. «PLA 1.7», paused on the way to 1.75, lists the 1.75
  filament instead of nothing; «6x2» is the 6×2 magnet and never the 6×20 it
  is a prefix of; «PLA 1.7 », finished, is 1.7 or nothing.
* **A product still on an older builder's rows** (no `INDEX_STAMP`: the
  catch-up has not rewritten it since the stamp bump) has no measure tokens to
  carry, so it is not ruled out by one: it ranks after every product that
  carries the size, on its other words. `searchProducts` asks which of the
  products lacking the size carry the stamp — one read, only for a query with
  a size and only when somebody lacks it. Without this, a deploy that bumps the
  stamp would answer «nozzle 0.4» and «PLA 1.75» with nothing until the
  catch-up finished. Once coverage is 1, a size is required of everybody.

### 4b. A query's grammar

* **Stopwords** (`QUERY_STOPWORDS`, worker/lib/search/vocabulary.ts) — «في»,
  «من», "for", "the", «بۆ», «لە» … — are dropped from the query, never from the
  index. With the Arabic descriptions indexed, «في» is a word in nearly every
  product, and counting it let every product "cover" half of «نوزل في
  الطابعة». A word the owner's dictionary gives a meaning to is never a
  stopword, a query of nothing but stopwords stays itself, and a spelled-out
  run («بي في سي») still sees its middle letter.
* **A unit written against a measure** («0.4mm», «0.4 ملم») is said by the
  measure and is not looked up.
* **Multi-word synonyms match on word boundaries.** «قطع غيار» fires on those
  two words, not inside «مقطع غيارات».

### 4c. Identifiers: a code is answered exactly, or not at all

A shopper holding a spool, a box or a spare part types the code printed on it:
the colour code «10101», the part code «FAP035», a SKU. The ranked search finds
a product by such a code (the codes are aliases in its `model` field), but it
cannot say **which selection** the code names, nor that **nothing carries it**.
The identifier lane (`worker/lib/search/identifiers.ts`, migration 0206) says
both, beside the ranked search and in the same wave:

* **One key.** `identifierKey` is the only normaliser, on the stored codes and
  on every chunk a shopper types: upper case, Arabic-Indic and Persian digits
  folded, separators dropped — «fap-035», «ＦＡＰ０３５» and «FAP035» are
  `FAP035`, «١٠١٠١» is `10101`. A key needs a digit: «ABS» is a word, and a
  product whose SKU happens to be one never makes the word an "exact match".
* **`search_identifiers`** holds `(key, product, scope, kind, source)`: the
  product's SKU, each active variant's SKU (scope: the variant), each
  searchable external id at the scope it was stored at (a created import's
  colour code: its option value), a colour code written in an option or colour
  name «Jade White (10100)», and the size an option value is named with
  («0.4mm» → `0.4`, kind `measure`). A colour code stored at **product** scope
  — a merge that mapped the colour onto a `product_colors` colour, which 0194
  cannot scope, the live PLA Basic's 43 codes — is also placed on the one
  colour or option value that names it in its name or ends its id with it
  («jade-white-10100»). Exactly one, or none.
* **The answer** (listing route, only when there is something to say):
  `exact` — `[{ product_id, key, kind, scope: { kind, id } }]`, the products
  that carry a typed code, listed first; `matched` — `{ [product_id]:
  { option_value_ids, color_id, variant_id } }`, the selection its codes and
  sizes name, for the card's link; `exact_miss` — the codes, as typed, that no
  product the shopper may see carries. The words for the miss line («no exact
  match for …», in ar, en and ckb) belong to the search UI, not the API.
* **A query of nothing but codes, all carried, is answered by them** — and by
  the products that write the code in their own text (`spelled`, below),
  after them in the ranking's order. «FAP035» has one exact answer; a kit
  named "with FAP035 heater" carries the code too; the cutting mats whose
  «FAP030» shares its letters are not answers to it. A code beside words
  («FAP035 hotend») puts the exact products first and keeps the ranking after
  them.
* **A miss is only said about a code.** Four characters at least, and five
  digits («10102», a GTIN) or letters with two digits or more («FAP036»,
  «RTX4090»). Never a word, a model name («X1-Carbon», «A1 mini»), a size
  («0.4mm», «PLA1.75»), a quantity («1000g») or a short number («2024»). And
  never when a visible product's index **spells** the code — a code in a name
  or description is not "nothing" — nor while the last chunk is still being
  typed and some code starts with it. Spelled means the joined key as one
  token (`fap035`) or every **piece** of the code as the tokeniser writes it
  (`codePieces`: separators split, letter and digit runs split, a lone
  character joined to its neighbour) on one product: «CR-10» and «CR10» are
  `cr` `10`, «PA12-CF» `pa` `12` `cf`, «TPU95A» `tpu` `95a`, «X1C/P1S» `x1c`
  `p1s`. «CR-11» against the CR-10 is still a miss.
* **Honest about what it cannot see.** A hidden product's code is a miss, not a
  leak. A code that belongs to a selection counts while that selection is
  sold: a discontinued colour's code is not an exact answer, though the
  product still carries it at product scope. A database without 0206 says
  nothing about codes at all — no `exact`, no `exact_miss` — and the ranked
  search answers alone.
* **One statement, seven parameters**, however many codes (at most twelve a
  query): the hits of the codes and of the sizes, the products whose index
  spells a code (grouped in SQL, so a common piece such as «10» costs rows
  read, not rows returned), and whether anything starts with the code still
  being typed. Four compound terms; D1 refuses more than five. A lane that
  fails is logged and the ranked search answers alone.

### 4d. The cost

Two reads, whatever the query, neither growing with the catalogue the way a
`LIKE '%…%'` scan does:

1. the candidate vocabulary — tokens sharing a query token's first two
   characters, an index range scan returning tens of rows;
2. the postings for the tokens that actually matched.

The fuzzy pass runs in the Worker over (1), not over the catalogue. That is
what makes typo tolerance affordable at all.

---

### 4e. The words as constraints (`nl=1`)

With `nl=1`, `/api/products?search=` reads the words first
(`packages/catalog/src/nlQuery.ts`, pure, deterministic, no model):
«فلامنت اسود اقل من 30 الف» searches «فلامنت» under the colour black and a
price of at most 30,000; «طابعة بدون AMS» searches «طابعة» and leaves out the
AMS units and the combos. Arabic (Iraqi forms included), English and Sorani;
digits from every keyboard; number words (الف، مليون، هەزار، ملیۆن، «مليون
ونص», «نص مليون»); bounds before or after the amount and ranges; dollars and
«ورقة» converted at the shop rate; colours, materials, the 1.75/2.85
diameter, the sale mode («متوفر هسه» / «حجز»), refill or with spool («ريفل»,
«بكرة كاملة», «بدون بكرة») and «رخيص» as the price order.

**THE PRECISION RULE** (lead decision; it replaces the bare-number policy of
smart search 1.6 rounds 1 to 3). The parser applies a constraint only when it
is unambiguous; anything else stays plain search text and never hides a
product. When nothing applies (nothing understood, or only a chip the URL
already sets, or a dollar bound with no shop rate) the request is exactly the
request without `nl=1`: the typed search, no `understood`.

* **A price needs a money marker AND a comparator.** The amount carries a
  marker of its own: a thousand or million word (الف، ألف، هزار، هەزار،
  thousand, k; مليون، ملیۆن، million, m, mil), a money word or sign (دينار،
  دینار، dinar، IQD، د.ع; $، دولار، dollar، USD; «ورقة», a hundred-dollar note),
  or digits grouped in threes («30,000», «٣٠٬٠٠٠», «1.500.000»). And a clear
  comparator or a range opener stands with it in the same clause (a comma or
  «،» between them ends the clause): before the amount («اقل من», «أقل», «تحت»,
  «دون», «بحدود», «اقصى», "under", "below", "less than", "max", "up to",
  «کەمتر لە», «خوار»; «اكثر من», «فوق», "over", "above", "more than", "min",
  "at least", «زیاتر لە», «لانی کەم») or after it («واقل», «فما دون», «ونازل»,
  "or less", "and up", "+", «وطالع», Sorani «لە 30 هەزار کەمتر», «لە 500
  هەزار زیاتر»), or a range opener («بين … و», «ما بين», «من … الى», "between
  … and", "from … to", «لە نێوان … و», «لە … تا»; «من 30 الف ونازل» and «لە 20
  هەزارەوە بۆ سەرەوە» are "from" with a bound after the amount).
* **A bare number is never a price.** 30, 30000, 1500, «ثلاثين», a number
  with no money word, may be a model, a size or a code: «اقل من 30», "under
  1000", «بين 5000 و 15000», «زیاتر لە 500» apply nothing, and their words
  stay in the search as typed («بين 20 و 30 الف» keeps its «و»; «اقل من 25
  للبكرة» keeps «للبكرة», which is then no spool facet either). An amount
  without a comparator is no price either: «نص مليون», «مليونين», «ب 500
  الف», «250-400 الف» (no opener), «لە 20 هەزارەوە» alone. There is no
  borrowing: a bare end never shares the money word of the other end («بين 25
  و 50 الف», «بين 3 و 5 ورقات» apply nothing). A measure or a count after the
  amount is no price («اقل من 1 كيلو», "under 300mm", «اقل من الف غرام»,
  «کەمتر لە 2 کیلۆی PLA»); a price PER unit SOLD is, and the per-unit words go
  with it («اقل من 25 الف للكيلو», "25k per kg", "25k/kg", «کەمتر لە 25 هەزار
  بۆ هەر کیلۆیەک», «کیلۆی کەمتر لە 25 هەزار»): the units sold by are a kilo,
  a gram, a piece, a roll, a spool, a litre, a millilitre and a metre; per a
  length, a temperature, a power or a time it stays a measure. "Kobra 3 Max",
  "Kobra 2 Plus" and "3+" are model names: max, min, plus and + after a bare
  number are no bound.
* **Ranges and two bounds.** A range applies only when both ends carry a
  marker («بين 500 الف و مليون», "between 500k and 1m", «لە نێوان 20 هەزار
  و 30 هەزار»). Written high-to-low it is sorted only when both ends carry the
  same marker («بين 50 الف و 25 الف» is 25,000 to 50,000, "between 30,000 and
  20,000" likewise); with two markers («بين مليون و 500 الف») it is not
  applied. Two separate bounds apply only when BOTH qualify: «اكثر من 20 الف
  واقل من 50 الف» is 20,000 to 50,000, «اكثر من 10 واقل من 30 الف» applies
  neither; two currencies, or two bounds with nothing between them («اكثر من
  مليون واقل من 500 الف»), apply neither.
* **Negation around a price.** A negated comparator is read as its positive
  meaning only in its FIXED FORMS: «لا يزيد عن», «لا يقل عن», «مو اكثر من»,
  «مو اقل من», "no more than", "no less than", "not over", "not under", and the
  Sorani «زیاتر نەبێت لە», «کەمتر نەبێت لە», «لە … زیاتر نەبێت», «لە … کەمتر
  نەبێت» («نەبێ» too). Any other negation around a price leaves it unapplied
  and searched as typed: «بدون اقل من 30 الف», «ما يزيد عن مليون» (MSA "what
  exceeds", Iraqi "not more than"), «ما اريد اكثر من مليون», "not more than
  500k", "nothing over 1m", «زیاتر نییە لە 30 هەزار», «کەمتر لە 20 هەزار
  نەبێت».
* **Exclusions are for known terms only.** A negation word («بدون», «بلا»,
  «مو», «غير», "without", "no", "non-", «بێ», «بەبێ», «نەک» …) directly
  before a known term leaves it out: AMS or a combo (they go together), a
  colour, a material; over an article, a colour noun, "in" or "even" («بدون
  اللون الاسود», «بدون الـ AMS», "not in black"). Before any other word it
  excludes nothing and both words stay searched («طابعة بدون شاشة»). A list
  after it («بدون AMS ولا كومبو», «بدون AMS والا كومبو», «بدون AMS او كومبو»,
  "without AMS or combo", "without AMS nor combo", «بێ AMS یان کۆمبۆ») leaves
  out each known term; an unknown word in the list stays searched and the list
  runs on to its next list word («بدون AMS ولا P1S ولا كومبو» leaves out AMS
  and the combo, and searches P1S). A carried negation never touches a price,
  the sale mode, the spool or the order: they are read as written, and the
  list runs on past them. «ولا» and «والا» are "or" without a negation («PLA
  ولا PETG» lists both). The Sorani negation after a known term («ڕەش نەبێت»,
  «PLA نەبێت», «بەردەست نییە») is the same.
* **The rest, as before.** A colour or a material anywhere (a material stays a
  search word and also narrows the materials). The diameter (1.75 / 2.85) only
  in a query about filament (a filament or material word), «قطر» or mm beside
  it or not; a negated diameter is no facet. The sale mode only for its fixed
  phrases («متوفر», «موجود», "in stock", "available now", «بەردەستە»; «حجز»,
  "pre-order", «پێشوەختە»; negated, the other one): "direct drive" and "AMS
  ready" are features. Refill or with spool for the refill words, «مع بكرة»,
  «بكرة كاملة», «بدون بكرة»; a bare spool word only in a query about filament
  («PLA بكرة»), never beside an empty, holder, reusable, adapter or buffer word.
* **What becomes a filter leaves the search.** Price, sale, colour and sort
  words and the negations are consumed, and so are the spool and diameter
  words that became the facet: consumed, a spool word never reaches the
  `spool → filament` synonym. With nothing left to search, the whole shop is
  listed under the constraints.
* **Where each lands.** Price, sale, spool and diameter join the listing state
  (an explicit URL value wins). Colours, materials and exclusions are judged
  per product before the filters, the counts and the paging: an exclusion
  reads the names (every language) and the family, never the description
  («works with the AMS» is written on printers sold without one); a colour
  needs evidence (the colour facet, a name, a colour or option value sold); a
  material judges only products that have a `material_type`.
* **The chip drop contract.** Each chip's `drop` is the search text with that
  chip's words taken out; read again it gives the same answer less exactly that
  chip (removing the first exclusion of a negation list keeps the negation for
  the rest). The golden corpus (`tests/nlQueryGolden.test.ts`) states every row
  to this rule and checks the contract on each. The answer carries
  `understood: { text, chips }` — data for the chips the search UI words in
  ar, en and ckb (smart search 1.7). `nl` is part of the edge cache key.

### 4f. Saying it back: the search UI (smart search 1.7)

The live field (`src/components/search/LiveSearch.tsx`) and the results page
(`src/pages/Products.tsx`) both ask with `nl=1`, so the panel under the field
and «عرض كل النتائج» list the same thing; the opening read the document primes
(`src/lib/bootFetch.ts`, `worker/lib/socialPreview.ts`) carries it too. What
they say beyond the products lives in `src/components/search/searchKit.tsx`, a
lazy chunk the panel hands the field, so none of the wording is in the entry:

* **Chips, one per constraint**, in ar, en and ckb («حتى 30,000 د.ع», «أسود»,
  «بدون AMS» / «بێ AMS»). Each chip of the answer carries `drop`: the search
  text with that chip's words taken out and every other word kept as typed
  (`NlQuery.without`, keyed by `nlChipKey`). Removing a chip puts `drop` in
  the field, so a removed chip is just another search and the field always
  shows what is applied.
* **The exact lines.** `exact` reads «تطابق دقيق لـ «FAP035»» and its row is
  marked «تطابق دقيق»; `exact_miss` reads «لا يوجد تطابق دقيق لـ «10102»». Both
  lines show when one code was carried and another was not («10101 10102»).
  Under the miss line a sentence labels only the rows that are not an exact
  hit, and only when there are some: «النتائج أدناه قريبة منه، وليست تطابقًا
  دقيقًا» when nothing is exact, «النتائج الأخرى قريبة منه…» ("the other results
  are near matches") beside an exact hit. Each of those rows carries «قريب» /
  "Near" / «نزیک», never the code.
* **Each row** shows the card's three-state availability (`AvailabilityLine`,
  the shared `cardAvailability` of packages/catalog).
* **`?v=`.** A result that matched a selection links to its product with that
  selection (`src/components/search/resultLink.ts`, the canonical combination
  key `o:…|c:…`). `src/pages/Product.tsx` decodes it as untrusted input
  (`linkedSelection` in `src/components/product/priceRequestState.ts`: only
  ids the product owns, one value per group), applies it once per product and
  link before the first paint — one selection state, so a phone and a desktop
  open the same way — and prices it through the quote. It is chosen on top of
  the opening selection (`linkedOpening`): «0.4» keeps the other groups and
  the single-value ones, and a linked colour brings the options it is sold
  with. **`?v=` then follows the selection**: a later choice rewrites it in
  place (`followSelectionInAddress`, `history.replaceState` over the entry the
  router holds; nothing chosen removes it), so a reload or a shared address
  opens what is on screen, never the variant the search matched. It is not a
  navigation: a router navigate, even a replace, makes a new location key, and
  the shell scrolls to the top on every new key, so each option tap would jump
  to the top. A page not opened from a link never grows a `?v=`. The link is
  applied once per product, link and NAVIGATION (`linkArrival`, keyed on the
  location key): tapping the same result again after a choice is a router
  replace to the same search, so only its new key says it happened, and the
  linked selection comes back. It is applied only while the window still shows
  it: a router entry whose `?v=` a choice already rewrote is an old address,
  never applied over the screen. The `?alert=` and `?price_request=`
  consumers drop their parameter with a replace built from the WINDOW address
  (`addressWithout`), so a router replace never brings back a stale `?v=`.

## 5. What is deliberately *not* forgiven

`editBudget` gives a three-letter token **no** typo budget. `abs` and `ams` are
one edit apart and are a plastic and a filament changer. A shopper shown an AMS
when they searched for ABS has been misled; being wrong is worse than finding
nothing.

**A token with a digit in it gets no typo budget either**, whatever its length.
It is a code, a model or a size, and one edit away is a different one: one
edit scored 0.55, so the unknown colour code «10102» answered with the colours
10100 and 10101. And a number is completed only while it is being typed:
«1010» may offer 10100 and 10101, «1010 » (finished) and a tool's lookup never
do. A model fragment with letters in it («x2» in «bambu x2 combo») still
reaches `x2d` by prefix — that is what it begins, not a typo of it.

**The Arabic article is not the word's first two letters.** «ال» (and «وال»,
«بال», «فال», «كال», «لل») begins most nouns in an Arabic description, so the
range «ال» holds thousands of words and the vocabulary read stops at its cap in
token order. A query token that starts with the article narrows on the article
and the stem's first letter (`candidatePrefix`, «الطابعه» → «الط»): the same
"first two letters" rule, applied to the word rather than to its article.

A MISSPELLING INSIDE THE FIRST TWO LETTERS is not forgiven either, and that is
a consequence of the cost model rather than an oversight. The candidate
vocabulary is fetched by each query token's first two characters — that bound is
what makes the fuzzy pass affordable — so «طبعات» never sees «طابعات», because
«طب» is not «طا». Widening the scan to rescue it would mean reading a far larger
slice of the vocabulary on *every* search. The owner's table answers it in one
row instead (migration 0091 seeds «طبعات» and «طبعه»), which is what §7 means by
the vocabulary being the owner's.

And a query that matches nothing returns nothing. There is no substring
fallback — one would quietly hand back whatever happened to contain the
letters, which is how a search engine starts showing people things they did not
ask for. The one exception is a **missing index table**, i.e. a Worker that
reached production before migration 0089: answering "no results" for every
search on a live shop is worse than the scan it replaces, and a missing TABLE
is the sanctioned degrade in `worker/lib/membershipBenefits.ts`.

### One letter, and the word still being typed

«H» names a shelf, not a word. It matches every word that NAMES a product —
name, brand, option, hashtag (weight ≥ 5) — and never prose, unless nothing
names anything with that letter. The old rule kept the forty SHORTEST h-words
of the whole vocabulary, which on a real catalogue were all description words.

The listing also returns `suggestion`: the word the shopper is typing,
completed from the names of the products it ranked first
(`worker/lib/search/complete.ts`). The storefront draws the rest of it in grey
inside the field; Space (only while it is showing), Tab or the arrow toward
the end of the text takes it (`src/components/search/`).

### Hidden products take no ranking slot

The index holds every product, hidden and draft ones included, and the route
filters what the engine hands it. A hidden product ranked in the top 200 cost a
visible one its place — «H» or a brand on a shop with hidden stock answered
with fewer, and worse, products than it had. When more than 200 products match,
the engine now asks the route which of its best **600** (3×) are listed — the
same `listedScope` the listing reads with — and cuts to 200 after
(`SearchOptions.visible`, `VISIBILITY_OVERFETCH`). One extra read, only on a
search that ranks more than 200 products.

### The hit list is ONE bound parameter

`GET /api/products?search=` binds the ranked ids as one JSON array
(`json_each`) for both the `IN` and the ranking `ORDER BY`. It bound every id
twice, and D1 refuses more than 100 parameters — any query ranking fifty
products or more answered 500. `tests/searchLive.test.ts` runs the route on a
D1 stand-in that refuses what D1 refuses.

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
  thousands of products cannot be indexed inside one invocation. It takes the
  products that do not carry the current **stamp** (`INDEX_STAMP`, a weight-0
  row `#doc:<n>`; `#doc:6` today), which is "never indexed" and "indexed by an
  older builder" in one predicate. The quarter-hour tick runs it after its
  jobs, with what they left of D1's 1,000 statements, charging every statement
  before it sends it (`backfillSearchIndex`, DECISIONS row 201): up to **200**
  products a pass; every unbudgeted caller takes fifty. It commits in groups of
  ten; a product it cannot write is marked `#fail:<n>`, reported, and skipped,
  so one bad row cannot stall the rest.
* **A product is a few statements, not one a token.** Its rows go in as JSON
  arrays, `INDEX_ROWS_PER_STATEMENT` (500) to an `INSERT … SELECT … FROM
  json_each(?)`, the stamp in the last one: a product is its DELETE and one
  INSERT per 500 rows. One statement a row made a stamp bump take days of
  ticks; now a few ticks rewrite the catalogue.
* **The rollout is visible.** `GET /api/admin/search/index-status` answers the
  stamp, the active products, how many are `current`, still on an `older`
  builder's rows, `missing` or `failed`, and the `coverage` (current / active).
  Coverage 1 is the whole active catalogue on the current builder. The pace is
  a bound, not a measurement: `backfill.max_per_pass` (200) and
  `min_passes_left` — a tick whose jobs spend more of the 1,000 statements, or
  bigger products, write fewer. Until coverage is 1 a product on older rows
  still answers by its old tokens, and ranks after the products that carry a
  size it was not yet indexed with (§4a) instead of dropping out.
* **A brand or section rename reindexes its products.** The index holds the
  NAMES; the rename deletes the affected products' stamps in the same batch and
  rewrites the first fifty at once — the cron does the rest.
* **The identifier rows ride with the tokens.** The product save and the
  catch-up write a product's `search_identifiers` rows in the same batch as its
  tokens (`planSearchIndexRows(db, id, rows, identifiers)`: a DELETE and one
  packed INSERT per 500 rows), from the same sources read by the same loader
  (`loadSearchSources`, the alias statement with each external id's scope and
  type), and stamp them `#ids:1` beside `#doc:6`. The catalogue import passes
  the external ids its own batch writes (`searchExternalIds`). A writer that
  rewrites tokens alone — a hashtag rename — deletes the `#ids:1` stamp with
  the rest of the product's rows, and the catch-up selects the product again
  (its predicate: no `#doc:6`, or, once 0206 is there, no `#ids:1`; whether
  0206 is there is asked inside the selection, through `sqlite_master`, so it
  costs no statement). So a deploy of 0206 needs no stamp bump: the catch-up
  fills the table at its usual pace, and `index-status` counts a product as
  `current` only with both stamps (`identifiers: { installed, stamp, rows }`).

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
| `worker/lib/search/normalize.ts` | Orthography: folding (letters and digits), diacritics, measures, tokenisation |
| `worker/lib/search/translit.ts` | Romanisation, and Latin letters spelled out in Arabic |
| `worker/lib/search/vocabulary.ts` | The seed dictionary, and the query stopwords |
| `worker/lib/search/match.ts` | Bounded edit distance and the budget |
| `worker/lib/search/index.ts` | Index rows, query expansion, scoring |
| `worker/lib/search/document.ts` | What of a product is searchable |
| `worker/lib/search/complete.ts` | The grey completion: which word, and how much of it is left |
| `worker/lib/search/store.ts` | The only part that touches D1 (bar the identifier lane) |
| `worker/lib/search/identifiers.ts` | The identifier key, the rows a product is keyed by, and the exact resolver |
| `migrations/0089_search_index.sql` | The two tables and the seed |
| `migrations/0206_search_identifiers.sql` | `search_identifiers` |
| `tests/search.test.ts` | The owner's own examples, and acceptance rows 1–4 and 13 of the assistant plan |
| `tests/searchLive.test.ts` | A realistic catalogue through the route on D1's parameter ceiling; hidden products; the `#doc:6` rollout and its status |
| `tests/searchBackfillBudget.test.ts` | The catch-up within a statement budget |
| `tests/searchIdentifiers.test.ts` | Acceptance rows 5–7 through the route on D1's limits; both writers; a database without 0206 |
| `packages/catalog/src/nlQuery.ts` | The words as constraints (`nl=1`): the parser, `nlApply` onto the listing state, `nlKeeps` per product |
| `tests/assistUnderstand.test.ts` | Acceptance rows 9–12: the parser in three languages, and through the route on D1's limits; a removed chip's text |
| `src/components/search/searchKit.tsx` | The search UI's words (smart search 1.7): chips, the exact line, the row note, the result link |
| `src/components/search/resultLink.ts` | The `?v=` link a result carries; `linkedSelection` (priceRequestState.ts) is the page's decoder |
| `tests/searchUi.test.ts` | The chips and the exact line in three languages, the row availability, `?v=` both ways |
