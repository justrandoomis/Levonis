"""P0 DRAFT of the spec-key registry (input to step 4's packages/catalog/src/bambuImport/registry/specKeys.ts).

Only canonical key, group and English synonyms live here; the ar/ckb labels are authored in step 4 with the
app's vocabulary (spec §C.6, §C.8). Coverage in P0 = label occurrences whose normalised text matches a synonym.
"""
import re

# key, group, synonyms (normalised by norm() below), expected-for types
R = [
    # ---- identity / appearance / composition (all types)
    ('appearance.color', 'physical', ['color', 'colour', 'colors', 'light color', 'led color', 'color(s)'], ['part', 'accessory', 'makers', 'laser_material']),
    ('part.material', 'material', ['materials', 'material', 'material type', 'product material', 'housing material', 'shell material',
                                   'case material', 'outer material', 'front material', 'back material', 'blade material', 'cage material',
                                   'inner & outer ring material', 'wire material', 'contact material', 'pad material', 'buckle material',
                                   'lanyard material', 'material of pin needle', 'material of magnet', 'insulating material', 'gear set material',
                                   'chassis', 'chassis & shell', 'outer frame', 'build plate material'], ['part', 'accessory', 'makers', 'laser_material']),
    ('identity.part_code', 'identity', ['product id', 'item number', 'sku', 'model', 'product model', 'item no', 'part number'], []),
    ('identity.product_name', 'identity', ['product name', 'name', 'item name', 'component', 'item', 'brand name', 'product type', 'type', 'style', 'description'], []),
    ('contents.quantity', 'contents', ['quantity', 'quantity pcs', 'quantities', 'qty', 'pieces', 'cells', 'number of leds', 'led board quantity'], []),
    ('package.contents', 'contents', ["what's in the box", 'in the box', 'package contents', 'packing list'], []),
    ('surface.treatment', 'physical', ['surface treatment', 'surface type', 'finish'], []),
    # ---- logistics (B.7)
    ('package.size', 'logistics', ['packaging size', 'package size', 'packing size', 'package dimensions', 'packaging dimensions', 'box size'], ['part', 'accessory']),
    ('package.weight', 'logistics', ['packaging weight', 'package weight', 'packing weight'], ['part', 'accessory']),
    ('product.dimensions', 'physical', ['product dimension', 'product dimensions', 'product size', 'dimensions', 'dimension', 'size',
                                         'physical dimensions', 'item length', 'length', 'width', 'w width', 'height', 'diameter',
                                         'd diameter', 'outer diameter', 'ring size', 'size working led width', 'charger board size',
                                         'l shaft length', 'h', 'm', 'y', 'l', 'a0', 'a1', 'le stroke length', 'l0 retracted length',
                                         'l1 extended length', 'hole distance', 'screen size', 'spool dimension'], ['printer', 'ams']),
    ('product.net_weight', 'physical', ['net weight', 'weight', 'product weight', 'item weight', 'lanyard weight'], ['printer', 'ams']),
    ('shipment.gross_weight', 'logistics', ['gross weight'], []),
    ('physical.thickness', 'physical', ['thickness', 'blade thickness'], ['laser_material']),
    ('physical.volume', 'physical', ['volume', 'capacity'], []),
    ('physical.grammage', 'physical', ['grammage'], []),
    # ---- printers: printing / motion / extrusion / thermal
    ('printing.technology', 'printing', ['printing technology'], ['printer']),
    ('printing.build_volume', 'printing', ['build volume', 'build volume w*d*h', 'print volume', 'printing volume', 'usable print size'], ['printer']),
    ('motion.max_speed', 'motion', ['max speed of toolhead', 'max speed of tool head', 'max print speed', 'max speed'], ['printer']),
    ('motion.max_acceleration', 'motion', ['max acceleration of toolhead', 'max acceleration of tool head', 'max acceleration'], ['printer']),
    ('motion.xy_accuracy', 'motion', ['xy positioning accuracy'], []),
    ('motion.z_measuring', 'motion', ['z height measuring method', 'z height measuring accuracy'], []),
    ('extrusion.hotend', 'extrusion', ['hot end', 'hotend'], ['printer']),
    ('extrusion.nozzle', 'extrusion', ['nozzle', 'nozzle material'], ['printer']),
    ('extrusion.max_nozzle_temp', 'extrusion', ['max hot end temperature', 'max nozzle temperature', 'max. printing temp.', 'max printing temp',
                                                  'max printing temperature'], ['printer']),
    ('extrusion.nozzle_diameter_included', 'extrusion', ['included nozzle diameter'], ['printer']),
    ('extrusion.nozzle_diameter_supported', 'extrusion', ['supported nozzle diameter', 'nozzle diameter'], ['printer', 'hotend']),
    ('extrusion.filament_diameter', 'extrusion', ['filament diameter', 'supported filament diameter'], ['printer', 'ams']),
    ('extrusion.extruder_gear', 'extrusion', ['extruder gear'], []),
    ('extrusion.extruder_motor', 'extrusion', ['extruder motor'], []),
    ('extrusion.max_flow', 'extrusion', ['max flow for hotend', 'max flow for hotend standard flow hotend', 'max flow for hotend optional high flow hotend'], []),
    ('thermal.max_bed_temp', 'thermal', ['max build plate temperature', 'max heatbed temperature', 'max heated bed temperature'], ['printer']),
    ('thermal.chamber_temp', 'thermal', ['active chamber heating', 'chamber temperature', 'max chamber temperature'], ['printer']),
    ('thermal.max_temp', 'thermal', ['max temperature', 'maximum temperature', 'highest temperature', 'temperature', 'surface temperature resistance',
                                     'heating power'], []),
    ('thermal.cooling', 'thermal', ['part cooling fan', 'cooling fan for hotend', 'auxiliary part cooling fan', 'main control board fan',
                                    'chamber exhaust fan', 'chamber heat circulation fan'], []),
    ('printing.build_plate', 'printing', ['build plate', 'supported build plate type', 'included build plate type'], ['printer']),
    ('printing.supported_filament', 'compat', ['supported filament', 'filament supported', 'supported filaments', 'supported material type',
                                               'supported filament*1', 'filament not supported', 'not recommended filament*2',
                                               'unsupported filament*3', 'unsupported filament', 'pla, petg, tpu, pva',
                                               'abs, asa, pc, pa, pet, carbon/glass fiber reinforced polymer'], ['printer', 'ams', 'hotend', 'plate']),
    ('printing.slicer', 'connectivity', ['slicer', 'slicer & software', 'supported operating system'], []),
    # ---- sensors / features
    ('sensors.filament_runout', 'printing', ['filament run out sensor'], []),
    ('sensors.filament_odometry', 'printing', ['filament odometry'], []),
    ('sensors.filament_tangle', 'printing', ['filament tangle sensor'], []),
    ('sensors.door', 'printing', ['door sensor'], []),
    ('sensors.camera', 'printing', ['live view camera', 'birdseye camera', 'toolhead camera', 'chamber monitoring camera', 'nozzle camera', 'camera',
                                     'monitoring camera'], []),
    ('printing.power_loss_recovery', 'printing', ['power loss recovery', 'power loss recover'], []),
    ('printing.filament_cutter', 'printing', ['filament cutter'], []),
    ('safety.filtration', 'safety', ['activated carbon filter type', 'voc filtration', 'particulate matter filtration', 'pre-filter grade', 'hepa filter grade'], []),
    ('safety.flame_retardant', 'safety', ['flame retardant grade', 'flame detection'], []),
    # ---- electronics / connectivity
    ('electrical.voltage', 'electrical', ['voltage', 'input voltage', 'rated voltage', 'operating voltage', 'nominal voltage', 'voltage / operation voltage',
                                          'rated input voltage', 'maximum voltage', 'overcharge voltage', 'overdischarge protection voltage', 'input', 'output',
                                          'electricity'], ['printer']),
    ('electrical.current', 'electrical', ['current', 'rated current', 'maximum current', 'no load current', 'stall current', 'standby current',
                                          'charging current', 'max continuous discharge current', 'overcurrent protection'], []),
    ('electrical.power', 'electrical', ['power', 'max power', 'rated output power', 'max output power', 'average power', 'pla steady-state power',
                                        'power supply'], ['printer']),
    ('electrical.frequency', 'electrical', ['rated input frequency', 'frequency'], []),
    ('electrical.connector', 'electrical', ['connector', 'connector model', 'input connector type', 'output connector type', 'plug', 'pin type',
                                            'usb-c output', 'usb-a output'], ['makers']),
    ('electrical.wire_gauge', 'electrical', ['wire gauge size'], []),
    ('electrical.cable_length', 'electrical', ['cable length'], []),
    ('electrical.battery', 'electrical', ['battery type', 'nominal capacity'], []),
    ('motor.speed', 'mechanical', ['rated speed', 'no load speed', 'no-load speed', 'speed range'], []),
    ('motor.torque', 'mechanical', ['locked-rotor torque', 'rated torque', 'stall torque', 'rated load', 'force'], []),
    ('motor.rotation', 'mechanical', ['rotating direction', 'direction of rotation', 'output shaft type', 'output shaft', 'output shaft 1', 'output shaft 2',
                                      'operating travel angle', 'motor type', 'reduction ratio', 'gear ratio', 'position of motor'], []),
    ('connectivity.wifi', 'connectivity', ['wi-fi protocol', 'wireless network', 'operating frequency', 'wi-fi transmitter power eirp', 'wi-fi transmitter power (eirp)'], ['printer']),
    ('connectivity.interface', 'connectivity', ['control interface', 'touchscreen', 'display', 'display screen', 'screen', 'screen resolution', 'storage',
                                                 'ethernet', 'network kill switch', 'removable network module', '802.1x network access control'], ['printer']),
    ('connectivity.compute', 'connectivity', ['core', 'neural processing unit', 'motion controller', 'application processor', 'chip type'], []),
    ('environment.operating_temp', 'other', ['working temperature', 'operating temperature', 'operation temperature', 'operating temperature range',
                                             'device operating temperature', 'display operating temperature', 'storage temperature',
                                             'storage temperature range', 'temperature range'], []),
    ('environment.ip_rating', 'other', ['international protection rating', 'waterproof'], []),
    ('fan.airflow', 'mechanical', ['max air flow', 'air flow at zero static pressure', 'noise'], []),
    ('lifetime.expected', 'other', ['expected life', 'working life', 'aging-resistance', 'data retention', 'read durability'], []),
    # ---- hardware (Maker's Supply)
    ('hardware.screw_type', 'mechanical', ['screw type', 'thread ridge type', 'mounting hole shape', 'end shape', 'fastener type', 'stud shape', 'stud type',
                                            'knurling type', 'mount type', 'teeth type'], []),
    ('hardware.bearing', 'mechanical', ['bearing type', 'bearing construction', 'ball bearing profile', 'ball type'], []),
    ('hardware.magnet', 'mechanical', ['magnet grade', 'direction of magnetization', 'magnetic control distance', 'adhesion'], []),
    ('hardware.hardness', 'mechanical', ['hardness'], []),
    ('hardware.gear', 'mechanical', ['pinion gear', 'spur gear', 'double-layer gear 1', 'double-layer gear 2', 'safety gear', 'set screw', 'smooth shaft',
                                     'knurled shaft'], []),
    # ---- laser / cutting machines and materials
    ('laser.type', 'printing', ['laser type', 'laser wavelength', 'laser power', 'laser spot dimension', 'laser safety class for laser module',
                                'overall laser safety class', 'overall laser safety class*', 'laser safety windows', 'air assist pump',
                                'laser module installation detection', 'safety key', 'temperature detection'], ['laser_machine']),
    ('laser.work_area', 'printing', ['engraving area', 'cutting area', 'drawing area', 'max engraving speed', 'max cutting thickness'], ['laser_machine']),
    ('cutting.blade', 'printing', ['blade type', 'blade pressure range', 'blade and pen recognition', 'cutting mat type', 'cutting mat type detection',
                                   'supported pen diameter', 'blade length', 'cutting mode', 'cutting mat'], []),
    ('laser.material_processing', 'material', ['processing mode', 'proccessing mode', 'processing mode and essential accessories', 'application',
                                                'recommended use', 'function'], ['laser_material']),
    ('laser.ventilation', 'safety', ['ventilation pipe adapter outer diameter'], []),
    ('laser.image_types', 'connectivity', ['supported image type'], []),
    # ---- AMS
    ('ams.spool_size', 'compat', ['supported spool size', 'supported spool size*', 'spool dimension'], ['ams']),
    ('ams.rfid', 'printing', ['rfid identification'], []),
    ('ams.drying', 'drying', ['drying', 'highest temperature', 'drying temperature'], []),
    # ---- misc sensors and lighting
    ('lighting.color_temperature', 'other', ['color temperature', 'light source type'], []),
    ('sensor.type', 'other', ['sensor type', 'resistor', 'range', 'temperature measurement range', 'temperature accuracy', 'humidity measurement range',
                              'humidity accuracy', 'output signal type', 'output channel'], []),
    ('camera.optics', 'other', ['fov', 'resolution ratio', 'fn', 'frame rate', 'most effective pixels', 'video format', 'dynamic range', 'focusing',
                                'focusing distance'], []),
    ('nfc.chip', 'other', ['read range'], []),
    ('remote.distance', 'other', ['remote control distance'], []),
    ('compat.applicable', 'compat', ['applicable to', 'compatibility', 'compatible printer', 'compatible with', 'fit for light size', 'bit compatibility'], []),
]

EXPECTED_COUNT = {'printer': 22, 'ams': 10, 'laser_machine': 12, 'filament': 16, 'hotend': 6, 'build_plate': 6,
                  'accessory': 4, 'spare_part': 4, 'laser_material': 5, 'makers_supply': 4}


def norm(s):
    s = (s or '').lower().replace('（', '(').replace('）', ')').replace('\n', ' ')
    s = re.sub(r'[¹²³*]+', '', s)
    s = re.sub(r'\((?:mm|cm|m|g|kg|lb|v|a|ma|w|k|rpm|pcs|g\*cm|db-a|cfm|in)\)', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip().strip(':').strip()
    return s


INDEX = {}
for key, group, syns, applies in R:
    for sy in syns:
        INDEX.setdefault(norm(sy), (key, group))


def lookup(label):
    n = norm(label)
    if n in INDEX:
        return INDEX[n]
    n2 = re.sub(r'\s*\(.*?\)\s*', ' ', n).strip()
    if n2 in INDEX:
        return INDEX[n2]
    return None


def slug(label):
    return 'x.' + re.sub(r'[^a-z0-9]+', '_', norm(label)).strip('_')[:60]
