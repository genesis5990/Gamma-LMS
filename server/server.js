// Express server for the LMS frontend + API.
//
// Phase 3 additions:
//   * /courses                — public catalog (Stripe pay-per-course landing)
//   * /api/checkout           — create Stripe Checkout session for a course
//   * /api/stripe/webhook     — Stripe webhook (signature-verified, raw body)
//   * /api/public-config      — runtime config for the catalog page
//   * /admin/requests         — super-admin access-request queue
//   * /:slug/admin/requests   — tenant-scoped access-request queue

const express = require('express');
const path = require('path');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 8080;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Reserved top-level paths that must NOT be treated as a tenant slug.
const RESERVED = new Set([
  'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml',
  'auth.js', 'config.js', 'tenant.js', 'course_data.json',
  'course.html', 'admin.html', 'index.html', 'courses.html', 'admin-requests.html',
  'verify', 'health', 'api', 'courses', 'preview', 'studio', 'dashboard',
  'terms', 'privacy',
  'studio.html', 'studio.js', 'studio.css',
  'dashboard.html', 'dashboard.js'
]);

// Slugs are URL-safe lowercase: a-z 0-9 - (3-40 chars).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

// ---- Stripe (lazy require so missing key during dev/local doesn't crash boot) ----
const STRIPE_SECRET     = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUB_KEY    = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK    = process.env.STRIPE_WEBHOOK_SECRET || '';
// SOC 2 F-02: no hardcoded fallbacks. The publishable key and project URL
// are operational secrets from a rotation/abuse-response standpoint even
// though they're "public" under Supabase's RLS threat model. They must
// come from env (Fly secrets in prod). Boot fails loudly if missing so a
// misconfigured deploy never silently uses a baked-in default.
const SUPABASE_URL      = process.env.SUPABASE_URL || '';
const SUPABASE_PUB_KEY  = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_PUB_KEY) {
  console.error('[boot] FATAL: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in env. Refusing to start.');
  process.exit(1);
}
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PUBLIC_SITE_URL   = process.env.PUBLIC_SITE_URL || 'https://mygenesis-training.fly.dev';
const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const RESEND_FROM       = process.env.RESEND_FROM || 'Deconflict <noreply@mygenesis-training.com>';

let stripe = null;
if (STRIPE_SECRET) {
  try {
    stripe = require('stripe')(STRIPE_SECRET);
  } catch (err) {
    console.error('[stripe] failed to init:', err.message);
  }
} else {
  console.warn('[stripe] STRIPE_SECRET_KEY not set — checkout endpoints will return 503');
}

// Course catalog (single course this phase). amount_cents is authoritative server-side.
// SYNC: keep amount_cents in sync with the SQL function `course_amount_cents(slug)`
// (migration 0024). Both must agree on the price for any coupon-eligible course.
const CATALOG = {
  crypto101: {
    course_id: 'crypto101',
    name: 'Crypto Intelligence Sharing',
    description: 'Conceptual foundations + applied tracing for law-enforcement and compliance investigators.',
    amount_cents: 29900,
    currency: 'usd'
  }
};

// Cache resolved Stripe price IDs per course so we don't hit the API every checkout.
const _priceCache = new Map();
async function getOrCreatePriceId(courseId) {
  if (_priceCache.has(courseId)) return _priceCache.get(courseId);
  const c = CATALOG[courseId];
  if (!c) throw new Error(`unknown course: ${courseId}`);

  // Idempotent search by metadata.course_id
  const products = await stripe.products.search({
    query: `metadata['course_id']:'${courseId}' AND active:'true'`,
    limit: 1
  });
  let product = products.data[0];
  if (!product) {
    product = await stripe.products.create({
      name: c.name,
      description: c.description,
      metadata: { course_id: courseId }
    });
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
  let price = prices.data.find(p =>
    p.unit_amount === c.amount_cents && p.currency === c.currency && p.type === 'one_time'
  );
  if (!price) {
    price = await stripe.prices.create({
      product:     product.id,
      unit_amount: c.amount_cents,
      currency:    c.currency,
      metadata:    { course_id: courseId }
    });
  }
  _priceCache.set(courseId, price.id);
  return price.id;
}

app.use(compression());

// Security headers (HSTS, CSP, X-Frame, nosniff, Referrer-Policy, Permissions-Policy).
// Applied to every response. CSP allow-list mirrors actual loads:
//   * Supabase JS UMD bundle  -> cdn.jsdelivr.net (script-src)
//   * Supabase REST/Realtime  -> *.supabase.co (connect-src, wss)
//   * Supabase storage media  -> *.supabase.co (img-src, media-src)
//   * frame-ancestors 'self'  -> studio preview iframe (same-origin) keeps working
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://*.supabase.co https://*.supabase.in",
  "media-src 'self' blob: https://*.supabase.co https://*.supabase.in",
  "connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co https://cdn.jsdelivr.net",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// =====================================================================
// Coming-soon gate
// All GET requests redirect to "/" except the passlist below. The homepage
// itself serves index.html (currently the coming-soon page).
// Bypass for admins: append ?preview=deconflict2026 to any URL once; a
// 30-day cookie carries the bypass on subsequent requests. The magic-link
// sender code (auth.js, studio.js, etc.) also appends the same query param
// to emailRedirectTo so callbacks from a fresh device pass the gate.
// =====================================================================
const COMING_SOON_BYPASS_TOKEN = 'deconflict2026';
const COMING_SOON_COOKIE_NAME  = 'cs_bypass';
const COMING_SOON_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Path prefixes that are NEVER gated. startsWith semantics:
// '/api/' matches '/api/<anything>'; '/verify' matches '/verify' and '/verify/<hash>'.
const COMING_SOON_ALLOW = [
  '/api/',              // all REST APIs (Stripe webhook, checkout, grade-quiz, admin/users, public-config)
  '/health',            // liveness check (Fly health probe)
  '/brand/',            // logos, favicons, manifest, needed by the coming-soon page itself
  '/preview/',          // already gated by previewAuthGate (author auth required)
  '/verify',            // public cert verification (URL is printed on every issued PDF)
  '/terms',             // legal disclosure (linked from receipts/emails)
  '/privacy',           // legal disclosure (linked from receipts/emails)
  '/config.js',         // server-rendered runtime config (no secrets, used by all client JS)
  '/course_data.json',  // scrubbed quiz data (answer keys stripped server-side)
  '/favicon',           // /favicon.ico, /favicon-*.png
  '/site.webmanifest',
  '/robots.txt',
  '/sitemap.xml',
];

function _hasComingSoonBypass(req) {
  if (req.query && req.query.preview === COMING_SOON_BYPASS_TOKEN) return 'query';
  const cookieHeader = req.headers['cookie'] || '';
  const m = new RegExp('(?:^|;\\s*)' + COMING_SOON_COOKIE_NAME + '=([^;]+)').exec(cookieHeader);
  if (m && decodeURIComponent(m[1]) === COMING_SOON_BYPASS_TOKEN) return 'cookie';
  return null;
}

app.use((req, res, next) => {
  console.log('[gate] HIT:', req.method, req.url);

  // Never gate non-GET methods (Stripe webhook, API writes, etc.).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    console.log('[gate] PASS: non-GET method');
    return next();
  }

  // Never gate the homepage itself (it serves the coming-soon page).
  if (req.path === '/') {
    console.log('[gate] PASS: homepage');
    return next();
  }

  // Never gate passlisted prefixes.
  for (const prefix of COMING_SOON_ALLOW) {
    if (req.path === prefix || req.path.startsWith(prefix)) {
      console.log('[gate] PASS: passlist', prefix);
      return next();
    }
  }

  // Bypass via ?preview=<token> or the cs_bypass cookie.
  const src = _hasComingSoonBypass(req);
  if (src) {
    if (src === 'query') {
      // Persist the bypass for 30 days so admins only need to do this once per device.
      res.cookie(COMING_SOON_COOKIE_NAME, COMING_SOON_BYPASS_TOKEN, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
        maxAge: COMING_SOON_COOKIE_MAX_AGE
      });
    }
    console.log('[gate] PASS: bypass', src);
    return next();
  }

  // Lock everything else behind the gate.
  console.log('[gate] REDIRECT:', req.url, '-> /');
  res.redirect(302, '/');
});

// =====================================================================
// /preview/* author gate (#9)
// Gated to course authors and admins (super_admin / tenant_admin / instructor).
// Token sources accepted (in order): Authorization: Bearer, ?access_token=, or
// the supabase-js localStorage cookie if the client sets one.
// =====================================================================
const PREVIEW_AUTHOR_ROLES = new Set(['super_admin', 'tenant_admin', 'instructor']);

function extractAccessToken(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  if (typeof req.query.access_token === 'string' && req.query.access_token) return req.query.access_token;
  const cookie = req.headers['cookie'] || '';
  const m = /(?:^|;\s*)sb-access-token=([^;]+)/.exec(cookie);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

// Preview-bucket assets that are safe to serve unauthenticated. The
// stylesheets contain no answer keys / no author content; the studio shell
// loads le-preview.css to theme its in-app preview pane and would otherwise
// 401 on every page load. Paths are relative to the /preview mount point.
const PREVIEW_PUBLIC_SUBPATHS = new Set([
  '/le-preview.css'
]);

async function previewAuthGate(req, res, next) {
  if (PREVIEW_PUBLIC_SUBPATHS.has(req.path)) {
    return next();
  }
  if (!SUPABASE_SVC_KEY) {
    console.warn('[preview-gate] SUPABASE_SERVICE_ROLE_KEY not set; denying');
    return res.status(503).json({ error: 'preview gate misconfigured' });
  }
  const token = extractAccessToken(req);
  if (!token) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).json({ error: 'preview is restricted to course authors; sign in and supply Authorization: Bearer <token>' });
  }
  let userId;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SVC_KEY,
        Authorization: `Bearer ${token}`
      }
    });
    if (!ur.ok) return res.status(401).json({ error: 'invalid or expired token' });
    const u = await ur.json().catch(() => null);
    userId = u && u.id;
    if (!userId) return res.status(401).json({ error: 'token did not resolve to a user' });
  } catch (err) {
    console.warn('[preview-gate] auth lookup failed:', err.message);
    return res.status(502).json({ error: 'auth lookup failed' });
  }
  try {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role&limit=1`, {
      headers: {
        apikey: SUPABASE_SVC_KEY,
        Authorization: `Bearer ${SUPABASE_SVC_KEY}`
      }
    });
    if (!pr.ok) return res.status(502).json({ error: 'role lookup failed' });
    const rows = await pr.json().catch(() => []);
    const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
    if (!PREVIEW_AUTHOR_ROLES.has(role)) {
      res.set('Cache-Control', 'no-store');
      return res.status(403).json({ error: 'preview is restricted to course authors' });
    }
  } catch (err) {
    console.warn('[preview-gate] role lookup failed:', err.message);
    return res.status(502).json({ error: 'role lookup failed' });
  }
  return next();
}

app.use('/preview', previewAuthGate);

// Health check
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

// SOC 2 F-02: /config.js is server-rendered from env at request time.
// This MUST be registered before express.static so it shadows any
// public/config.js file (which has been removed). Rotating the
// publishable key is now "set Fly secret + restart" — no code change.
app.get('/config.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  // JSON.stringify guards against any character in the env value breaking
  // out of the string literal. PASS_THRESHOLD is a non-secret default —
  // course.html overrides it per-course from server data.
  res.send(
    '// Runtime config — server-rendered from env (SOC 2 F-02). Do not commit a static copy.\n' +
    'window.SUPABASE_URL = '             + JSON.stringify(SUPABASE_URL)       + ';\n' +
    'window.SUPABASE_PUBLISHABLE_KEY = ' + JSON.stringify(SUPABASE_PUB_KEY)   + ';\n' +
    'window.COURSE_ID = '                + JSON.stringify('crypto101')        + ';\n' +
    'window.PASS_THRESHOLD = 0.7;\n'
  );
});

// Runtime config for client pages (publishable values only — no secrets here).
app.get('/api/public-config', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({
    supabase_url:             SUPABASE_URL,
    supabase_publishable_key: SUPABASE_PUBLISHABLE_KEY_FOR_CONFIG(),
    stripe_publishable_key:   STRIPE_PUB_KEY,
    public_site_url:          PUBLIC_SITE_URL,
    catalog: Object.values(CATALOG).map(c => ({
      course_id:    c.course_id,
      name:         c.name,
      description:  c.description,
      amount_cents: c.amount_cents,
      currency:     c.currency
    }))
  });
});

function SUPABASE_PUBLISHABLE_KEY_FOR_CONFIG() {
  return SUPABASE_PUB_KEY;
}

// =====================================================================
// Stripe webhook — MUST come before express.json() so raw body is available.
// =====================================================================
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(503).send('stripe not configured');
    if (!STRIPE_WEBHOOK) return res.status(503).send('webhook secret not configured');

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK
      );
    } catch (err) {
      console.warn('[stripe webhook] signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const courseId = session.metadata?.course_id || null;
        const email    = session.customer_details?.email || session.customer_email || null;
        if (courseId && email) {
          const isPaid = session.payment_status === 'paid';
          const amountCents = session.amount_total || CATALOG[courseId]?.amount_cents || 0;
          const currency    = session.currency || 'usd';
          const purchaseRow = await upsertPurchase({
            user_id:               session.client_reference_id || null,
            email,
            course_id:             courseId,
            stripe_session_id:     session.id,
            stripe_payment_intent: session.payment_intent || null,
            stripe_customer_id:    session.customer || null,
            amount_cents:          amountCents,
            currency,
            status:                isPaid ? 'paid' : 'pending',
            paid_at:               isPaid ? new Date().toISOString() : null
          });

          if (isPaid) {
            const purchaseId = Array.isArray(purchaseRow) ? purchaseRow[0]?.id : purchaseRow?.id;

            // Fire-and-await fulfillment, but never let failures block the 200 to Stripe.
            try {
              await fulfillPurchase({
                email,
                courseId,
                sessionId: session.id,
                amountCents,
                currency,
                purchaseId
              });
            } catch (fulfillErr) {
              console.warn('[stripe webhook] fulfillment error (non-fatal):', fulfillErr.message);
            }

            // Record coupon redemption if the checkout session carried one.
            const couponId = session.metadata?.coupon_id || null;
            if (couponId) {
              try {
                const userId = session.client_reference_id || (await lookupUserIdByEmail(email));
                await supabaseRpc('record_coupon_redemption', {
                  p_coupon_id:      couponId,
                  p_user_id:        userId,
                  p_email:          email,
                  p_course_slug:    courseId,
                  p_purchase_id:    purchaseId,
                  p_original_cents: parseInt(session.metadata.original_cents || '0', 10),
                  p_discount_cents: parseInt(session.metadata.discount_cents || '0', 10),
                  p_final_cents:    parseInt(session.metadata.final_cents || String(amountCents), 10)
                });
              } catch (rerr) {
                console.warn('[stripe webhook] record_coupon_redemption failed (non-fatal):', rerr.message);
              }
            }
          }
        }
      } else if (event.type === 'charge.refunded') {
        const charge = event.data.object;
        const pi     = charge.payment_intent;
        if (pi) {
          await markPurchaseRefunded(pi);
        }
      }
    } catch (err) {
      console.error('[stripe webhook] handler error:', err);
      // Return 500 so Stripe retries
      return res.status(500).send('handler error');
    }

    res.json({ received: true });
  }
);

// JSON body parsing for the rest of the API.
app.use('/api', express.json({ limit: '64kb' }));

// =====================================================================
// Server-side quiz grading for the legacy v1 course (course_data.json
// keyed by lesson_id text). Source-of-truth answer keys live in the JSON
// on disk; we read them privately and never ship them to the browser.
// The new authoring schema is graded by the public.grade_attempt RPC
// (migration 0016).
// =====================================================================
const fs = require('fs');
const QUIZ_KEY_FIELDS = ['correct', 'answer', 'answer_index'];

function loadCourseData() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'course_data.json'), 'utf8'));
  } catch (err) {
    console.error('[grade-quiz] failed to read course_data.json:', err.message);
    return null;
  }
}
function loadPreviewCourse(slug) {
  const safe = /^[a-z0-9-]+$/.test(slug) ? slug : null;
  if (!safe) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'preview', `${safe}.course.json`), 'utf8'));
  } catch (err) {
    return null;
  }
}

// Recursively strip quiz answer-key fields from any object. Used to scrub
// course_data.json and /preview/*.course.json before serving.
function stripQuizKeys(node) {
  if (Array.isArray(node)) return node.map(stripQuizKeys);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) {
      if (QUIZ_KEY_FIELDS.includes(k)) continue;
      out[k] = stripQuizKeys(node[k]);
    }
    return out;
  }
  return node;
}

// Serve the scrubbed legacy course payload.
app.get('/course_data.json', (_req, res) => {
  const data = loadCourseData();
  if (!data) return res.status(500).json({ error: 'course data unavailable' });
  res.set('Cache-Control', 'no-cache');
  res.json(stripQuizKeys(data));
});

// Serve the scrubbed preview course payload (anonymous content review).
app.get(/^\/preview\/([a-z0-9-]+)\.course\.json$/, (req, res) => {
  const data = loadPreviewCourse(req.params[0]);
  if (!data) return res.status(404).json({ error: 'preview not found' });
  res.set('Cache-Control', 'no-cache');
  res.json(stripQuizKeys(data));
});

// Grade a legacy v1 quiz. Body: { lesson_id, answers: { "<qIndex>": "<key|index>" } }.
// Returns { score, total, passed, wrong, threshold }. Does NOT write to
// quiz_attempts itself — the existing client (auth.js#saveQuizAttempt) will
// call sb.from('quiz_attempts').insert(...) on success, preserving the
// per-user audit trail under RLS. We just compute the truth server-side.
app.post('/api/grade-quiz', (req, res) => {
  const { lesson_id, answers } = req.body || {};
  if (typeof lesson_id !== 'string' || !lesson_id) return res.status(400).json({ error: 'lesson_id required' });
  if (!answers || typeof answers !== 'object')      return res.status(400).json({ error: 'answers required' });

  const data = loadCourseData();
  if (!data || !data.quizzes) return res.status(500).json({ error: 'course data unavailable' });

  const quiz = data.quizzes[lesson_id];
  if (!Array.isArray(quiz)) return res.status(404).json({ error: 'quiz not found' });

  let correctCount = 0;
  const wrong = [];
  quiz.forEach((q, i) => {
    const truth = q.correct != null ? String(q.correct)
                : q.answer != null  ? String(q.answer)
                : null;
    const picked = answers[String(i)];
    const pickedStr = picked == null ? null : String(picked);
    if (truth != null && pickedStr === truth) correctCount++;
    else wrong.push(i);
  });

  const total     = quiz.length;
  const score     = total > 0 ? Math.round((correctCount / total) * 100) : 0;
  const threshold = Math.round(((typeof data.pass_threshold === 'number' ? data.pass_threshold : 0.7)) * 100);
  const passed    = score >= threshold;

  res.set('Cache-Control', 'no-cache');
  res.json({ score, total, correct: correctCount, passed, wrong, threshold });
});

// =====================================================================
// /api/checkout — create Stripe Checkout session for a course.
// Optional body field `coupon_code` triggers server-side validation via
// preview_coupon RPC. If the coupon resolves to is_free=true (e.g. 100% off)
// we skip Stripe entirely, write purchase + enrollment + redemption rows
// directly with service-role credentials, and return { free: true, redirect }.
// =====================================================================
async function supabaseRpc(fn, params, jwt) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SVC_KEY,
    Authorization: `Bearer ${jwt || SUPABASE_SVC_KEY}`
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params || {})
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`rpc ${fn} ${resp.status}: ${txt}`);
  }
  return resp.json().catch(() => null);
}

async function getUserFromBearer(req) {
  const token = extractAccessToken(req);
  if (!token || !SUPABASE_SVC_KEY) return null;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${token}` }
    });
    if (!ur.ok) return null;
    const u = await ur.json().catch(() => null);
    if (!u || !u.id) return null;
    return { id: u.id, email: u.email || null, token };
  } catch (_e) {
    return null;
  }
}

app.post('/api/checkout', async (req, res) => {
  // Lockdown (coming-soon mode): no new enrollments while the gate is up.
  // The Stripe webhook handler is intentionally NOT gated so any purchases
  // already in flight at Stripe complete and fulfill normally.
  return res.status(503).json({ error: 'Enrollment temporarily paused. Please check back shortly.' });

  const { course_id, success_url, cancel_url, user_id, coupon_code } = req.body || {};
  const c = CATALOG[course_id];
  if (!c) return res.status(400).json({ error: 'unknown course_id' });

  // Coupons require an authenticated user (preview_coupon enforces this too,
  // but failing fast gives a clearer error).
  let user = null;
  if (coupon_code) {
    user = await getUserFromBearer(req);
    if (!user) {
      return res.status(401).json({ error: 'sign in required to apply a coupon' });
    }
  }

  // ---- Server-side coupon validation (never trust the client) ----
  let coupon = null;
  if (coupon_code) {
    if (!SUPABASE_SVC_KEY) return res.status(503).json({ error: 'coupon validation unavailable' });
    try {
      // Validate as the user (RLS-aware) using their JWT — preview_coupon
      // checks per-user redemption history and LE-only access.
      coupon = await supabaseRpc('preview_coupon',
        { p_code: String(coupon_code).trim(), p_course_slug: course_id },
        user.token);
    } catch (err) {
      console.warn('[checkout] preview_coupon failed:', err.message);
      return res.status(500).json({ error: 'coupon validation failed' });
    }
    if (!coupon || coupon.valid !== true) {
      const reason = (coupon && coupon.reason) || 'invalid';
      return res.status(400).json({ error: 'coupon ' + reason, reason });
    }
  }

  // ---- Free path (100% off): skip Stripe entirely ----
  if (coupon && coupon.is_free === true) {
    if (!SUPABASE_SVC_KEY) return res.status(503).json({ error: 'free-checkout unavailable' });
    try {
      const sessionToken = 'free_' + (globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : (Date.now() + '_' + Math.random().toString(36).slice(2)));
      const nowIso = new Date().toISOString();

      const purchaseRows = await supabaseWrite('purchases', 'POST', {
        user_id:           user.id,
        email:             user.email,
        course_id,
        stripe_session_id: sessionToken,
        amount_cents:      0,
        currency:          c.currency,
        status:            'paid',
        paid_at:           nowIso
      });
      const purchase = Array.isArray(purchaseRows) ? purchaseRows[0] : purchaseRows;
      const purchaseId = purchase && purchase.id ? purchase.id : null;

      // Upsert enrollment (course_id is text/slug — see schema).
      await supabaseWrite(
        'enrollments?on_conflict=user_id,course_id',
        'POST',
        { user_id: user.id, course_id, status: 'active', tenant_id: null }
      );

      // Record the redemption (service-role only).
      try {
        await supabaseRpc('record_coupon_redemption', {
          p_coupon_id:      coupon.coupon_id,
          p_user_id:        user.id,
          p_email:          user.email,
          p_course_slug:    course_id,
          p_purchase_id:    purchaseId,
          p_original_cents: coupon.original_cents,
          p_discount_cents: coupon.discount_cents,
          p_final_cents:    coupon.final_cents
        });
      } catch (rerr) {
        console.warn('[checkout] record_coupon_redemption failed (non-fatal):', rerr.message);
      }

      return res.json({
        free:     true,
        redirect: `/dashboard?free=1&course=${encodeURIComponent(course_id)}`
      });
    } catch (err) {
      console.error('[checkout] free-path error:', err);
      return res.status(500).json({ error: err.message || 'free checkout failed' });
    }
  }

  // ---- Stripe path (full price OR partial discount) ----
  if (!stripe) return res.status(503).json({ error: 'stripe not configured' });

  try {
    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      success_url: success_url || `${PUBLIC_SITE_URL}/courses?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancel_url  || `${PUBLIC_SITE_URL}/courses?status=cancelled`,
      client_reference_id: (user && user.id) || (typeof user_id === 'string' ? user_id : undefined),
      metadata: { course_id },
      customer_creation: 'always'
    };

    if (coupon && coupon.discount_cents > 0 && !coupon.is_free) {
      // Inline ad-hoc line item using final_cents — bypasses the catalog price.
      sessionParams.line_items = [{
        quantity: 1,
        price_data: {
          currency:    c.currency,
          unit_amount: coupon.final_cents,
          product_data: {
            name:        c.name,
            description: c.description + ` (coupon ${coupon.code} applied)`
          }
        }
      }];
      sessionParams.metadata = {
        course_id,
        coupon_id:      coupon.coupon_id,
        coupon_code:    coupon.code,
        original_cents: String(coupon.original_cents),
        discount_cents: String(coupon.discount_cents),
        final_cents:    String(coupon.final_cents)
      };
    } else {
      const priceId = await getOrCreatePriceId(course_id);
      sessionParams.line_items = [{ price: priceId, quantity: 1 }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('[checkout] error:', err);
    res.status(500).json({ error: err.message || 'checkout failed' });
  }
});

// =====================================================================
// Admin user creation — POST /api/admin/users
// Bearer JWT (super_admin or tenant_admin) is required. Caller's role and
// tenant_id are loaded from the DB (never trusted from the client). Role
// is allow-listed; super_admin escalation via this route is forbidden.
// tenant_admin's tenant_id is forced from their own profile row.
// =====================================================================
const ADMIN_USER_CREATE_ROLES = new Set(['super_admin', 'tenant_admin']);
const ADMIN_USER_TARGET_ROLES = new Set(['student', 'tenant_admin']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const _adminCreateRl = new Map(); // ip -> [timestamps]
function _rateLimit(ip, maxPerMin = 10) {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = (_adminCreateRl.get(ip) || []).filter(t => now - t < windowMs);
  if (arr.length >= maxPerMin) {
    _adminCreateRl.set(ip, arr);
    return false;
  }
  arr.push(now);
  _adminCreateRl.set(ip, arr);
  return true;
}

async function getCallerProfile(req) {
  const token = extractAccessToken(req);
  if (!token || !SUPABASE_SVC_KEY) return null;
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${token}` }
  });
  if (!ur.ok) return null;
  const u = await ur.json().catch(() => null);
  if (!u || !u.id) return null;
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=role,tenant_id,email&limit=1`, {
    headers: { apikey: SUPABASE_SVC_KEY, Authorization: `Bearer ${SUPABASE_SVC_KEY}` }
  });
  if (!pr.ok) return null;
  const rows = await pr.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return null;
  return { id: u.id, email: row.email || u.email || null, role: row.role, tenant_id: row.tenant_id || null };
}

app.post('/api/admin/users', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip || 'unknown';
  if (!_rateLimit(ip, 10)) return res.status(429).json({ error: 'rate limit exceeded' });

  const token = extractAccessToken(req);
  if (!token) return res.status(401).json({ error: 'authentication required' });

  if (!SUPABASE_SVC_KEY) return res.status(503).json({ error: 'admin user creation unavailable' });

  const caller = await getCallerProfile(req);
  if (!caller) return res.status(401).json({ error: 'authentication required' });
  if (!ADMIN_USER_CREATE_ROLES.has(caller.role)) {
    return res.status(403).json({ error: 'admin role required' });
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const agency = typeof body.agency_name === 'string' ? body.agency_name.trim() : '';
  const badge = typeof body.badge_number === 'string' ? body.badge_number.trim() : '';
  const role = typeof body.role === 'string' ? body.role.trim() : '';
  const sendInvite = body.send_invite !== false; // default true

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email is required' });
  if (!fullName) return res.status(400).json({ error: 'full_name is required' });
  if (fullName.length > 200) return res.status(400).json({ error: 'full_name too long (max 200)' });
  if (agency && agency.length > 200) return res.status(400).json({ error: 'agency_name too long (max 200)' });
  if (badge && badge.length > 50) return res.status(400).json({ error: 'badge_number too long (max 50)' });
  if (!ADMIN_USER_TARGET_ROLES.has(role)) {
    return res.status(400).json({ error: 'role must be one of student, tenant_admin' });
  }

  // Tenant assignment — tenant_admin is forced to their own tenant_id.
  // super_admin may target any tenant via body.tenant_id, else defaults to
  // their own tenant_id (required to insert a public.invitations row).
  let tenantId = null;
  if (caller.role === 'super_admin') {
    tenantId = (typeof body.tenant_id === 'string' && body.tenant_id)
      ? body.tenant_id
      : (caller.tenant_id || null);
  } else {
    tenantId = caller.tenant_id || null;
  }

  const userMetadata = {
    full_name: fullName,
    agency_name: agency || null,
    badge_number: badge || null,
    role,
    invited_role: role,
    tenant_id: tenantId
  };

  // For sendInvite=true into request_approval/invite_only tenants, the
  // handle_new_user trigger checks public.invitations first. Insert (or
  // refresh) a pending invitation BEFORE calling Auth invite so the trigger's
  // primary path takes over and the new user is provisioned with the right
  // tenant_id + role on first sign-in.
  if (sendInvite && tenantId) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/invitations?on_conflict=email,tenant_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SVC_KEY,
          Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          email,
          role,
          invited_by: caller.id,
          source: 'admin_invite'
        })
      }).then(async (r) => {
        if (!r.ok) {
          const t = await r.text();
          // Duplicate pending invites are fine — surface anything else.
          if (!/duplicate key|already exists/i.test(t)) {
            console.warn('[admin/users] invitations insert non-fatal:', r.status, t.slice(0, 200));
          }
        }
      });
    } catch (err) {
      console.warn('[admin/users] invitations insert error (continuing):', err.message);
    }
  }

  let createdUser = null;
  try {
    if (sendInvite) {
      const inviteResp = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SVC_KEY,
          Authorization: `Bearer ${SUPABASE_SVC_KEY}`
        },
        body: JSON.stringify({
          email,
          data: userMetadata,
          redirect_to: `${PUBLIC_SITE_URL}/dashboard?preview=deconflict2026`
        })
      });
      const txt = await inviteResp.text();
      if (!inviteResp.ok) {
        if (/already.*registered|exists/i.test(txt)) {
          return res.status(409).json({ error: 'A user with this email already exists.' });
        }
        console.warn('[admin/users] invite failed:', inviteResp.status, txt);
        return res.status(500).json({ error: 'invite failed: ' + txt.slice(0, 200) });
      }
      try { createdUser = JSON.parse(txt); } catch (_) { createdUser = null; }
    } else {
      const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SVC_KEY,
          Authorization: `Bearer ${SUPABASE_SVC_KEY}`
        },
        body: JSON.stringify({
          email,
          email_confirm: true,
          user_metadata: userMetadata
        })
      });
      const txt = await createResp.text();
      if (!createResp.ok) {
        if (/already.*registered|exists/i.test(txt)) {
          return res.status(409).json({ error: 'A user with this email already exists.' });
        }
        console.warn('[admin/users] create failed:', createResp.status, txt);
        return res.status(500).json({ error: 'create failed: ' + txt.slice(0, 200) });
      }
      try { createdUser = JSON.parse(txt); } catch (_) { createdUser = null; }
    }
  } catch (err) {
    console.error('[admin/users] auth call error:', err);
    return res.status(500).json({ error: err.message || 'auth call failed' });
  }

  const newUserId = createdUser?.id || createdUser?.user?.id || null;
  if (!newUserId) {
    console.error('[admin/users] no user id returned:', createdUser);
    return res.status(500).json({ error: 'auth user created but no id returned' });
  }

  // Upsert profile (handle_new_user trigger may already have inserted a row;
  // upsert merges our admin-supplied fields on top).
  try {
    await supabaseWrite('profiles?on_conflict=id', 'POST', {
      id: newUserId,
      email,
      full_name: fullName,
      role,
      tenant_id: tenantId,
      agency_name: agency || null,
      badge_number: badge || null
    });
  } catch (err) {
    console.error('[admin/users] profile upsert failed:', err.message);
    return res.status(500).json({ error: 'auth user created but profile upsert failed: ' + err.message });
  }

  res.status(201).json({ id: newUserId, email, role, invited: sendInvite });
});

// =====================================================================
// Helpers — Supabase REST writes (service-role)
// =====================================================================
async function supabaseWrite(pathSuffix, method, body, params = '') {
  if (!SUPABASE_SVC_KEY) {
    console.warn('[supabase] SUPABASE_SERVICE_ROLE_KEY not set — purchase row not written');
    return null;
  }
  const url = `${SUPABASE_URL}/rest/v1/${pathSuffix}${params}`;
  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SVC_KEY,
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`supabase ${method} ${pathSuffix} ${resp.status}: ${txt}`);
  }
  return resp.json().catch(() => null);
}

async function upsertPurchase(row) {
  return supabaseWrite('purchases?on_conflict=stripe_session_id', 'POST', row);
}

async function markPurchaseRefunded(paymentIntent) {
  return supabaseWrite(
    'purchases',
    'PATCH',
    { status: 'refunded', refunded_at: new Date().toISOString() },
    `?stripe_payment_intent=eq.${encodeURIComponent(paymentIntent)}`
  );
}

// =====================================================================
// PPC fulfillment (Phase 3.5)
//   1. Look up auth user by email (existing buyer)
//   2. If found: backfill purchases.user_id + upsert enrollments
//      If not:  generate_link auto-creates the auth.users row, and the
//               handle_new_user trigger does the linkage in-band
//   3. Send branded Resend email with a magic-link sign-in button.
// Webhook returns 200 even if email fails — purchase + enrollment are durable.
// =====================================================================
async function lookupUserIdByEmail(email) {
  if (!SUPABASE_SVC_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`;
  const resp = await fetch(url, {
    headers: {
      apikey: SUPABASE_SVC_KEY,
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`
    }
  });
  if (!resp.ok) {
    console.warn('[fulfill] profile lookup failed:', resp.status, await resp.text().catch(() => ''));
    return null;
  }
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
}

async function generateMagicLink(email, redirectTo) {
  if (!SUPABASE_SVC_KEY) return null;
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SVC_KEY,
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`
    },
    body: JSON.stringify({
      type: 'magiclink',
      email,
      options: { redirect_to: redirectTo }
    })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.warn('[fulfill] generate_link failed:', resp.status, txt);
    return null;
  }
  const data = await resp.json().catch(() => ({}));
  return data?.action_link || data?.properties?.action_link || null;
}

async function linkPurchaseAndEnroll(userId, email, courseId) {
  // Backfill purchases.user_id for any paid rows under this email
  await supabaseWrite(
    'purchases',
    'PATCH',
    { user_id: userId },
    `?email=eq.${encodeURIComponent(email)}&user_id=is.null&status=eq.paid`
  ).catch((err) => {
    console.warn('[fulfill] purchase backfill failed:', err.message);
  });

  // Upsert enrollment (user_id, course_id) — tenant_id NULL for PPC
  await supabaseWrite(
    'enrollments?on_conflict=user_id,course_id',
    'POST',
    { user_id: userId, course_id: courseId, status: 'active', tenant_id: null }
  ).catch((err) => {
    console.warn('[fulfill] enrollment upsert failed:', err.message);
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function purchaseEmailHtml({ courseName, amountCents, currency, sessionId, magicLink }) {
  const last8 = (sessionId || '').slice(-8);
  const amount = (amountCents / 100).toFixed(2);
  const cur    = (currency || 'usd').toUpperCase();
  const date   = new Date().toUTCString();
  const cname  = escapeHtml(courseName);
  const link   = magicLink;

  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0d1424;background:#f7f8fc;margin:0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #d9dfee;padding:32px;">
      <img src="https://mygenesis-training.com/brand/logo-horizontal-dark-320.png" alt="Deconflict" width="240" style="display:block;margin:0 0 20px;" />
      <h2 style="margin:0 0 12px;font-size:20px;">Your ${cname} access is ready.</h2>
      <p style="margin:0 0 16px;color:#3a4666;">Thank you for purchasing <strong>${cname}</strong> ($${escapeHtml(amount)} ${escapeHtml(cur)}).</p>
      <p style="margin:0 0 16px;color:#3a4666;">Click the button below to sign in and start the course. You're already enrolled. The link will sign you in automatically.</p>
      <p style="margin:0 0 24px;text-align:center;">
        <a href="${link}" style="display:inline-block;background:#1f63d6;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">Sign in to start the course</a>
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:13px;color:#3a4666;">
        <tr><td style="padding:6px 0;color:#5b6788;">Receipt</td><td style="padding:6px 0;text-align:right;">${escapeHtml(last8)}</td></tr>
        <tr><td style="padding:6px 0;color:#5b6788;">Amount</td><td style="padding:6px 0;text-align:right;">$${escapeHtml(amount)} ${escapeHtml(cur)}</td></tr>
        <tr><td style="padding:6px 0;color:#5b6788;">Date</td><td style="padding:6px 0;text-align:right;">${escapeHtml(date)}</td></tr>
      </table>
      <p style="margin:0 0 12px;color:#5b6788;font-size:13px;">This sign-in link is valid until used or for 30 days. If the button doesn't work, copy and paste this URL into your browser:</p>
      <p style="margin:0 0 16px;word-break:break-all;color:#5b6788;font-size:12px;">${escapeHtml(link)}</p>
      <p style="margin:0 0 16px;color:#5b6788;font-size:12px;">A separate receipt from Stripe will arrive shortly.</p>
      <hr style="border:0;border-top:1px solid #d9dfee;margin:24px 0;" />
      <p style="margin:0;color:#5b6788;font-size:12px;">Deconflict</p>
    </div>
  </body></html>`;
}

async function sendPurchaseEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('[fulfill] RESEND_API_KEY not set — purchase email skipped');
    return false;
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`
    },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.warn('[fulfill] resend send failed:', resp.status, txt);
    return false;
  }
  return true;
}

async function fulfillPurchase({ email, courseId, sessionId, amountCents, currency }) {
  if (!SUPABASE_SVC_KEY) {
    console.warn('[fulfill] SUPABASE_SERVICE_ROLE_KEY not set — skipping fulfillment');
    return;
  }

  const courseName = CATALOG[courseId]?.name || courseId;
  const redirectTo = `${PUBLIC_SITE_URL}/?welcome=1`;

  // 1. Resolve existing user (if any) and link/enroll synchronously.
  const userId = await lookupUserIdByEmail(email);
  if (userId) {
    await linkPurchaseAndEnroll(userId, email, courseId);
  }
  // For new buyers, generate_link below auto-creates the auth user, and
  // the handle_new_user trigger (migration 0007) backfills purchase + enrollment.

  // 2. Generate magic link and send email.
  const magicLink = await generateMagicLink(email, redirectTo);
  if (!magicLink) {
    console.warn('[fulfill] no magic link generated; email not sent');
    return;
  }

  const subject = `Your ${courseName} access is ready`;
  const html    = purchaseEmailHtml({ courseName, amountCents, currency, sessionId, magicLink });
  const sent    = await sendPurchaseEmail(email, subject, html);
  if (!sent) {
    console.warn('[fulfill] purchase email send failed for', email);
  }
}

// =====================================================================
// Public certificate verification
// =====================================================================
app.get(/^\/verify(?:\/([0-9a-f]{64}))?\/?$/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'verify.html'));
});

// =====================================================================
// Static disclosures: /terms and /privacy. Linked from the course title
// page (added v0.4.59); learners need a working target before continuing.
// Copy is intentionally minimal — replace with the canonical legal copy
// when finalized.
// =====================================================================
function _disclosurePage(title, body) {
  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} · Deconflict</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <style>
      :root { --ink:#0d1424; --paper:#f7f8fc; --line:#d9dfee; --accent:#0a3d91; }
      body { margin:0; font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--paper); }
      main { max-width: 820px; margin: 40px auto; padding: 28px clamp(20px,4vw,40px); background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 1px 3px rgba(13,20,36,.06); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      h2 { margin-top: 24px; font-size: 18px; }
      a { color: var(--accent); }
      .small { font-size: 13px; color:#5b6788; margin-top: 30px; }
    </style></head><body><main>${body}<p class="small">Last updated 2026-05-10. <a href="/">Back to home</a></p></main></body></html>`;
}

app.get('/terms', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(_disclosurePage('Terms of Service', `
    <h1>Terms of Service</h1>
    <p>By accessing the Deconflict / mygenesis-training platform you agree to these terms. The platform is provided on an as-is basis for training and educational use. We may update or modify the courses, certificates, and platform behavior at any time.</p>
    <h2>Acceptable use</h2>
    <p>Do not share your account, attempt to circumvent security or access controls, scrape platform content for resale, or use the platform to train derivative AI systems without written permission.</p>
    <h2>No warranties</h2>
    <p>Course content is provided without warranty of any kind. Nothing on this platform is legal, financial, investment, tax, or operational advice. See the per-course disclosures and consult qualified professionals for your specific situation.</p>
    <h2>Account termination</h2>
    <p>We reserve the right to suspend or terminate accounts that violate these terms or applicable law.</p>
    <h2>Contact</h2>
    <p>Questions: <a href="mailto:support@mygenesis-training.com">support@mygenesis-training.com</a></p>
  `));
});

app.get('/privacy', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(_disclosurePage('Privacy Policy', `
    <h1>Privacy Policy</h1>
    <p>This page summarizes what data the Deconflict / mygenesis-training platform collects and how it is used.</p>
    <h2>What we collect</h2>
    <ul>
      <li>Account profile (email, full name, agency / department, optional badge number)</li>
      <li>Course progress: lessons viewed, quiz attempts, scores</li>
      <li>Terms of Service acceptance records (course, timestamp, user agent)</li>
      <li>Server access logs for security and fraud prevention</li>
    </ul>
    <h2>How we use it</h2>
    <p>We use this data to deliver courses, issue certificates, support reporting to your agency, secure the platform, and respond to support requests. We do not sell user data.</p>
    <h2>Sharing</h2>
    <p>Course completion data may be visible to your tenant administrators (typically your agency). Service providers (Supabase for storage / auth, Resend for email, Stripe for payments where applicable) process data on our behalf under their own agreements.</p>
    <h2>Your rights</h2>
    <p>You may request access to or deletion of your account data by emailing <a href="mailto:support@mygenesis-training.com">support@mygenesis-training.com</a>.</p>
  `));
});

// =====================================================================
// Public catalog
// =====================================================================
app.get('/courses', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'courses.html'));
});

// /courses/<slug> — canonical learner / studio-preview route. Serves the
// course.html shell; the JS resolves the slug from the pathname and pulls
// live data from Supabase (live edits show up immediately for authors).
app.get(/^\/courses\/([a-z0-9-]+)\/?$/, (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'course.html'));
});

// =====================================================================
// Preview routes — auth-less content review pages.
// Serves a standalone viewer for an authored course JSON. No DB writes,
// no enrollment, no progress. The /preview/* directory is also reachable
// via express.static below for sibling assets (the .course.json and CSS),
// but we add an explicit route for the bare slug so /preview/le-field-tactics
// (no .html) resolves cleanly.
// =====================================================================
app.get('/preview/le-field-tactics', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'preview', 'le-field-tactics.html'));
});
app.get('/preview/btc-investigations', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'preview', 'btc-investigations.html'));
});

// =====================================================================
// Studio (authoring UI) — auth-gated client-side via Supabase RLS.
// Server just serves the static shell; all data access goes through
// the JS client + Supabase row-level security (is_course_author()).
// =====================================================================
// Studio v2 SPA — all /studio/* paths serve studio.html; client router handles them.
app.get(/^\/studio(?:\/.*)?$/, (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'studio.html'));
});

// =====================================================================
// Access-request queue (super-admin global view)
// =====================================================================
app.get('/admin/requests', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'admin-requests.html'));
});

// =====================================================================
// Coupons admin (super-admin / tenant-admin). Client gates render via RLS.
// =====================================================================
app.get('/admin/coupons', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'coupons.html'));
});

// =====================================================================
// Tenant routing — must come BEFORE express.static
//   /<slug>                  -> course.html
//   /<slug>/admin            -> admin.html
//   /<slug>/admin/requests   -> admin-requests.html
//   /admin                   -> admin.html (super-admin)
// =====================================================================
app.get(/^\/([^\/]+)\/admin\/requests\/?$/, (req, res, next) => {
  const slug = req.params[0].toLowerCase();
  if (RESERVED.has(slug)) return next();
  if (!SLUG_RE.test(slug)) return next();
  res.set('X-Tenant-Slug', slug);
  res.set('Cache-Control', 'no-cache');
  return res.sendFile(path.join(PUBLIC_DIR, 'admin-requests.html'));
});

// Root dashboard (tenant_id is null)
app.get('/dashboard', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

// Tenant dashboard
app.get(/^\/([^\/]+)\/dashboard\/?$/, (req, res, next) => {
  const slug = req.params[0].toLowerCase();
  if (RESERVED.has(slug)) return next();
  if (!SLUG_RE.test(slug)) return next();
  res.set('X-Tenant-Slug', slug);
  res.set('Cache-Control', 'no-cache');
  return res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.get(/^\/([^\/]+)(?:\/(admin)?\/?)?$/, (req, res, next) => {
  const slug = req.params[0].toLowerCase();
  const sub  = req.params[1];

  if (RESERVED.has(slug)) return next();

  if (slug === 'admin' && !sub) {
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  }
  if (slug === 'verify')  return next();
  if (slug === 'courses') return next();

  if (!SLUG_RE.test(slug)) return next();

  res.set('X-Tenant-Slug', slug);

  if (sub === 'admin') {
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'course.html'));
});

// Static assets
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (/(course\.html|admin\.html|admin-requests\.html|courses\.html|index\.html|studio\.html|studio\.js|studio\.css|dashboard\.html|dashboard\.js|config\.js|auth\.js|tenant\.js|request-access\.js|admin-welcome\.js|tenant-themes\.css|course_data\.json)$/.test(filePath)) {
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
