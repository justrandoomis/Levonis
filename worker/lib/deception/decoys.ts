/**
 * THE BAIT — paths no customer and no well-behaved crawler ever asks for,
 * answered with realistic FAKE data (owner brief 2026-10-10: «يتم اكتشافهم عن
 * طريق ملفات وهمية»; design §2, DECISIONS row 206).
 *
 * EVERYTHING HERE IS INVENTED IN MEMORY. No database is read to build a decoy:
 * no real name, id, price, cost, supplier or user can appear, copied or
 * derived (tests/deceptionDecoys.test.ts seeds real rows and greps every
 * answer for them). The names come from fixed word lists of invented brands;
 * the figures from a PRNG seeded by the answer's batch id, so `renderDecoy` is
 * PURE — the owner console regenerates exactly what an attacker was given
 * without storing it.
 *
 * NO OFFENSIVE BEHAVIOUR: no script, no tracking, no tarpit, no compression
 * bomb, no redirect off the site, at most 8 KB. Hostnames are `.internal`
 * names that resolve nowhere; keys and passwords are Levonis's own canary
 * formats (./canary.ts), never a third party's.
 */
import type { CanaryBatch } from './canary';

export type DecoyCode =
  | 'env'
  | 'git_config'
  | 'config_json'
  | 'sql_dump'
  | 'costs_export'
  | 'internal_costs'
  | 'v0_admin'
  | 'wp_login'
  | 'phpmyadmin';

export const DECOY_CODES: readonly DecoyCode[] = [
  'env',
  'git_config',
  'config_json',
  'sql_dump',
  'costs_export',
  'internal_costs',
  'v0_admin',
  'wp_login',
  'phpmyadmin',
];
export const isDecoyCode = (v: unknown): v is DecoyCode => typeof v === 'string' && (DECOY_CODES as readonly string[]).includes(v);

interface DecoySpec {
  exact: readonly string[];
  prefixes: readonly string[];
}

/** One registry: the paths of each decoy. */
export const DECOYS: Readonly<Record<DecoyCode, DecoySpec>> = {
  env: { exact: ['/.env', '/.env.local', '/.env.production', '/.env.backup'], prefixes: [] },
  git_config: { exact: ['/.git'], prefixes: ['/.git/'] },
  config_json: { exact: ['/config.json'], prefixes: [] },
  sql_dump: { exact: ['/backup.sql', '/database.sql'], prefixes: [] },
  costs_export: { exact: ['/admin/export'], prefixes: ['/admin/export/'] },
  internal_costs: { exact: ['/api/internal'], prefixes: ['/api/internal/'] },
  v0_admin: { exact: ['/api/v0'], prefixes: ['/api/v0/'] },
  wp_login: { exact: ['/wp-login.php', '/xmlrpc.php', '/wp-admin'], prefixes: ['/wp-admin/'] },
  phpmyadmin: { exact: ['/phpmyadmin'], prefixes: ['/phpmyadmin/'] },
};

/**
 * The Hono patterns the decoy router answers — every exact path and every
 * prefix as `<prefix>*`. Written out because a pattern is what the security
 * log names (the route PATTERN, never the URL).
 */
export const DECOY_ROUTE_PATTERNS: readonly string[] = Object.values(DECOYS).flatMap((d) => [
  ...d.exact,
  ...d.prefixes.map((p) => `${p}*`),
]);

/**
 * The `run_worker_first` entries of wrangler.jsonc (all three blocks): without
 * them the asset layer answers these paths with the SPA shell at 200 and the
 * Worker never sees them. tests/deceptionDecoys.test.ts holds the file to this.
 */
export const DECOY_WORKER_FIRST: readonly string[] = [
  '/.env',
  '/.env.local',
  '/.env.production',
  '/.env.backup',
  '/.git/*',
  '/config.json',
  '/backup.sql',
  '/database.sql',
  '/admin/export/*',
  '/wp-login.php',
  '/wp-admin/*',
  '/xmlrpc.php',
  '/phpmyadmin/*',
];

/** The robots.txt `Disallow` lines for the sensitive-looking decoys. */
export const DECOY_DISALLOW: readonly string[] = [
  '/.env',
  '/.git/',
  '/config.json',
  '/backup.sql',
  '/database.sql',
  '/admin/export/',
  '/api/internal/',
  '/api/v0/',
];

/** Which decoy this path is, or null. */
export function decoyFor(path: string): DecoyCode | null {
  for (const code of DECOY_CODES) {
    const d = DECOYS[code];
    if (d.exact.includes(path) || d.prefixes.some((p) => path.startsWith(p))) return code;
  }
  return null;
}

// ------------------------------------------------------------- content

/** mulberry32 — a small seeded PRNG; the batch id is the seed. */
export function prng(batch: string): () => number {
  let a = (parseInt(batch.slice(0, 8), 16) || 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many fake product rows a batch carries (8 to 15) and its key noise — the inputs `mintBatch` needs. */
export function batchShape(batch: string): { productCount: number; keyNoise: string } {
  const r = prng(`${batch.slice(2)}${batch.slice(0, 2)}`);
  const productCount = 8 + Math.floor(r() * 8);
  let keyNoise = '';
  for (let i = 0; i < 8; i++) keyNoise += Math.floor(r() * 16).toString(16);
  return { productCount, keyNoise };
}

/** Invented brands and parts for a 3D-printing shop. None is a real brand. */
const BRANDS = ['Corvex', 'Halden', 'Mirra', 'Tessar', 'Volkra', 'Ardent', 'Kelvo', 'Nordra', 'Quillon', 'Brisk'];
const PARTS = [
  'Hardened Nozzle 0.4',
  'Textured Build Sheet 256',
  'Silk Filament 1kg',
  'Matte Filament 1kg',
  'Hotend Assembly V3',
  'Linear Rail Kit 350',
  'Belt Pack GT2 6mm',
  'Enclosure Panel Set',
  'Carbon Rod Set',
  'Extruder Gear Kit',
  'Thermistor Pair 300C',
  'Cooling Fan 5015',
  'Resin Vat Film',
  'Dryer Box Duo',
  'Spool Holder Pro',
];

export interface FakeRow {
  product_id: string;
  sku: string;
  name: string;
  supplier_code: string;
  unit_cost_usd: number;
  landed_cost_iqd: number;
  price_iqd: number;
  margin_pct: number;
}

/** The batch's fake catalogue rows: plausible ranges, prices consistent with the landed cost. */
export function fakeRows(tokens: Pick<CanaryBatch, 'batch' | 'productIds'>): FakeRow[] {
  const r = prng(tokens.batch);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const code = (n: number) => Array.from({ length: n }, () => letters[Math.floor(r() * letters.length)]).join('');
  return tokens.productIds.map((id) => {
    const unit = Math.round((2 + r() * 178) * 100) / 100;
    const landed = Math.round((unit * 1490 * (1.08 + r() * 0.2)) / 250) * 250;
    const factor = 1.18 + r() * 0.27;
    const price = Math.max(landed + 250, Math.round((landed * factor) / 250) * 250);
    return {
      product_id: id,
      sku: `LV-${code(3)}-${100 + Math.floor(r() * 900)}`,
      name: `${pick(BRANDS)} ${pick(PARTS)}`,
      supplier_code: `SUP-${code(4)}`,
      unit_cost_usd: unit,
      landed_cost_iqd: landed,
      price_iqd: price,
      margin_pct: Math.round(((price - landed) / price) * 1000) / 10,
    };
  });
}

export interface DecoyContext {
  /** The host that was asked, as classified (never echoed unless it is the request's own). */
  host: string;
  /** The configured root domain, for the e-mail canary and the internal names. */
  rootDomain: string;
  /** The request's method and path. */
  method: string;
  path: string;
}

export interface DecoyAnswer {
  status: number;
  contentType: string;
  body: string;
  /** A same-site redirect (the fake WordPress sign-in), never off the site. */
  location?: string;
}

const csvCell = (v: string | number) => (typeof v === 'number' ? String(v) : `"${v.replace(/"/g, '""')}"`);
const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function noise(r: () => number, n: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: n }, () => chars[Math.floor(r() * chars.length)]).join('');
}

function htmlPage(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><title>${htmlEscape(title)}</title><style>body{font-family:sans-serif;background:#f1f1f1;color:#222;margin:40px}form,.box{background:#fff;padding:24px;max-width:420px;border:1px solid #ddd}label{display:block;margin:12px 0 4px}input{width:100%;padding:6px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;font-size:12px}</style></head><body>${inner}</body></html>`;
}

/**
 * The answer a decoy gives, from the batch's tokens alone. PURE: the same
 * (code, tokens, context) always renders the same bytes.
 */
export function renderDecoy(code: DecoyCode, tokens: CanaryBatch, ctx: DecoyContext): DecoyAnswer {
  const r = prng(`${tokens.batch}${code}`);
  const rows = fakeRows(tokens);
  const base = `https://${ctx.host}`;
  const internal = 'levonis.internal';
  const nextPage = `${base}/api/internal/pricing/costs?page=2&key=${tokens.apiKey}`;
  switch (code) {
    case 'env':
      return {
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: [
          'APP_ENV=production',
          `APP_URL=${base}`,
          `API_BASE=${base}/api/internal`,
          `LEVONIS_API_KEY=${tokens.apiKey}`,
          `ADMIN_EMAIL=${tokens.email}`,
          `ADMIN_PASSWORD=${tokens.password}`,
          `DB_HOST=db-primary.${internal}`,
          'DB_PORT=5432',
          'DB_NAME=levonis_prod',
          'DB_USER=levonis_app',
          `DB_PASSWORD=${tokens.dbPassword}`,
          `PRICING_EXPORT_URL=${base}/api/internal/pricing/costs?key=${tokens.apiKey}`,
          `SESSION_SECRET=${noise(r, 48)}`,
          'CACHE_TTL=300',
          '',
        ].join('\n'),
      };
    case 'git_config':
      if (ctx.path === '/.git/HEAD') return { status: 200, contentType: 'text/plain; charset=utf-8', body: 'ref: refs/heads/main\n' };
      return {
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: [
          '[core]',
          '\trepositoryformatversion = 0',
          '\tfilemode = true',
          '\tbare = false',
          '[remote "origin"]',
          `\turl = https://deploy:${tokens.password}@git.${internal}/levonis/backend.git`,
          '\tfetch = +refs/heads/*:refs/remotes/origin/*',
          '[branch "main"]',
          '\tremote = origin',
          '\tmerge = refs/heads/main',
          '[user]',
          `\temail = ${tokens.email}`,
          '\tname = ops',
          '',
        ].join('\n'),
      };
    case 'config_json':
      return {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(
          {
            env: 'production',
            api: { base: `${base}/api/internal`, key: tokens.apiKey },
            admin: { email: tokens.email, password: tokens.password, session: tokens.session },
            database: { host: `db-primary.${internal}`, user: 'levonis_app', password: tokens.dbPassword },
            pricing: { export: `${base}/admin/export/costs.csv?token=${tokens.apiKey}`, featured: rows.slice(0, 3).map((x) => x.product_id) },
          },
          null,
          2
        ),
      };
    case 'sql_dump': {
      const lines = [
        '-- dump of levonis_prod',
        `-- host: db-primary.${internal}`,
        'CREATE TABLE product_costs (product_id TEXT PRIMARY KEY, sku TEXT, name TEXT, supplier_code TEXT, unit_cost_usd REAL, landed_cost_iqd INTEGER, price_iqd INTEGER, margin_pct REAL);',
        ...rows.map(
          (x) =>
            `INSERT INTO product_costs VALUES ('${x.product_id}','${x.sku}','${x.name.replace(/'/g, "''")}','${x.supplier_code}',${x.unit_cost_usd},${x.landed_cost_iqd},${x.price_iqd},${x.margin_pct});`
        ),
        'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, password_hash TEXT);',
        `INSERT INTO users VALUES ('usr_${tokens.batch}01','${tokens.email}','admin','$2b$12$${noise(r, 53)}');`,
        '',
      ];
      return { status: 200, contentType: 'application/sql; charset=utf-8', body: lines.join('\n') };
    }
    case 'costs_export': {
      const header = ['product_id', 'sku', 'name', 'supplier_code', 'unit_cost_usd', 'landed_cost_iqd', 'price_iqd', 'margin_pct'];
      const body = [
        header.join(','),
        ...rows.map((x) => [x.product_id, x.sku, x.name, x.supplier_code, x.unit_cost_usd, x.landed_cost_iqd, x.price_iqd, x.margin_pct].map(csvCell).join(',')),
        `# next page: ${nextPage}`,
        '',
      ].join('\n');
      return { status: 200, contentType: 'text/csv; charset=utf-8', body };
    }
    case 'internal_costs':
    case 'v0_admin':
      return {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ success: true, page: 1, products: rows, next: nextPage }),
      };
    case 'wp_login': {
      if (ctx.path === '/xmlrpc.php') {
        return {
          status: 200,
          contentType: 'text/xml; charset=utf-8',
          body: '<?xml version="1.0" encoding="UTF-8"?>\n<methodResponse><params><param><value><array><data><value><string>system.listMethods</string></value><value><string>wp.getUsersBlogs</string></value></data></array></value></param></params></methodResponse>\n',
        };
      }
      if (ctx.path === '/wp-login.php' && ctx.method === 'POST') {
        return { status: 302, contentType: 'text/html; charset=utf-8', body: '', location: '/wp-admin/' };
      }
      if (ctx.path.startsWith('/wp-admin')) {
        return {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: htmlPage(
            'Dashboard',
            `<div class="box"><h1>Dashboard</h1><p>Welcome back, ops.</p><p><a href="/admin/export/costs.csv?token=${htmlEscape(tokens.apiKey)}">Export product costs (CSV)</a></p><p>API key: <code>${htmlEscape(tokens.apiKey)}</code></p></div>`
          ),
        };
      }
      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: htmlPage(
          'Log In',
          '<form method="post" action="/wp-login.php"><h1>Log In</h1><label for="user_login">Username or Email Address</label><input type="text" name="log" id="user_login"><label for="user_pass">Password</label><input type="password" name="pwd" id="user_pass"><p><input type="submit" value="Log In"></p></form>'
        ),
      };
    }
    case 'phpmyadmin': {
      if (ctx.method === 'POST') {
        const table = rows
          .slice(0, 6)
          .map((x) => `<tr><td>${htmlEscape(x.product_id)}</td><td>${htmlEscape(x.name)}</td><td>${x.unit_cost_usd}</td><td>${x.landed_cost_iqd}</td><td>${x.price_iqd}</td></tr>`)
          .join('');
        return {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: htmlPage(
            'phpMyAdmin',
            `<div class="box"><h1>levonis_prod</h1><p>Tables: product_costs, users, orders, suppliers</p><table><tr><th>product_id</th><th>name</th><th>unit_cost_usd</th><th>landed_cost_iqd</th><th>price_iqd</th></tr>${table}</table><p><a href="/admin/export/costs.csv?token=${htmlEscape(tokens.apiKey)}">Export</a></p></div>`
          ),
        };
      }
      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: htmlPage(
          'phpMyAdmin',
          '<form method="post" action="/phpmyadmin/index.php"><h1>Welcome to phpMyAdmin</h1><label for="u">Username</label><input type="text" name="pma_username" id="u"><label for="p">Password</label><input type="password" name="pma_password" id="p"><p><input type="submit" value="Log in"></p></form>'
        ),
      };
    }
  }
}

/** The decoy's own policy: no script anywhere, forms post only to this site. */
export const DECOY_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
