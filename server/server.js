// Minimal static server for the LMS frontend.
// Multi-tenant routing: /<slug>/* resolves to the tenant-aware course/admin shell.
// Bare / serves the neutral GDAA landing page (index.html).
// Phase 2 will add a /api/certificate endpoint here for server-signed PDFs.

const express = require('express');
const path = require('path');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 8080;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Reserved top-level paths that must NOT be treated as a tenant slug.
// (Anything in /public/ that the browser may request directly.)
const RESERVED = new Set([
  'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml',
  'auth.js', 'config.js', 'course_data.json',
  'course.html', 'admin.html', 'index.html',
  'verify', 'health', 'api'
]);

// Slugs are URL-safe lowercase: a-z 0-9 - (3-40 chars). Tighten later if needed.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

app.use(compression());

// Health check (used by fly.io)
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

// Public certificate verification — anyone can hit this.
// /verify             -> lookup form
// /verify/<64hex>     -> result card (verify.html reads hash from URL)
app.get(/^\/verify(?:\/([0-9a-f]{64}))?\/?$/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'verify.html'));
});

// ------- Tenant routing (must come BEFORE express.static so it can rewrite) -------
//   /<slug>            -> course.html?tenant=<slug>
//   /<slug>/           -> course.html?tenant=<slug>
//   /<slug>/admin      -> admin.html?tenant=<slug>
//   /<slug>/admin/     -> admin.html?tenant=<slug>
//   /admin             -> admin.html (super-admin all-tenants view; no tenant query)
//   /verify/<hash>     -> verify.html (Phase 2 — file may not exist yet)
app.get(/^\/([^\/]+)(?:\/(admin)?\/?)?$/, (req, res, next) => {
  const slug = req.params[0].toLowerCase();
  const sub  = req.params[1]; // 'admin' or undefined

  // Don't shadow real files
  if (RESERVED.has(slug)) return next();

  // /admin -> super-admin view (no tenant)
  if (slug === 'admin' && !sub) {
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  }

  // /verify/<hash> -> verify page (Phase 2)
  if (slug === 'verify') return next();

  if (!SLUG_RE.test(slug)) return next();

  // Set tenant cookie so client-side scripts can pick it up without re-parsing URL
  res.set('X-Tenant-Slug', slug);

  if (sub === 'admin') {
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'course.html'));
});

// Static assets (after tenant routing so /<slug> doesn't get intercepted by express.static)
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // Don't cache the entrypoints or runtime config; we want updates to land immediately
    if (/(course\.html|admin\.html|index\.html|config\.js|auth\.js|tenant\.js|course_data\.json)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Bare root -> neutral GDAA landing
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Anything else -> 404 to landing
app.get('*', (_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`mygenesis-training listening on :${PORT}`);
});
