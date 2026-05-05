// tenant.js — runtime tenant resolution + theming + (Phase 3) request-access UX.
// Loaded BEFORE auth.js by course.html, admin.html, admin-requests.html.

(function () {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const slugFromUrl = pathParts[0] && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(pathParts[0])
    ? pathParts[0].toLowerCase()
    : null;

  const isSuperAdminView = pathParts[0] === 'admin' && pathParts.length === 1;

  const DEFAULT_THEME = {
    slug: null,
    name: 'Genesis Digital Assets Academy',
    primary_color: '#0d1424',
    secondary_color: '#c8a64a',
    logo_url: null,
    logo_url_white: null,
    enrollment_mode: 'open'
  };

  function applyTheme(t) {
    const root = document.documentElement;
    root.style.setProperty('--brand-ink', t.primary_color || DEFAULT_THEME.primary_color);
    root.style.setProperty('--brand-bg',  t.secondary_color || DEFAULT_THEME.secondary_color);
    document.title = t.name ? `${t.name} — Crypto 101 for Investigators` : document.title;

    let anyLogo = false;
    document.querySelectorAll('[data-tenant-logo]').forEach(el => {
      const variant = el.getAttribute('data-tenant-logo');
      const url = variant === 'dark' ? t.logo_url_white : t.logo_url;
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

  // Rebrand the sign-in overlay headline/body for tenant pages.
  // Falls back silently if the overlay isn't on the page.
  function applyAuthModalBranding(t) {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    const h2 = overlay.querySelector('h2');
    if (!h2) return;
    if (t && t.slug && t.name) {
      h2.textContent = `Sign in to ${t.name}`;
    } else if (t && t.slug === 'deconflict') {
      // Hardcoded fallback per spec, in case name is missing.
      h2.textContent = 'Sign in to Deconflict Training';
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
      if (typeof window.openRequestAccess === 'function') window.openRequestAccess();
    });
  }

  applyTheme(DEFAULT_THEME);

  window.tenantReady = (async () => {
    if (!slugFromUrl || isSuperAdminView) {
      window.tenant = { ...DEFAULT_THEME, isSuperAdminView };
      window.TENANT_CONFIG = { ...window.tenant };
      return window.tenant;
    }

    // Fetch tenant config (anonymous; tenants table has public-read RLS)
    const url = `${window.SUPABASE_URL}/rest/v1/tenants`
      + `?slug=eq.${encodeURIComponent(slugFromUrl)}`
      + `&select=id,slug,name,logo_url,logo_url_white,primary_color,secondary_color,billing_status,contact_email,enrollment_mode`;
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
    if (['request_approval', 'invite_only'].includes(window.tenant?.enrollment_mode)) {
      ensureRequestAccessUI(window.tenant);
      injectAuthModalRequestLink(window.tenant);
    }
    return window.tenant;
  })();

  // ---------------------------------------------------------------------
  // Request access UI — injected on gated tenant landing pages so that
  // anonymous officers can submit a structured access request.
  // ---------------------------------------------------------------------
  function ensureRequestAccessUI(tenant) {
    if (document.getElementById('reqAccessLauncher')) return;

    // Inline styles so we don't depend on the host page's CSS.
    const style = document.createElement('style');
    style.textContent = `
      .ra-launcher {
        position: fixed; bottom: 18px; right: 18px; z-index: 100000;
        background: #1f63d6; color:#fff; border:0; border-radius: 999px;
        padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
        box-shadow: 0 4px 14px rgba(13,20,36,.25);
      }
      .ra-launcher:hover { background: #0a3d91; }
      .ra-overlay {
        position: fixed; inset: 0; background: rgba(13,20,36,.55); z-index: 100001;
        display:none; align-items:center; justify-content:center; padding: 20px;
      }
      .ra-overlay.show { display:flex; }
      .ra-card {
        background:#fff; border-radius: 12px; max-width: 520px; width: 100%;
        max-height: 92vh; overflow:auto;
        padding: 26px; box-shadow: 0 20px 60px rgba(0,0,0,.35);
        font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color:#0d1424;
      }
      .ra-card h3 { margin: 0 0 6px; font-size: 19px; }
      .ra-card .lede { color:#5b6788; font-size: 14px; margin: 0 0 16px; }
      .ra-card label { display:block; font-size:13px; font-weight:600; margin-top:10px; color:#1d2a47; }
      .ra-card label .opt { font-weight: 400; color:#5b6788; }
      .ra-card input, .ra-card textarea {
        width:100%; padding: 9px 11px; border:1px solid #d9dfee; border-radius:6px;
        font-size: 14px; margin-top: 4px; font-family: inherit;
      }
      .ra-card textarea { min-height: 80px; resize: vertical; }
      .ra-card .row { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 480px) { .ra-card .row { grid-template-columns: 1fr; } }
      .ra-card .actions { display:flex; gap:10px; margin-top: 18px; justify-content:flex-end; }
      .ra-card button {
        padding: 10px 16px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer; border: 0;
      }
      .ra-card button.primary { background:#1f63d6; color:#fff; }
      .ra-card button.primary:hover { background:#0a3d91; }
      .ra-card button.ghost { background:#fff; color:#0d1424; border:1px solid #d9dfee; }
      .ra-card .msg { font-size: 13px; padding: 8px 10px; border-radius: 6px; margin-top: 10px; display:none; }
      .ra-card .msg.show { display:block; }
      .ra-card .msg.ok { background:#d8f0e2; color:#1b6b3d; }
      .ra-card .msg.err{ background:#fbe0e0; color:#8a1a1a; }
    `;
    document.head.appendChild(style);

    const launcher = document.createElement('button');
    launcher.id = 'reqAccessLauncher';
    launcher.className = 'ra-launcher';
    launcher.type = 'button';
    launcher.textContent = 'Request access';
    document.body.appendChild(launcher);

    const overlay = document.createElement('div');
    overlay.id = 'reqAccessOverlay';
    overlay.className = 'ra-overlay';
    overlay.innerHTML = `
      <div class="ra-card" role="dialog" aria-modal="true" aria-labelledby="raTitle">
        <h3 id="raTitle">Request access — ${escapeHtml(tenant.name || 'training portal')}</h3>
        <p class="lede">This portal is invitation-only. Submit your details and your program administrator will review your request and email you a sign-in link if approved.</p>
        <form id="reqAccessForm">
          <label>Email <input name="email" type="email" required autocomplete="email"></label>
          <label>Full name <input name="full_name" type="text" required autocomplete="name"></label>
          <div class="row">
            <label>Agency <input name="agency" type="text" required></label>
            <label>Badge number <input name="badge_number" type="text" required></label>
          </div>
          <label>Rank <span class="opt">(optional)</span><input name="rank" type="text"></label>
          <div class="row">
            <label>Supervisor name <span class="opt">(optional)</span><input name="supervisor_name" type="text"></label>
            <label>Supervisor email <span class="opt">(optional)</span><input name="supervisor_email" type="email"></label>
          </div>
          <label>Note <span class="opt">(optional)</span><textarea name="note" placeholder="Anything that will help your administrator confirm your role."></textarea></label>
          <div class="msg" id="raMsg"></div>
          <div class="actions">
            <button type="button" class="ghost" id="raCancel">Cancel</button>
            <button type="submit" class="primary" id="raSubmit">Submit request</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const open = () => overlay.classList.add('show');
    const close = () => overlay.classList.remove('show');
    launcher.addEventListener('click', open);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#raCancel').addEventListener('click', close);
    // Expose for the inline auth-modal link (Phase 3.6).
    window.openRequestAccess = open;

    overlay.querySelector('#reqAccessForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const msgEl = overlay.querySelector('#raMsg');
      const submit = overlay.querySelector('#raSubmit');
      const fd = new FormData(form);
      const payload = {
        tenant_id:        tenant.id,
        email:            (fd.get('email')   || '').toString().trim(),
        full_name:        (fd.get('full_name') || '').toString().trim(),
        agency:           (fd.get('agency')  || '').toString().trim(),
        badge_number:     (fd.get('badge_number') || '').toString().trim(),
        rank:             (fd.get('rank') || '').toString().trim() || null,
        supervisor_name:  (fd.get('supervisor_name')  || '').toString().trim() || null,
        supervisor_email: (fd.get('supervisor_email') || '').toString().trim() || null,
        note:             (fd.get('note') || '').toString().trim() || null
      };
      if (!payload.email || !payload.full_name || !payload.agency || !payload.badge_number) {
        showRaMsg(msgEl, 'Please fill in email, full name, agency, and badge number.', 'err');
        return;
      }

      submit.disabled = true; submit.textContent = 'Submitting…';
      try {
        // Anonymous insert (RLS allows status=pending inserts from anon).
        const resp = await fetch(`${window.SUPABASE_URL}/rest/v1/access_requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: window.SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${window.SUPABASE_PUBLISHABLE_KEY}`,
            Prefer: 'return=minimal'
          },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(txt || `HTTP ${resp.status}`);
        }
        showRaMsg(msgEl, 'Request submitted. You’ll receive an email when your administrator reviews it.', 'ok');
        form.reset();
        setTimeout(close, 2500);
      } catch (err) {
        showRaMsg(msgEl, 'Could not submit: ' + (err.message || err), 'err');
      } finally {
        submit.disabled = false; submit.textContent = 'Submit request';
      }
    });
  }

  function showRaMsg(el, text, kind) {
    el.textContent = text;
    el.className = 'msg show ' + (kind || '');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
})();
