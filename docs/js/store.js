/**
 * Client-side state: an offline-first cache, a cart, an outbox and the sync
 * loop that keeps this browser and every other device on the same data.
 *
 * Everything a shop needs to keep selling lives in localStorage, so a dropped
 * connection or a closed tab never loses a sale.
 */

import api, { ApiError, getBase, hasBase, getToken, getTokenMeta, isTokenExpired, setToken } from './api.js';
import { num, round2, uuid, sortBy } from './util.js';
import {
  openDB, dbInfo, dbGetAll, dbPutMany, dbPut, dbDelete, writeMeta, readMeta,
  migrateLegacyLocalStorage, appendAudit, takeSnapshot, exportDatabase, importDatabase,
  clearDatabase, listSnapshots, restoreSnapshot, planMigrations, readAuditMirror,
  listAudit, DB_VERSION,
} from './db.js';
import { normalizePayments, orderBalance, paymentStatus } from './payments.js';
import { ROLES, can as roleCan, authenticateLocal, localStaff, setLocalPin } from './roles.js';

const CACHE_KEY = 'dxn.cache.v2';
const CART_KEY = 'dxn.cart.v2';
const OUTBOX_KEY = 'dxn.outbox.v2';
const SESSION_KEY = 'dxn.session.v2';
const HELD_KEY = 'dxn.held.v3';
const THEME_KEY = 'dxn.theme.v3';
const ROLE_KEY = 'dxn.role.v1';
const CONFLICTS_KEY = 'dxn.conflicts.v1';

const POLL_MS = 15000;
const MAX_ORDERS = 400;

/**
 * Product photography bundled with the app so the catalogue looks right even
 * on the first offline launch. Files live in docs/images/products/ and the
 * original source URLs are recorded in docs/images/products/sources.json.
 */
export const PRODUCT_IMAGES = {
  'DXN-SOAP-GANO': 'images/products/ganozhi-beauty-soap.jpg',
  'DXN-ALOE-BAR-1': null,
  'DXN-ALOE-BAR-3': null,
  'DXN-NEEM-BAR-1': 'images/products/neem-bathing-bar.jpg',
  'DXN-NEEM-BAR-3': 'images/products/neem-bathing-bar.jpg',
  'DXN-SHAMPOO-GANO': 'images/products/ganozhi-shampoo.jpg',
  'DXN-NEEM-FACEWASH': 'images/products/neem-face-wash.jpg',
  'DXN-PAPAYA-SCRUB': 'images/products/papaya-facial-scrub.jpg',
  'DXN-APRICOT-SCRUB': null,
  'DXN-ALOE-SCRUB': 'images/products/aloe-facial-scrub.jpg',
  'DXN-ALOE-CLEANSING-JELLY': 'images/products/aloe-cleansing-gel.jpg',
  'DXN-TOOTHPASTE-120': 'images/products/ganozhi-toothpaste.jpg',
  'DXN-TOOTHPASTE-50': 'images/products/ganozhi-toothpaste.jpg',
  'DXN-TOOTHPASTE-IND-150': 'images/products/ganozhi-toothpaste.jpg',
  'DXN-TOOTHPASTE-IND-75': 'images/products/ganozhi-toothpaste.jpg',
  'DXN-TALCUM': 'images/products/talcum-powder.jpg',
  'DXN-SUNSCREEN-100': 'images/products/sun-screen-lotion.jpg',
  'DXN-BODY-LOTION': 'images/products/aloe-body-lotion.jpg',
  'DXN-BODY-SCRUB-200': 'images/products/body-scrub.jpg',
  'DXN-HAIR-OIL-100': 'images/products/hair-oil.jpg',
  'DXN-HAIR-PACK-20X5': null,
  'DXN-RISHI-GANO-TEA-200': 'images/products/rishi-gano-tea.jpg',
  'DXN-MASALA-TEA-100': 'images/products/masala-tea.jpg',
  'DXN-LZC-BLACK-20': 'images/products/lingzhi-black-coffee.jpg',
  'DXN-LZC-3IN1-20': 'images/products/lingzhi-coffee-3in1.jpg',
  'DXN-LZC-LITE-20': 'images/products/lingzhi-coffee-lite.jpg',
  'DXN-WHITE-COFFEE-20': 'images/products/white-coffee.jpg',
  'DXN-ZHI-MOCHA-20': 'images/products/zhi-mocha-premium.jpg',
  'DXN-EU-CAFE-20': 'images/products/eu-cafe.jpg',
  'DXN-VITA-CAFE-20': 'images/products/vita-cafe.jpg',
  'DXN-CORDYCEPS-COFFEE-20': 'images/products/cordyceps-coffee.jpg',
  'DXN-LIONS-MANE-COFFEE-20': 'images/products/lions-mane-coffee.jpg',
  'DXN-COCOZHI-500': 'images/products/cocozhi.jpg',
  'DXN-SPIRULINA-CEREAL-500': 'images/products/spirulina-cereal.jpg',
  'DXN-CORDYCEPS-CEREAL-500': 'images/products/cordyceps-cereal.jpg',
  'DXN-LEMONZHI-500': 'images/products/lemonzhi.jpg',
  'DXN-ZHI-YOBITE-30': 'images/products/zhi-yobite.jpg',
  'DXN-LINA-YOBITE-30': 'images/products/lina-yobite.jpg',
  'DXN-APPLE-ENZYME-750': 'images/products/apple-enzyme.jpg',
  'DXN-APPLE-JAM-300': 'images/products/apple-jam.jpg',
  'DXN-LIONS-MANE-OOCHA': 'images/products/lions-mane-ooocha.jpg',
  'DXN-LIONS-MANE-MATCHA': 'images/products/lions-mane-lemon-matcha.jpg',
  'DXN-SPIRUDLE-PLAIN': 'images/products/spirudle.jpg',
  'DXN-GOJI-BERRY': 'images/products/goji-berry.jpg',
  'DXN-OOCHA-NOODLES': 'images/products/oocha-noodles.jpg',
  'DXN-OOCHA-NOODLES-TYF': 'images/products/oocha-noodles-tyf.jpg',
  'DXN-VEGGIE-NOODLE': 'images/products/veggie-noodle.jpg',
  'DXN-RG-POWDER-50': 'images/products/rg-powder-50.jpg',
  'DXN-GL-POWDER-80': 'images/products/gl-powder-80.jpg',
  'DXN-CORDYCEPS-POWDER-30': 'images/products/cordyceps-powder-30.jpg',
  'DXN-LIONS-MANE-POWDER-30': 'images/products/lions-mane-powder-30.jpg',
};

const PRODUCT_DESCRIPTIONS = {
  'DXN-SOAP-GANO': 'Ganozhi translucent beauty soap with Ganoderma extract and moisturisers.',
  'DXN-ALOE-BAR-1': 'Aloe vera bathing bar that cleanses gently while keeping skin soft and hydrated.',
  'DXN-ALOE-BAR-3': 'Three-bar family pack of the aloe vera bathing bar.',
  'DXN-NEEM-BAR-1': 'Neem bathing bar with natural neem extract for everyday skin care.',
  'DXN-NEEM-BAR-3': 'Three-bar family pack of the neem bathing bar.',
  'DXN-SHAMPOO-GANO': 'Ganozhi nourishing shampoo with Ganoderma extract for soft, healthy-looking hair.',
  'DXN-NEEM-FACEWASH': 'Gentle neem face wash that clears oil and impurities without drying the skin.',
  'DXN-PAPAYA-SCRUB': 'Papaya facial scrub that lifts dead skin for a fresher, brighter face.',
  'DXN-APRICOT-SCRUB': 'Apricot facial scrub with fine granules to smooth and refresh the skin.',
  'DXN-ALOE-SCRUB': 'Aloe vera facial scrub for gentle exfoliation and soft, calm skin.',
  'DXN-ALOE-CLEANSING-JELLY': 'Aloe vera cleansing jelly that removes make-up and daily grime gently.',
  'DXN-TOOTHPASTE-120': 'Ganozhi toothpaste with Ganoderma extract for everyday oral care. 150g tube.',
  'DXN-TOOTHPASTE-50': 'Travel-size 50g tube of Ganozhi toothpaste.',
  'DXN-TOOTHPASTE-IND-150': 'Indian-made 150g Ganozhi toothpaste tube.',
  'DXN-TOOTHPASTE-IND-75': 'Indian-made 75g Ganozhi toothpaste tube.',
  'DXN-TALCUM': 'DXN talcum powder that keeps skin fresh, dry and comfortable.',
  'DXN-SUNSCREEN-100': 'Daily sun screen lotion for light, non-greasy protection outdoors.',
  'DXN-BODY-LOTION': 'Aloe vera hand and body lotion that moisturises without a greasy feel.',
  'DXN-BODY-SCRUB-200': 'Body scrub with natural exfoliating grains for smooth, refreshed skin.',
  'DXN-HAIR-OIL-100': 'Herbal hair oil that helps reduce hair fall and nourish the scalp.',
  'DXN-HAIR-PACK-20X5': 'Nourishing hair pack sachets for a weekly deep-conditioning treatment.',
  'DXN-RISHI-GANO-TEA-200': 'Premium herbal tea blending ginseng and Ganoderma extract.',
  'DXN-MASALA-TEA-100': 'Aromatic spiced masala tea blend for a warming cup.',
  'DXN-LZC-BLACK-20': 'DXN Lingzhi Black Coffee with Ganoderma extract. 20 sachets.',
  'DXN-LZC-3IN1-20': 'The classic DXN coffee: premium instant coffee blended with Ganoderma lucidum extract, sugar and non-dairy creamer. 20 sachets.',
  'DXN-LZC-LITE-20': 'A lighter, creamier Lingzhi coffee with reduced sugar for an everyday cup.',
  'DXN-WHITE-COFFEE-20': 'Smooth white coffee with Ganoderma extract and a creamy finish.',
  'DXN-ZHI-MOCHA-20': 'A rich mocha blend of coffee, cocoa and Ganoderma extract for a cafe-style cup at home.',
  'DXN-EU-CAFE-20': 'Smooth European-style instant coffee enriched with Ganoderma extract.',
  'DXN-VITA-CAFE-20': 'Six-in-one coffee blend with ginseng, tongkat ali and Ganoderma extract.',
  'DXN-CORDYCEPS-COFFEE-20': 'Instant coffee blended with cordyceps extract, creamer and cane sugar.',
  'DXN-LIONS-MANE-COFFEE-20': 'Coffee enriched with lion\'s mane mushroom extract for a smooth, earthy cup.',
  'DXN-COCOZHI-500': 'Healthy cocoa drink with Ganoderma extract, 20 sachets of 25g.',
  'DXN-SPIRULINA-CEREAL-500': 'Nutritious spirulina cereal drink mix, 20 sachets of 25g.',
  'DXN-CORDYCEPS-CEREAL-500': 'Cordyceps cereal drink mix, 20 sachets of 25g.',
  'DXN-LEMONZHI-500': 'Refreshing lemon and Ganoderma drink mix, 25 sachets of 20g.',
  'DXN-ZHI-YOBITE-30': 'Oat-based nutritious drink mix from DXN. 30g pack.',
  'DXN-LINA-YOBITE-30': 'Oat-based nutritious drink mix from DXN. 30g pack.',
  'DXN-APPLE-ENZYME-750': 'Fermented apple enzyme drink for digestion and daily wellbeing. 750ml.',
  'DXN-APPLE-JAM-300': 'Apple jam made from fermented apples, 300g jar.',
  'DXN-LIONS-MANE-OOCHA': 'Oocha green tea blend with lion\'s mane mushroom extract.',
  'DXN-LIONS-MANE-MATCHA': 'Lemon matcha drink with lion\'s mane mushroom extract.',
  'DXN-SPIRUDLE-PLAIN': 'Spirulina noodle made without artificial colouring.',
  'DXN-GOJI-BERRY': 'Dried goji berries, a naturally sweet source of antioxidants.',
  'DXN-OOCHA-NOODLES': 'Oocha noodles made with nutritious ingredients for a quick meal.',
  'DXN-OOCHA-NOODLES-TYF': 'Oocha noodles in Tom Yam flavour.',
  'DXN-VEGGIE-NOODLE': 'Vegetable noodle from DXN, quick to cook and light to eat.',
  'DXN-RG-POWDER-50': 'Reishi Gano (RG) Ganoderma lucidum mushroom powder, 50g.',
  'DXN-GL-POWDER-80': 'Ganocelium (GL) Ganoderma mycelium powder, 80g.',
  'DXN-CORDYCEPS-POWDER-30': 'Cordyceps mushroom powder, 30g.',
  'DXN-LIONS-MANE-POWDER-30': 'Lion\'s mane mushroom powder, 30g.',
};

/** Shown on a cold start so the shop is never staring at an empty screen. */
const SEED_PRODUCTS = [
  ['DXN-SOAP-GANO', 'Ganozhi Soap 75g', 'Personal Care', 470, 390, 65, 0],
  ['DXN-ALOE-BAR-1', 'Aloe Vera Bathing Bar (100g)', 'Personal Care', 185, 155, 35, 0],
  ['DXN-ALOE-BAR-3', 'Aloe Vera Bathing Bar (Family Pack, 3x100g)', 'Personal Care', 490, 410, 95, 0],
  ['DXN-NEEM-BAR-1', 'Neem Bathing Bar (100g)', 'Personal Care', 210, 175, 35, 0],
  ['DXN-NEEM-BAR-3', 'Neem Bathing Bar (Family Pack, 3x100g)', 'Personal Care', 490, 410, 95, 0],
  ['DXN-SHAMPOO-GANO', 'Ganozhi Shampoo 200ml', 'Personal Care', 440, 365, 65, 0],
  ['DXN-NEEM-FACEWASH', 'Neem Face Wash 100ml', 'Personal Care', 230, 190, 45, 0],
  ['DXN-PAPAYA-SCRUB', 'Papaya Facial Scrub 100ml', 'Personal Care', 280, 235, 55, 0],
  ['DXN-APRICOT-SCRUB', 'Apricot Facial Scrub 100ml', 'Personal Care', 280, 235, 55, 0],
  ['DXN-ALOE-SCRUB', 'Aloe Vera Facial Scrub 100ml', 'Personal Care', 1400, 1165, 190, 0],
  ['DXN-ALOE-CLEANSING-JELLY', 'Aloe Vera Cleansing Jelly', 'Personal Care', 1310, 1090, 145, 0],
  ['DXN-TOOTHPASTE-120', 'Ganozhi Toothpaste (Malaysian) 150g', 'Personal Care', 1000, 835, 110, 0],
  ['DXN-TOOTHPASTE-50', 'Ganozhi Toothpaste (Malaysian) 50g', 'Personal Care', 640, 535, 70, 0],
  ['DXN-TOOTHPASTE-IND-150', 'Ganozhi Toothpaste (Indian) 150g', 'Personal Care', 840, 700, 135, 0],
  ['DXN-TOOTHPASTE-IND-75', 'Ganozhi Toothpaste (Indian) 75g', 'Personal Care', 565, 470, 85, 0],
  ['DXN-TALCUM', 'Talcum Powder', 'Personal Care', 1430, 1190, 225, 0],
  ['DXN-SUNSCREEN-100', 'Sun Screen Lotion 100ml', 'Personal Care', 295, 245, 35, 0],
  ['DXN-BODY-LOTION', 'Aloe Vera Body Lotion', 'Personal Care', 1530, 1275, 180, 0],
  ['DXN-BODY-SCRUB-200', 'Body Scrub 200g', 'Personal Care', 540, 450, 90, 0],
  ['DXN-HAIR-OIL-100', 'Hair Oil 100ml', 'Personal Care', 710, 590, 135, 0],
  ['DXN-HAIR-PACK-20X5', 'Hair Pack (20g x 5)', 'Personal Care', 290, 240, 45, 0],
  ['DXN-RISHI-GANO-TEA-200', 'Rishi Gano Tea 200g', 'Coffee & Tea', 545, 455, 90, 0],
  ['DXN-MASALA-TEA-100', 'Masala Tea 100g', 'Coffee & Tea', 300, 250, 60, 0],
  ['DXN-LZC-BLACK-20', 'Lingzhi Black Coffee (5g x 20)', 'Coffee & Tea', 1190, 990, 350, 0],
  ['DXN-LZC-3IN1-20', 'Lingzhi Coffee 3-in-1', 'Coffee & Tea', 2460, 2050, 475, 0],
  ['DXN-LZC-LITE-20', 'Lingzhi Coffee 3-in-1 Lite', 'Coffee & Tea', 2370, 1975, 365, 0],
  ['DXN-WHITE-COFFEE-20', 'White Coffee Zhino', 'Coffee & Tea', 2550, 2125, 290, 0],
  ['DXN-ZHI-MOCHA-20', 'Zhi Mocha Coffee', 'Coffee & Tea', 1510, 1260, 290, 0],
  ['DXN-EU-CAFE-20', 'Eu Cafe', 'Coffee & Tea', 2140, 1785, 300, 0],
  ['DXN-VITA-CAFE-20', 'Vita Cafe', 'Coffee & Tea', 2460, 2050, 345, 0],
  ['DXN-CORDYCEPS-COFFEE-20', 'Cordyceps Coffee 3-in-1', 'Coffee & Tea', 2330, 1940, 450, 0],
  ['DXN-LIONS-MANE-COFFEE-20', 'Lion\'s Mane Coffee', 'Coffee & Tea', 2840, 2365, 390, 0],
  ['DXN-COCOZHI-500', 'Cocozhi 500g', 'Food & Drink', 2695, 2245, 525, 0],
  ['DXN-SPIRULINA-CEREAL-500', 'Spirulina Cereal 500g', 'Food & Drink', 3180, 2650, 540, 0],
  ['DXN-CORDYCEPS-CEREAL-500', 'Cordyceps Cereal 500g', 'Food & Drink', 4255, 3545, 825, 0],
  ['DXN-LEMONZHI-500', 'Lemonzhi 500g', 'Food & Drink', 895, 745, 175, 0],
  ['DXN-ZHI-YOBITE-30', 'Zhi Yobite 30g', 'Food & Drink', 840, 700, 125, 0],
  ['DXN-LINA-YOBITE-30', 'Lina Yobite 30g', 'Food & Drink', 840, 700, 125, 0],
  ['DXN-APPLE-ENZYME-750', 'Apple Enzyme Drink 750ml', 'Food & Drink', 4060, 3385, 570, 0],
  ['DXN-APPLE-JAM-300', 'Apple Fermented Jam 300g', 'Food & Drink', 1555, 1295, 225, 0],
  ['DXN-LIONS-MANE-OOCHA', 'Lion\'s Mane Oocha', 'Food & Drink', 2810, 2340, 395, 0],
  ['DXN-LIONS-MANE-MATCHA', 'Lion\'s Mane Lemon Matcha', 'Food & Drink', 2020, 1685, 305, 0],
  ['DXN-SPIRUDLE-PLAIN', 'Spirudle', 'Food & Drink', 1225, 1020, 190, 0],
  ['DXN-GOJI-BERRY', 'Goji Berry', 'Food & Drink', 4115, 3430, 625, 0],
  ['DXN-OOCHA-NOODLES', 'Oocha Noodles', 'Food & Drink', 1225, 1020, 175, 0],
  ['DXN-OOCHA-NOODLES-TYF', 'Oocha Noodles (TYF)', 'Food & Drink', 1915, 1595, 235, 0],
  ['DXN-VEGGIE-NOODLE', 'Veggie Noodle', 'Food & Drink', 1060, 885, 170, 0],
  ['DXN-RG-POWDER-50', 'RG Powder 50g', 'Supplements', 4145, 3455, 1070, 0],
  ['DXN-GL-POWDER-80', 'GL Powder 80g', 'Supplements', 3060, 2550, 770, 0],
  ['DXN-CORDYCEPS-POWDER-30', 'Cordyceps Powder 30g', 'Supplements', 3275, 2730, 960, 0],
  ['DXN-LIONS-MANE-POWDER-30', 'Lion\'s Mane Powder 30g', 'Supplements', 1680, 1400, 390, 0],
].map(([sku, name, category, retail, member, pv, stock], index) => ({
  id: index + 1,
  sku,
  name,
  category,
  description: PRODUCT_DESCRIPTIONS[sku] || null,
  retail_price: retail,
  member_price: member,
  pv_points: pv,
  stock_qty: stock || (index % 13 === 0 ? 2 : index % 17 === 0 ? 0 : 12 + (index * 11) % 50),
  low_stock_at: 5,
  image_url: PRODUCT_IMAGES[sku] || null,
  is_active: 1,
  created_at: null,
  updated_at: null,
  rev: 0,
}));

/** Fills in bundled artwork/descriptions when the server row has none. */
function decorateProduct(product) {
  if (!product) return product;
  return {
    ...product,
    image_url: product.image_url || PRODUCT_IMAGES[product.sku] || null,
    description: product.description || PRODUCT_DESCRIPTIONS[product.sku] || null,
  };
}

/** Absolute URL for a product photo, safe for API rows and bundled files. */
export function imageFor(product) {
  if (!product) return null;
  const raw = product.image_url || PRODUCT_IMAGES[product.sku] || null;
  if (!raw) return null;
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return raw;
  }
}

const DEFAULT_SETTINGS = {
  branch_name: 'Mohammadpur Stock Point',
  whatsapp_number: '8801939994578',
  currency: 'BDT',
  low_stock_threshold: 5,
  receipt_footer: 'Thank you for choosing Mohammadpur Stock Point. Wealth through health.',
  business_address: 'H # 1, R # 11, B # A, Chandrima Model Town, Dhaka-1207',
  business_phone: '01939994578',
  allow_public_orders: 1,
};

/** Placeholder profile shipped before the Mohammadpur rebrand. */
const LEGACY_SETTINGS = {
  branch_name: ['DXN Stockpoint', 'DXN Stockpoint Central'],
  whatsapp_number: ['8801987851131'],
  receipt_footer: ['Thank you for choosing DXN!', 'Thank you for choosing DXN. Wealth through health.'],
  business_address: [''],
  business_phone: [''],
};

/** Fills the new shop profile over untouched placeholder values only. */
function withDefaults(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  for (const [key, placeholders] of Object.entries(LEGACY_SETTINGS)) {
    if (placeholders.includes(String(merged[key] ?? ''))) merged[key] = DEFAULT_SETTINGS[key];
  }
  return merged;
}

export const state = {
  ready: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncState: 'idle', // idle | syncing | online | pending | offline | local | error
  syncError: '',
  lastSyncAt: 0,
  lastPush: 0,
  rev: 0,
  products: [],
  orders: [],
  customers: [],
  settings: { ...DEFAULT_SETTINGS },
  cart: [],
  sale: emptySale(),
  tier: 'retail',
  outbox: [],
  held: [],
  theme: 'light',
  isAdmin: false,
  isCustomer: false,
  customer: null,
  health: null,
  connected: false,
  // Enterprise additions
  role: 'VIEWER',
  staff: [],
  remoteStaff: [],
  conflicts: [],
  db: { available: false, version: 0, migrated: [], ready: false, error: '' },
  audit: [],
  checkout: { busy: false, id: '' },
  recentSkus: [],
  expenses: [],
};

function emptySale() {
  return {
    customer_id: null,
    customer_name: '',
    customer_phone: '',
    dxn_member_id: '',
    payment_method: 'CASH',
    payments: [],
    discount: 0,
    note: '',
    client_uuid: '',
    allow_credit: false,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // private mode or quota — the session keeps working in memory
  }
}

export function persistCache() {
  const payload = {
    rev: state.rev,
    products: state.products,
    orders: state.orders,
    customers: state.customers,
    expenses: state.expenses,
    conflicts: state.conflicts,
    settings: state.settings,
    savedAt: Date.now(),
  };
  write(CACHE_KEY, payload);
  mirrorCache(payload);
}

/**
 * Durable mirror. localStorage keeps the first paint instant; IndexedDB is the
 * transactional store of record. Writes are coalesced so a 200-line order does
 * not open 200 transactions.
 */
let mirrorTimer = 0;
let mirrorQueued = false;
function mirrorCache(payload) {
  if (!state.db.available) return;
  if (mirrorQueued) return;
  mirrorQueued = true;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(async () => {
    mirrorQueued = false;
    try {
      await dbPutMany('products', payload.products);
      await dbPutMany('orders', payload.orders);
      await dbPutMany('customers', payload.customers);
      await dbPutMany('expenses', payload.expenses || []);
      await dbPutMany('conflicts', (payload.conflicts || []).map((row) => ({ ...row, id: row.id || row.key })));
      await writeMeta('cache', { rev: payload.rev, savedAt: payload.savedAt, settings: payload.settings });
    } catch (error) {
      state.db.error = error.message;
    }
  }, 80);
}

export function persistCart() {
  write(CART_KEY, { cart: state.cart, sale: state.sale, tier: state.tier });
}

export function persistOutbox() {
  write(OUTBOX_KEY, state.outbox);
  if (state.db.available) {
    // Rewrite the durable outbox so a crash between writes cannot leave a
    // ghost queue entry. The queue is small (it drains on sync).
    (async () => {
      try {
        const existing = await dbGetAll('outbox');
        const keep = new Set(state.outbox.map((item) => item.id));
        for (const row of existing) if (!keep.has(row.id)) await dbDelete('outbox', row.id);
        await dbPutMany('outbox', state.outbox);
      } catch { /* the localStorage mirror still holds it */ }
    })();
  }
}

export function persistHeld() {
  write(HELD_KEY, state.held);
  if (state.db.available) {
    (async () => {
      try {
        const existing = await dbGetAll('held');
        const keep = new Set(state.held.map((item) => item.id));
        for (const row of existing) if (!keep.has(row.id)) await dbDelete('held', row.id);
        await dbPutMany('held', state.held);
      } catch { /* ignore */ }
    })();
  }
}

export function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* ignore */ }
  document.documentElement.dataset.theme = state.theme;
  notify();
}

export function holdSale(label = '') {
  if (!state.cart.length) return { ok: false, message: 'The cart is empty.' };
  const snapshot = {
    id: uuid(),
    label: (label || '').trim() || `Sale ${state.held.length + 1}`,
    createdAt: Date.now(),
    cart: JSON.parse(JSON.stringify(state.cart)),
    sale: { ...state.sale },
    tier: state.tier,
    totals: cartTotals(),
  };
  state.held.unshift(snapshot);
  state.held = state.held.slice(0, 12);
  persistHeld();
  clearCart();
  notify();
  return { ok: true, id: snapshot.id };
}

export function resumeHeld(id) {
  const index = state.held.findIndex((item) => item.id === id);
  if (index === -1) return { ok: false, message: 'That held sale is no longer available.' };
  const snapshot = state.held[index];
  if (state.cart.length) {
    return { ok: false, message: 'Clear or finish the current cart before resuming a held sale.' };
  }
  state.cart = JSON.parse(JSON.stringify(snapshot.cart || []));
  state.sale = { ...emptySale(), ...(snapshot.sale || {}) };
  state.tier = snapshot.tier === 'member' ? 'member' : 'retail';
  state.held.splice(index, 1);
  persistHeld();
  persistCart();
  notify();
  return { ok: true };
}

export function deleteHeld(id) {
  state.held = state.held.filter((item) => item.id !== id);
  persistHeld();
  notify();
}

// ── Tiny observable ─────────────────────────────────────────────────────────

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let queued = false;

export function notify() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (error) {
        console.error(error);
      }
    }
  });
}

/** Renders immediately while a poll is in flight. */
export function notifyNow() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (error) {
      console.error(error);
    }
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

export function hydrate() {
  const cache = read(CACHE_KEY, null);
  if (cache) {
    state.rev = num(cache.rev);
    state.products = Array.isArray(cache.products) ? cache.products : [];
    state.orders = Array.isArray(cache.orders) ? cache.orders : [];
    state.customers = Array.isArray(cache.customers) ? cache.customers : [];
    state.expenses = Array.isArray(cache.expenses) ? cache.expenses : [];
    state.conflicts = Array.isArray(cache.conflicts) ? cache.conflicts : read(CONFLICTS_KEY, []);
    state.settings = withDefaults(cache.settings);
    state.lastSyncAt = num(cache.savedAt);
  }

  state.products = state.products.map(decorateProduct);
  if (!state.products.length) state.products = SEED_PRODUCTS.map((p) => decorateProduct({ ...p }));

  const savedCart = read(CART_KEY, null);
  if (savedCart) {
    state.cart = Array.isArray(savedCart.cart) ? savedCart.cart : [];
    state.sale = { ...emptySale(), ...(savedCart.sale || {}) };
    state.tier = savedCart.tier === 'member' ? 'member' : 'retail';
  }

  state.outbox = read(OUTBOX_KEY, []) || [];
  state.held = read(HELD_KEY, []) || [];

  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') state.theme = savedTheme;
  } catch { /* ignore */ }

  const session = read(SESSION_KEY, null);
  state.isAdmin = Boolean(session?.isAdmin) && Boolean(getToken()) && !isTokenExpired(getTokenMeta());
  state.isCustomer = Boolean(session?.isCustomer) && Boolean(getToken()) && !isTokenExpired(getTokenMeta());
  if (!state.isAdmin && session?.isAdmin) write(SESSION_KEY, { isAdmin: false, isCustomer: state.isCustomer });
  if (!state.isCustomer && session?.isCustomer) write(SESSION_KEY, { isAdmin: state.isAdmin, isCustomer: false });

  state.staff = localStaff();
  state.audit = readAuditMirror(200);
  if (!state.conflicts.length) state.conflicts = read(CONFLICTS_KEY, []);
  try {
    const savedRole = localStorage.getItem(ROLE_KEY);
    if (savedRole && ROLES[savedRole] && state.isAdmin) state.role = savedRole;
    else if (session?.role && ROLES[session.role] && state.isAdmin) state.role = session.role;
    else state.role = state.isAdmin ? ROLES.ADMIN : ROLES.VIEWER;
  } catch {
    state.role = state.isAdmin ? ROLES.ADMIN : ROLES.VIEWER;
  }
  state.syncState = hasBase() ? 'idle' : 'local';
  state.ready = true;
  return state;
}

/**
 * Opens the durable database, imports the pre-IndexedDB cache once and then
 * adopts whatever is newer. Never blocks first paint: callers render from the
 * localStorage mirror immediately, and this resolves a moment later.
 */
export async function initDurable() {
  try {
    await openDB();
    const info = dbInfo();
    state.db = { ...info, ready: true };
    const legacy = await migrateLegacyLocalStorage({
      cache: CACHE_KEY, outbox: OUTBOX_KEY, held: HELD_KEY, cart: CART_KEY,
    });

    const [products, orders, customers, outbox, held, expenses, conflicts, auditRows, meta] = await Promise.all([
      dbGetAll('products'), dbGetAll('orders'), dbGetAll('customers'),
      dbGetAll('outbox'), dbGetAll('held'), dbGetAll('expenses'),
      dbGetAll('conflicts'), listAudit(300), readMeta('cache'),
    ]);

    if (products.length) state.products = products.map(decorateProduct);
    if (orders.length) state.orders = orders;
    if (customers.length) state.customers = customers;
    if (outbox.length) state.outbox = outbox;
    if (held.length) state.held = held;
    if (expenses.length) state.expenses = expenses;
    if (conflicts.length) state.conflicts = conflicts;
    if (auditRows.length) state.audit = auditRows;
    if (meta?.savedAt && meta.savedAt > state.lastSyncAt) {
      state.rev = Math.max(state.rev, num(meta.rev));
      if (meta.settings) state.settings = withDefaults(meta.settings);
      state.lastSyncAt = meta.savedAt;
    }

    // Merge in any browser-tab writes that happened while the DB was opening.
    const cache = read(CACHE_KEY, null);
    if (cache) {
      mergeProducts(Array.isArray(cache.products) ? cache.products : []);
      mergeOrders(Array.isArray(cache.orders) ? cache.orders : []);
      mergeCustomers(Array.isArray(cache.customers) ? cache.customers : []);
    }

    state.db.ready = true;
    if (legacy.migrated) {
      await appendAudit({ actor: 'system', role: 'SYSTEM', action: 'migration.legacy-import', entity: 'database', detail: JSON.stringify(legacy.counts) });
    }
    await writeMeta('health', { at: Date.now(), ok: true, version: info.version });
    persistCache();
    notify();
    return { ok: true, ...legacy, version: info.version };
  } catch (error) {
    state.db = { available: false, version: 0, migrated: [], ready: false, error: error.message };
    notify();
    return { ok: false, error: error.message };
  }
}

export async function databaseStatus() {
  return {
    ...state.db,
    plan: planMigrations(state.db.version || 0, DB_VERSION),
    snapshots: await listSnapshots().catch(() => []),
  };
}

export async function backupDatabase() {
  return exportDatabase();
}

export async function restoreDatabase(backup) {
  await takeSnapshot('before-restore');
  await importDatabase(backup);
  await initDurable();
  return true;
}

export async function snapshotDatabase(label) {
  return takeSnapshot(label);
}

export async function rollbackDatabase(id) {
  await restoreSnapshot(id);
  await initDurable();
  return true;
}

export async function resetDatabase() {
  await takeSnapshot('before-reset');
  await clearDatabase();
  try {
    for (const key of [CACHE_KEY, CART_KEY, OUTBOX_KEY, HELD_KEY, SESSION_KEY]) localStorage.removeItem(key);
  } catch { /* ignore */ }
  state.products = SEED_PRODUCTS.map((p) => decorateProduct({ ...p }));
  state.orders = [];
  state.customers = [];
  state.expenses = [];
  state.conflicts = [];
  state.audit = [];
  state.outbox = [];
  state.held = [];
  state.cart = [];
  state.sale = emptySale();
  state.rev = 0;
  persistCache();
  notify();
}

export async function audit(action, entity = '', entityId = null, detail = '') {
  const row = await appendAudit({
    actor: state.customer?.name || (state.isAdmin ? (state.staff.find((s) => s.role === state.role)?.name || 'Shop owner') : 'Guest'),
    role: state.role,
    action, entity, entity_id: entityId, detail,
  });
  state.audit.unshift(row);
  state.audit = state.audit.slice(0, 300);
  return row;
}

export function can(action) {
  return roleCan(state.role, action);
}

export function setAdmin(flag) {
  state.isAdmin = Boolean(flag);
  if (flag) state.isCustomer = false;
  if (!flag) state.role = ROLES.VIEWER;
  else if (state.role === ROLES.VIEWER) state.role = ROLES.ADMIN;
  write(SESSION_KEY, { isAdmin: state.isAdmin, isCustomer: state.isCustomer, role: state.role });
  try { localStorage.setItem(ROLE_KEY, state.role); } catch { /* ignore */ }
  if (!flag && !state.isCustomer) {
    setToken('');
    if (state.settings) {
      // admin-only fields never stay in the shared cache
      const { admin_pin_hash, ...rest } = state.settings;
      state.settings = rest;
    }
  }
  notify();
}

export function setRole(role, { admin = true } = {}) {
  const next = ROLES[String(role || '').toUpperCase()] || ROLES.VIEWER;
  state.role = next;
  if (admin) {
    state.isAdmin = true;
    state.isCustomer = false;
  }
  write(SESSION_KEY, { isAdmin: state.isAdmin, isCustomer: state.isCustomer, role: state.role });
  try { localStorage.setItem(ROLE_KEY, state.role); } catch { /* ignore */ }
  notify();
}

/**
 * Offline sign-in. When a server is connected the API is the authority, but a
 * shop with no signal must still be able to open the till: the locally cached
 * staff PIN verifies against the salted hash and grants the stored role.
 */
export async function loginLocal(pin) {
  const staff = await authenticateLocal(String(pin || '').trim());
  if (!staff) return { ok: false, message: 'That PIN does not match any active staff member.' };
  setRole(staff.role);
  await audit('auth.login', 'staff', staff.id, `Offline sign-in as ${staff.role}`);
  return { ok: true, staff, role: staff.role };
}

export async function changeLocalPin(staffId, pin) {
  const staff = await setLocalPin(staffId, pin);
  state.staff = localStaff();
  await audit('auth.pin_changed', 'staff', staff.id, 'PIN changed on this device');
  notify();
  return staff;
}

export function setCustomer(flag, customer = null) {
  state.isCustomer = Boolean(flag);
  if (flag) {
    state.isAdmin = false;
    state.role = ROLES.VIEWER;
  }
  state.customer = flag ? customer : null;
  write(SESSION_KEY, { isAdmin: state.isAdmin, isCustomer: state.isCustomer, role: state.role });
  if (!flag) setToken('');
  notify();
}

/** Re-reads the cache another tab just wrote. */
export function refreshFromStorage() {
  const cache = read(CACHE_KEY, null);
  if (!cache) return;
  state.rev = num(cache.rev);
  state.products = (Array.isArray(cache.products) ? cache.products : state.products).map(decorateProduct);
  state.orders = Array.isArray(cache.orders) ? cache.orders : state.orders;
  state.customers = Array.isArray(cache.customers) ? cache.customers : state.customers;
  state.settings = withDefaults(cache.settings);
  state.lastSyncAt = num(cache.savedAt) || state.lastSyncAt;
  const outbox = read(OUTBOX_KEY, null);
  if (Array.isArray(outbox)) state.outbox = outbox;
  notify();
}

// ── Derived data ────────────────────────────────────────────────────────────

export const currency = () => state.settings.currency || DEFAULT_SETTINGS.currency;

export const activeProducts = () => state.products.filter((p) => Number(p.is_active ?? 1) === 1);

export const productById = (id) => state.products.find((p) => Number(p.id) === Number(id)) || null;

export function unitPrice(product) {
  if (!product) return 0;
  return state.tier === 'member' ? num(product.member_price) : num(product.retail_price);
}

export function stockLevel(product) {
  const qty = num(product?.stock_qty);
  const threshold = Math.max(num(product?.low_stock_at, 5), num(state.settings.low_stock_threshold, 5));
  if (qty <= 0) return 'out';
  if (qty <= threshold) return 'low';
  return 'ok';
}

export function categories() {
  return [...new Set(activeProducts().map((p) => p.category).filter(Boolean))].sort();
}

export function cartLines() {
  return state.cart
    .map((line) => {
      const product = productById(line.productId);
      if (!product) return null;
      const price = unitPrice(product);
      const pv = num(product.pv_points);
      const gross = round2(price * line.qty);
      const discount = round2(Math.min(gross, Math.max(0, num(line.discount))));
      return {
        product,
        productId: product.id,
        qty: line.qty,
        price,
        pv,
        discount,
        lineTotal: round2(gross - discount),
        lineGross: gross,
        linePv: round2(pv * line.qty),
        available: num(product.stock_qty),
      };
    })
    .filter(Boolean);
}

export function cartTotals() {
  const lines = cartLines();
  const gross = round2(lines.reduce((sum, l) => sum + l.lineGross, 0));
  const lineDiscount = round2(lines.reduce((sum, l) => sum + l.discount, 0));
  const pv = round2(lines.reduce((sum, l) => sum + l.linePv, 0));
  const orderDiscount = Math.min(round2(num(state.sale.discount)), round2(gross - lineDiscount));
  const subtotal = round2(gross - lineDiscount);
  const discount = round2(lineDiscount + Math.max(0, orderDiscount));
  const total = round2(Math.max(0, subtotal - Math.max(0, orderDiscount)));
  const units = lines.reduce((sum, l) => sum + l.qty, 0);

  const preview = normalizePayments(
    Array.isArray(state.sale.payments) ? state.sale.payments : [],
    total,
    { allowCredit: true },
  );
  return {
    lines,
    subtotal,
    gross,
    discount,
    orderDiscount,
    total,
    pv,
    units,
    count: lines.length,
    paid: preview.paid,
    due: preview.due,
    change: preview.change,
    paymentStatus: preview.status,
    payments: preview.payments,
  };
}

/** Recently sold SKUs, newest first, for the POS quick row. */
export function recentProducts(limit = 8) {
  const seen = new Set();
  const out = [];
  for (const order of state.orders) {
    if (order.type === 'RETURN' || order.status === 'CANCELLED') continue;
    for (const item of order.items || []) {
      const key = item.product_sku || item.sku;
      if (!key || seen.has(key)) continue;
      const product = state.products.find((p) => String(p.sku) === String(key));
      if (!product || Number(product.is_active ?? 1) !== 1) continue;
      seen.add(key);
      out.push(product);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Most frequently sold products across the cached history. */
export function frequentProducts(limit = 8) {
  const counts = new Map();
  for (const order of state.orders) {
    if (order.type === 'RETURN' || order.status === 'CANCELLED') continue;
    for (const item of order.items || []) {
      const key = item.product_sku || item.sku;
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + num(item.quantity));
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sku]) => state.products.find((p) => String(p.sku) === String(sku)))
    .filter((p) => p && Number(p.is_active ?? 1) === 1)
    .slice(0, limit);
}

export function cartCount() {
  return state.cart.reduce((sum, line) => sum + line.qty, 0);
}

export const pendingCount = () => state.outbox.filter((o) => o.status !== 'failed').length;
export const failedCount = () => state.outbox.filter((o) => o.status === 'failed').length;

// ── Cart ────────────────────────────────────────────────────────────────────

export function setTier(tier) {
  state.tier = tier === 'member' ? 'member' : 'retail';
  persistCart();
  notify();
}

export function addToCart(productId, qty = 1) {
  const product = productById(productId);
  if (!product) return { ok: false, message: 'That product is no longer in the catalogue.' };

  const existing = state.cart.find((line) => Number(line.productId) === Number(productId));
  const next = (existing?.qty || 0) + qty;
  if (next > num(product.stock_qty)) {
    return { ok: false, message: `Only ${num(product.stock_qty)} left of ${product.name}.` };
  }
  if (next <= 0) {
    state.cart = state.cart.filter((line) => Number(line.productId) !== Number(productId));
  } else if (existing) {
    existing.qty = next;
  } else {
    state.cart.push({ productId: product.id, qty: next });
  }
  persistCart();
  notify();
  return { ok: true };
}

export function setQty(productId, qty) {
  const product = productById(productId);
  const target = Math.max(0, Math.min(Math.round(qty), num(product?.stock_qty)));
  if (target <= 0) {
    removeFromCart(productId);
    return;
  }
  const line = state.cart.find((l) => Number(l.productId) === Number(productId));
  if (line) line.qty = target;
  else state.cart.push({ productId: Number(productId), qty: target });
  persistCart();
  notify();
}

export function removeFromCart(productId) {
  state.cart = state.cart.filter((line) => Number(line.productId) !== Number(productId));
  persistCart();
  notify();
}

/** Per-line discount, capped at the line value. */
export function setLineDiscount(productId, amount) {
  const line = state.cart.find((l) => Number(l.productId) === Number(productId));
  if (!line) return;
  const product = productById(productId);
  const gross = round2(unitPrice(product) * line.qty);
  line.discount = round2(Math.min(gross, Math.max(0, num(amount))));
  persistCart();
  notify();
}

export function clearCart() {
  state.cart = [];
  state.sale = emptySale();
  persistCart();
  notify();
}

export function updateSale(patch) {
  state.sale = { ...state.sale, ...patch };
  persistCart();
  notify();
}

export function setSaleCustomer(customer) {
  if (!customer) {
    state.sale.customer_id = null;
    state.sale.customer_name = '';
    state.sale.customer_phone = '';
    state.sale.dxn_member_id = '';
  } else {
    state.sale.customer_id = customer.id || null;
    state.sale.customer_name = customer.name || '';
    state.sale.customer_phone = customer.phone || '';
    state.sale.dxn_member_id = customer.dxn_member_id || '';
  }
  persistCart();
  notify();
}

/** Adds a split payment entry to the current sale. */
export function addPayment(method, amount, extra = {}) {
  const entry = {
    method: String(method || 'CASH').toUpperCase(),
    amount: round2(Math.max(0, num(amount))),
    reference: extra.reference || '',
    note: extra.note || '',
  };
  if (!entry.amount) return { ok: false, message: 'Enter an amount first.' };
  state.sale.payments = [...(state.sale.payments || []), entry];
  state.sale.payment_method = entry.method;
  persistCart();
  notify();
  return { ok: true, entry };
}

export function removePayment(index) {
  state.sale.payments = (state.sale.payments || []).filter((_, i) => i !== index);
  persistCart();
  notify();
}

export function clearPayments() {
  state.sale.payments = [];
  persistCart();
  notify();
}

/** Stable idempotency key for the current cart. */
export function checkoutKey() {
  if (!state.sale.client_uuid) {
    state.sale.client_uuid = uuid();
    persistCart();
  }
  return state.sale.client_uuid;
}

export function buildOrderPayload() {
  const { lines, subtotal, discount, total, pv, paid, due, change, payments, paymentStatus: status } = cartTotals();
  const key = checkoutKey();
  return {
    client_uuid: key,
    customer_id: state.sale.customer_id || (state.isCustomer && state.customer?.id ? state.customer.id : undefined),
    customer_name: (state.sale.customer_name || '').trim() || 'Walk-in customer',
    customer_phone: (state.sale.customer_phone || '').trim(),
    dxn_member_id: (state.sale.dxn_member_id || '').trim().toUpperCase(),
    is_member: state.tier === 'member',
    payment_method: payments.length ? payments[0].method : (state.sale.payment_method || 'CASH'),
    payments,
    amount_paid: paid,
    due_amount: due,
    change_amount: change,
    payment_status: status,
    allow_credit: state.sale.allow_credit ? 1 : 0,
    discount,
    note: (state.sale.note || '').trim(),
    source: 'web',
    items: lines.map((line) => ({
      product_id: line.productId,
      product_sku: line.product.sku,
      quantity: line.qty,
      unit_price: line.price,
      unit_pv: line.pv,
      discount: line.discount,
    })),
    _totals: { subtotal, total, pv, paid, due, change, status },
  };
}

// ── Outbox ──────────────────────────────────────────────────────────────────

/**
 * Saves the sale locally and queues it. This is the only path to checkout:
 * there is no direct network call, so a dead connection or a force-close can
 * never lose a completed sale. Repeated taps return the same queued entry.
 */
export function enqueueOrder() {
  if (state.checkout.busy) return { ok: false, message: 'This sale is already being saved.', duplicate: true };
  const totals = cartTotals();
  if (!totals.lines.length) return { ok: false, message: 'The cart is empty.' };
  const short = totals.lines.find((line) => line.qty > line.available);
  if (short) return { ok: false, message: `Not enough stock for ${short.product.name} (${short.available} left).` };

  const paymentCheck = normalizePayments(totals.payments, totals.total, {
    allowCredit: Boolean(state.sale.allow_credit) || Boolean(state.sale.customer_id) || Boolean(state.sale.dxn_member_id),
  });
  if (!paymentCheck.ok) return { ok: false, message: paymentCheck.message };
  if (paymentCheck.due > 0 && !state.sale.customer_id && !state.sale.dxn_member_id && !state.sale.customer_phone) {
    return { ok: false, message: 'A credit sale needs a customer name and phone or DXN member ID.' };
  }

  const payload = buildOrderPayload();
  if (!payload.items.length) return { ok: false, message: 'The cart is empty.' };
  if (state.outbox.some((item) => item.id === payload.client_uuid)) {
    return { ok: false, message: 'This sale has already been saved.', duplicate: true };
  }
  const localTotals = payload._totals;
  delete payload._totals;

  state.checkout = { busy: true, id: payload.client_uuid };
  state.outbox.push({
    id: payload.client_uuid,
    kind: 'order',
    payload,
    totals: localTotals,
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending',
    error: '',
  });
  persistOutbox();

  // Show the sale immediately: local stock only ever goes down optimistically.
  for (const item of payload.items) {
    const product = productById(item.product_id);
    if (product) product.stock_qty = num(product.stock_qty) - item.quantity;
  }
  persistCache();
  audit('sale.queued', 'order', payload.client_uuid, `${payload.customer_name} - ${localTotals.total} (${localTotals.status})`);
  clearCart();
  state.checkout = { busy: false, id: '' };
  notify();

  syncNow();
  return { ok: true, payload, totals: localTotals, outboxId: payload.client_uuid };
}

export function dropFromOutbox(id) {
  const item = state.outbox.find((o) => o.id === id);
  if (item) {
    if (item.kind === 'order') {
      for (const line of item.payload?.items || []) {
        const product = productById(line.product_id);
        if (product) product.stock_qty = num(product.stock_qty) + num(line.quantity);
      }
    } else if (item.kind === 'return') {
      // processReturn restored the shelf optimistically; undo that restore.
      for (const line of item.payload?.items || []) {
        const product = productById(line.product_id);
        if (product) product.stock_qty = num(product.stock_qty) - num(line.quantity);
      }
    } else if (item.kind === 'payment') {
      const order = state.orders.find((o) => Number(o.id) === Number(item.payload?.order_id));
      if (order) {
        order.payments = (order.payments || []).filter((p) => p.client_uuid !== item.payload?.client_uuid);
        const paid = round2((order.payments || []).reduce((sum, p) => sum + Math.max(0, num(p.amount)), 0));
        const due = round2(Math.max(0, num(order.total_amount) - paid));
        order.amount_paid = paid;
        order.due_amount = due;
        order.payment_status = paymentStatus(paid, order.total_amount);
        if (due > 0 && order.status === 'PAID') order.status = 'CONFIRMED';
        mergeOrders([order]);
      }
    } else if (item.kind === 'expense') {
      state.expenses = state.expenses.filter((e) => e.client_uuid !== item.payload?.client_uuid && e.id !== item.payload?.id);
    }
    persistCache();
  }
  state.outbox = state.outbox.filter((entry) => entry.id !== id);
  persistOutbox();
  notify();
}

export function retryOutboxItem(id) {
  const item = state.outbox.find((o) => o.id === id);
  if (!item) return;
  item.status = 'pending';
  item.error = '';
  item.attempts = 0;
  persistOutbox();
  notify();
  syncNow();
}

export function retryAll() {
  for (const item of state.outbox) {
    item.status = 'pending';
    item.error = '';
  }
  persistOutbox();
  notify();
  syncNow();
}

async function flushOutbox() {
  if (!state.outbox.length) return 0;
  let sent = 0;
  let blocked = false;

  for (const item of [...state.outbox]) {
    if (item.status === 'failed') continue;
    try {
      item.attempts += 1;
      if (item.kind === 'payment') {
        const result = await api.recordPayment(item.payload.order_id, item.payload);
        if (result?.order) mergeOrders([result.order]);
      } else if (item.kind === 'return') {
        const result = await api.createReturn(item.payload.order_id, item.payload);
        if (result?.order) mergeOrders([result.order]);
        if (result?.original) mergeOrders([result.original]);
      } else if (item.kind === 'expense') {
        const result = await api.createExpense(item.payload);
        if (result?.expense) {
          state.expenses = [result.expense, ...state.expenses.filter((e) => e.id !== result.expense.id)];
        }
      } else {
        const result = await api.createOrder(item.payload);
        if (result?.order) mergeOrders([result.order]);
      }
      state.outbox = state.outbox.filter((o) => o.id !== item.id);
      sent += 1;
    } catch (error) {
      item.error = error.message;
      if (error instanceof ApiError && [400, 403, 404, 409, 422].includes(error.status)) {
        // A permanent rejection (e.g. stock ran out). Keep it visible so the
        // shop can decide; never retry it silently in a loop.
        item.status = 'failed';
      } else {
        blocked = true;
        break;
      }
    }
  }

  persistOutbox();
  if (sent) {
    state.lastPush = Date.now();
    persistCache();
  }
  if (blocked) {
    throw new ApiError('Still offline — queued sales will be pushed when the connection returns.');
  }
  return sent;
}

// ── Payments & returns ──────────────────────────────────────────────────────

/**
 * Records money against an existing order. Offline it is queued; online it is
 * pushed immediately. The server de-duplicates by payment uuid.
 */
export async function recordPayment(orderId, payment) {
  const order = state.orders.find((o) => Number(o.id) === Number(orderId));
  if (!order) return { ok: false, message: 'Order not found.' };
  const amount = round2(Math.max(0, num(payment.amount)));
  if (!amount) return { ok: false, message: 'Enter an amount greater than zero.' };
  const balance = orderBalance(order);
  if (amount > balance.due + 0.009) {
    return { ok: false, message: `That is more than the ${balance.due.toFixed(2)} still due.` };
  }
  const entry = {
    order_id: Number(orderId),
    amount,
    method: String(payment.method || 'CASH').toUpperCase(),
    reference: payment.reference || '',
    note: payment.note || '',
    client_uuid: uuid(),
    paid_at: new Date().toISOString(),
  };

  const optimistic = {
    ...order,
    amount_paid: round2(balance.paid + amount),
    due_amount: round2(Math.max(0, balance.due - amount)),
    payments: [...(order.payments || []), entry],
  };
  optimistic.payment_status = paymentStatus(optimistic.amount_paid, optimistic.total_amount);
  // Payment status and fulfilment status are different axes. Only settle the
  // order when the balance reaches zero; otherwise leave PACKED/DELIVERED etc.
  // exactly as they were, mirroring the server's recordPayment behaviour.
  if (optimistic.due_amount <= 0) optimistic.status = 'PAID';
  else if (optimistic.status === 'PAID') optimistic.status = 'CONFIRMED';
  mergeOrders([optimistic]);
  persistCache();

  if (hasBase()) {
    try {
      const result = await api.recordPayment(orderId, entry);
      if (result?.order) mergeOrders([result.order]);
      persistCache();
      audit('payment.recorded', 'order', orderId, `${amount} via ${entry.method}`);
      notify();
      return { ok: true, queued: false };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 0) {
        mergeOrders([order]);
        persistCache();
        return { ok: false, message: error.message };
      }
    }
  }

  state.outbox.push({
    id: entry.client_uuid, kind: 'payment', payload: entry,
    createdAt: Date.now(), attempts: 0, status: 'pending', error: '',
  });
  persistOutbox();
  await audit('payment.queued', 'order', orderId, `${amount} via ${entry.method}`);
  notify();
  syncNow();
  return { ok: true, queued: true };
}

/**
 * Processes a return as a linked reversal, never by editing the original.
 * Stock is restored and the customer balance reduced on the server; offline
 * the whole operation is queued as one atomic outbox entry.
 */
export async function processReturn(orderId, { items, reason = '', refundMethod = 'CASH' } = {}) {
  const order = state.orders.find((o) => Number(o.id) === Number(orderId));
  if (!order) return { ok: false, message: 'Order not found.' };
  const requested = (Array.isArray(items) ? items : []).map((item) => ({
    product_id: Number(item.product_id),
    quantity: Math.max(0, Math.round(num(item.quantity))),
  })).filter((item) => item.quantity > 0);
  if (!requested.length) return { ok: false, message: 'Choose at least one item to return.' };

  const already = new Map();
  for (const row of state.orders) {
    if (row.type !== 'RETURN' || Number(row.original_order_id) !== Number(order.id)) continue;
    for (const item of row.items || []) {
      const key = Number(item.product_id);
      already.set(key, (already.get(key) || 0) + Math.abs(num(item.quantity)));
    }
  }
  for (const line of requested) {
    const sold = (order.items || []).find((i) => Number(i.product_id) === line.product_id);
    const remaining = sold ? num(sold.quantity) - (already.get(line.product_id) || 0) : 0;
    if (!sold || line.quantity > remaining) {
      return { ok: false, message: `Only ${remaining} of ${sold?.name || 'that item'} can still be returned.` };
    }
  }

  const payload = {
    client_uuid: uuid(),
    items: requested,
    reason: String(reason || '').slice(0, 300),
    refund_method: String(refundMethod || 'CASH').toUpperCase(),
  };

  // Optimistic stock restore so the shelf is sellable again immediately.
  for (const line of requested) {
    const product = productById(line.product_id);
    if (product) product.stock_qty = num(product.stock_qty) + line.quantity;
  }
  persistCache();
  notify();

  if (hasBase()) {
    try {
      const result = await api.createReturn(orderId, payload);
      if (result?.order) mergeOrders([result.order]);
      if (result?.original) mergeOrders([result.original]);
      persistCache();
      await audit('return.created', 'order', orderId, `${requested.length} line(s) - ${reason || 'no reason'}`);
      notify();
      return { ok: true, queued: false, order: result?.order };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 0) {
        for (const line of requested) {
          const product = productById(line.product_id);
          if (product) product.stock_qty = num(product.stock_qty) - line.quantity;
        }
        persistCache();
        notify();
        return { ok: false, message: error.message };
      }
    }
  }

  state.outbox.push({
    id: payload.client_uuid, kind: 'return', payload: { ...payload, order_id: Number(orderId) },
    createdAt: Date.now(), attempts: 0, status: 'pending', error: '',
  });
  persistOutbox();
  await audit('return.queued', 'order', orderId, `${requested.length} line(s)`);
  syncNow();
  return { ok: true, queued: true };
}

/** Records an out-of-pocket business expense, online immediately or queued. */
export async function addExpense({ category, amount, note = '', spent_at = '' } = {}) {
  const value = round2(Math.max(0, num(amount)));
  if (!value) return { ok: false, message: 'Enter an amount greater than zero.' };
  const entry = {
    id: `local-${uuid()}`,
    client_uuid: uuid(),
    category: String(category || 'Other').trim().slice(0, 60) || 'Other',
    amount: value,
    note: String(note || '').trim().slice(0, 300),
    spent_at: spent_at || new Date().toISOString(),
  };
  state.expenses.unshift(entry);
  persistCache();
  notify();

  if (hasBase()) {
    try {
      const result = await api.createExpense(entry);
      if (result?.expense) {
        state.expenses = [result.expense, ...state.expenses.filter((e) => e.id !== entry.id && e.client_uuid !== entry.client_uuid)];
      }
      persistCache();
      await audit('expense.created', 'expense', result?.expense?.id || entry.id, `${value} · ${entry.category}`);
      notify();
      return { ok: true, queued: false, expense: result?.expense };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 0) {
        state.expenses = state.expenses.filter((e) => e.id !== entry.id);
        persistCache();
        notify();
        return { ok: false, message: error.message };
      }
    }
  }

  state.outbox.push({
    id: entry.client_uuid, kind: 'expense', payload: entry,
    createdAt: Date.now(), attempts: 0, status: 'pending', error: '',
  });
  persistOutbox();
  await audit('expense.queued', 'expense', entry.id, `${value} · ${entry.category}`);
  notify();
  syncNow();
  return { ok: true, queued: true, expense: entry };
}

// ── Sync ────────────────────────────────────────────────────────────────────

function persistConflicts() {
  write(CONFLICTS_KEY, state.conflicts);
  if (state.db.available) {
    dbPutMany('conflicts', state.conflicts.map((row) => ({ ...row, id: row.id || row.key }))).catch(() => {});
  }
}

function noteConflict(entity, id, local, incoming) {
  const key = `${entity}:${id}`;
  if (state.conflicts.some((c) => c.key === key && c.incomingRev === num(incoming?.rev))) return;
  state.conflicts.unshift({
    id: uuid(),
    key,
    entity,
    id_value: id,
    localRev: num(local?.rev),
    incomingRev: num(incoming?.rev),
    localUpdated: local?.updated_at || '',
    incomingUpdated: incoming?.updated_at || '',
    at: new Date().toISOString(),
    resolved: false,
    choice: '',
    local,
    incoming,
  });
  state.conflicts = state.conflicts.slice(0, 40);
  persistConflicts();
}

function mergeProducts(incoming) {
  const map = new Map(state.products.map((p) => [Number(p.id), p]));
  for (const product of incoming) {
    const id = Number(product.id);
    const local = map.get(id);
    let keptStock = null;
    if (local && num(local.rev) > num(product.rev) && num(product.rev) > 0) {
      noteConflict('product', id, local, product);
      // A newer device edit (stock take, price change) has not reached the
      // server yet. Keep it visible instead of silently reverting the shelf.
      keptStock = num(local.stock_qty);
    }
    map.set(id, decorateProduct(keptStock === null ? product : { ...product, stock_qty: keptStock }));
  }
  state.products = sortBy([...map.values()], 'name');
}

function mergeMoney(local, incoming) {
  const payments = new Map();
  for (const entry of [...(local?.payments || []), ...(incoming?.payments || [])]) {
    const key = entry.client_uuid || `${entry.method}:${entry.paid_at}:${entry.amount}`;
    payments.set(key, { ...(payments.get(key) || {}), ...entry });
  }
  const refunds = new Map();
  for (const entry of [...(local?.refunds || []), ...(incoming?.refunds || [])]) {
    const key = entry.client_uuid || `${entry.method}:${entry.refunded_at}:${entry.amount}`;
    refunds.set(key, { ...(refunds.get(key) || {}), ...entry });
  }
  const paid = round2(Math.max(num(local?.amount_paid), num(incoming?.amount_paid)));
  const status = paymentStatus(paid, num(incoming?.total_amount));
  return {
    payments: [...payments.values()],
    refunds: [...refunds.values()],
    amount_paid: paid,
    due_amount: round2(Math.max(0, num(incoming?.total_amount) - paid)),
    payment_status: status,
    // Fulfilment status comes from the server; settle only a zero balance.
    status: status === 'PAID' ? 'PAID' : (incoming?.status || local?.status || 'CONFIRMED'),
  };
}

function mergeOrders(incoming) {
  const map = new Map(state.orders.map((o) => [Number(o.id), o]));
  for (const order of incoming) {
    const id = Number(order.id);
    if (!id) continue;
    const local = map.get(id);
    // A local row with newer money than the server row is a real conflict.
    // Union the ledgers so no payment is lost, then let the outbox push it.
    const localMoney = num(local?.amount_paid) > num(order.amount_paid) || num(local?.refunded_amount) > num(order.refunded_amount);
    if (local && localMoney && num(local.rev) > num(order.rev) && num(order.rev) > 0) {
      noteConflict('order', id, local, order);
      map.set(id, { ...(local || {}), ...order, ...mergeMoney(local, order) });
      continue;
    }
    map.set(id, { ...(local || {}), ...order });
  }
  state.orders = [...map.values()]
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id))
    .slice(0, MAX_ORDERS);
}

/** Chooses which copy wins after a sync conflict. Always auditable. */
export async function resolveConflict(key, choice = 'server') {
  const conflict = state.conflicts.find((c) => c.key === key);
  if (!conflict) return false;
  const selected = choice === 'device' ? 'device' : 'server';
  conflict.resolved = true;
  conflict.choice = selected;
  conflict.resolvedAt = new Date().toISOString();
  persistConflicts();
  if (selected === 'device' && conflict.local) {
    if (conflict.entity === 'order') mergeOrders([conflict.local]);
    if (conflict.entity === 'product') mergeProducts([conflict.local]);
    persistCache();
  }
  await audit(`conflict.${selected}`, conflict.entity, conflict.id_value || conflict.id, conflict.key);
  notify();
  return true;
}

/** Lets admin forms push a freshly saved row without waiting for the next poll. */
export function upsertProducts(list) {
  mergeProducts(list || []);
  persistCache();
  notify();
}

export function upsertOrders(list) {
  mergeOrders(list || []);
  persistCache();
  notify();
}

function mergeCustomers(incoming) {
  const map = new Map(state.customers.map((c) => [Number(c.id), c]));
  for (const customer of incoming) map.set(Number(customer.id), { ...(map.get(Number(customer.id)) || {}), ...customer });
  state.customers = [...map.values()].slice(0, 1000);
}

function applySync(payload) {
  if (Array.isArray(payload.products) && payload.products.length) mergeProducts(payload.products);
  if (Array.isArray(payload.orders) && payload.orders.length) mergeOrders(payload.orders);
  if (Array.isArray(payload.customers) && payload.customers.length) mergeCustomers(payload.customers);
  if (Array.isArray(payload.expenses) && payload.expenses.length) {
    const map = new Map(state.expenses.map((e) => [String(e.id), e]));
    for (const expense of payload.expenses) map.set(String(expense.id), expense);
    state.expenses = [...map.values()].sort((a, b) => String(b.spent_at || '').localeCompare(String(a.spent_at || '')));
  }
  if (Array.isArray(payload.staff) && payload.staff.length) state.remoteStaff = payload.staff;
  if (Array.isArray(payload.audit) && payload.audit.length) {
    const mapped = payload.audit.map((row) => ({
      ...row,
      at: row.created_at || row.at || new Date().toISOString(),
    }));
    const seen = new Set(state.audit.map((row) => `${row.at}|${row.action}|${row.detail || ''}`));
    state.audit = [...mapped.filter((row) => !seen.has(`${row.at}|${row.action}|${row.detail || ''}`)), ...state.audit]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 300);
  }
  if (payload.settings && typeof payload.settings === 'object') {
    const { admin_pin_hash, ...safe } = payload.settings;
    state.settings = withDefaults({ ...state.settings, ...safe });
  }
  state.rev = Math.max(state.rev, num(payload.server_rev));
  persistCache();
}

let syncing = false;

export async function syncNow({ quiet = false } = {}) {
  if (syncing) return;
  if (!hasBase()) {
    state.syncState = 'local';
    if (!quiet) notify();
    return;
  }
  if (!navigator.onLine) {
    state.syncState = 'offline';
    notify();
    return;
  }

  syncing = true;
  state.syncState = 'syncing';
  state.syncError = '';
  notify();

  try {
    await flushOutbox();

    let payload = await api.sync(state.rev);
    applySync(payload);

    let guard = 0;
    while (payload.truncated && guard < 50) {
      guard += 1;
      // The first page is oldest-first; resume from its last revision instead
      // of jumping straight to server_rev and silently dropping later pages.
      state.rev = num(payload.next_since, state.rev);
      payload = await api.sync(state.rev);
      applySync(payload);
    }

    state.lastSyncAt = Date.now();
    state.syncState = state.outbox.length ? 'pending' : 'online';
    state.syncError = '';
    persistCache();
  } catch (error) {
    state.syncError = error.message || 'Sync failed';
    state.syncState = error?.status === 0 ? 'offline' : 'error';
  } finally {
    syncing = false;
    notify();
  }
}

export async function verifySession() {
  if (state.isAdmin && getToken() && !isTokenExpired()) {
    try {
      const info = await api.me();
      if (info?.role && ROLES[String(info.role).toUpperCase()]) {
        state.role = String(info.role).toUpperCase();
        write(SESSION_KEY, { isAdmin: state.isAdmin, isCustomer: state.isCustomer, role: state.role });
        try { localStorage.setItem(ROLE_KEY, state.role); } catch { /* ignore */ }
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.isAuth) {
        setAdmin(false);
        return false;
      }
      return state.isAdmin;
    }
  }
  if (state.isCustomer && getToken() && !isTokenExpired()) {
    try {
      const result = await api.me();
      if (result?.customer) state.customer = result.customer;
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.isAuth) {
        setCustomer(false);
        return false;
      }
      return state.isCustomer;
    }
  }
  return false;
}

let loopStarted = false;

export function startSyncLoop() {
  if (loopStarted) return;
  loopStarted = true;

  window.addEventListener('online', () => {
    state.online = true;
    notify();
    syncNow();
  });

  window.addEventListener('offline', () => {
    state.online = false;
    state.syncState = 'offline';
    notify();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNow({ quiet: true });
  });

  window.addEventListener('storage', (event) => {
    if (event.key === CACHE_KEY || event.key === OUTBOX_KEY) refreshFromStorage();
  });

  setInterval(() => {
    if (!document.hidden && navigator.onLine) syncNow({ quiet: true });
  }, POLL_MS);

  syncNow();
  verifySession();
}

export { DEFAULT_SETTINGS, getBase };
