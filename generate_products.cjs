const fs = require('fs');
let dataTs = fs.readFileSync('src/data.ts', 'utf8');

const newProducts = `
export const DUMMY_PRODUCTS: Product[] = [
  // Printers Category
  {
    id: '1',
    name: 'Levonis Pro X3',
    price: 1299.99,
    originalPrice: 1499.99,
    proPrice: 1199.99,
    image: 'https://images.unsplash.com/photo-1631558774020-f472ce7ab0b1?q=80&w=2940&auto=format&fit=crop',
    category: 'printers',
    stock: 12,
    description: 'A professional-grade 3D printer with high precision and large build volume. Ideal for complex industrial models and large-scale prototyping. Features an enclosed chamber and auto-leveling.',
    options: ['Standard Build Plate', 'PEI Magnetic Plate', 'Glass Bed'],
    colors: ['#2C3E50', '#E74C3C', '#ECF0F1'],
    features: ['Auto-leveling', 'Enclosed Chamber', 'High-speed printing', 'Wi-Fi connectivity'],
    availability: 'in_stock'
  },
  {
    id: '102',
    name: 'NanoPrint Lite',
    price: 199.99,
    originalPrice: 249.99,
    image: 'https://images.unsplash.com/photo-1572981779307-38b8cabb2407?q=80&w=2940&auto=format&fit=crop',
    category: 'printers',
    stock: 0,
    description: 'Compact and affordable 3D printer for beginners. Easy to set up and use right out of the box.',
    colors: ['#FFFFFF', '#000000', '#3498DB'],
    features: ['Plug and Play', 'Silent Motherboard', 'Compact Design'],
    availability: 'pre_order'
  },
  {
    id: '103',
    name: 'MegaForge Industrial',
    price: 4999.00,
    proPrice: 4750.00,
    image: 'https://images.unsplash.com/photo-1581092162384-8987c1d64718?q=80&w=2940&auto=format&fit=crop',
    category: 'printers',
    stock: 2,
    description: 'Massive scale 3D printer for industrial manufacturing. Dual extrusion capability.',
    options: ['Single Extruder', 'Dual Extruder', 'High-Temp Dual Extruder'],
    features: ['Massive Build Volume', 'Dual Extrusion', 'Industrial Grade'],
    availability: 'in_stock'
  },

  // Resins Category
  {
    id: '2',
    name: 'EcoResin Ultra Clear',
    price: 45.00,
    originalPrice: 55.00,
    proPrice: 40.00,
    image: 'https://images.unsplash.com/photo-1616851600880-77a88ca4d35e?q=80&w=2938&auto=format&fit=crop',
    category: 'resins',
    stock: 50,
    description: 'High-clarity, non-yellowing resin perfect for optical parts and transparent models. Plant-based and eco-friendly formulation with low odor.',
    colors: ['#transparent'],
    options: ['500g', '1KG', '5KG Bulk'],
    features: ['High Clarity', 'Eco-friendly', 'Low Odor', 'Fast Curing'],
    availability: 'in_stock'
  },
  {
    id: '202',
    name: 'ToughResin Pro',
    price: 65.00,
    proPrice: 58.50,
    image: 'https://images.unsplash.com/photo-1584916201218-f4242ceb4809?q=80&w=2940&auto=format&fit=crop',
    category: 'resins',
    stock: 120,
    description: 'Engineering-grade tough resin. Simulates ABS properties. High impact resistance.',
    colors: ['#808080', '#000000', '#FFFFFF', '#0000FF', '#FF0000'],
    options: ['1KG', '2KG'],
    features: ['High Impact Resistance', 'ABS-like', 'High Precision'],
    availability: 'in_stock'
  },
  {
    id: '203',
    name: 'Castable Wax Resin',
    price: 89.99,
    originalPrice: 99.99,
    image: 'https://images.unsplash.com/photo-1601004890684-d8cbf643f5f2?q=80&w=2940&auto=format&fit=crop',
    category: 'resins',
    stock: 0,
    description: 'Ideal for jewelry casting. Burns out cleanly with no ash.',
    options: ['500g'],
    features: ['Clean Burnout', 'High Detail', 'Wax-like Properties'],
    availability: 'pre_order'
  },

  // Filaments Category
  {
    id: '3',
    name: 'Carbon Fiber PLA',
    price: 35.50,
    originalPrice: 42.00,
    proPrice: 32.00,
    image: 'https://images.unsplash.com/photo-1620612265934-8b65cd31d457?q=80&w=2940&auto=format&fit=crop',
    category: 'filaments',
    stock: 100,
    description: 'Premium PLA infused with milled carbon fibers for increased rigidity and a beautiful matte black finish. Easy to print with standard brass nozzles.',
    colors: ['#1C1C1C'],
    options: ['1.75mm', '2.85mm'],
    features: ['High Rigidity', 'Matte Finish', 'Low Warping'],
    availability: 'in_stock'
  },
  {
    id: '302',
    name: 'Silk Silk PLA Rainbow',
    price: 28.99,
    originalPrice: 35.00,
    image: 'https://images.unsplash.com/photo-1563207153-f404bf02d69f?q=80&w=2940&auto=format&fit=crop',
    category: 'filaments',
    stock: 45,
    description: 'Beautiful multi-color transitions with a high-gloss silk finish. Perfect for decorative prints.',
    colors: ['#FF0000', '#00FF00', '#0000FF'],
    features: ['Glossy Finish', 'Color Changing', 'Easy to Print'],
    availability: 'in_stock'
  },
  {
    id: '303',
    name: 'Flexible TPU 95A',
    price: 32.00,
    proPrice: 28.80,
    image: 'https://images.unsplash.com/photo-1611077544955-408a688b1fc5?q=80&w=2940&auto=format&fit=crop',
    category: 'filaments',
    stock: 0,
    description: 'Highly flexible and durable filament for functional parts like phone cases and gaskets.',
    colors: ['#000000', '#FFFFFF', '#FF3366', '#33CCFF', '#FF9900'],
    options: ['1KG Spool'],
    features: ['High Flexibility', 'Durability', 'Chemical Resistance'],
    availability: 'pre_order'
  },

  // Parts Category
  {
    id: '4',
    name: 'Titanium Extruder Nozzle',
    price: 18.99,
    originalPrice: 24.99,
    proPrice: 15.99,
    image: 'https://images.unsplash.com/photo-1581092160562-40aa08e78837?q=80&w=2940&auto=format&fit=crop',
    category: 'parts',
    stock: 200,
    description: 'High-performance titanium alloy nozzle for abrasive materials. Offers superior thermal conductivity and extreme wear resistance for carbon fiber and glow-in-the-dark filaments.',
    options: ['0.2mm', '0.4mm', '0.6mm', '0.8mm'],
    features: ['Abrasion Resistant', 'Titanium Alloy', 'Superior Thermal Conductivity'],
    availability: 'in_stock'
  },
  {
    id: '402',
    name: 'Silent Stepper Motor Driver',
    price: 12.50,
    image: 'https://images.unsplash.com/photo-1606518172081-30cc8ebcb9d5?q=80&w=2940&auto=format&fit=crop',
    category: 'parts',
    stock: 80,
    description: 'TMC2209 silent stepper motor drivers for ultra-quiet 3D printing operation.',
    options: ['Single', 'Pack of 4', 'Pack of 5'],
    features: ['Ultra-Quiet', 'StallGuard', 'CoolStep'],
    availability: 'in_stock'
  },
  {
    id: '403',
    name: 'PEI Spring Steel Sheet',
    price: 35.00,
    originalPrice: 40.00,
    proPrice: 31.50,
    image: 'https://images.unsplash.com/photo-1602052577122-f73b9710adba?q=80&w=2940&auto=format&fit=crop',
    category: 'parts',
    stock: 0,
    description: 'Textured and smooth dual-sided PEI magnetic spring steel build plate. Excellent adhesion.',
    options: ['235x235mm', '310x310mm', '350x350mm'],
    features: ['Dual-sided', 'Magnetic', 'Excellent Adhesion', 'Easy Part Removal'],
    availability: 'pre_order'
  },
  {
    id: '404',
    name: 'Smart Filament Sensor',
    price: 25.00,
    image: 'https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=2940&auto=format&fit=crop',
    category: 'parts',
    stock: 15,
    description: 'Detects filament runout and tangles to pause prints safely.',
    features: ['Runout Detection', 'Tangle Detection', 'Universal Compatibility'],
    availability: 'in_stock'
  }
];
`;

dataTs = dataTs.replace(/export const DUMMY_PRODUCTS: Product\[\] = \[[\s\S]*?\];/, newProducts.trim());
fs.writeFileSync('src/data.ts', dataTs);
