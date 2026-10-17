# Translating the imported Bambu Lab text (Arabic and Sorani)

docs/bambu-import/I18N-DESIGN.md; DECISIONS rows 2 and 183. These rules bind every translator and reviewer.

## What you write
For each batch `batches/batch-NNN.json`, write `batches/batch-NNN.out.json`:

    [ { "h": "<the string's h>", "ar": "<Arabic>", "ckb": "<Sorani>", "status": "reviewed" | "needs_review" } ]

One object per string you translate, `h` copied exactly. Leave a string out rather than guess: it stays English.
`needs_review` is stored and never shown. A reviewer signs off before `reviewed` is committed.

## The house rules
1. Product NAMES are never translated: product, option and colour names stay English (see names.json). A name inside a sentence is copied verbatim.
2. Model numbers, part codes, units and brand names stay in Latin script, exactly as written: X1C, A1 mini, SA011, M3*21.5, 4-Pin, 24V, 10mA, 0.4 mm, °C, PLA, PETG-CF, Bambu Lab.
3. Numbers stay Western digits (0-9), never Arabic-Indic digits; every number of the English appears in both translations.
4. Sorani (ckb) is real Central Kurdish in Arabic script, with its own letters (ە ێ ۆ ڵ ڕ) — never a copy of the Arabic.
5. Never add a price, a cost, stock, availability, delivery or shipping time — the English carries none, so a translation never does.
6. Write Arabic punctuation between Arabic words, and around Latin names inside Arabic sentences: ، ؛ ؟
7. Never put a bidi control character (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) in the text: the site isolates Latin runs itself.
8. Keep one line one line: no line break inside a translation; a bullet or a table separator is not part of the string.
9. Use the app's own words where they exist (glossary.json): the same spec label, section and colour names the site already shows.
10. The length stays reasonable: at most three times the English (or the English plus 200 characters).

## What is checked (packages/catalog/src/bambuImport/i18n.ts validateTranslationRow)
The key matches the English; the text is normalized (one space, no line break, NFC); Arabic has Arabic letters and no Sorani-only letter; Sorani has its letters once it has two words; the digits are the same; codes, upper-case terms (PLA, AMS, USB) and units after a number survive verbatim; names survive verbatim; no bidi control; no price, stock or shipping word. One failing row refuses its whole part at load time.
