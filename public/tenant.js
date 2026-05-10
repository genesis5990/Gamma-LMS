// tenant.js — runtime tenant resolution + theming + (Phase 3) request-access UX.
// Loaded BEFORE auth.js by course.html, admin.html, admin-requests.html.

(function () {
  // Keep in sync with RESERVED_TOP_LEVEL in auth.js. Any first path segment
  // here is NOT a tenant slug — /admin/requests must not resolve to slug "admin".
  const RESERVED_TOP_LEVEL = new Set([
    'admin', 'studio', 'dashboard', 'api', 'auth', 'preview', 'verify',
    'courses', 'health', 'healthz', 'login', 'logout', 'signin', 'signup',
    'signout', 'assets', 'terms', 'privacy',
    'config.js', 'auth.js', 'tenant.js', 'dashboard.js', 'studio.js',
    'admin-nav.js', 'admin-welcome.js', 'request-access.js',
    'course.html', 'admin.html', 'index.html', 'courses.html',
    'admin-requests.html', 'studio.html', 'dashboard.html', 'verify.html',
    'studio.css', 'tenant-themes.css', 'brand-header.css', 'style.css',
    'course_data.json',
    'favicon.ico', 'robots.txt', 'sitemap.xml',
    'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'
  ]);

  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const firstSeg = (pathParts[0] || '').toLowerCase();
  const isReserved = RESERVED_TOP_LEVEL.has(firstSeg);
  const slugFromUrl = (!isReserved && pathParts[0] && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(pathParts[0]))
    ? pathParts[0].toLowerCase()
    : null;

  // Any /admin or /admin/* path is the super-admin global view (no tenant scope).
  const isSuperAdminView = firstSeg === 'admin';

  const DEFAULT_THEME = {
    slug: null,
    name: 'Deconflict',
    primary_color: '#0d1424',
    secondary_color: '#c8a64a',
    logo_url: null,
    logo_url_white: null,
    enrollment_mode: 'open'
  };

  // Per-tenant logo overrides (Phase 4A: prefer transparent variants on
  // chrome where the surface color is set by CSS, not the SVG background).
  const TENANT_LOGO_OVERRIDES = {
    deconflict: {
      light: '/assets/tenants/deconflict/transparent/Logo-With-Text.svg',
      dark:  '/assets/tenants/deconflict/transparent/Logo-With-Text.svg'
    }
  };

  function applyTheme(t) {
    const root = document.documentElement;
    root.style.setProperty('--brand-ink', t.primary_color || DEFAULT_THEME.primary_color);
    root.style.setProperty('--brand-bg',  t.secondary_color || DEFAULT_THEME.secondary_color);
    document.title = t.name ? `${t.name} — Crypto Intelligence Sharing` : document.title;

    // Phase 4A: tag <body> with the tenant slug so per-tenant CSS can scope.
    if (document.body) {
      if (t.slug) document.body.setAttribute('data-tenant', t.slug);
      else document.body.removeAttribute('data-tenant');
    }

    const override = t.slug ? TENANT_LOGO_OVERRIDES[t.slug] : null;
    let anyLogo = false;
    document.querySelectorAll('[data-tenant-logo]').forEach(el => {
      const variant = el.getAttribute('data-tenant-logo');
      let url;
      if (override) {
        url = variant === 'dark' ? override.dark : override.light;
      } else {
        url = variant === 'dark' ? t.logo_url_white : t.logo_url;
      }
      if (url) {
        el.setAttribute('src', url);
        el.setAttribute('alt', t.name || 'Logo');
        el.removeAttribute('hidden');
        el.style.removeProperty('display');
        anyLogo = true;
      }
    });
    if (anyLogo) {
      document.querySelectorAll('[data-tenant-fallback], #defaultBadge').forEach(el => {
        el.style.display = 'none';
      });
    }
    document.querySelectorAll('[data-tenant-name]').forEach(el => {
      el.textContent = t.name || '';
    });
  }

  // Per-tenant icon-only logo for the sign-in modal (icon mark only, no
  // wordmark — keeps the "Sign in to <Tenant>" heading from being redundant).
  const TENANT_MODAL_ICON = {
    deconflict: '/assets/tenants/deconflict/transparent/Logo-Only.svg'
  };

  // Rebrand the sign-in overlay headline/body for tenant pages.
  // Falls back silently if the overlay isn't on the page.
  function applyAuthModalBranding(t) {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    const card = overlay.firstElementChild;
    const h2 = overlay.querySelector('h2');
    if (!h2) return;
    if (t && t.slug && t.name) {
      h2.textContent = `Sign in to ${t.name}`;
    } else if (t && t.slug === 'deconflict') {
      // Hardcoded fallback per spec, in case name is missing.
      h2.textContent = 'Sign in to Deconflict Training';
    }
    // Inject the tenant icon at the top of the modal card (idempotent).
    const iconUrl = t && t.slug ? TENANT_MODAL_ICON[t.slug] : null;
    if (iconUrl && card && !card.querySelector('[data-tenant-modal-icon]')) {
      const img = document.createElement('img');
      img.setAttribute('data-tenant-modal-icon', '');
      img.src = iconUrl;
      img.alt = t.name || '';
      img.style.cssText = 'display:block; height:64px; width:64px; margin:0 auto 14px; object-fit:contain;';
      card.insertBefore(img, card.firstChild);
    }
  }

  // Inject a "Request access" CTA inside the sign-in modal on gated tenant
  // pages. Shares the same handler/form as the floating launcher.
  function injectAuthModalRequestLink(tenant) {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    if (overlay.querySelector('#authRequestAccessLink')) return;
    const sendBtn = overlay.querySelector('#authSend');
    if (!sendBtn) return;
    const wrap = document.createElement('p');
    wrap.style.cssText = 'margin:14px 0 0; font-size:13px; text-align:center;';
    wrap.innerHTML = `Don't have access yet? <a href="#" id="authRequestAccessLink" style="color:#1f63d6; font-weight:600; text-decoration:none;">Request access &rarr;</a>`;
    sendBtn.insertAdjacentElement('afterend', wrap);
    wrap.querySelector('#authRequestAccessLink').addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof window.openRequestAccess === 'function') {
        window.openRequestAccess({ tenantId: tenant.id, tenantName: tenant.name });
      }
    });
  }

  applyTheme(DEFAULT_THEME);

  // Phase 4A: minimize FOUC by setting data-tenant from the URL slug as soon
  // as <body> is parsed, before the async fetch resolves. This is best-effort —
  // applyTheme() will reset/correct it once tenantReady resolves.
  function preTagBody() {
    if (!document.body) return;
    if (slugFromUrl && !isSuperAdminView) {
      document.body.setAttribute('data-tenant', slugFromUrl);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', preTagBody, { once: true });
  } else {
    preTagBody();
  }

  window.tenantReady = (async () => {
    if (!slugFromUrl || isSuperAdminView) {
      window.tenant = { ...DEFAULT_THEME, isSuperAdminView };
      window.TENANT_CONFIG = { ...window.tenant };
      return window.tenant;
    }

    // Fetch tenant branding. Post-migration 0015, tenants_public is the
    // public-safe view (id, slug, name, logo_url, logo_url_white, primary_color,
    // secondary_color, enrollment_mode). Until the migration lands we fall
    // back to the legacy tenants table, which still has anon SELECT.
    const VIEW = 'tenants_public';
    const TABLE = 'tenants';
    const cols = 'id,slug,name,logo_url,logo_url_white,primary_color,secondary_color,enrollment_mode';
    const buildUrl = (resource) =>
      `${window.SUPABASE_URL}/rest/v1/${resource}`
        + `?slug=eq.${encodeURIComponent(slugFromUrl)}`
        + `&select=${cols}`;
    const headers = {
      apikey: window.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${window.SUPABASE_PUBLISHABLE_KEY}`
    };
    try {
      let resp = await fetch(buildUrl(VIEW), { headers });
      if (!resp.ok && resp.status === 404) {
        // tenants_public not deployed yet — fall back to direct tenants read.
        resp = await fetch(buildUrl(TABLE), { headers });
      }
      if (!resp.ok) throw new Error(`tenant fetch ${resp.status}`);
      const rows = await resp.json();
      if (!rows.length) {
        window.tenant = { ...DEFAULT_THEME, slug: slugFromUrl, notFound: true };
      } else {
        window.tenant = rows[0];
        applyTheme(window.tenant);
      }
    } catch (err) {
      console.warn('[tenant] config fetch failed', err);
      window.tenant = { ...DEFAULT_THEME, slug: slugFromUrl, error: String(err) };
    }
    window.TENANT_CONFIG = { ...window.tenant };

    // Phase 3.6: rebrand the sign-in overlay headline for all tenant pages.
    applyAuthModalBranding(window.tenant);

    // Phase 3: when enrollment is gated, show a "Request access" affordance.
    // The inline link inside the auth modal is fine for everyone (only logged-out
    // users ever see the auth modal). The floating launcher, however, must only
    // appear for logged-out visitors on the bare `/<slug>` tenant landing — never
    // on /<slug>/admin*, /course.html, /admin.html, /verify, or for signed-in or
    // already-enrolled users.
    if (['request_approval', 'invite_only'].includes(window.tenant?.enrollment_mode)) {
      injectAuthModalRequestLink(window.tenant);
      if (await shouldMountRequestAccessLauncher(window.tenant)) {
        ensureRequestAccessUI(window.tenant);
      }
    }
    return window.tenant;
  })();

  async function shouldMountRequestAccessLauncher(tenant) {
    // Only on the bare tenant landing path: /<slug> (length 1).
    // Excludes /<slug>/admin, /<slug>/admin/requests, /course.html, /admin.html,
    // /verify, /admin, etc.
    if (!slugFromUrl || isSuperAdminView) return false;
    if (pathParts.length !== 1) return false;

    // Don't mount for signed-in users. Wait for auth.js to settle so first paint
    // doesn't flash the launcher to a returning member.
    try {
      if (window.authReady) await window.authReady;
      const user = (typeof window.currentUser === 'function') ? window.currentUser() : null;
      if (user) {
        // Already enrolled in this tenant? Definitely don't show the request CTA.
        // (Even if not enrolled, a signed-in user shouldn't see the floater — the
        // brief says signed-in users never get it.)
        return false;
      }
    } catch { /* if auth probing fails, fall through and show the launcher */ }

    return true;
  }

  // ---------------------------------------------------------------------
  // Request access UI — floating launcher on gated tenant landing pages.
  // The modal itself lives in /request-access.js (shared with /index.html).
  // ---------------------------------------------------------------------
  function ensureRequestAccessUI(tenant) {
    if (document.getElementById('reqAccessLauncher')) return;

    const style = document.createElement('style');
    style.textContent = `
      .ra-launcher {
        position: fixed; bottom: 18px; right: 18px; z-index: 100000;
        background: #1f63d6; color:#fff; border:0; border-radius: 999px;
        padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
        box-shadow: 0 4px 14px rgba(13,20,36,.25);
      }
      .ra-launcher:hover { background: #0a3d91; }
    `;
    document.head.appendChild(style);

    const launcher = document.createElement('button');
    launcher.id = 'reqAccessLauncher';
    launcher.className = 'ra-launcher';
    launcher.type = 'button';
    launcher.textContent = 'Request access';
    launcher.addEventListener('click', () => {
      if (typeof window.openRequestAccess === 'function') {
        window.openRequestAccess({ tenantId: tenant.id, tenantName: tenant.name });
      }
    });
    document.body.appendChild(launcher);
  }
})();
