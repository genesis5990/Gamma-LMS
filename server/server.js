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
  'verify', 'health', 'api', 'courses'
]);

// Slugs are URL-safe lowercase: a-z 0-9 - (3-40 chars).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

// ---- Stripe (lazy require so missing key during dev/local doesn't crash boot) ----
const STRIPE_SECRET     = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUB_KEY    = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK    = process.env.STRIPE_WEBHOOK_SECRET || '';
const SUPABASE_URL      = process.env.SUPABASE_URL || 'https://fyacdyarcfgngqetmaoc.supabase.co';
const SUPABASE_PUB_KEY  = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_GuhUwx3z7xPerxTNNd2iEA_cqOOeOwI';
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PUBLIC_SITE_URL   = process.env.PUBLIC_SITE_URL || 'https://mygenesis-training.fly.dev';

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
const CATALOG = {
  crypto101: {
    course_id: 'crypto101',
    name: 'Crypto 101 for Investigators',
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

// Health check
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

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
          await upsertPurchase({
            user_id:               session.client_reference_id || null,
            email,
            course_id:             courseId,
            stripe_session_id:     session.id,
            stripe_payment_intent: session.payment_intent || null,
            stripe_customer_id:    session.customer || null,
            amount_cents:          session.amount_total || CATALOG[courseId]?.amount_cents || 0,
            currency:              session.currency || 'usd',
            status:                session.payment_status === 'paid' ? 'paid' : 'pending',
            paid_at:               session.payment_status === 'paid' ? new Date().toISOString() : null
          });
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
// /api/checkout — create Stripe Checkout session for a course
// =====================================================================
app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'stripe not configured' });

  const { course_id, success_url, cancel_url, user_id } = req.body || {};
  const c = CATALOG[course_id];
  if (!c) return res.status(400).json({ error: 'unknown course_id' });

  try {
    const priceId = await getOrCreatePriceId(course_id);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: success_url || `${PUBLIC_SITE_URL}/courses?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancel_url  || `${PUBLIC_SITE_URL}/courses?status=cancelled`,
      client_reference_id: typeof user_id === 'string' ? user_id : undefined,
      metadata: { course_id },
      // Collect email at checkout for guest purchases
      customer_creation: 'always'
    });
    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('[checkout] error:', err);
    res.status(500).json({ error: err.message || 'checkout failed' });
  }
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
// Public certificate verification
// =====================================================================
app.get(/^\/verify(?:\/([0-9a-f]{64}))?\/?$/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'verify.html'));
});

// =====================================================================
// Public catalog
// =====================================================================
app.get('/courses', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'courses.html'));
});

// =====================================================================
// Access-request queue (super-admin global view)
// =====================================================================
app.get('/admin/requests', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'admin-requests.html'));
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
    if (/(course\.html|admin\.html|admin-requests\.html|courses\.html|index\.html|config\.js|auth\.js|tenant\.js|course_data\.json)$/.test(filePath)) {
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
