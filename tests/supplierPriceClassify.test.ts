/**
 * A BAMBU PRODUCT'S ESTIMATE TYPE (docs/SMART_PRICING.md §3.8): the first
 * source that gives one wins —
 *
 *   owner > the confirmed Tmall match's category > the import's type
 *   (+ filament subtype `pack` → filament_pack, a spare part named as an
 *   electronic part → electronics_part, an accessory named as one →
 *   electronics_device) > EST_TYPE_MISSING.
 *
 * The Tmall table maps all 16 capture categories (`other` gives none); the
 * seeded types' sourcing agrees with the capture's own rule on every real
 * item (electronic devices and parts from the EU store, the rest from China);
 * the real manifest rows classify as the owner's rule says, the electronics
 * rule word for word as the EU store capture records it (its head noun
 * decides: a board is electronic, a board's cover or heatsink is not).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPORT_TYPE_TYPES,
  SEEDED_TYPE_KEYS,
  SEEDED_TYPE_SOURCING,
  TMALL_CATEGORY_TYPES,
  classifyEstimateType,
  isElectronicsName,
} from '../packages/catalog/src/supplierPrices/classify';
import { manifestRow, tmallFile } from './fixtures/supplierPrices/load';

test('precedence: owner > Tmall category > import type > missing', () => {
  const all = { owner_type: 'accessory', supplier_category: 'electronic_part', import_type: 'spare_part', name_en: 'AMS lite Mainboard' };
  assert.deepEqual(classifyEstimateType(all), { type_key: 'accessory', type_source: 'owner', flags: [] });
  assert.deepEqual(classifyEstimateType({ ...all, owner_type: null }), { type_key: 'electronics_part', type_source: 'supplier_category', flags: [] });
  assert.deepEqual(classifyEstimateType({ ...all, owner_type: '', supplier_category: null }), { type_key: 'electronics_part', type_source: 'import_type', flags: [] });
  assert.deepEqual(classifyEstimateType({ import_type: 'spare_part', name_en: 'AMS lite Housing Assembly' }), { type_key: 'spare_part', type_source: 'import_type', flags: [] });
  assert.deepEqual(classifyEstimateType({}), { type_key: null, type_source: '', flags: ['EST_TYPE_MISSING'] });
  assert.deepEqual(classifyEstimateType({ supplier_category: 'other', import_type: 'something_new' }), { type_key: null, type_source: '', flags: ['EST_TYPE_MISSING'] });
});

test('the confirmed Tmall category reclassifies an imported spare part (a mainboard is EU-sourced)', () => {
  const r = classifyEstimateType({ supplier_category: 'electronic_part', import_type: 'spare_part', name_en: 'Extruder Board' });
  assert.equal(r.type_key, 'electronics_part');
  assert.equal(r.type_source, 'supplier_category');
  assert.equal(SEEDED_TYPE_SOURCING.electronics_part, 'EU_STORE_EUR');
  // `other` gives no type: the import's decides.
  assert.deepEqual(classifyEstimateType({ supplier_category: 'other', import_type: 'accessory' }), { type_key: 'accessory', type_source: 'import_type', flags: [] });
});

test('the Tmall table: all 16 capture categories', () => {
  assert.deepEqual(TMALL_CATEGORY_TYPES, {
    printer: 'printer',
    multi_material_unit: 'ams',
    laser_or_cutter_device: 'laser_machine',
    scanner: 'electronics_device',
    air_purifier: 'electronics_device',
    electronic_part: 'electronics_part',
    filament: 'filament',
    filament_bundle: 'filament_pack',
    nozzle_hotend: 'hotend',
    build_plate: 'build_plate',
    spare_part: 'spare_part',
    tool: 'accessory',
    accessory: 'accessory',
    maker_kit: 'makers_supply',
    laser_material: 'laser_material',
    other: null,
  });
  for (const t of Object.values(TMALL_CATEGORY_TYPES)) if (t) assert.ok((SEEDED_TYPE_KEYS as readonly string[]).includes(t), t);
});

test('the seeded sourcing agrees with the capture’s own rule on every real Tmall item', () => {
  const items = tmallFile().items;
  assert.ok(items.length >= 20);
  for (const it of items) {
    const type = TMALL_CATEGORY_TYPES[it.category];
    if (!type) continue;
    assert.equal(SEEDED_TYPE_SOURCING[type], it.sourcing, `${it.item_key} ${it.category}`);
  }
  // EU sourcing is exactly the electronics; filament, by sea only, is Chinese.
  assert.deepEqual(
    SEEDED_TYPE_KEYS.filter((k) => SEEDED_TYPE_SOURCING[k] === 'EU_STORE_EUR'),
    ['printer', 'ams', 'laser_machine', 'electronics_device', 'electronics_part']
  );
});

test('the import’s types, the pack subtype and the electronics keywords — on real manifest rows', () => {
  const cases: Array<[string, string]> = [
    ['h2d', 'printer'],
    ['refurbished-bambu-lab-h2d-3d-printer', 'printer'],
    ['pla-basic-filament', 'filament'],
    ['pla-cmyk-lithophane', 'filament_pack'],
    ['bambu-hotend-a1-a2', 'hotend'],
    ['bambu-textured-pei-plate', 'build_plate'],
    ['print-finishing-kit', 'accessory'],
    ['led-flame-tea-light-candle-set-warm-yellow', 'makers_supply'],
    ['ams-lite-mainboard', 'electronics_part'],
    ['ams-lite-4-pin-cable', 'electronics_part'],
    ['cooling-fan-for-hotend-x1c', 'electronics_part'],
    ['cable-chain-assembly', 'spare_part'],
    // The owner's rule names the filament buffer an electronic part (the EU capture sources it from the EU store).
    ['filament-buffer', 'electronics_part'],
    ['ams-2-pro-feeder-unit', 'spare_part'],
  ];
  for (const [handle, want] of cases) {
    const row = manifestRow(handle);
    const r = classifyEstimateType({ import_type: row.type, import_subtype: row.subtype, name_en: row.title });
    assert.equal(r.type_key, want, `${handle} (${row.type}/${row.subtype}: ${row.title})`);
    assert.equal(r.type_source, 'import_type');
  }
  // The registry's own names are read too.
  assert.equal(IMPORT_TYPE_TYPES.plate, 'build_plate');
  assert.equal(classifyEstimateType({ import_type: 'part', name_en: 'Heatbed - A1' }).type_key, 'electronics_part');
  // The pack subtype applies to filament only.
  assert.equal(classifyEstimateType({ import_type: 'accessory', import_subtype: 'pack' }).type_key, 'accessory');
});

test('electronics keywords: a part that is an electronic part, not one that houses one', () => {
  for (const name of [
    'AMS lite Mainboard',
    'AP Board - X1 Series',
    'MC Board',
    'TH Board - P1 Series',
    'AMS Internal Hub Motor',
    'Screen - X1 Series',
    'Display Connector Flex Cable - X1 Series',
    'Chamber Camera - X1 Series',
    'Power Supply 350W - X1 Series',
    'Laser Module 10W',
    'Heatbed - A1',
    'Cooling Fan for Hotend - X1C',
    'Filament Runout Sensors',
    'Bambu Bus Cable',
    'Door Switch',
    'Ceramic Heater 3 pcs - X1C',
    // The rest of the owner's list: boards, LEDs and lights, antennas, buttons, sockets and ports,
    // touchscreens, lidar, thermistors, harnesses and cords, the filament buffer.
    'AMS RFID Board',
    'LED Light - X1 Series',
    'Top Chamber LED',
    'WiFi Antenna - H2 Series',
    'Start/Pause Button',
    'Power Socket',
    'USB Port Assembly - P2S',
    'Touchscreen - H2 Series',
    'Bambu Micro Lidar (Dual Red Laser) - X1 Series',
    'Thermistor 3 pcs - X1C',
    'Wiring Harness Pack - R1',
    'AMS HT AC Power Cord',
    'Filament Buffer',
    // The head decides: a lid sensor is a sensor; a word in brackets counts when the head says neither.
    'AMS HT Lid Status Hall Sensor',
    'AMS Feeder Unit (Hall)',
    'Dual Extruder Idlers and Filament Sensor',
    'Ceramic Heater & Thermistor 3 pcs - P1 Series',
    'Hotend Heating Assembly – A1 Series', // an en dash before the model
  ]) {
    assert.equal(isElectronicsName(name), true, name);
  }
  for (const name of [
    'Hotend Fan Cover',
    'X-axis Motor Cover',
    'Heatbed Nozzle Wiper - A1 mini',
    'Cable Chain Assembly',
    'Camera Bracket',
    'Fan Duct - P1 Series',
    'AMS lite Housing Assembly',
    'PTFE Tube',
    'Fanatic Sticker',
    '',
    // What only houses, carries or cools an electronic part, whatever word comes first.
    'P1S Heatsink for MC Board',
    'Extruder Switch Cam',
    'Filament Sensor Base - A1 Series',
    'Ventilation Fan Mounting Base - R1',
    'Heatbed Surface Magnet (with Cutout) - P1P',
    'Motor Drive Pulley - X1 Series and P1 Series',
    'AC Board Cover - H2 Series',
    'Top Chamber LED Cover',
    'Part Cooling Fan Air Duct',
    'Screen Rear Housing with Hinge - P2S',
    'Smoke Purifier Air Filter',
    'Vision Encoder',
  ]) {
    assert.equal(isElectronicsName(name), false, name);
  }
});

test('™ and ® are dropped after the name is trimmed, in the capture’s order (partCore)', () => {
  // "™ - Fan" is trimmed first and then loses its sign: " - Fan", whose part before the dash is empty.
  for (const name of ['™ - Fan', '® -Fan', ' ™ - Fan', '™™ - LED']) assert.equal(isElectronicsName(name), false, name);
  for (const name of ['™- Fan', '™ Fan', 'Fan ™', 'Fan™ - X1', 'Bambu™ Mainboard® – X1']) assert.equal(isElectronicsName(name), true, name);
});

test('the owner’s rule as the EU capture records it: real manifest names, both ways', () => {
  // Spare parts the EU capture sources from the EU store (eu-store-2026-10-31, or its rule on the
  // rest of the manifest): electronic parts, never China.
  const parts = [
    '4-pin & 8-pin Extension Board - R1', '4-pin/6-pin Connection Board - A2L', '4pin Interface Board', 'AC Board - A2L', 'AC Board - H2 Series',
    'AC Board - LV - P2S', 'AC Board - X1 Series and P1 Series', 'AC Board - X2D', 'Active Chamber Exhaust', 'Air Pump - R1',
    'AMS 2 Pro Heating Unit (Slot 1 and 2)', 'AMS 2 Pro Heating Unit (Slot 3 and 4)', 'AMS 2 Pro Power Board', 'AMS Connector Board',
    'AMS Feeder Unit (Hall)', 'AMS HT AC Power Cord', 'AMS HT Heating Unit', 'AMS HT Lid Status Hall Sensor', 'AMS HT Power Board',
    'AMS HT Power Socket', 'AMS HT RFID Coil', 'AMS Power Board', 'AMS RFID Board', 'Auxiliary Hotend Heating Assembly - Right - X2D',
    'Bambu Micro Lidar (Dual Red Laser) - X1 Series', 'Control Button Board - R1', 'Cutting Module Adapter Board - A2L', 'Emergency Stop Button',
    'Extruder Connection Board - H2D/H2C', 'Extruder Connection Board - P2S', 'Extruder Connection Board - X2D',
    'Extruder Interface Board - P1 Series', 'Extruder Interface Board V9 - X1C', 'Filament Buffer', 'Filament Buffer - H2 Series',
    'Filament Buffer - P2S', 'Filament Buffer - X2D', 'Filament Buffer Connection Board', 'H2 Status Indicator',
    'Hotend Heating Assembly - A1 Series', 'Hotend Heating Assembly - A2L', 'Hotend Heating Assembly - H2D and H2C', 'Hotend Heating Assembly - H2S',
    'Hotend Heating Assembly - Left - X2D', 'Hotend Heating Assembly - P2S', 'Hotend Heating Assembly Connection Board - X2D',
    'Induction Heating Assembly - Right', 'Induction Hotend Latch Actuator', 'Induction Hotend Rack Control Board', 'Laser Status Indicator',
    'Laser Tube Assembly - R1', 'LED Light - P1 Series', 'LED Light - P2S', 'LED Light - X1 Series', 'LED Lighting Kit - R1',
    'Power Filter & Protecter - R1', 'Power Safety Key Unit', 'Power Socket', 'Start/Pause Button', 'Thermistor 3 pcs - X1C',
    'Toolhead Board - A1 Series', 'Toolhead Board - A2L', 'Top Chamber LED', 'Touchscreen - H2 Series', 'USB Port Assembly - P2S', 'USB Port Board',
    'USB Port Board - R1', 'WiFi Antenna - H2 Series', 'WiFi Antenna - P1 Series and A1 mini', 'WiFi Antenna - R1', 'WiFi Antenna - X1 Series',
    'Wiring Harness Pack - R1',
  ];
  // Accessories it sources from the EU store: electronic devices, never China.
  const accessories = [
    'AMS Hub - A1 Series', 'Auto Fire Extinguishing System', 'Automatic Conveyor Feeder', 'Bambu Lab AMS Hub', 'Bambu Lab Purifier E1 Pro',
    'Cutting Upgrade Kit - H2 Series/A2L', 'External Exhaust Fan Bundle - X2D', 'External Exhaust Fan Kit - P2S', 'Filament Track Switch',
    'Laser Module', 'Laser Upgrade Kit', 'Mini Heat Press', 'SanDisk Ultra Fit USB 3.2 Flash Drive', 'Smoke Purifier',
    'Toolhead Enhanced Cooling Fan', 'USB‑C Soldering Iron Kit for Heat-Set Inserts', 'Vortek Upgrade Kit',
  ];
  // Mechanical parts it sources from China although an electronic word comes first: never EU.
  const mechanical = [
    'Extruder Switch Cam', 'Filament Sensor Base - A1 Series', 'Heatbed Surface Magnet (with Cutout) - P1P',
    'Heatbed Surface Magnet (without Cutout) - X1 Series and P1 Series', 'Motor Drive Pulley - X1 Series and P1 Series', 'P1S Heatsink for MC Board',
    'Ventilation Fan Mounting Base - R1',
  ];
  const typeOf = (import_type: string, name_en: string) => classifyEstimateType({ import_type, name_en });
  for (const name of parts) assert.deepEqual(typeOf('spare_part', name), { type_key: 'electronics_part', type_source: 'import_type', flags: [] }, name);
  for (const name of accessories) assert.deepEqual(typeOf('accessory', name), { type_key: 'electronics_device', type_source: 'import_type', flags: [] }, name);
  for (const name of mechanical) assert.equal(typeOf('spare_part', name).type_key, 'spare_part', name);
  for (const t of ['electronics_part', 'electronics_device'] as const) assert.equal(SEEDED_TYPE_SOURCING[t], 'EU_STORE_EUR');
  // Accessories that are not electronic stay accessories (China); the registry's `tool` is read the same way.
  for (const name of ['Smoke Purifier Air Filter', 'External Exhaust Air Filter', 'Vision Encoder - R1', 'LightGrip Cutting Mat', 'Print Finishing Kit', 'Glue Stick']) {
    assert.equal(typeOf('accessory', name).type_key, 'accessory', name);
  }
  assert.equal(typeOf('tool', 'Mini Heat Press').type_key, 'electronics_device');
  // Only spare parts and accessories are judged by name: a maker kit's LED stays a maker supply.
  assert.equal(typeOf('makers_supply', 'Halloween Pumpkin Light').type_key, 'makers_supply');
});

test('an owner type is any key the table holds; a key outside it, or malformed, passes to the next source', () => {
  assert.deepEqual(classifyEstimateType({ owner_type: 'resin', known_types: [...SEEDED_TYPE_KEYS, 'resin'] }), { type_key: 'resin', type_source: 'owner', flags: [] });
  assert.equal(classifyEstimateType({ owner_type: 'resin', known_types: SEEDED_TYPE_KEYS, import_type: 'filament' }).type_source, 'import_type');
  assert.equal(classifyEstimateType({ owner_type: 'Printer', import_type: 'printer' }).type_source, 'import_type');
  assert.equal(classifyEstimateType({ owner_type: 'x', import_type: 'printer' }).type_source, 'import_type');
  // A seeded key the table no longer holds is passed over the same way.
  assert.deepEqual(classifyEstimateType({ supplier_category: 'scanner', known_types: ['printer'] }), { type_key: null, type_source: '', flags: ['EST_TYPE_MISSING'] });
});
