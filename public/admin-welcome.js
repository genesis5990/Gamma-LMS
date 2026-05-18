// =====================================================================
// admin-welcome.js — Phase 4B
//
// One-time welcome modal shown to tenant_admin / super_admin users on
// their first sign-in. Self-contained: injects its own DOM + styles,
// gates on profiles.metadata->>'welcome_modal_seen_at', persists the
// flag via supabase-js when dismissed.
//
// Loaded by admin.html and admin-requests.html after auth.js + tenant.js.
// Auto-runs once window.authReady resolves; no-op for non-admins.
// =====================================================================
(function () {
  if (window.__adminWelcomeBooted) return;
  window.__adminWelcomeBooted = true;

  const STYLE_ID = 'admin-welcome-style';
  const OVERLAY_ID = 'adminWelcomeOverlay';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
#${OVERLAY_ID} {
  position: fixed; inset: 0;
  background: rgba(13,20,36,.75);
  z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
#${OVERLAY_ID} .aw-card {
  background: var(--brand-paper, #fff);
  color: var(--brand-ink, #0d1424);
  max-width: 520px; width: 100%;
  border-radius: 14px;
  padding: 32px 30px 26px;
  box-shadow: 0 20px 50px rgba(0,0,0,.4);
  border-top: 4px solid var(--brand-bg, #c8a64a);
}
#${OVERLAY_ID} h2 {
  margin: 0 0 6px;
  font-size: 20px;
  letter-spacing: .2px;
}
#${OVERLAY_ID} p {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.55;
  color: #334155;
}
#${OVERLAY_ID} p:last-of-type { margin-bottom: 22px; }
#${OVERLAY_ID} .aw-actions {
  display: flex; gap: 10px; flex-wrap: wrap;
  justify-content: flex-end;
}
#${OVERLAY_ID} .aw-btn {
  padding: 10px 16px;
  font: inherit; font-size: 14px; font-weight: 600;
  border-radius: 8px; border: 0; cursor: pointer;
}
#${OVERLAY_ID} .aw-btn-primary {
  background: var(--brand-ink, #0d1424); color: #fff;
  text-decoration: none; display: inline-block;
}
#${OVERLAY_ID} .aw-btn-primary:hover { opacity: .92; }
#${OVERLAY_ID} .aw-btn-secondary {
  background: transparent; color: #475569;
  border: 1px solid #cbd5e1;
}
#${OVERLAY_ID} .aw-btn-secondary:hover { background: #f1f5f9; }
`;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  // Single shared Supabase client. auth.js publishes window.supabaseClient
  // on every page that loads admin-welcome.js (admin.html, admin-requests.html).
  function getClient() {
    return window.supabaseClient || null;
  }

  function requestsHref() {
    // /<slug>/admin/requests if scoped, else /admin/requests
    const t = window.tenant;
    if (t && t.slug) return '/' + t.slug + '/admin/requests';
    return '/admin/requests';
  }

  function showModal(profile) {
    injectStyles();
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'awTitle');
    overlay.innerHTML = `
      <div class="aw-card">
        <h2 id="awTitle">Welcome to your admin area</h2>
        <p>You're signed in as an administrator. From here you can review pending access requests, approve or deny new officers, and keep an eye on your roster's progress.</p>
        <p>Approving a request mints a 30-day magic-link invitation that the requester receives by email. You can come back any time. This welcome only shows once.</p>
        <div class="aw-actions">
          <button type="button" class="aw-btn aw-btn-secondary" id="awDismiss">Got it, dismiss</button>
          <a class="aw-btn aw-btn-primary" id="awGo" href="${requestsHref()}">Review pending requests</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const sb = getClient();
    let persisted = false;
    async function persist() {
      if (persisted) return;
      persisted = true;
      try {
        const next = Object.assign({}, profile.metadata || {}, {
          welcome_modal_seen_at: new Date().toISOString()
        });
        await sb.from('profiles').update({ metadata: next }).eq('id', profile.id);
      } catch (e) {
        console.warn('[admin-welcome] failed to persist seen flag', e);
      }
    }

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { persist(); close(); }
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { persist(); close(); }
    });
    overlay.querySelector('#awDismiss').addEventListener('click', () => {
      persist(); close();
    });
    overlay.querySelector('#awGo').addEventListener('click', () => {
      // Persist before navigation; href takes care of the redirect.
      persist();
    });
    document.addEventListener('keydown', onKey);
  }

  async function boot() {
    try {
      if (!window.authReady) return;
      await window.authReady;
      // Wait for tenant resolution so requestsHref() picks the right slug.
      if (window.tenantReady) { try { await window.tenantReady; } catch (_) {} }
      const user = window.currentUser && window.currentUser();
      if (!user) return;

      const sb = getClient();
      if (!sb) return;
      const { data: prof, error } = await sb
        .from('profiles')
        .select('id, role, metadata')
        .eq('id', user.id)
        .single();
      if (error || !prof) return;
      if (prof.role !== 'tenant_admin' && prof.role !== 'super_admin') return;

      const seen = prof.metadata && prof.metadata.welcome_modal_seen_at;
      if (seen) return;

      showModal(prof);
    } catch (e) {
      console.warn('[admin-welcome] boot failed', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
