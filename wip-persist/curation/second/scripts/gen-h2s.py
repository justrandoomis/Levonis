"""Writes the independent second curated extraction for handle h2s (schema 2)."""
import json
import sys

OUT = sys.argv[1]
CURATED_AT = sys.argv[2]

PDF = "https://store.bblcdn.com/s7/default/3f91ec86de1a4ce28fe8fb660b95cd3e/h2s.pdf"
PDF_TITLE = "H2S & H2S Laser Edition Spec Sheet"
PDF_AT = "2026-10-16T08:21:29Z"
WIKI = "https://wiki.bambulab.com/en/h2s/manual/acc-in-the-box"
WIKI_TITLE = "H2S Packaging List"
WIKI_AT = "2026-10-16T08:23:38Z"

V_H2S = {"kind": "option_value", "source_value_id": "636696880147419138", "id": "ov_07600dc4ab2773735c3d3fc9", "value_text": "H2S"}
V_AMS = {"kind": "option_value", "source_value_id": "636696880147419139", "id": "ov_8b634cb4fcec7011924bb3d5", "value_text": "H2S AMS Combo"}
V_LASER = {"kind": "option_value", "source_value_id": "636696880147419140", "id": "ov_eca3e58fb453b03a34f7536e", "value_text": "H2S Laser Full Combo"}
PRODUCT = {"kind": "product"}

US = "US version (100–120 V)"
BOOL_NOTE = "Format only: the store page shows the same fact as the text 'Supported' (value_bool 1); here it is the typed value true."


def spec(key, value, unit, locator, quote, *, status="verified", region="", scope=None, test_method="", test_condition="", conflict=None):
    assert len(quote) <= 200, (key, len(quote))
    row = {
        "key": key,
        "scope": scope or PRODUCT,
        "value": value,
        "unit": unit,
        "status": status,
        "confidence": "official_doc",
        "source_kind": "store_doc",
        "source_url": PDF,
        "source_title": PDF_TITLE,
        "locator": locator,
        "quote": quote,
        "test_method": test_method,
        "test_condition": test_condition,
        "region": region,
        "retrieved_at": PDF_AT,
    }
    if conflict:
        row["conflict"] = conflict
    return row


FLOW_COND = "250 mm round model with a single outer wall; Bambu Lab ABS; 280 °C printing temperature"

specs = [
    # ---- page 1
    spec("printing.technology", "Fused Deposition Modeling", "", "p.1 › Printing Technology", "Printing Technology Fused Deposition Modeling"),
    spec("printing.build_volume", "340 × 320 × 340 mm", "mm", "p.1 › Body › Build Volume (W*D*H)", "Build Volume (W*D*H) 340*320*340 mm³"),
    spec("physical.chassis", "Aluminum and Steel", "", "p.1 › Body › Chassis & Shell", "Chassis & Shell Aluminum and Steel",
         conflict="Store page row 'Chassis' says 'Aluminum, Steel, Plastic and Glass'; the spec sheet row 'Chassis & Shell' says 'Aluminum and Steel'."),
    spec("product.length", 492, "mm", "p.1 › Physical Dimensions › Physical Dimensions (1st figure)", "Physical Dimensions 492*514*626 mm³"),
    spec("product.width", 514, "mm", "p.1 › Physical Dimensions › Physical Dimensions (2nd figure)", "Physical Dimensions 492*514*626 mm³"),
    spec("product.height", 626, "mm", "p.1 › Physical Dimensions › Physical Dimensions (3rd figure)", "Physical Dimensions 492*514*626 mm³"),
    spec("product.net_weight", 30000, "g", "p.1 › Physical Dimensions › Net Weight", "Net Weight 30 kg",
         conflict="Store page: 'H2S: 30 kg; H2S Laser Edition: 30.5 kg'. The spec sheet covers both editions and states one value, 30 kg; it agrees for H2S and differs for the Laser Edition (Laser Full Combo)."),
    spec("extrusion.hotend", "All Metal", "", "p.1 › Toolhead › Hotend", "Hotend All Metal"),
    spec("extrusion.extruder_gear", "Hardened Steel", "", "p.1 › Toolhead › Extruder Gear", "Extruder Gear Hardened Steel"),
    spec("extrusion.nozzle_material", "Hardened Steel", "", "p.1 › Toolhead › Nozzle", "Nozzle Hardened Steel"),
    spec("thermal.max_nozzle_temp", 350, "°C", "p.1 › Toolhead › Max Nozzle Temperature", "Max Nozzle Temperature 350 ℃"),
    spec("extrusion.nozzle_diameter", 0.4, "mm", "p.1 › Toolhead › Included Nozzle Diameter", "Included Nozzle Diameter 0.4 mm"),
    spec("extrusion.supported_nozzle_diameters", ["0.2 mm", "0.4 mm", "0.6 mm", "0.8 mm"], "", "p.1 › Toolhead › Supported Nozzle Diameter",
         "Supported Nozzle Diameter 0.2 mm, 0.4 mm, 0.6 mm, 0.8 mm"),
    spec("printing.filament_cutter", "Built-in", "", "p.1 › Toolhead › Filament Cutter", "Filament Cutter Built-in"),
    spec("extrusion.filament_diameter", 1.75, "mm", "p.1 › Toolhead › Filament Diameter", "Filament Diameter 1.75 mm"),
    spec("extrusion.extruder_motor", "Bambu Lab High-precision Permanent Magnet Synchronous Motor", "", "p.1 › Toolhead › Extruder Motor",
         "Extruder Motor Bambu Lab High-precision Permanent Magnet Synchronous Motor"),
    spec("printing.build_plate", ["Textured PEI plate", "Smooth PEI Plate"], "", "p.1 › Heatbed › Supported Build Plate Type",
         "Supported Build Plate Type Textured PEI plate, Smooth PEI Plate"),
    spec("thermal.max_bed_temp", 120, "°C", "p.1 › Heatbed › Max Heatbed Temperature", "Max Heatbed Temperature 120 ℃"),
    spec("motion.max_speed", 1000, "mm/s", "p.1 › Speed › Max Speed of Toolhead", "Max Speed of Toolhead 1000 mm/s"),
    spec("motion.max_acceleration", 20000, "mm/s²", "p.1 › Speed › Max Acceleration of Toolhead", "Max Acceleration of Toolhead 20,000 mm/s²"),
    spec("motion.max_flow", 40, "mm³/s", "p.1 › Speed › Max Flow for Hotend (Standard Flow Hotend)",
         "Max Flow for Hotend (Standard Flow Hotend) 40 mm³/s (Test parameters: 250 mm round model with a single outer wall; Bambu Lab ABS; 280 ℃ printing temperature)",
         test_condition=f"Standard Flow Hotend; test parameters: {FLOW_COND}"),
    spec("motion.max_flow_high_flow", 65, "mm³/s", "p.1 › Speed › Max Flow for Hotend (Optional High Flow Hotend)",
         "Max Flow for Hotend (Optional High Flow Hotend) 65 mm³/s (Test parameters: 250 mm round model with a single outer wall; Bambu Lab ABS; 280 ℃ printing temperature)",
         test_condition=f"Optional High Flow Hotend; test parameters: {FLOW_COND}"),
    spec("thermal.chamber_heating", True, "", "p.1 › Chamber Temperature Control › Active Chamber Heating", "Active Chamber Heating Supported", conflict=BOOL_NOTE),
    spec("thermal.chamber_temp", 65, "°C", "p.1 › Chamber Temperature Control › Max Temperature", "Chamber Temperature Control Max Temperature 65 ℃"),
    spec("safety.prefilter_grade", "G3", "", "p.1 › Air Purification › Pre-filter Grade", "Pre-filter Grade G3"),
    spec("safety.hepa_grade", "H12", "", "p.1 › Air Purification › HEPA Filter Grade", "HEPA Filter Grade H12"),
    spec("safety.carbon_filter", "Granulated Coconut Shell", "", "p.1 › Air Purification › Activated Carbon Filter Type", "Activated Carbon Filter Type Granulated Coconut Shell"),
    spec("safety.voc_filtration", "Superior", "", "p.1 › Air Purification › VOC Filtration", "VOC Filtration Superior"),
    spec("safety.particulate_filtration", "Supported", "", "p.1 › Air Purification › Particulate Matter Filtration", "Particulate Matter Filtration Supported"),
    # ---- page 2
    spec("thermal.part_cooling_fan", "Closed Loop Control", "", "p.2 › Cooling › Part Cooling Fan", "Part Cooling Fan Closed Loop Control"),
    spec("thermal.hotend_fan", "Closed Loop Control", "", "p.2 › Cooling › Cooling Fan for Hotend", "Cooling Fan for Hotend Closed Loop Control"),
    spec("thermal.control_board_fan", "Closed Loop Control", "", "p.2 › Cooling › Main Control Board Fan", "Main Control Board Fan Closed Loop Control"),
    spec("thermal.chamber_exhaust_fan", "Closed Loop Control", "", "p.2 › Cooling › Chamber Exhaust Fan", "Chamber Exhaust Fan Closed Loop Control"),
    spec("thermal.chamber_circulation_fan", "Closed Loop Control", "", "p.2 › Cooling › Chamber Heat Circulation Fan", "Chamber Heat Circulation Fan Closed Loop Control"),
    spec("thermal.aux_part_cooling_fan", "Closed Loop Control", "", "p.2 › Cooling › Auxiliary Part Cooling Fan", "Auxiliary Part Cooling Fan Closed Loop Control"),
    spec("printing.supported_filament",
         ["PLA", "PETG", "TPU", "PVA", "BVOH", "ABS", "ASA", "PC", "PA", "PET", "PPS",
          "Carbon/Glass Fiber Reinforced PLA", "Carbon/Glass Fiber Reinforced PETG", "Carbon/Glass Fiber Reinforced PA",
          "Carbon/Glass Fiber Reinforced PET", "Carbon/Glass Fiber Reinforced PC", "Carbon/Glass Fiber Reinforced ABS",
          "Carbon/Glass Fiber Reinforced ASA", "Carbon/Glass Fiber Reinforced PPA", "Carbon/Glass Fiber Reinforced PPS"],
         "", "p.2 › Filament Supported",
         "Filament Supported PLA, PETG, TPU, PVA, BVOH, ABS, ASA, PC, PA, PET, PPS; Carbon/Glass Fiber Reinforced PLA, PETG, PA, PET, PC, ABS, ASA, PPA, PPS",
         conflict="Same cell text as the store page row 'Supported Filament Type'. Here 'Carbon/Glass Fiber Reinforced' qualifies each material after it; the page parse lists those as bare names (PPA appears unqualified)."),
    spec("printing.camera", "Built-in; 1920*1080", "", "p.2 › Sensor › Live View Camera", "Live View Camera Built-in; 1920*1080"),
    spec("printing.camera_toolhead", "Built-in; 1600*1200", "", "p.2 › Sensor › Toolhead Camera", "Toolhead Camera Built-in; 1600*1200"),
    spec("printing.camera_birdseye", "Built-in; 3264*2448 (Equipped with Laser Edition)", "", "p.2 › Sensor › BirdsEye Camera",
         "BirdsEye Camera Built-in; 3264*2448 (Equipped with Laser Edition)",
         conflict="Format only: the store page writes the same value with full-width parentheses."),
    spec("printing.door_sensor", True, "", "p.2 › Sensor › Door Sensor", "Door Sensor Supported", conflict=BOOL_NOTE),
    spec("printing.filament_runout_sensor", True, "", "p.2 › Sensor › Filament Run Out Sensor", "Filament Run Out Sensor Supported", conflict=BOOL_NOTE),
    spec("printing.filament_tangle_sensor", True, "", "p.2 › Sensor › Filament Tangle Sensor", "Filament Tangle Sensor Supported", conflict=BOOL_NOTE),
    spec("printing.filament_odometry", True, "", "p.2 › Sensor › Filament Odometry", "Filament Odometry Supported with AMS", test_condition="with AMS",
         conflict="Format only: the store page shows the text 'Supported with AMS' (value_bool 1); here it is true with the AMS condition in test_condition."),
    spec("printing.power_loss_recovery", True, "", "p.2 › Sensor › Power Loss Recovery", "Power Loss Recovery Supported", conflict=BOOL_NOTE),
    # electrical (region rule §C.6): the 220 V values first, the US values unverified
    spec("electrical.voltage", "200-240 VAC, 50/60 Hz", "", "p.2 › Electrical Requirements › Voltage (2nd range)", "Voltage 100–120 VAC / 200–240 VAC, 50/60 Hz",
         region="intl_220v"),
    spec("electrical.voltage", "100-120 VAC, 50/60 Hz", "", "p.2 › Electrical Requirements › Voltage (1st range)", "Voltage 100–120 VAC / 200–240 VAC, 50/60 Hz",
         region="us_110v", status="unverified", test_condition=US),
    spec("electrical.frequency", "50/60 Hz", "", "p.2 › Electrical Requirements › Voltage", "Voltage 100–120 VAC / 200–240 VAC, 50/60 Hz", region="intl_220v"),
    spec("electrical.frequency", "50/60 Hz", "", "p.2 › Electrical Requirements › Voltage", "Voltage 100–120 VAC / 200–240 VAC, 50/60 Hz",
         region="us_110v", status="unverified", test_condition=US),
    spec("electrical.max_power", 2050, "W", "p.2 › Electrical Requirements › Max Power¹; p.3 footnote 1", "Max Power¹ 2050 W@220 V / 1170 W@110 V",
         region="intl_220v",
         test_condition="at 220 V; footnote 1: the printer maintains maximum power for about 3 minutes so the heatbed quickly reaches the needed temperature"),
    spec("electrical.max_power", 1170, "W", "p.2 › Electrical Requirements › Max Power¹; p.3 footnote 1", "Max Power¹ 2050 W@220 V / 1170 W@110 V",
         region="us_110v", status="unverified",
         test_condition="US version (100–120 V), at 110 V; footnote 1: maximum power is held for about 3 minutes while the heatbed heats"),
    spec("physical.operating_temp", "10 °C-30 °C", "", "p.2 › Working Temperature", "Working Temperature 10 ℃-30 ℃"),
    spec("connectivity.display", "5-inch 720*1280 Touchscreen", "", "p.2 › Electronics › Touchscreen", "Touchscreen 5-inch 720*1280 Touchscreen"),
    spec("connectivity.storage", "Built-in 8 GB EMMC and USB Port", "", "p.2 › Electronics › Storage", "Storage Built-in 8 GB EMMC and USB Port"),
    spec("connectivity.control_interface", ["Touchscreen", "mobile App", "PC App"], "", "p.2 › Electronics › Control Interface",
         "Control Interface Touchscreen, mobile App, PC App"),
    spec("connectivity.npu", "2 TOPS", "", "p.2 › Electronics › Neural Processing Unit", "Neural Processing Unit 2 TOPS"),
    spec("connectivity.software",
         "Bambu Studio Supports third-party slicers which export standard G-code, such as Super Slicer, PrusaSlicer and Cura, but certain advanced features may not be supported.",
         "", "p.2 › Software › Slicer",
         "Slicer Bambu Studio Supports third-party slicers which export standard G-code, such as Super Slicer, PrusaSlicer and Cura, but certain advanced features may not be supported."),
    spec("connectivity.operating_systems", ["MacOS", "Windows", "Linux"], "", "p.2 › Software › Supported Operating System",
         "Supported Operating System MacOS, Windows, Linux"),
    spec("connectivity.ethernet", "Not Available", "", "p.2 › Network Control › Ethernet", "Ethernet Not Available"),
    spec("connectivity.wireless_network", "Wi-Fi", "", "p.2 › Network Control › Wireless Network", "Wireless Network Wi-Fi"),
    spec("connectivity.network_kill_switch", False, "", "p.2 › Network Control › Network Kill Switch", "Network Kill Switch Not Available"),
    spec("connectivity.removable_network_module", False, "", "p.2 › Network Control › Removable Network Module", "Removable Network Module Not Available"),
    spec("connectivity.network_access_control", False, "", "p.2 › Network Control › 802.1X Network Access Control", "802.1X Network Access Control Not Available"),
    spec("connectivity.wifi",
         "Operating Frequency — 2412-2472 MHz (CE/FCC), 2400-2483.5 MHz (SRRC), 5150-5850 MHz\n"
         "Wi-Fi Transmitter Power (EIRP) — 2.4 GHz: <23 dBm (FCC); <20 dBm (CE/SRRC/MIC) 5 GHz Band1/2: <23 dBm (FCC/CE/SRRC/MIC) 5 GHz Band3: <30 dBm (CE); <24 dBm (FCC) 5 GHz Band4: <23 dBm (FCC/SRRC); <14 dBm (CE)\n"
         "Wi-Fi Protocol — IEEE 802.11 a/b/g/n",
         "", "p.2 › Wi-Fi › Operating Frequency; Wi-Fi Transmitter Power (EIRP); Wi-Fi Protocol",
         "Operating Frequency 2412-2472 MHz (CE/FCC), 2400-2483.5 MHz (SRRC) 5150-5850 MHz … Wi-Fi Protocol IEEE 802.11 a/b/g/n"),
]

searched = [
    {
        "kind": "spec_sheet",
        "url": PDF,
        "title": PDF_TITLE,
        "retrieved_at": PDF_AT,
        "pages": 3,
        "keys": ["printing.*", "motion.*", "extrusion.*", "thermal.*", "electrical.*", "connectivity.*", "physical.*", "safety.*",
                 "product.*", "package.*", "shipment.*", "carton.*", "identity.*"],
        "note": "All three pages read (pdftotext -layout and a page render). Page 3 holds the 10W laser module and cutting module tables; the registry has no key for those rows. not_published lists printer keys that neither this sheet, the packaging list nor the store page states; dual-hotend keys, the nozzle camera, carton/package logistics (US values are on the store page) and laser-only keys are left out.",
    },
    {
        "kind": "wiki",
        "url": WIKI,
        "title": WIKI_TITLE,
        "retrieved_at": WIKI_AT,
        "keys": ["package.contents"],
        "note": "Packaging list table with two columns: H2S Laser Full Combo and H2S AMS Combo. No list is published for the printer-only H2S version.",
    },
]


def rel(relation, target_label, target_kind, locator, quote, *, scope=None, evidence_kind="spec_row", url=PDF, title=PDF_TITLE, at=PDF_AT):
    assert len(quote) <= 300
    return {
        "relation": relation,
        "scope": scope or PRODUCT,
        "target_kind": target_kind,
        "target_label": target_label,
        "evidence_kind": evidence_kind,
        "source_url": url,
        "source_title": title,
        "locator": locator,
        "quote": quote,
        "retrieved_at": at,
    }


LASER_QUOTE = "Laser Safety Windows Equipped on Laser Edition, normal H2S can upgrade through Laser Upgrade Kit"
relations = [
    rel("compatible_with", "Laser Upgrade Kit", "laser_module", "p.1 › Body › Laser Safety Windows; Air Assist Pump", LASER_QUOTE, scope=V_H2S),
    rel("compatible_with", "Laser Upgrade Kit", "laser_module", "p.1 › Body › Laser Safety Windows; Air Assist Pump", LASER_QUOTE, scope=V_AMS),
    rel("compatible_with", "10W Laser Module", "laser_module", "p.3 › 10W Laser Module Spec › Engraving Area",
        "10W Laser Module Spec … Engraving Area H2D: 310 * 270 mm² H2S: 310 * 260 mm²"),
    rel("compatible_with", "Cutting Module", "part", "p.3 › Cutting Module Spec › Cutting Area",
        "Cutting Module Spec … Cutting Area H2D：300*285 mm² H2S：297.5*300 mm²"),
    rel("compatible_with", "High Flow Hotend", "part", "p.1 › Speed › Max Flow for Hotend (Optional High Flow Hotend)",
        "Max Flow for Hotend (Optional High Flow Hotend) 65 mm³/s"),
    rel("compatible_with", "Textured PEI plate", "part", "p.1 › Heatbed › Supported Build Plate Type",
        "Supported Build Plate Type Textured PEI plate, Smooth PEI Plate"),
    rel("compatible_with", "Smooth PEI Plate", "part", "p.1 › Heatbed › Supported Build Plate Type",
        "Supported Build Plate Type Textured PEI plate, Smooth PEI Plate"),
    rel("compatible_with", "AMS", "ams", "p.2 › Sensor › Filament Odometry", "Filament Odometry Supported with AMS"),
    rel("compatible_with", "AMS 2 Pro", "ams", "Packaging List › H2S AMS Combo / H2S Laser Full Combo › row 1",
        "H2S AMS Combo | H2S Printer AMS 2 Pro Build Plate (Pre-installed on heatbed)", evidence_kind="wiki_table", url=WIKI, title=WIKI_TITLE, at=WIKI_AT),
]


def items(*names, section=""):
    out = []
    for n in names:
        if isinstance(n, tuple):
            text, qty = n
        else:
            text, qty = n, None
        out.append({"text": text, "qty": qty, "section": section})
    return out


TOOLS_AMS = ["0.4 mm Nozzle", "Hotend Silicone Sock", "Toolhead Cutter", "Unclogging Pin", "Nozzle Wiping Pad", "Scraper Blade",
             "Nozzle Wiping Component", "Screws (for Spool Holder, Scraper)", "Allen Key (H1.5 & H2.0)", "Camera Privacy Cover",
             "Lubricant Oil", "Lubricant Grease"]
TOOLS_LASER = ["0.4 mm Nozzle", "Hotend Silicone Sock", "Toolhead Cutter", "45° Fine-point Blade", "Unclogging Pin", "Nozzle Wiping Pad",
               "Scraper Blade", "Nozzle Wiping Component", "Weeding Tool", "Screws (for Spool Holder, Scraper)", "Allen Key (H1.5 & H2.0)",
               "Laser Homing Area XY & Z Marker", "Rubber Screws for Chamber Exhaust Fan", "Camera Privacy Cover", "Lubricant Oil",
               "Lubricant Grease"]
DOCS = ["Quick Start Guide", "Warranty Leaflet", "Disclaimer and Safety Guidelines"]

in_the_box = [
    {
        "scope": V_AMS,
        "source_kind": "wiki",
        "source_url": WIKI,
        "source_title": WIKI_TITLE,
        "locator": "Packaging List › column 'H2S AMS Combo'",
        "retrieved_at": WIKI_AT,
        "items": (
            items("H2S Printer", "AMS 2 Pro", "Build Plate (Pre-installed on heatbed)", "Safety Key (attached to the rear board)")
            + items("Spool Holder", "Power Cord (in AMS)", section="Accessory Box")
            + items(*TOOLS_AMS, section="Tool Box")
            + items("PTFE Tube", "Desiccant", *DOCS)
            + items(("PTFE tube (2 pcs)", 2), "6-pin cable", "printer power cord", section="Packaged inside the AMS 2 Pro")
        ),
        "note": "The last row says where items travel (inside the AMS 2 Pro); it overlaps 'Power Cord (in AMS)' and 'PTFE Tube' above. Kept as the list states it.",
    },
    {
        "scope": V_LASER,
        "source_kind": "wiki",
        "source_url": WIKI,
        "source_title": WIKI_TITLE,
        "locator": "Packaging List › column 'H2S Laser Full Combo'",
        "retrieved_at": WIKI_AT,
        "items": (
            items("H2S Printer", "AMS 2 Pro", "Build Plate (Pre-installed on heatbed)",
                  ("Safety Key (one attached to the rear board, one on the Emergency Stop Button)", 2))
            + items("Power Cord", "6-pin Cable", "Marker Pen", "Spool Holder", "Emergency Stop Button", "Cutting Module", "Pen Holder",
                    "Pen Height Calibrator", "Pen Fixture", "Laser module", section="Accessory Box")
            + items(*TOOLS_LASER, section="Tool Box")
            + items("PTFE Tube", "Desiccant", *DOCS)
            + items("Laser Platform", "Cutting Platform", "StrongGrip Cutting Mat (Pre-installed on Cutting Platform)",
                    "LightGrip Cutting Mat (Pre-installed on Cutting Platform)", "Laser Slats Pack", "Material Pins", "Basswood Plywood",
                    "Cork Sheet", "Heat Transfer Vinyl", "Protective Paper for Heat Transfer", "Pearlescent White Greeting Card Set",
                    "Rectangular PU Iron-on Patch", "Round Stainless Steel Tag (Large & Small)", "Brush", "H2.5 Allen Key", section="Supply Box")
            + items("Smoke Ventilation Pipe", "Ventilation Pipe Adapter", "Pipe Clamp", "Screws for Ventilation Pipe Adapter", "Air Pump Intake",
                    section="Packaged inside the AMS 2 Pro")
        ),
        "note": "The wiki numbers the accessory box list 1–9 with '9.' used twice (Pen Fixture, Laser module); both items are kept.",
    },
]

documents = [
    {"kind": "spec_sheet", "url": PDF, "title": PDF_TITLE, "language": "en", "pages": 3, "retrieved_at": PDF_AT,
     "sha256": "7c0aeef677273024bc407024ffdc10c1b439e0864fb66d41504a65db69fe746e"},
    {"kind": "wiki", "url": WIKI, "title": WIKI_TITLE, "language": "en", "retrieved_at": WIKI_AT,
     "sha256": "fcfc6fb534a85eeb859f8504806e5b757b83b2f80d8579a138537ead53e75fb3"},
]

not_published = [
    "printing.layer_height",
    "printing.auto_leveling",
    "printing.unsupported_filament",
    "printing.build_plate_material",
    "electrical.rated_power",
    "electrical.standby_power",
    "electrical.steady_state_power",
    "electrical.current",
    "connectivity.bluetooth",
    "connectivity.motion_controller",
    "connectivity.application_processor",
    "physical.noise",
    "physical.outer_frame",
    "safety.certifications",
]

doc = {
    "handle": "h2s",
    "schema": 2,
    "curated_by": "agent-2",
    "curated_at": CURATED_AT,
    "searched": searched,
    "specs": specs,
    "hex": [],
    "relations": relations,
    "in_the_box": in_the_box,
    "documents": documents,
    "not_published": not_published,
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(len(specs), "specs;", len(not_published), "not_published")
