// request-access.js — shared modal for prospective students to request access.
// Two modes:
//   openRequestAccess({ tenantId, tenantName })  — gated tenant landing
//   openRequestAccess({})                        — public site landing (intake)
//
// Posts directly to PostgREST /rest/v1/access_requests with the anonymous
// publishable key. RLS (access_requests_insert_anon) permits status='pending'
// inserts; tenant_id is nullable post-migration 0028, so intake rows omit it
// and land in the super-admin queue.

(function () {
  if (window.openRequestAccess) return; // already installed

  let installed = false;
  let overlay, msgEl, form, submitBtn;
  let mode = 'intake'; // 'intake' | 'tenant'
  let currentTenantId = null;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function installStyles() {
    if (document.getElementById('raSharedStyles')) return;
    const style = document.createElement('style');
    style.id = 'raSharedStyles';
    style.textContent = `
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
  }

  function installOverlay() {
    if (installed) return;
    installStyles();
    overlay = document.createElement('div');
    overlay.id = 'reqAccessOverlay';
    overlay.className = 'ra-overlay';
    overlay.innerHTML = `
      <div class="ra-card" role="dialog" aria-modal="true" aria-labelledby="raTitle">
        <h3 id="raTitle"></h3>
        <p class="lede" id="raLede"></p>
        <form id="reqAccessForm">
          <div class="row">
            <label>Full name <input name="full_name" type="text" required autocomplete="name"></label>
            <label>Email <input name="email" type="email" required autocomplete="email"></label>
          </div>
          <label id="raAgencyLabel">Agency / training program <input name="agency" type="text" required></label>
          <label>Badge / employee number <input name="badge_number" type="text" required></label>
          <label>Rank or title <span class="opt">(optional)</span><input name="rank" type="text"></label>
          <div class="row">
            <label>Supervisor name <span class="opt">(optional)</span><input name="supervisor_name" type="text"></label>
            <label>Supervisor email <span class="opt">(optional)</span><input name="supervisor_email" type="email"></label>
          </div>
          <label>Note <span class="opt">(optional)</span><textarea name="note" placeholder="Anything that will help an administrator confirm your role."></textarea></label>
          <div class="msg" id="raMsg"></div>
          <div class="actions">
            <button type="button" class="ghost" id="raCancel">Cancel</button>
            <button type="submit" class="primary" id="raSubmit">Submit request</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    msgEl = overlay.querySelector('#raMsg');
    form = overlay.querySelector('#reqAccessForm');
    submitBtn = overlay.querySelector('#raSubmit');

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#raCancel').addEventListener('click', close);
    form.addEventListener('submit', onSubmit);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('show')) close();
    });
    installed = true;
  }

  function setMode(opts) {
    const titleEl = overlay.querySelector('#raTitle');
    const ledeEl = overlay.querySelector('#raLede');
    const agencyLabel = overlay.querySelector('#raAgencyLabel');
    const agencyInput = agencyLabel.querySelector('input');
    if (opts && opts.tenantId) {
      mode = 'tenant';
      currentTenantId = opts.tenantId;
      const name = opts.tenantName || 'training portal';
      titleEl.textContent = `Request access · ${name}`;
      ledeEl.textContent = `This portal is invitation-only. Submit your details and your program administrator will review your request and email you a sign-in link if approved.`;
      agencyLabel.firstChild.nodeValue = 'Agency ';
      agencyInput.placeholder = '';
    } else {
      mode = 'intake';
      currentTenantId = null;
      titleEl.textContent = 'Request Access to Training';
      ledeEl.textContent = "Tell us a little about you and your agency. An administrator will review and follow up by email.";
      agencyLabel.firstChild.nodeValue = 'Agency / training program ';
      agencyInput.placeholder = 'e.g. Springfield Police Department, FBI Cyber Division, etc.';
    }
  }

  function open(opts) {
    installOverlay();
    setMode(opts || {});
    msgEl.className = 'msg';
    msgEl.textContent = '';
    overlay.classList.add('show');
    setTimeout(() => {
      const first = form.querySelector('input[name="full_name"]');
      if (first) first.focus();
    }, 0);
  }
  function close() { overlay && overlay.classList.remove('show'); }

  function showMsg(text, kind) {
    msgEl.textContent = text;
    msgEl.className = 'msg show ' + (kind || '');
  }

  async function onSubmit(e) {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      email:            (fd.get('email')   || '').toString().trim(),
      full_name:        (fd.get('full_name') || '').toString().trim(),
      agency:           (fd.get('agency')  || '').toString().trim(),
      badge_number:     (fd.get('badge_number') || '').toString().trim(),
      rank:             (fd.get('rank') || '').toString().trim() || null,
      supervisor_name:  (fd.get('supervisor_name')  || '').toString().trim() || null,
      supervisor_email: (fd.get('supervisor_email') || '').toString().trim() || null,
      note:             (fd.get('note') || '').toString().trim() || null
    };
    if (mode === 'tenant' && currentTenantId) payload.tenant_id = currentTenantId;
    if (!payload.email || !payload.full_name || !payload.agency || !payload.badge_number) {
      showMsg('Please fill in full name, email, agency, and badge number.', 'err');
      return;
    }

    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
    try {
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
      if (mode === 'intake') {
        showMsg("Request submitted. You'll receive an email when your administrator reviews it.", 'ok');
      } else {
        showMsg("Request submitted. You'll receive an email when your administrator reviews it.", 'ok');
      }
      form.reset();
      setTimeout(close, 2500);
    } catch (err) {
      showMsg('Could not submit: ' + (err.message || err), 'err');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = 'Submit request';
    }
  }

  window.openRequestAccess = open;
})();
