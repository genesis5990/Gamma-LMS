/* admin-nav.js
 * Shared cross-page nav shown only to authenticated admin/instructor users.
 * Include AFTER /config.js, the supabase UMD bundle, and /auth.js (when present).
 * Safe to include on pages without auth.js — it will silently no-op when the
 * Supabase UMD or config isn't available.
 *
 * Renders a slim fixed top bar with quick links between:
 *   Dashboard · Access requests · Course Studio · Catalog · Live site · Sign out
 * The current page is highlighted via prefix match on location.pathname.
 */
(function adminNavInit() {
  if (window.__adminNavMounted) return;            // idempotent
  window.__adminNavMounted = true;

  // --- Bail early if dependencies aren't available -------------------------
  if (typeof window.supabase === 'undefined') return;
  if (!window.SUPABASE_URL || !window.SUPABASE_PUBLISHABLE_KEY) return;

  // Single shared Supabase client. Prefer the one auth.js (or the page's
  // inline script) created and exposed as window.supabaseClient. As a
  // fallback for pages that load admin-nav.js without auth.js or an inline
  // client (e.g. courses.html), create one here and publish it under the
  // same global so any later script reuses it.
  let client = window.supabaseClient;
  if (!client) {
    try {
      client = window.supabase.createClient(
        window.SUPABASE_URL,
        window.SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
      );
      window.supabaseClient = client;
    } catch (_e) { return; }
  }

  const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin', 'instructor']);

  const COUPON_ROLES = new Set(['super_admin', 'tenant_admin']);

  const NAV_ITEMS = [
    { href: '/admin',           label: 'Dashboard',       match: p => p === '/admin' || p === '/admin/' },
    { href: '/admin/requests',  label: 'Access requests', match: p => p.startsWith('/admin/requests') },
    { href: '/admin/coupons',   label: 'Coupons',         match: p => p.startsWith('/admin/coupons'), roles: COUPON_ROLES },
    { href: '/studio',          label: 'Course Studio',   match: p => p === '/studio' || p.startsWith('/studio/') || p === '/studio.html' },
    { href: '/courses',         label: 'Catalog',         match: p => p === '/courses' || p === '/courses.html' },
    { href: '/',                label: 'Live site',       match: p => p === '/' || p === '/index.html' },
  ];

  function injectStyles() {
    if (document.getElementById('admin-nav-style')) return;
    const css = `
      :root { --admin-nav-h: 44px; }
      body.has-admin-nav { padding-top: var(--admin-nav-h) !important; }
      #admin-nav {
        position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
        height: var(--admin-nav-h);
        background: #0b1220; color: #e6edf6;
        border-bottom: 1px solid rgba(255,255,255,.08);
        display: flex; align-items: center;
        padding: 0 14px; gap: 10px;
        font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        box-shadow: 0 1px 0 rgba(0,0,0,.25);
      }
      #admin-nav .brand {
        font-weight: 700; letter-spacing: .02em;
        color: #fff; opacity: .9; margin-right: 6px;
        white-space: nowrap;
      }
      #admin-nav .brand .badge {
        display: inline-block; margin-left: 6px;
        font-size: 10px; padding: 2px 6px; border-radius: 999px;
        background: rgba(99,179,237,.18); color: #9ec5fe;
        border: 1px solid rgba(99,179,237,.35);
        text-transform: uppercase; letter-spacing: .08em;
      }
      #admin-nav nav { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; flex: 1; }
      #admin-nav a {
        color: #d1dbe8; text-decoration: none;
        padding: 6px 10px; border-radius: 6px;
        border: 1px solid transparent;
      }
      #admin-nav a:hover { background: rgba(255,255,255,.06); color: #fff; }
      #admin-nav a.is-current,
      #admin-nav a[aria-current="page"] {
        background: rgba(200,166,74,.18);
        border-color: rgba(200,166,74,.55);
        color: #f5e7bf;
        font-weight: 600;
      }
      #admin-nav .who { opacity: .7; font-size: 12px; margin-right: 8px; white-space: nowrap; }
      #admin-nav .signout {
        background: transparent; color: #d1dbe8;
        border: 1px solid rgba(255,255,255,.18);
        padding: 6px 10px; border-radius: 6px; cursor: pointer; font: inherit;
      }
      #admin-nav .signout:hover { background: rgba(255,255,255,.06); color: #fff; }
      @media (max-width: 720px) {
        :root { --admin-nav-h: auto; }
        #admin-nav { padding: 6px 10px; gap: 6px; }
        #admin-nav .who { display: none; }
        #admin-nav nav a { padding: 5px 8px; font-size: 12px; }
      }
      @media print { #admin-nav { display: none !important; } body.has-admin-nav { padding-top: 0 !important; } }
    `.trim();
    const style = document.createElement('style');
    style.id = 'admin-nav-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildBar(role, email) {
    const path = window.location.pathname;
    const bar = document.createElement('div');
    bar.id = 'admin-nav';
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', 'Admin navigation');

    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.innerHTML = 'Admin <span class="badge">' + escapeHtml(role.replace(/_/g, ' ')) + '</span>';
    bar.appendChild(brand);

    const nav = document.createElement('nav');
    NAV_ITEMS.forEach(item => {
      if (item.roles && !item.roles.has(role)) return;
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (item.match(path)) {
        a.classList.add('is-current');
        a.setAttribute('aria-current', 'page');
      }
      nav.appendChild(a);
    });
    bar.appendChild(nav);

    if (email) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = email;
      bar.appendChild(who);
    }

    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'signout';
    out.textContent = 'Sign out';
    out.addEventListener('click', async () => {
      if (typeof window.signOut === 'function') {
        await window.signOut();
        return;
      }
      // Defensive fallback: auth.js didn't load. Use global scope so the
      // server-side JWT is actually revoked (SOC 2 F-03).
      try { await client.auth.signOut({ scope: 'global' }); } catch (_e) { /* noop */ }
      try {
        const u = (window.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0];
        if (u) localStorage.removeItem('sb-' + u + '-auth-token');
      } catch (_e) { /* noop */ }
      window.location.href = '/';
    });
    bar.appendChild(out);

    document.body.classList.add('has-admin-nav');
    document.body.insertBefore(bar, document.body.firstChild);

    // Hide page-local sign-out / user-chip controls to avoid duplicates.
    // Dashboard and other pages render their own controls for non-admins;
    // when admin-nav mounts, it owns the sign-out and identity display.
    ['signOutBtn', 'userChip'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.setAttribute('hidden', '');
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function maybeMount() {
    let session = null;
    try {
      const { data } = await client.auth.getSession();
      session = data && data.session;
    } catch (_e) { return; }
    if (!session || !session.user) return;

    let role = null;
    try {
      const { data, error } = await client
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();
      if (error) return;
      role = data && data.role;
    } catch (_e) { return; }

    if (!ADMIN_ROLES.has(role)) return;
    injectStyles();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => buildBar(role, session.user.email));
    } else {
      buildBar(role, session.user.email);
    }
  }

  maybeMount();
})();
