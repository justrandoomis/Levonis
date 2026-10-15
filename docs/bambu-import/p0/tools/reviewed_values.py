"""Reviewed display labels for option values whose source text the payload validator refuses (spec §C.10 layer 2:
a customer-text string the classifier labels money / promotion / shipping_policy / warranty -> IMPORT_PAYLOAD_KEY_REFUSED).

hold_code cannot park such an item (migration 0195 allows only '', OWNER_HIDDEN, ORDER_TYPE_WORD), and an unparked refusal is a
BLOCKED PAYLOAD_REFUSED at the item's turn, which stops the run. So P0 freezes a neutral, evidence-based label per value in the
manifest row (`value_labels`, keyed by the source value id, like `sku_codes`). The step-4 builder applies it IN THE OPTION MODEL
(options.ts output: the value's nameEn / nameAr / nameCkb and variantLabel), after the ids, the variant_key and the SKU join are
computed from the source and BEFORE media binding, so every string derived from the value carries the label: name_en / name_ar /
name_ckb, variant_label, the value's source_refs.source_label, and the image alt texts, whose selection label is the value's
nameEn (value, value_set and representative rows) or the variant's value names joined by ' / ' (variant rows). All of these are
customer text in payload.ts (cust), and owner text would refuse a promotion too, so the source wording is never written; the
source value id stays in source_refs.source_id and variant_key = 'bv-' + H(source value id) is unchanged.
Proven with the real step-4 code (work/step4/check.ts): labels on names, variant label and source label only -> still refused at
$.images[].alt_en (3 image rows); labels also on the alt selection -> the whole ams-2-pro payload passes assertImportPayload.
Safe default until the owner answers P0-11.

The refused source text is deliberately NOT stored here or in any P0 output (hits are ids and class only).
"""

VALUE_LABELS = {
    'ams-2-pro': {
        # group 580876092018089985 "How many AMS 2 Pro unit(s) do you plan to connect to your printer", 6th value (2 variants:
        # with "A1 Series" and with "X1/P1 Series"). Both variants carry the note "We've put together the most common AMS 2 Pro
        # upgrades (accessories included). …", which the label paraphrases.
        '758126084595167233': {
            'group_source_id': '580876092018089985',
            'refused_class': 'promotion',
            'name_en': 'Upgrade bundle (accessories included)',
            'name_ar': 'باقة ترقية (تشمل الملحقات)',
            'name_ckb': 'پاکێجی بەرزکردنەوە (لەگەڵ پێداویستییەکان)',
            'evidence': {'evidence_kind': 'variant_note', 'variant_ids': ['758126084595167234', '758126084595167239'],
                         'quote': "We've put together the most common AMS 2 Pro upgrades (accessories included)."},
            'reason': 'source_label_refused_by_classifier',
            'apply_in': 'option model, after ids / variant_key / SKU join, before media binding',
            'applies_to': ['groups[].values[].name_en', 'groups[].values[].name_ar', 'groups[].values[].name_ckb', 'groups[].values[].variant_label',
                           'source_refs[kind=value].source_label', 'images[].alt_en', 'images[].alt_ar', 'images[].alt_ckb'],
        },
    },
}
