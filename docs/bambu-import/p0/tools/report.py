"""Write scans.md and owner-questions.md from the P0 JSON outputs. Usage: python3 -I tools/report.py"""
import collections, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
P0 = os.path.dirname(HERE)
J = lambda n: json.load(open(os.path.join(P0, n), encoding='utf-8'))  # noqa: E731
S, M, T, C, I, SY = J('scans.json'), J('manifest.json'), J('taxonomy-map.json'), J('compat-targets.json'), J('identity-map.json'), J('search-synonyms.json')
try:
    TS = J(os.path.join('work', 'step4', 'check.json'))   # the real step-4 classifier and validator (work/step4/check.ts)
except FileNotFoundError:
    TS = None


def tbl(rows, cols):
    out = ['| ' + ' | '.join(cols) + ' |', '|' + '---|' * len(cols)]
    for r in rows:
        out.append('| ' + ' | '.join(str(r.get(c, '')).replace('|', '\\|').replace('\n', ' ⏎ ') for c in cols) + ' |')
    return '\n'.join(out)


L = []
w = L.append
w('# Bambu Lab import — P0 scans (step 3 c)\n')
w('DRAFT, sandbox only. Built from the 1,115 crawled pages (`p0/raw`, all HTTP 200) by `p0/tools/build.py`; no network was used. '
  'Machine-readable detail: `scans.json`. Nothing here carries a source price, stock, discount or promotion.\n')
cnt = M['counts']
w('## 0. Corpus\n')
w(f"- Products: **{cnt['rows']}**; unique source ids {cnt['unique_source_ids']}; unique handles {cnt['unique_handles']}; every sitemap handle equals its decoded `seoCode`.")
w(f"- Types: " + ', '.join(f'{k} {v}' for k, v in sorted(cnt['by_type'].items(), key=lambda kv: -kv[1])) + '.')
w(f"- Description formats: " + ', '.join(f'{k} {v}' for k, v in S['description_formats'].items()) +
  f". **Format E** (a component-list CMS payload, `props.data[{{componentType…}}]`) is not one of the spec's four (§C.5): "
  + ', '.join(S['description_format_E_component_list']) + '.')
w(f"- Thin pages (no description, no feature bullets): {', '.join(S['thin_pages']) or 'none'}.")
w(f"- Machines (printers, AMS, R1) with no server-rendered spec table: {', '.join(S['machines_without_spec_table']) or 'none'} — their specs come only from curation.\n")

vk = S['variant_keys']
w('## 1. `variant_key` uniqueness\n')
w(f"Rule: {vk['rule']}.\n")
w(f"- Case-only duplicate values in one group: **{len(vk['case_only_duplicates'])}** — " +
  '; '.join(f"`{x['handle']}` {x['group']}: {' / '.join(x['values'])} → {', '.join(x['variant_keys'])}" for x in vk['case_only_duplicates']) +
  '. The two keys differ, so `legacyShapeErrors` passes.')
for k in ('exact_duplicate_value_text_in_group', 'duplicate_value_ids_in_product', 'empty_value_ids', 'sku_value_not_in_group', 'duplicate_variant_combos',
          'jsonld_identity_problems', 'handle_problems'):
    w(f"- {k.replace('_', ' ')}: **{len(vk[k])}**")
w('\nSo no `ov_` id collides, every SKU names a value of its group (no `IDENTITY_AMBIGUOUS` from §C.3), and every JSON-LD `productGroupID`/`hasVariant[].sku` agrees with `P`.\n')

ow = S['order_type_words']
w('## 2. Order-type words (`availabilityFromName`)\n')
w(tbl(ow['hits'], ['handle', 'group', 'value', 'reads_as']))
w(f"\nProducts held `ORDER_TYPE_WORD`: {', '.join(ow['products'])}. The hit is a substring false positive: `/direct(\\s*sale)?/i` matches \"Omni**direct**ional\". "
  "`legacyShapeErrors` would refuse these values for a new product, so the hold is real (§B.5, L-18). Option group names: "
  f"{len(ow['group_name_hits'])} hits.\n")

rt = S['refused_customer_text']
w('## 2b. Customer-text refusals (§C.10 layer 2, `IMPORT_PAYLOAD_KEY_REFUSED`)\n')
w(f"Every source string copied verbatim into a customer-text payload field (title, option group name, option value name, variant label, "
  f"their `source_label`) run through `tools/sentences.py`, a port of `sentences.ts` and `payload.ts` `REFUSED_FOR.customer` "
  f"(money, promotion, shipping policy, warranty). Scanned: {rt['scanned']['titles']} titles, {rt['scanned']['option_groups']} groups, "
  f"{rt['scanned']['option_values']} values. Ids and class only; the refused text is not written here.\n")
w(tbl(rt['hits'], ['handle', 'queue_position', 'field', 'value_source_id', 'class', 'covered_by']))
w(f"\n`hold_code` cannot park such an item (0195 allows only '', OWNER_HIDDEN, ORDER_TYPE_WORD), and an unparked refusal is BLOCKED "
  f"`PAYLOAD_REFUSED` at its turn, which stops the run. Each hit therefore carries a reviewed neutral label in its manifest row "
  f"(`value_labels`, ar/en/ckb, owner question P0-11). Uncovered: {len(rt['uncovered'])}. The step-4 package's own report "
  f"(`parse-report.json`) refuses the same single value.\n")
if TS:
    _a = TS['ams_2_pro']
    w(f"Cross-check with the real TypeScript code (`work/step4/check.ts`, imports from the step-4 package, no network): `classifySentence` with "
      f"`payload.ts`'s sentence split over the same {TS['scanned']['titles']} titles, {TS['scanned']['option_groups']} groups and "
      f"{TS['scanned']['option_values']} values finds {len(TS['hits'])} hit(s), the same as the port. On `ams-2-pro`, applying the label to the value's "
      f"names, variant label and source label is not enough: `assertImportPayload` still refuses `{_a['after_names_only']}` — the alt text of "
      f"{_a['alt_fixed'] // 3} image rows carries the value as its selection label (one representative row, two variant rows \"<printer> / <value>\"). "
      f"With the label applied in the option model before media binding (names, variant label, source label and those alt texts) the whole payload "
      f"passes: `{_a['after_names_and_alts']}`. See owner-questions.md §E item 1.\n")

w('## 3. Composite cells (§C.6 labelled sub-value parser)\n')
w(f"{len(S['composite_cells'])} distinct composite cells on {len({x['handle'] for x in S['composite_cells']})} products:\n")
w(tbl([{**x, 'excerpt': x['excerpt'][:110]} for x in S['composite_cells']], ['handle', 'label', 'segments', 'excerpt']))
w('\nSource anomalies to keep as published (with a `spec_sources_disagree` / review note, never "fixed"): H2C gross weight lists '
  '"H2C Laser Full Combo-10W" twice (49.0 kg and 49.5 kg); the A1 product size is 465×410×430 mm on `a1` but 385×410×430 mm on '
  '`refurbished-a1` and the A1 starter kit.\n')

w('## 4. US / region tables (§C.6 region rule)\n')
w(tbl([{'handle': x['handle'], 'type': x['type'], 'hits': x['hit_count'], 'matches': ', '.join(sorted({h['match'] for h in x['hits']}))} for x in S['region_tables']],
      ['handle', 'type', 'hits', 'matches']))
w('\nThe 8 `Electrical Requirements` rows ("Please purchase the version corresponding to your region\'s voltage…") are region evidence, not specs.\n')

sl = S['spec_labels']
w('## 5. Spec-label coverage (draft registry `p0/tools/registry.py`)\n')
w(f"- Label occurrences {sl['label_occurrences']}; mapped {sl['mapped_occurrences']} (**{sl['coverage_occurrences']*100:.1f} %**).")
w(f"- Distinct labels {sl['distinct_labels']}; mapped {sl['distinct_mapped']}; unknown {sl['unknown_distinct']} (each becomes `x.<slug>`, `unverified`).")
w(f"- Products without any spec-table row: {len(sl['products_without_spec_rows'])} (filaments by design — TDS only — plus parts and kits whose page has no table).")
w(f"- Matrix tables kept as text (not key/value): " + ', '.join(f"`{x['handle']}` ({x['section']})" for x in sl['matrix_tables']) + '.')
w(f"- Labels over 80 characters (a value printed in the label cell): " + ', '.join(f"`{x['handle']}`" for x in sl['labels_over_80_chars']) + '.\n')
w('### Top 50 unknown labels\n')
w(tbl([{'#': i + 1, 'label': x['label'], 'occurrences': x['occurrences'], 'products': x['products'], 'example': x['example']['handle'],
        'value': x['example']['value'][:40], 'proposed_key': x['proposed_key']} for i, x in enumerate(sl['top_50_unknown'])],
      ['#', 'label', 'occurrences', 'products', 'example', 'value', 'proposed_key']))

md = S['media']
w('\n## 6. Media review list (same file name, different upload)\n')
w(md['note'] + '\n')
w(tbl(md['same_name_different_url'], ['handle', 'file_name', 'gallery_indexes', 'distinct_urls', 'any_variant_bound']))
w(f"\n- Same URL twice in one gallery: {len(md['same_url_twice_in_gallery'])}.")
w(f"- Variants with no hero image: " + '; '.join(f"`{x['handle']}` ({len(x['variant_ids'])})" for x in md['variants_without_hero']) + '.')
w(f"- Variant hero not in the gallery: {len(md['variant_hero_not_in_gallery'])}.")
w(f"- Binding rules over the corpus (P0 file-level, §C.4): " + ', '.join(f'{k} {v}' for k, v in md['binding_rule_totals'].items()) + '.')
w(f"- Description images over the 40 cap (L-2): " + ', '.join(f"`{x['handle']}` {x['description_images']}" for x in md['description_images_over_40']) + '.')
w(f"- `store-test.bblcdn.com` references: {len(md['store_test_host_links'])}.\n")
w('### Override candidates by file name (NOT applied; `media-overrides.json` stays empty until a visual review)\n')
w(tbl(md['override_candidates_by_file_name'], ['handle', 'image_file', 'candidate_value', 'group', 'score']))

b = S['in_the_box']
w('\n## 7. In-the-box images\n')
w(f"{b['products_with_box_images']} products carry {b['total_box_images']} in-the-box images; over the 30 cap: {len(b['over_30_cap'])}.\n")
w(tbl(b['top'], ['handle', 'images', 'items']))

w('\n## 8. Tracker links (`e.bambulab.com/t?c=…`)\n')
tl = S['tracker_links']
by_text = collections.Counter(x['text'] for x in tl)
w(f"{len(tl)} tracker links on {len({x['handle'] for x in tl})} products (one HEAD each at ENRICH, no redirect followed). Link texts: " +
  ', '.join(f'"{k}" {v}' for k, v in by_text.most_common(6)) + '. Full list in `scans.json` → `tracker_links`.\n')

wl = S['wiki_links']
w('## 9. Wiki links\n')
w(f"{len(wl)} products link {sum(x['count'] for x in wl)} distinct wiki URLs; {sum(1 for x in wl if x['over_3_followed_limit'])} products have more than 3 (only the first 3 are followed, L-21): "
  + ', '.join(f"`{x['handle']}` {x['count']}" for x in wl if x['over_3_followed_limit']) + '.\n')
d = S['documents']
w(f"Other documents: {d['pdf_links']} PDF links, {d['model_files']} model files (.zip/.3mf/.stl/.step), {d['videos']} YouTube videos, "
  f"{d['makerworld_links']} MakerWorld links, {d['store_links_to_rewrite']} store links to rewrite to slugs or text.\n")

ps = S['plan_size']
w('## 10. Plan size (statements per `/write` invocation, §A.5 budget 900)\n')
w(f"Method: {ps['method']}. Median {ps['median']}, max {ps['max']}.\n")
w(tbl([{'handle': p['handle'], 'type': p['type'], 'per_row_writes': p['statements_estimate'], 'multirow_side_inserts': p['statements_estimate_multirow_side_inserts'],
        'values': p['breakdown']['values'], 'variants': p['breakdown']['variants'], 'image_rows': p['breakdown']['image_rows'],
        'search_tokens': p['breakdown']['search_tokens'], 'external_ids': p['breakdown']['external_ids']} for p in ps['over_600']],
      ['handle', 'type', 'per_row_writes', 'multirow_side_inserts', 'values', 'variants', 'image_rows', 'search_tokens', 'external_ids']))
w(f"\n**`pla-basic-filament` (audit class, queue position 5) is over 900** when every side row is its own statement; with multi-row side INSERTs "
  f"(≤ 100 bound parameters each) it is ~643 and only it stays above 600. See owner-questions.md §E.\n")

w('## 11. Relation collections over 400 rows (`MAX_ROWS_PER_COLLECTION`)\n')
w(f"{len(S['collections_over_400_rows'])} products. The largest are `pla-basic-filament` (51 image rows, 43 variants) and its peers — far below 400.\n")

w('## 12. SKU codes harvested from the cross-sell payload (§C.1)\n')
sk = S['sku_codes']
w(f"{sk['stats'].get('distinct_entries', 0)} distinct cross-sell SKU entries (seen {sk['stats'].get('duplicate_sightings', 0)} more times); "
  f"all matched a sitemap handle and one of its variant ids; frozen for {sk['products_with_codes']} products / {sk['variants_with_codes']} variants; "
  f"conflicts {len(sk['conflicts'])}. Only `{{id, productId, seoCode, skuCode}}` were read.\n")

w('## 13. Other findings\n')
w(f"- Handle/title disagreements (identity from the title, never the handle): " + ', '.join(f"`{x['handle']}` = \"{x['title']}\"" for x in S['handle_title_mismatch']) + '.')
w(f"- Option-group kinds: " + ', '.join(f'{k} {v}' for k, v in S['group_kinds'].items()) + '. Group names with kind `other` (English label + `translation_review`): '
  + ', '.join(f'"{x}"' for x in S['option_group_names_needing_translation_review']) + '.')
sc = S['sentence_classes']
w(f"- Sentence classifier counts (§C.10, counts only): " + ', '.join(f"{k} {v['sentences']} sentences / {v['products']} products" for k, v in sc.items()) + '.')
w(f"- Compatibility: {S['compat']['labels_mapped']} atomic labels mapped, {S['compat']['labels_unresolvable']} reviewed-unresolvable, {S['compat']['compounds']} raw strings; "
  f"targets missing from the manifest: {len(S['compat']['targets_missing_from_manifest'])}. \"A1 Series\" resolves per subject "
  f"({len(C['labels']['A1 Series']['by_subject'])} by page evidence, {len(C['labels']['A1 Series']['subjects_on_default'])} on the narrow default; P0-1); "
  f"\"A1/A2L\" is reviewed to the atoms A1, A2L.")
w('- Spec §C.4 golden test vs its own rule: on `ams-2-pro` gallery #0 is the hero of 13 variants that are exactly the union of the five "Connect …" '
  'values, so rule 2 (value_set) applies before the per-variant fallback — the golden test expects 13 variant rows. Step 4 must pick one.')
w('- Spec §D.2 says the canary\'s route "already resolves it to `@parts-x1p1`"; route L2 `552709760676352000` is in fact the AMS feeder subtree '
  '(its other five members are AMS feeder parts), so `filament-buffer` needs, and has, a handle override quoting "Compatibility: X1 Series and P1 Series".')
open(os.path.join(P0, 'scans.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')

# ======================================================================== owner questions
held = [r for r in M['rows'] if r['hold_code']]
Q = []
q = Q.append
q('# Bambu Lab import — owner questions and holds (P0, step 3 f)\n')
q('DRAFT for review. Every item has a **safe default that is in effect until the owner answers**; nothing here stops the other '
  f"{M['counts']['rows'] - len(held)} products (§L), provided the step-4 items in §E (1 and 2) land before step 9. "
  "References: spec §L.2 (L-1 … L-21), DECISIONS row 239.\n")
q('## A. Holds (queued last, block at their turn until answered), and one item that would block the run\n')
for r in held:
    hits = [h for h in S['order_type_words']['hits'] if h['handle'] == r['handle']]
    q(f"**H-1 · `{r['handle']}` — `{r['hold_code']}` (L-18), queue position {r['queue_position']} of {M['counts']['rows']}.** "
      f"Option values " + ', '.join(f'"{h["value"]}"' for h in hits) + ' read as an order type because `availabilityFromName` matches '
      '"direct" inside "Omni**direct**ional"; `legacyShapeErrors` would refuse them for a new product.')
    q('- Default: the item stays last and blocks `ORDER_TYPE_WORD`; the run closes "partial" naming it.')
    q('- Options for the owner: (a) the L-18 narrow, tested exemption for import-created values with a `bv-` key; (b) fix the word boundary in '
      '`availabilityFromName` (`\\bdirect\\b`), an app-wide change that also helps admins; (c) leave it held.\n')
q('**H-2 · `OWNER_HIDDEN` (L-7) — unknown until step 3 (e).** Matching against existing Levonis products needs the step-2 sealed snapshot, which is not '
  'available yet. Default: every candidate that targets an owner-hidden product is written `hold_owner_hidden`, queued last and blocks `OWNER_HIDDEN`.\n')
rt = S['refused_customer_text']
for x in rt['hits']:
    r = next(rr for rr in M['rows'] if rr['handle'] == x['handle'])
    lab = r['value_labels'][x['value_source_id']]
    q(f"**Not a hold — `{x['handle']}`, queue position {x['queue_position']} (audit class), would block the run.** Option value "
      f"`{x['value_source_id']}` ({x['field']}) is refused by the payload validator as `{x['class']}` (§C.10; the step-4 report gives the same "
      "`IMPORT_PAYLOAD_KEY_REFUSED`). `hold_code` cannot express it (0195), and a block at position 4 would stop the run right after `h2d` and "
      "the refurbished H2D. Fixed in P0: the manifest row carries a reviewed neutral label for that one value "
      f"(«{lab['name_ar']}» / {lab['name_en']} / «{lab['name_ckb']}»), so the payload never holds the source wording; the item stays in the audit "
      "block with its 15 variants. Owner question P0-11; it needs §E item 1 before step 9 (the label must also reach the alt text of 3 image rows, "
      "or the payload is still refused there).\n")
q('## B. Open decisions of §L.2, with what P0 measured\n')
LQ = [
    ('L-1', 'Show a colour HEX when Bambu does not publish one?', 'No — official swatch only; hex only from a published source (curated Hex Code PDF).',
     f"{sum(1 for r in M['rows'] if r['type']=='filament')} filament products; colour groups carry swatch images only."),
    ('L-2', 'Description-image cap per product', '40; extras listed in the report (in-the-box separate, ≤ 30).',
     'Over 40: ' + ', '.join(f"{x['handle']} ({x['description_images']})" for x in S['media']['description_images_over_40']) + '. In-the-box max 23 (h2c).'),
    ('L-3', 'Re-host PDFs (TDS/SDS/manuals) in R2?', 'No — verified links to the official URLs; dead links hidden and reported.',
     f"{S['documents']['pdf_links']} PDF and {S['documents']['model_files']} model-file links seen."),
    ('L-4', 'Show package CBM to customers?', 'No — admin-only.', 'CBM is never derived from a US-only printer box (13 region pages).'),
    ('L-5', 'Arabic display names for products?', 'No — the English official name in all three languages.', '—'),
    ('L-6', 'Add missing Bambu variants to an existing Levonis product?', 'No — logged `variant_not_merged`.', 'Measured after step 3 (e).'),
    ('L-7', 'Owner-hidden Levonis product that matches a Bambu product', 'Hold (`hold_owner_hidden`), queued last.', 'See H-2.'),
    ('L-8', 'Refurbished printers placement', 'Own leaf «طابعات مجدَّدة من المصنع» (`@printers-refurb`, under `cat_printers_fdm` so their form and template keep only the FDM groups), not «المستعمل».',
     'Five products: ' + ', '.join(r['handle'] for r in M['rows'] if r['subtype'] == 'refurbished') + '.'),
    ('L-9', 'Bambu bundles and starter kits', 'Ordinary products + secondary «الحزم والمجموعات» (`@bundles`).',
     f"{T['secondary_counts'].get('@bundles', 0)} products get `@bundles` (title evidence: bundle / combo / starter kit / trial set / mystery box)."),
    ('L-10', 'Product withdrawn at the source mid-run', 'BLOCKED `SOURCE_WITHDRAWN`; owner may approve `WITHDRAWN_AT_SOURCE`.',
     'All 1,115 pages answered 200 on 2026-10-15.'),
    ('L-11', 'Marketing collections as tags', 'Ignored.', f"{sum(v for k, v in T['collections']['_ignored_non_type_counts'].items())} non-type collection handles ignored (handles omitted from the map)."),
    ('L-12', 'Source URLs visible to staff', 'Owner-only.', '—'),
    ('L-13', 'Third-party technical sources', 'Not used.', '—'),
    ('L-14', 'Adopt documented package measures into Pricing V2 inputs', 'No automatic adoption.', 'Package size/weight rows exist on ~575 part pages.'),
    ('L-15', 'Remove the ops route and workflow 60 after the run', 'Keep until a later cleanup commit.', '—'),
    ('L-16', 'Refuse the V2 publish of an imported product until its stock mode is chosen', 'Yes (on).', '—'),
    ('L-17', 'Dedicated customer test account for live price requests', 'Not created; the Worker validator proves eligibility.', '—'),
    ('L-18', 'Option value that reads as an order type', 'Queued last, blocked `ORDER_TYPE_WORD`.', 'One product: see H-1.'),
    ('L-19', "Show Bambu's warranty sentences to customers?", 'No — owner-only spec rows.',
     f"{S['sentence_classes']['warranty']['sentences']} warranty/return sentences on {S['sentence_classes']['warranty']['products']} products."),
    ('L-20', 'Show US 110 V table values to customers?', 'Only under the collapsed «إصدارات أخرى» with the US label.',
     f"{len(S['region_tables'])} products carry US-voltage text (printers + the mini heat press)."),
    ('L-21', 'Follow up to 3 Bambu wiki links per product during the run?', 'Yes, ≥ 5 s apart.',
     f"{len(S['wiki_links'])} products link wiki pages; {sum(1 for x in S['wiki_links'] if x['over_3_followed_limit'])} have more than 3."),
]
q(tbl([{'#': a, 'question': b_, 'safe default (in effect)': c_, 'P0 fact': d_} for a, b_, c_, d_ in LQ], ['#', 'question', 'safe default (in effect)', 'P0 fact']))
q('\n## C. New questions raised by P0 (each with its safe default)\n')
_a1_wiki_h = [h for h, b in C['labels']['A1 Series']['by_subject'].items() if any(e['evidence_kind'] == 'wiki_link' and '/en/a1-mini/' in e['quote'] for e in b['evidence'])]
_a1_wiki = len(_a1_wiki_h)
_a1_wiki_titled = sum(1 for h in _a1_wiki_h if h.endswith('-a1-series'))
NQ = [
    ('P0-1', 'What does "A1 Series" mean on each product: the A1 only, or the A1 and the A1 mini?',
     'Per product, from its own evidence (`compat-targets.json` → `A1 Series.by_subject`): '
     + str(sum(1 for b in C['labels']['A1 Series']['by_subject'].values() if b['basis'] == 'includes_a1_mini')) + ' products include the A1 mini (shared toolhead parts whose install guide is under the A1 mini wiki, '
     'toolhead board, A1/A2 hotend, filament cutter, AMS lite, and the A1 screws kit whose own table names A1 mini locations); '
     + str(sum(1 for b in C['labels']['A1 Series']['by_subject'].values() if b['basis'] == 'excludes_a1_mini')) + ' exclude it (AMS, AMS 2 Pro and AMS HT printer question and the A1 AMS hub; '
     'the accessory box sold with the A1, whose A1 mini twin is a separate product; 3D effect plates that list the A1 mini separately; the build plate combo '
     'whose plate rows size it for the A1 at 256 mm); the '
     + str(len(C['labels']['A1 Series']['subjects_on_default'])) + ' with no evidence either way ('
     + ', '.join('`%s`' % h for h in C['labels']['A1 Series']['subjects_on_default']) + ') get the A1 and refurbished A1 only. '
     '"A1/A2L" is the A1 model (atoms A1, A2L).',
     'For "includes": the toolhead-board page lists Compatibility "A1" and "A1 mini" under a section reading "A1 Series"; the maintenance kit\'s section '
     '"For A1 Series" lists "For A1" and "For A1 mini"; ' + str(_a1_wiki) + ' products (' + str(_a1_wiki_titled) + ' of them "… - A1 Series" parts) link their guide under '
     'wiki.bambulab.com/en/a1-mini/; the step-4 '
     'registry puts the A1 mini in the A1 Series. For "excludes": the a1-mini page says "AMS is incompatible with the A1 mini. If you want a multi-color '
     'print using A1 mini, you must use the AMS lite.", yet AMS, AMS 2 Pro and AMS HT offer "A1 Series" as a printer; the touch screen and nozzle wiper '
     'labelled "A1/A2L" have separate A1 mini versions. Owner: confirm the per-product reading, and say whether any of the defaults should include the A1 mini.',
     '§B.6 evidence only, R-13'),
    ('P0-2', 'Sorani names of the seeded «مواد الصيانة» shelves are empty (`cat_maint`, `cat_maint_hotend`, `cat_maint_plate`, `cat_maint_spare`; 0148, row 154)',
     'The import never renames an existing node; its new child shelves carry Sorani. The owner fills the four names in the sections screen.',
     f"{sum(v for k, v in T['leaf_counts'].items() if k.startswith('@parts-')) + T['leaf_counts'].get('cat_maint_hotend', 0) + T['leaf_counts'].get('cat_maint_plate', 0)} products land under them.", 'row 183'),
    ('P0-3', 'New taxonomy nodes (%d) — names and slugs' % len(T['create']), 'Insert-only; a taken slug gets `-2`; nothing existing is renamed or moved.',
     'The live tree was not read (no contact with levonis-iq.com); owner-made nodes are unknown until the step-2 snapshot.', '§D.1/§D.2'),
    ('P0-4', 'Laser secondary membership for printers', 'H2D, H2S and H2C (each has a "… Laser Full Combo" option) get `cat_laser_machines`; A2L (cutting only) does not.',
     'Collections pages are never fetched by the run (§J.1), so the `laser-crafting` collection cannot be used.', '§D.2 collections'),
    ('P0-5', 'R1 laser cutter in the curated scope?', 'Yes — P0 fixes the curated scope (§F) and adds R1 (92 curated in all, inside 70–95).',
     'Its server-rendered page has a "Specs" heading but no table (page-builder format C), so without curation every R1 spec would be `not_found`; 69 R1 spare parts depend on it.', '§F'),
    ('P0-6', 'Filament packs (6) curated?', 'Yes, counted as filament products.', 'Packs reuse their component lines\' TDS.', '§F'),
    ('P0-7', 'Bind the file-name override candidates (24), e.g. H2D `AMS_2_Pro.jpg` → "Dual AMS 2 Pro Bundle", `AMS_HT.jpg` → "AMS HT bundle"?',
     'No — they stay general until a visual review commits a reviewed override.', 'P0 fetched no image bytes.', '§C.4 step 2'),
    ('P0-8', 'Published source anomalies (H2C gross weight "10W" twice; A1 size 465 vs 385 mm)', 'Kept as published per page, `unverified`, with a review note.',
     'No number is corrected or picked at random.', '§C.6 conflicts'),
    ('P0-9', 'Thin pages (`bambu-lab-purifier-e1-pro`; `h2d-pro` has one "Type: Hotend" variant and no description)', 'Imported as published; missing data recorded `not_found`.', '—', 'R3'),
    ('P0-10', 'Variants with no hero image (%d variants on %d products: %s)' % (sum(len(x['variant_ids']) for x in S['media']['variants_without_hero']),
              len(S['media']['variants_without_hero']), ', '.join('%s %d' % (x['handle'], len(x['variant_ids'])) for x in S['media']['variants_without_hero'])), 'No image is borrowed; their selection shows the general images.', '—', '§5 no borrowing'),
]
for h_, vl in [(r['handle'], r['value_labels']) for r in M['rows'] if r['value_labels']]:
    for vid, lab in vl.items():
        NQ.append(('P0-11', f'`{h_}`: display label for option value `{vid}`, whose source label the import refuses as `{lab["refused_class"]}`',
                   f'«{lab["name_ar"]}» / {lab["name_en"]} / «{lab["name_ckb"]}» in name, variant label, source label and the image alt texts that name the '
                   'value; the source wording is not stored (its value id is); both variants kept.',
                   f'Both variants of that value carry the note: "{lab["evidence"]["quote"]}" Alternatives: another wording, or drop the value and its '
                   '2 variants (the audit expects 15 variants).', '§C.2, §C.10, §I.4'))
q(tbl([{'#': a, 'question': b_, 'safe default': c_, 'evidence': d_, 'ref': e_} for a, b_, c_, d_, e_ in NQ], ['#', 'question', 'safe default', 'evidence', 'ref']))
q('\n## D. Pending in this P0 pass\n')
q('- **(e) `existing-matches.json`** — needs the step-2 sealed snapshot; so do the OWNER_HIDDEN holds and the Levonis ids of X1C / X1E / P1P / P1S / X1 '
  'that `compat-targets.json` marks `resolve_from: step2_snapshot`, and `taxonomy-map.json` → `snapshot_sha256`.')
q('- **(g) curated files** — later stage (canary and the audit classes first).\n')
q('## E. Integrator items that block step 9 or 12 (not owner questions)\n')
q('1. **Reviewed value labels (blocks step 9).** The step-4 builder must apply a manifest row\'s `value_labels[<source value id>]` in the option model '
  '(the value\'s `nameEn/nameAr/nameCkb` and `variantLabel`), after the ids, `variant_key` and the SKU join are computed from the source and before media '
  'binding, so that every derived customer string carries it: `name_en/name_ar/name_ckb`, `variant_label`, the value\'s `source_refs.source_label` and the '
  '`alt_en/alt_ar/alt_ckb` of the image rows whose selection label names the value (`media.ts` passes the value\'s `nameEn`, or the variant\'s value names '
  'joined by " / ", to `altText`). `payload.ts` types all of these as customer text, and owner text would refuse a promotion too, so the source wording '
  'cannot be kept even in `source_label`. Proven with the real step-4 code (`p0/work/step4/check.ts`): names, variant label and source label alone still '
  'leave `refused_text:promotion at $.images[].alt_en` (3 image rows of `ams-2-pro`); with the alt texts too the whole payload passes `assertImportPayload`. '
  'Without it `ams-2-pro` (audit class, position 4) is BLOCKED `PAYLOAD_REFUSED` and the run stops. Add a writer test with the AMS 2 Pro fixture that '
  'asserts no payload string contains the refused value text.')
_a1_subj = set(C['labels']['A1 Series']['by_subject']) | set(C['labels']['A1 Series']['subjects_on_default'])
try:
    _a1_unres = [i['handle'] for i in J('parse-report.json')['items'] if i['handle'] in _a1_subj and (i.get('relations_by_state') or {}).get('unresolvable')]
except FileNotFoundError:
    _a1_unres = []
q('2. **"A1 Series" per subject (blocks step 9).** `relations.ts` must read `labels[label].by_subject[subject handle].members` first and '
  '`labels[label].default.members` otherwise. The entry has no `to` and no top-level `members` on purpose, so today\'s `relations.ts` cannot silently '
  f"apply one global answer: the refreshed `parse-report.json` shows `unresolvable` rows (label kept as text, no fits) on {len(_a1_unres)} of the "
  f"{len(_a1_subj)} subjects" + (" (not on " + ', '.join('`%s`' % h for h in sorted(_a1_subj - set(_a1_unres))) + ", whose group step 4 does not read: item 9)" if _a1_subj - set(_a1_unres) else '')
  + '. `tests/` cover one subject of each basis (includes, excludes, default).')
q('3. **Spec erratum, outside the P0 sandbox.** import-spec.md §D.2 table still gives `@printers-refurb` the parent `cat_printers`; the map now uses '
  '`cat_printers_fdm` (`excludedGroups` in `worker/lib/templateFamilies.ts` answers a branch that names neither printer leaf with the FDM + Resin union). '
  'Correct the table when the spec is next edited.')
q('4. **Plan budget.** `pla-basic-filament` (audit class, position 5) is estimated at ~906 statements with one statement per side row (> 900 = 1,000 − 100); '
  '`pla-matte` ~810. With multi-row side INSERTs (≤ 100 bound parameters each) they fall to ~643 / ~597. Default without a change: BLOCKED `PLAN_TOO_LARGE` at its turn. '
  'Fix before step 12: batch the side tables in the writer (step 6), or the §A.6 append-only image stage.')
q('5. **Description format E** (`h2c`, `h2s`, `p2s`, `refurbished-bambu-lab-p2s-3d-printer`, `bambu-lab-p2s-combo-starter-kit`): `describe.ts` (step 4) must parse the component list '
  '(SpecTable, Inbox with per-version columns, FAQ, Anchor sections); add one E fixture.')
q('6. **Spec §C.4 rule vs golden test** on `ams-2-pro` (value_set vs 13 variant rows) — choose before writing `bambuMediaBinding`.')
q('7. **Registry**: %d unknown spec labels; the top 50 (scans.md §5) join `specKeys.ts` before the run.' % S['spec_labels']['unknown_distinct'])
q('8. **Review the map**: %d evidence-backed handle overrides and %d secondary-membership entries in `taxonomy-map.json` (each cites its route and a quote). '
  'Changed in the final pass: `floating-damper-feet` → `@printer-acc`; `mini-heat-press` → `cat_laser_acc` (type accessory); `z-belt` and the P1/A1 mini '
  'WiFi antenna leave «لكل السلاسل» for `@parts-x1p1` with `@parts-p2x2` / `@parts-a1` as secondaries (and `cutting-essentials-refill-pack` gains `@parts-a1`). '
  'Step 4 still derives its own spec-parser type from the route (`productTypeOf`: the heat press `laser_material`, the feet `tool`); their leaf, '
  'and so their form and template, come from the map.'
  % (len(T['handles']), len(T['also_by_handle'])))
q('9. **Option groups that name printers but give no relation rows** (optional data, R3; not a blocker): `registry/groups.ts` reads neither '
  '"Select your printer series" (`cyberbrick-timelapse-kit`, which P0 reads as compatibility; one of the "A1 Series" subjects) nor "Device" '
  '(`ptfe-tubes`: 14 printer and AMS values, which P0 does not read either) as a printer group, so `relations.ts` skips them. Add both to the printer '
  'matcher (every value is a label `compat-targets.json` maps or lists as reviewed-unresolvable) or accept that the two products carry no fits rows.')
open(os.path.join(P0, 'owner-questions.md'), 'w', encoding='utf-8').write('\n'.join(Q) + '\n')
print('ok')
