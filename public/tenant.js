// tenant.js — runtime tenant resolution + theming.
// Loaded BEFORE auth.js by both course.html and admin.html.
//
// Responsibilities:
//   1. Determine the tenant slug from the URL path: /<slug>/...
//   2. Fetch tenant row from Supabase (anonymous read; tenants table has public read RLS)
//   3. Apply CSS variables (--brand-ink, --brand-bg) and inject logos where requested
//   4. Expose window.tenantReady (Promise) and window.tenant (object)
//
// If no slug present (bare root) we don't run — index.html doesn't load this file.

(function () {
  // Strip leading slash, take first path segment.
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const slugFromUrl = pathParts[0] && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(pathParts[0])
    ? pathParts[0].toLowerCase()
    : null;

  // For the super-admin view at /admin, slug is null and we serve a "global" theme.
  const isSuperAdminView = pathParts[0] === 'admin' && pathParts.length === 1;

  // Default theme (used until config loads, and for super-admin global view)
  const DEFAULT_THEME = {
    slug: null,
    name: 'Genesis Digital Assets Academy',
    primary_color: '#0d1424',
    secondary_color: '#c8a64a',
    logo_url: null,
    logo_url_white: null
  };

  function applyTheme(t) {
    const root = document.documentElement;
    root.style.setProperty('--brand-ink', t.primary_color || DEFAULT_THEME.primary_color);
    root.style.setProperty('--brand-bg',  t.secondary_color || DEFAULT_THEME.secondary_color);
    document.title = t.name ? `${t.name} — Crypto 101 for Investigators` : document.title;

    // Replace any <img data-tenant-logo> with the tenant's light/dark logo.
    let anyLogo = false;
    document.querySelectorAll('[data-tenant-logo]').forEach(el => {
      const variant = el.getAttribute('data-tenant-logo'); // 'light' | 'dark'
      const url = variant === 'dark' ? t.logo_url_white : t.logo_url;
      if (url) {
        el.setAttribute('src', url);
        el.setAttribute('alt', t.name || 'Logo');
        el.removeAttribute('hidden');
        anyLogo = true;
      }
    });
    // Hide the fallback letter badge once a real logo is shown.
    if (anyLogo) {
      document.querySelectorAll('[data-tenant-fallback], #defaultBadge').forEach(el => {
        el.style.display = 'none';
      });
    }

    // Replace any element with [data-tenant-name] with the tenant display name
    document.querySelectorAll('[data-tenant-name]').forEach(el => {
      el.textContent = t.name || '';
    });
  }

  // Apply default theme immediately so the page never flashes unstyled
  applyTheme(DEFAULT_THEME);

  window.tenantReady = (async () => {
    if (!slugFromUrl || isSuperAdminView) {
      window.tenant = { ...DEFAULT_THEME, isSuperAdminView };
      return window.tenant;
    }

    // Wait for Supabase client (auth.js exposes window.sb after init)
    // We do an anonymous fetch directly so this works even before auth.js loads.
    const url = `${window.SUPABASE_URL}/rest/v1/tenants?slug=eq.${encodeURIComponent(slugFromUrl)}&select=id,slug,name,logo_url,logo_url_white,primary_color,secondary_color,billing_status,contact_email`;
    try {
      const resp = await fetch(url, {
        headers: {
          apikey: window.SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${window.SUPABASE_PUBLISHABLE_KEY}`
        }
      });
      if (!resp.ok) throw new Error(`tenant fetch ${resp.status}`);
      const rows = await resp.json();
      if (!rows.length) {
        // Unknown slug — fall back to default theme but record the attempted slug
        window.tenant = { ...DEFAULT_THEME, slug: slugFromUrl, notFound: true };
      } else {
        window.tenant = rows[0];
        applyTheme(window.tenant);
      }
    } catch (err) {
      console.warn('[tenant] config fetch failed', err);
      window.tenant = { ...DEFAULT_THEME, slug: slugFromUrl, error: String(err) };
    }
    return window.tenant;
  })();
})();
