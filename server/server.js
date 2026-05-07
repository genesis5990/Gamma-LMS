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
  'verify', 'health', 'api', 'courses', 'preview', 'studio',
  'studio.html', 'studio.js', 'studio.css'
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
const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const RESEND_FROM       = process.env.RESEND_FROM || 'Genesis Digital Assets Academy <noreply@mygenesis-training.com>';

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
  "connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co",
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
            // Fire-and-await fulfillment, but never let failures block the 200 to Stripe.
            try {
              await fulfillPurchase({
                email,
                courseId,
                sessionId: session.id,
                amountCents,
                currency,
                purchaseId: Array.isArray(purchaseRow) ? purchaseRow[0]?.id : purchaseRow?.id
              });
            } catch (fulfillErr) {
              console.warn('[stripe webhook] fulfillment error (non-fatal):', fulfillErr.message);
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
      <h2 style="margin:0 0 12px;font-size:20px;">Your ${cname} access is ready.</h2>
      <p style="margin:0 0 16px;color:#3a4666;">Thank you for purchasing <strong>${cname}</strong> ($${escapeHtml(amount)} ${escapeHtml(cur)}).</p>
      <p style="margin:0 0 16px;color:#3a4666;">Click the button below to sign in and start the course. You're already enrolled — the link will sign you in automatically.</p>
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
      <p style="margin:0;color:#5b6788;font-size:12px;">Genesis Digital Assets Academy</p>
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
// Public catalog
// =====================================================================
app.get('/courses', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'courses.html'));
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
    if (/(course\.html|admin\.html|admin-requests\.html|courses\.html|index\.html|studio\.html|studio\.js|studio\.css|config\.js|auth\.js|tenant\.js|admin-welcome\.js|tenant-themes\.css|course_data\.json)$/.test(filePath)) {
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
