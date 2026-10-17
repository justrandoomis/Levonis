import json, sys
OUT = sys.argv[1]
NOW = sys.argv[2]
PDF = "https://store.bblcdn.com/s7/kpwam/2d002a0570c24569802b564d05f425b2/R1_Spec.pdf"
PDF_T = "Bambu Lab R1 Spec sheet"
PDF_AT = "2026-10-16T08:22:44Z"
WIKI = "https://wiki.bambulab.com/en/r1/manual/acc-in-the-box"
WIKI_T = "Packing List for the Bambu Lab R1"
WIKI_AT = "2026-10-16T08:25:35Z"
PAGE = "https://us.store.bambulab.com/products/r1"
PAGE_T = "Bambu Lab R1 store page"
PAGE_AT = "2026-10-16T06:57:52Z"

OV = {
  "R1": {"kind": "option_value", "source_value_id": "777338703516315650", "id": "ov_c26503c993326693afa538d6", "value_text": "R1", "group": "Version"},
  "LMB": {"kind": "option_value", "source_value_id": "777368103003684865", "id": "ov_3a4a61cc0dbefcd77c13e3bb", "value_text": "R1 Long Material Bundle", "group": "Version"},
  "LMRB": {"kind": "option_value", "source_value_id": "777368103003684866", "id": "ov_a8c105f28cd30da9466a576a", "value_text": "R1 Long Material & Rotary Bundle", "group": "Version"},
}
PROD = {"kind": "product"}

def pdf_spec(key, value, unit, locator, quote, scope=PROD, status="verified", tc="", page_row="", **extra):
    s = {"key": key, "scope": scope, "value": value, "unit": unit, "status": status, "confidence": "official_doc",
         "source_kind": "store_doc", "source_url": PDF, "source_title": PDF_T, "locator": locator, "quote": quote,
         "test_method": "", "test_condition": tc, "region": "", "retrieved_at": PDF_AT}
    if page_row:
        s["store_page_check"] = f"Agrees with the store page 'R1 Specs' table, {page_row} (not in the parsed payload: the extractor does not read the Specs richText)."
    s.update(extra)
    return s

specs = []
specs.append(pdf_spec("printing.technology", "55W CO2 laser", "", "p.1 › Processing › Laser type", "Laser type 55W CO2 laser",
                      page_row="row 'Laser type'", note="The sheet's row is 'Laser type'; the registry has no laser key, so the machine's technology row carries it."))
specs.append(pdf_spec("printing.working_area", "600 × 300 mm (standalone); 600 × 3000 mm with the Conveyor", "", "p.1 › Processing › Working area",
                      "Working area Standalone: 600×300mm With Conveyor: 600×3000mm",
                      tc="Standalone: 600 × 300 mm. With the Conveyor (Automatic Conveyor Feeder): 600 × 3000 mm.", page_row="row 'Working area'"))
specs.append(pdf_spec("motion.max_speed", 1000, "mm/s", "p.1 › Processing › Max speed", "Max speed 1000mm/s", page_row="row 'Max speed'"))
specs.append(pdf_spec("motion.max_acceleration", 20000, "mm/s²", "p.1 › Processing › Max acceleration", "Max acceleration 20000mm/s²", page_row="row 'Max acceleration'"))
for key, v in (("product.length", 940), ("product.width", 560), ("product.height", 200)):
    specs.append(pdf_spec(key, v, "mm", "p.2 › Physical & Power › Dimensions", "Dimensions 940×560×200mm",
                          tc="Machine dimensions as published (940 × 560 × 200 mm; order as written, lid closed).", page_row="row 'Dimensions'"))
specs.append(pdf_spec("physical.recommended_space", "1140 × 860 × 750 mm", "mm", "p.2 › Physical & Power › Space required",
                      "Standalone: W940 × D660 × H650mm (lid open). Allowing 100mm of clearance on the left, right, rear, and top: 1140 × 860 × 750mm.",
                      tc="Standalone, lid open (W940 × D660 × H650 mm) plus 100 mm clearance left, right, rear and top. With Riser Base: 1140 × 860 × 950 mm (W940 × D660 × H850 mm lid open). With Riser Base and Conveyor: the Riser Base footprint plus, in front, stock length − 400 mm and, behind, stock length − 550 mm.",
                      page_row="row 'Space required'"))
for key, v in (("package.length", 1095), ("package.width", 725), ("package.height", 310)):
    specs.append(pdf_spec(key, v, "mm", "p.2 › Physical & Power › Package dimensions", "Package dimensions 1095×725×310mm", scope=OV["R1"],
                          tc="The R1 machine's package. The bundles add the Riser Base, Conveyor and Rotary items (store 'What's in the box'); their packaging is not published.",
                          page_row="row 'Package dimensions'"))
specs.append(pdf_spec("product.net_weight", 33500, "g", "p.2 › Physical & Power › Weight", "Weight 33.5kg", status="unverified",
                      tc="Published as 'Weight' only; the sheet does not say whether it is the net (machine) or the gross (packed) weight.",
                      page_row="row 'Weight'",
                      note="Unverified: the label is ambiguous (net or gross), and the registry's product.net_weight does not list laser_machine in appliesTo."))
specs.append(pdf_spec("electrical.max_power", 780, "W", "p.2 › Physical & Power › Max input power", "Max input power 780W",
                      tc="Universal input 100–240 VAC, 50/60 Hz (one value for every region).", page_row="row 'Max input power'"))
specs.append(pdf_spec("electrical.voltage", "100–240 VAC", "", "p.2 › Physical & Power › Input voltage", "Input voltage 100–240 VAC, 50/60Hz",
                      tc="Universal input; no separate US 110 V or international 220 V version is published.", page_row="row 'Input voltage'"))
specs.append(pdf_spec("electrical.frequency", "50/60 Hz", "", "p.2 › Physical & Power › Input voltage", "Input voltage 100–240 VAC, 50/60Hz", page_row="row 'Input voltage'"))
specs.append(pdf_spec("physical.operating_temp", "10 °C – 30 °C", "", "p.2 › Physical & Power › Recommended operating temp", "Recommended operating temp 10°C – 30°C",
                      tc="Recommended operating temperature.", page_row="row 'Recommended operating temp'"))
specs.append(pdf_spec("connectivity.software", "Bambu Suite", "", "p.2 › Software › Software", "Software Bambu Suite", page_row="row 'Software'"))
specs.append(pdf_spec("connectivity.operating_systems", ["Windows", "macOS"], "", "p.2 › Software › OS", "OS Windows, macOS", page_row="row 'OS'"))
specs.append(pdf_spec("connectivity.wifi",
                      "Dual-band Wi-Fi, IEEE 802.11 a/b/g/n/ac/ax; 2412–2472 MHz, 5150–5850 MHz (FCC/CE); 2400–2483.5 MHz, 5150–5850 MHz (SRRC); TX power (EIRP): 2.4 GHz <23 dBm (FCC), <20 dBm (CE/SRRC/MIC); 5 GHz Band 1/2 <23 dBm; Band 3 <30 dBm (CE) / <24 dBm (FCC); Band 4 <23 dBm (FCC/SRRC) / <14 dBm (CE)",
                      "", "p.2 › Connectivity › Wireless; Wi-Fi frequency; Wi-Fi TX power (EIRP); Wi-Fi protocol",
                      "Wireless Dual-band Wi-Fi … Wi-Fi frequency 2412–2472MHz, 5150–5850MHz (FCC/CE) · 2400–2483.5MHz, 5150–5850MHz (SRRC) … Wi-Fi protocol IEEE 802.11 a/b/g/n/ac/ax",
                      page_row="rows 'Wireless', 'Wi-Fi frequency', 'Wi-Fi TX power (EIRP)', 'Wi-Fi protocol'"))
specs.append(pdf_spec("connectivity.interface", "USB", "", "p.2 › Connectivity › USB", "USB Supported",
                      tc="The sheet says only 'USB: Supported' (port use not stated).", page_row="row 'USB'"))
specs.append(pdf_spec("safety.certifications", ["Class 1 laser safety"], "", "p.2 › Safety › Safety certification", "Safety certification Class 1 laser safety",
                      tc="Class 1 in standard enclosed use. Store spec footnote 3: with the riser base or the auto-feed accessory the enclosure is no longer complete and the machine becomes a Class 4 device, requiring CO2 laser-safety eyewear, for trained professional use only.",
                      page_row="row 'Safety certification' (footnote 3)"))
specs.append({"key": "connectivity.display", "scope": PROD, "value": "Touchscreen", "unit": "", "status": "unverified", "confidence": "official_page",
              "source_kind": "store_page", "source_url": PAGE, "source_title": PAGE_T, "locator": "description › components[4] › 'Tricky setup? Solved.' (usage step)",
              "quote": "R1 puts a touchscreen right on the machine.", "test_method": "", "test_condition": "", "region": "", "retrieved_at": PAGE_AT,
              "note": "Product prose, not a spec-table row: kept unverified. The spec sheet has no display row."})

# What's in the box (store page table, flight row 161): per version, with quantities.
BOX_COMMON = [("R1", 1), ("Power Cord", 1), ("Smoke Ventilation Hose", 1), ("Smoke Ventilation Fan", 1), ("Anti-freeze", 1), ("Funnel", 1),
              ("Allen Key", 1), ("Safety Key (Pre-installed)", 1), ("Laser Alignment Sensor", 1), ("Material Pin", 1), ("Calibration Board", 1),
              ("Lubricant Grease", 2), ("Lubricant Oil", 1), ("Clear Acrylic", 1), ("Basswood Plywood", 1)]
BOX = {
  "R1": BOX_COMMON,
  "LMB": BOX_COMMON + [("Riser Base", 1), ("Automatic Conveyor Feeder", 1)],
  "LMRB": BOX_COMMON + [("Riser Base", 1), ("Automatic Conveyor Feeder", 1), ("Rotary Attachment", 1), ("Rotary Attachment Bracket", 1)],
}
COL = {"R1": "R1", "LMB": "R1 Long Material Bundle", "LMRB": "R1 Long Material & Rotary Bundle"}
QUOTES = {
  "R1": "R1 1 · Power Cord 1 · Smoke Ventilation Hose 1 · Smoke Ventilation Fan 1 · Anti-freeze 1 · Funnel 1 · Allen Key 1 · Lubricant Grease 2 · Riser Base - · Automatic Conveyor Feeder -",
  "LMB": "Riser Base 1 · Automatic Conveyor Feeder 1 · Rotary Attachment - · Rotary Attachment Bracket - (column 'R1 Long Material Bundle')",
  "LMRB": "Riser Base 1 · Automatic Conveyor Feeder 1 · Rotary Attachment 1 · Rotary Attachment Bracket 1 (column 'R1 Long Material & Rotary Bundle')",
}
def item_text(t, q):
    return f"{t} × {q}"
in_the_box = []
for k in ("R1", "LMB", "LMRB"):
    specs.append({"key": "package.contents", "scope": OV[k], "value": [item_text(t, q) for t, q in BOX[k]], "unit": "", "status": "verified",
                  "confidence": "official_page", "source_kind": "store_page", "source_url": PAGE, "source_title": PAGE_T,
                  "locator": f"description › components[6] 'What's in the box' table (flight row 161) › column '{COL[k]}'",
                  "quote": QUOTES[k], "test_method": "", "test_condition": "", "region": "", "retrieved_at": PAGE_AT,
                  "note": "Wiki packing list agrees on the shared accessories; it names 'H2.0 & H1.5 Allen Keys' where the store table lists 'Allen Key × 1', and 'Lubricant Oil & Grease' as one entry."})
    in_the_box.append({"scope": OV[k], "section": f"What's in the box — {COL[k]}", "source_kind": "store_page", "source_url": PAGE, "source_title": PAGE_T,
                       "locator": f"description › components[6] 'What's in the box' table (flight row 161) › column '{COL[k]}'", "retrieved_at": PAGE_AT,
                       "items": [{"text": t, "qty": q} for t, q in BOX[k]]})
in_the_box.append({"scope": PROD, "section": "Accessories Introduction (accessories in the R1 package)", "source_kind": "wiki", "source_url": WIKI, "source_title": WIKI_T,
                   "locator": "¶ Accessories Introduction (table, rows 1–12)", "retrieved_at": WIKI_AT,
                   "note": "Accessories only (the machine itself is not a row); quantities not given. Same for every version per the store table.",
                   "items": [{"text": "Power Cord", "qty": None}, {"text": "Smoke Ventilation Hose", "qty": None}, {"text": "Smoke Ventilation Fan", "qty": None},
                             {"text": "Anti-freeze", "qty": None}, {"text": "Funnel", "qty": None}, {"text": "H2.0 & H1.5 Allen Keys", "qty": None},
                             {"text": "Safety Key", "qty": None, "note": "Pre-installed"}, {"text": "Laser Alignment Sensor", "qty": None},
                             {"text": "Material Pin", "qty": None}, {"text": "Calibration Board", "qty": None}, {"text": "Lubricant Oil & Grease", "qty": None},
                             {"text": "Basswood Plywood & Clear Acrylic Sheet", "qty": None}]})

def rel(relation, label, kind, handle, ev, skind, url, title, loc, quote, at, cond=""):
    r = {"relation": relation, "scope": PROD, "target_kind": kind, "target_label": label}
    if handle: r["target_source_handle"] = handle
    r.update({"evidence_kind": ev, "source_kind": skind, "source_url": url, "source_title": title, "locator": loc, "quote": quote, "retrieved_at": at})
    if cond: r["condition"] = cond
    return r
C4 = "description › components[4] › 'Go taller. Rounder. Longer. Thicker.'"
relations = [
  rel("compatible_with", "Riser Base", "part", "riser-base", "description_text", "store_page", PAGE, PAGE_T, C4 + " › item 'Riser Base'",
      "Raises R1 to create clearance for taller objects. Also required for the Conveyor and Rotary.", PAGE_AT,
      "Included in both bundles. Store spec footnote 3: with the riser base the machine becomes Class 4."),
  rel("compatible_with", "Automatic Conveyor Feeder", "part", "automatic-conveyor-feeder", "description_text", "store_page", PAGE, PAGE_T, C4 + " › item 'Conveyor'",
      "Automatically feeds long stock through R1, letting you cut and engrave boards up to 3 meters long.", PAGE_AT,
      "Requires the Riser Base. Included in both bundles. Store spec footnote 3: with the auto-feed accessory the machine becomes Class 4."),
  rel("compatible_with", "Bambu Lab Rotary Attachment", "part", "rotary-attachment", "description_text", "store_page", PAGE, PAGE_T, C4 + " › item 'Rotary Attachment'",
      "Rotates round objects for full 360° engraving on bottles, bowls, cups, and more. Requires the Riser Base.", PAGE_AT,
      "Requires the Riser Base; included (with its bracket) in the R1 Long Material & Rotary Bundle."),
  rel("compatible_with", "Focusing Lens - Medium & Long Focal", "part", "focusing-lens-medium-long-focal", "description_text", "store_page", PAGE, PAGE_T, C4 + " › item 'Focus lenses (Medium / Long)'",
      "Greater depth of focus for cleaner cuts through thicker materials — up to 20 mm with the long-focus lens.", PAGE_AT),
  rel("compatible_with", "Focusing Lens - Short Focal", "part", "focusing-lens-short-focal", "faq", "store_page", PAGE, PAGE_T, "description › components[8] FAQ › question 1",
      "Short Focal Length (S): Standard.Smaller spot size, better detail performance;", PAGE_AT, "The standard lens."),
  rel("compatible_with", "Bambu Lab Purifier E1 Pro", "other", "bambu-lab-purifier-e1-pro", "faq", "store_page", PAGE, PAGE_T, "description › components[8] FAQ › question 5",
      "We recommend using the Bambu Lab E1 Pro Purifier, which links with the R1 Laser Cutter to filter smoke and particles generated during laser operation", PAGE_AT,
      "Recommended; links with the R1 (smart function)."),
  rel("compatible_with", "Smoke Purifier", "other", "smoke-purifier", "faq", "store_page", PAGE, PAGE_T, "description › components[8] FAQ › question 5",
      "The Bambu Lab Smoke Purifier is structurally compatible with the R1, but it lacks the smart function.", PAGE_AT,
      "Structurally compatible only: no smart linkage; controlled manually with its power switch and speed knob."),
  rel("compatible_with", "Auto Fire Extinguishing System", "other", "auto-fire-extinguishing-system", "spec_table", "store_page", PAGE, PAGE_T,
      "description › components[7] 'R1 Specs' › Safety interlocks (footnote 4)", "Auto fire extinguishing⁴ … 4. Requires the Auto Fire Extinguishing System, sold separately.", PAGE_AT,
      "Needed for the auto fire extinguishing interlock; sold separately (not in any version's box)."),
]
SM = "p.1 › Processing › Supported materials"
CE = "Cut & engrave: wood, acrylic (incl. clear acrylic), leather, fabric, paper, EVA foam, shell"
EO = "Engrave only: coated metal (bare metal cannot be engraved), glass, ceramic"
for label, cond in (("Wood", "Cut and engrave. Store spec footnote 1: all references to wood refer to plywood."),
                    ("Acrylic (incl. clear acrylic)", "Cut and engrave."), ("Leather", "Cut and engrave."), ("Fabric", "Cut and engrave."),
                    ("Paper", "Cut and engrave."), ("EVA foam", "Cut and engrave."), ("Shell", "Cut and engrave.")):
    relations.append(rel("compatible_with", label, "material", "", "spec_table", "store_doc", PDF, PDF_T, SM, CE, PDF_AT, cond))
for label in ("Coated metal", "Glass", "Ceramic"):
    relations.append(rel("compatible_with", label, "material", "", "spec_table", "store_doc", PDF, PDF_T, SM, EO, PDF_AT, "Engrave only (no cutting)."))
relations.append(rel("not_compatible_with", "Bare (uncoated) metal", "material", "", "spec_table", "store_doc", PDF, PDF_T, SM, EO, PDF_AT,
                     "Cannot be engraved. FAQ 4 also warns: do not process uncoated metals or similar reflective materials."))

not_published = ["electrical.rated_power", "electrical.current", "electrical.standby_power", "connectivity.bluetooth", "physical.chassis", "physical.noise"]

searched = [
  {"kind": "store_doc", "url": PDF, "title": PDF_T,
   "keys": ["printing.*", "motion.*", "electrical.*", "connectivity.*", "physical.*", "product.*", "package.*", "shipment.*", "safety.*"],
   "retrieved_at": PDF_AT, "also": "Every row of both pages (Processing, Measurement & Positioning, Automation, Safety, Physical & Power, Software, Connectivity); supported materials (relations)."},
  {"kind": "wiki", "url": WIKI, "title": WIKI_T, "keys": ["package.contents"], "retrieved_at": WIKI_AT,
   "also": "Accessories table (in_the_box)."},
  {"kind": "store_page", "url": PAGE, "title": PAGE_T,
   "keys": ["printing.*", "motion.*", "electrical.*", "connectivity.*", "physical.*", "product.*", "package.*", "shipment.*", "safety.*", "package.contents"],
   "retrieved_at": PAGE_AT,
   "also": "Parsed payload (no spec rows); the 'R1 Specs' table and footnotes (flight row 162), the 'What's in the box' table (flight row 161), FAQ answers and accessory blocks (relations), Product Features highlights, messages bundle (no R1 namespace, no 220 V / 110 V R1 values)."},
]

documents = [
  {"kind": "spec_sheet", "url": PDF, "title": PDF_T, "language": "en", "published_on": "2026-09-21", "retrieved_at": PDF_AT,
   "sha256": "a1f387492ad67bc984e756799a9e341a8c52d9f4412800bf7479390dd1eb9c9f",
   "note": "The store page's 'Download PDF' button in the R1 Specs block; the builder did not collect it (downloadButton is outside the extractor's read list). Two pages, printed page numbers 14 and 15."},
  {"kind": "wiki", "url": WIKI, "title": WIKI_T, "language": "en", "published_on": "2026-09-22", "retrieved_at": WIKI_AT},
]

doc = {"handle": "r1", "schema": 2, "curated_by": "agent-2", "curated_at": NOW, "searched": searched, "specs": specs, "hex": [],
       "relations": relations, "in_the_box": in_the_box, "documents": documents, "not_published": not_published}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(len(specs), len(not_published), len(relations))
