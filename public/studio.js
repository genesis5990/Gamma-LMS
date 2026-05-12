/* =====================================================================
 * Course Studio v2
 *   - hash-free router: /studio (dashboard), /studio/edit/:slug (editor),
 *     /studio/media (library), /studio/users (people)
 *   - drag-and-drop image upload to Supabase storage course-assets
 *   - clipboard paste-image upload
 *   - autosave every 30s, save status pill, Ctrl/Cmd+S
 *   - keyboard shortcuts (B/I/K/1/2/3/Z/Y/F)
 *   - word/char count + reading time
 *   - validation panel (broken images, empty pages, missing alt, unbalanced tags)
 *   - HTML source toggle (rich <-> raw)
 *   - find & replace (Ctrl+F)
 *   - reorder pages/lessons/modules via drag handles + outline actions
 *   - duplicate / add / delete page / lesson / module
 *
 * Talks to Supabase via supabase-js global. RLS enforces author-only
 * writes (super_admin/instructor/tenant_admin).
 * =================================================================== */

// Single shared Supabase client. auth.js (loaded earlier on this page) owns
// the client and exposes it as window.supabaseClient. Creating a second one
// here would race with auth.js on the same localStorage auth token.
const sb = window.supabaseClient;
if (!sb) {
  console.error('[studio] window.supabaseClient is missing — auth.js must load before studio.js');
  throw new Error('supabaseClient unavailable');
}

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STUDIO_VERSION = 'v2';
const TOAST_TIMEOUT = 2400;
const AUTOSAVE_INTERVAL_MS = 30_000;
const STORAGE_BUCKET = 'course-assets';
const MAX_IMAGE_DIM = 1600;     // px — auto-downscale beyond this
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUPABASE_PROJECT_URL = window.SUPABASE_URL;

// ---------- state ---------------------------------------------------
const state = {
  user:       null,
  profile:    null,
  route:      null,            // { name, params }
  // editor sub-state ------
  courses:    [],
  course:     null,
  version:    null,
  modules:    [],
  finalQs:    [],
  selection:  null,
  dirty:      new Map(),
  autosaveTimer: null,
  htmlMode:   false,           // raw HTML toggle for current page
  // global -----------------
  allCoursesMeta: [],          // for dashboard course grid
  authReady:  false,
};

// ---------- escape + utilities -------------------------------------
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Convert HTML to clean plain text (strips tags AND decodes entities like &nbsp;).
// Use for any preview/snippet derived from body_html.
function htmlToPlainText(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  }
}
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtRelTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 86400*7) return `${Math.floor(diff/86400)}d ago`;
  return d.toLocaleDateString();
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Debug panel (v0.4.73). Append `?debug=1` to any /studio URL to surface a
// fixed-position panel that records every bounded await, its duration, and
// any error. Toggle with the keyboard chord `D` (when the panel exists).
// Next time the dashboard hangs we can read the panel instead of guessing.
const _STUDIO_DEBUG = (() => {
  try { return new URLSearchParams(window.location.search).get('debug') === '1'; }
  catch (_e) { return false; }
})();
function _debugEnsurePanel() {
  if (!_STUDIO_DEBUG) return null;
  let host = document.getElementById('studio-debug-panel');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'studio-debug-panel';
  host.style.cssText = [
    'position:fixed','right:8px','bottom:8px','z-index:9999',
    'width:380px','max-height:50vh','overflow:auto',
    'background:rgba(6,10,22,0.94)','color:#cbd5e1',
    'font:11px/1.4 ui-monospace,monospace','padding:8px 10px',
    'border:1px solid #334155','border-radius:6px',
    'box-shadow:0 6px 24px rgba(0,0,0,0.45)'
  ].join(';');
  host.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '<strong style="color:#60a5fa">studio debug</strong>' +
    '<button id="studio-debug-clear" style="background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:3px;padding:1px 6px;cursor:pointer">clear</button>' +
    '</div><div id="studio-debug-log"></div>';
  document.body.appendChild(host);
  host.querySelector('#studio-debug-clear').addEventListener('click', () => {
    const log = host.querySelector('#studio-debug-log');
    if (log) log.innerHTML = '';
  });
  return host;
}
function _debugLog(line, kind) {
  if (!_STUDIO_DEBUG) return;
  const host = _debugEnsurePanel();
  if (!host) return;
  const log = host.querySelector('#studio-debug-log');
  if (!log) return;
  const t = new Date().toISOString().slice(11, 23);
  const colour = kind === 'err' ? '#fca5a5' : kind === 'warn' ? '#fbbf24'
               : kind === 'ok' ? '#86efac' : '#94a3b8';
  const row = document.createElement('div');
  row.style.cssText = 'color:' + colour + ';white-space:pre-wrap;word-break:break-word';
  row.textContent = t + ' ' + line;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

// Bounded await for any promise. Used by the dashboard so a single hung
// Supabase query (e.g. RLS-blocked, missing table) cannot leave the panels
// stuck on "Loading…" forever. Mirrors the _awaitWithTimeout helper in
// course.html added in v0.4.65.
function _studioAwait(label, p, ms = 8000) {
  if (!p || typeof p.then !== 'function') {
    return Promise.resolve({ __studioTimeout: false, value: p });
  }
  let timer;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  _debugLog('start ' + label + ' (timeout=' + ms + 'ms)');
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      const dt = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      console.warn('[studio]', label, 'TIMEOUT after', ms, 'ms');
      _debugLog('TIMEOUT ' + label + ' after ' + dt + 'ms', 'err');
      resolve({ __studioTimeout: true });
    }, ms);
  });
  return Promise.race([
    p.then(v => {
      const dt = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      const err = v && v.error;
      if (err) _debugLog('ok-with-err ' + label + ' ' + dt + 'ms · ' + (err.message || err), 'warn');
      else _debugLog('ok ' + label + ' ' + dt + 'ms', 'ok');
      return { __studioTimeout: false, value: v };
    }, e => {
      const dt = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      _debugLog('reject ' + label + ' ' + dt + 'ms · ' + (e?.message || e), 'err');
      return { __studioTimeout: false, error: e };
    }),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

// derivePageTitle: prefer p.title, else first heading text from body_html,
// else first paragraph snippet, else "Untitled page". Used by the outline.
function derivePageTitle(p) {
  if (!p) return 'Untitled page';
  if (p.title && String(p.title).trim()) return String(p.title).trim();
  const html = String(p.body_html || '');
  if (!html) return 'Untitled page';
  // First heading h1–h6 — use htmlToPlainText so &nbsp; and entities are decoded
  const h = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (h) {
    const txt = htmlToPlainText(h[1]);
    if (txt) return txt.length > 80 ? txt.slice(0, 77) + '…' : txt;
  }
  // First paragraph
  const para = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (para) {
    const txt = htmlToPlainText(para[1]);
    if (txt) return txt.length > 80 ? txt.slice(0, 77) + '…' : txt;
  }
  // Fallback: any text
  const stripped = htmlToPlainText(html);
  if (stripped) return stripped.length > 80 ? stripped.slice(0, 77) + '…' : stripped;
  return 'Untitled page';
}

// ---------- toast ---------------------------------------------------
function toast(msg, kind = '') {
  const el = $('#studio-toast');
  el.className = `studio-toast ${kind}`;
  el.textContent = msg;
  el.classList.remove('hidden', 'fade-out');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, TOAST_TIMEOUT);
}

// ---------- save-state pill ----------------------------------------
function setSaveState(kind, label) {
  const el = $('#studio-savestate');
  if (!el) return;
  el.className = 'studio-savestate ' + (kind ? 'is-' + kind : '');
  el.textContent = label;
}

// ---------- modal ---------------------------------------------------
function openModal({ title, bodyHtml, footHtml, onMount }) {
  const host = $('#modal-host');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-foot').innerHTML = footHtml || '';
  host.classList.remove('hidden');
  onMount && onMount(host);
  return host;
}
function closeModal() { $('#modal-host').classList.add('hidden'); }
$('#modal-close').addEventListener('click', closeModal);
$('#modal-host').addEventListener('click', (e) => { if (e.target.id === 'modal-host') closeModal(); });

// ---------- auth gate ----------------------------------------------
async function bootstrapAuth() {
  // Wait for auth.js to finish its INITIAL_SESSION handling before reading
  // the session here. Without this, on cold load getSession() can return
  // null even though localStorage has a valid token, and the dashboard
  // queries fly out without a JWT — Supabase RLS then returns empty rows
  // silently and the dash renders with all zeros until the user refreshes.
  if (window.authReady && typeof window.authReady.then === 'function') {
    try { await window.authReady; } catch (_e) { /* fall through to getSession */ }
  }

  const { data } = await sb.auth.getSession();
  state.user = data.session?.user || null;

  // ROOT CAUSE (v0.4.73): _renderDashboardInner calls sb.auth.refreshSession()
  // which makes the GoTrue client emit TOKEN_REFRESHED. Prior versions of this
  // listener handled every non-INITIAL_SESSION event by calling checkAccess()
  // → router() → renderDashboard() → refreshSession() — an infinite re-entry
  // loop that fired 12+ parallel Supabase queries per cycle until the
  // connection pool / rate limiter saturated and panels appeared "hung".
  //
  // The two earlier fixes (v0.4.70 bound the awaits, v0.4.71 added a 12s
  // watchdog) treated symptoms: each new re-entry built a new render frame,
  // so the watchdog's `_swapIfLoading` lookups never matched the latest DOM
  // and panels stayed stuck.
  //
  // Fix: only re-render on the auth events that genuinely change who the user
  // is (SIGNED_IN, SIGNED_OUT, USER_UPDATED). TOKEN_REFRESHED is a background
  // refresh — the JWT changes, the user does not, and we must not re-enter
  // the dashboard. Also guard against concurrent checkAccess() runs.
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'INITIAL_SESSION') return;
    if (event === 'TOKEN_REFRESHED') {
      // Update cached user but DO NOT re-render. The dashboard's in-flight
      // queries will pick up the new JWT on their next request automatically.
      state.user = session?.user || state.user;
      return;
    }
    const sameUser = (state.user?.id || null) === (session?.user?.id || null);
    state.user = session?.user || null;
    if (sameUser && event !== 'SIGNED_OUT') return;
    await checkAccess();
  });

  await checkAccess();
}


async function checkAccess() {
  const gate     = $('#studio-gate');
  const gateMsg  = $('#studio-gate-msg');
  const gateForm = $('#studio-gate-form');
  const shell    = $('#studio-shell');

  if (!state.user) {
    gate.classList.remove('hidden');
    shell.classList.add('hidden');
    gateMsg.textContent = 'Sign in with your Studio email to continue.';
    gateForm.classList.remove('hidden');
    return;
  }

  const { data: prof, error } = await sb
    .from('profiles').select('id, role, full_name, email')
    .eq('id', state.user.id).maybeSingle();

  if (error) {
    gate.classList.remove('hidden');
    shell.classList.add('hidden');
    gateMsg.textContent = `Profile lookup failed: ${error.message}`;
    return;
  }

  state.profile = prof;
  const ok = prof && ['super_admin','instructor','tenant_admin'].includes(prof.role);
  if (!ok) {
    gate.classList.remove('hidden');
    shell.classList.add('hidden');
    gateMsg.textContent = `Access denied. Studio is for super_admin / instructor / tenant_admin only. (Your role: ${prof?.role || 'none'})`;
    gateForm.classList.add('hidden');
    return;
  }

  gate.classList.add('hidden');
  shell.classList.remove('hidden');
  $('#studio-user-label').textContent = prof.full_name || prof.email || state.user.email;
  state.authReady = true;
  await router();   // render whatever route the user landed on
}

$('#studio-gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#studio-gate-email').value.trim();
  const errEl = $('#studio-gate-error');
  errEl.classList.add('hidden');
  try {
    const redirect = window.location.origin + '/studio';
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: redirect },
    });
    if (error) throw error;
    $('#studio-gate-msg').textContent = 'Magic link sent — check your email.';
    $('#studio-gate-form').classList.add('hidden');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// (Studio header sign-out button removed in v0.4.38 — admin-nav owns sign-out.)

// =====================================================================
// ROUTER — uses real URL paths via History API
// =====================================================================
function parseRoute() {
  const p = window.location.pathname.replace(/\/+$/, '') || '/studio';
  if (p === '/studio')              return { name: 'dashboard' };
  if (p === '/studio/courses')      return { name: 'courses' };
  if (p === '/studio/media')        return { name: 'media' };
  if (p === '/studio/users')        return { name: 'users' };
  if (p.startsWith('/studio/edit/')) {
    const slug = p.slice('/studio/edit/'.length);
    return { name: 'editor', params: { slug } };
  }
  return { name: 'dashboard' };
}

function navigate(path) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  router();
}

async function router() {
  if (!state.authReady) return;
  // discard guard
  if (state.dirty.size && !confirm('You have unsaved changes. Discard them and leave the editor?')) {
    history.replaceState({}, '', '/studio/edit/' + (state.course?.slug || ''));
    return;
  }
  state.dirty.clear();
  stopAutosave();

  const route = parseRoute();
  state.route = route;

  // hide editor-only header buttons by default
  $('#btn-toggle-preview').classList.add('hidden');
  $('#btn-discard').classList.add('hidden');
  $('#btn-save').classList.add('hidden');
  setSaveState('ready', '● Ready');

  // active nav highlight
  const navMap = { dashboard:'/studio', courses:'/studio/courses', media:'/studio/media', users:'/studio/users', editor:'/studio/edit/' };
  $$('.studio-nav-link').forEach(a => {
    const href = a.getAttribute('href');
    a.classList.toggle('is-active', !a.dataset.external && (
      (route.name === 'dashboard' && href === '/studio') ||
      (route.name === 'courses' && href === '/studio/courses') ||
      (route.name === 'media' && href === '/studio/media') ||
      (route.name === 'users' && href === '/studio/users') ||
      (route.name === 'editor' && href === '/studio/courses')
    ));
  });

  const view = $('#studio-view');
  view.innerHTML = '';

  if (route.name === 'dashboard' || route.name === 'courses') return renderDashboard(view, route.name === 'courses');
  if (route.name === 'media')                                  return renderMedia(view);
  if (route.name === 'users')                                  return renderUsers(view);
  if (route.name === 'editor')                                 return renderEditor(view, route.params.slug);
}

window.addEventListener('popstate', router);

// Intercept internal nav-link clicks
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  if (a.dataset.external) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/studio')) return;
  e.preventDefault();
  navigate(href);
});

// /preview/* links: top-level navigations can't carry an Authorization
// header, so the previewAuthGate (server.js) 401s. Plant a short-lived
// sb-access-token cookie before opening the link so the gate can read it.
// Covers course-card "Preview" buttons and the static LE/BTC nav links
// (which use data-external and bypass the studio router above).
document.addEventListener('click', async (e) => {
  if (e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href^="/preview/"]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;
  e.preventDefault();
  try {
    if (window.supabaseClient && window.supabaseClient.auth) {
      const { data } = await window.supabaseClient.auth.getSession();
      const token = data && data.session && data.session.access_token;
      if (token) {
        const secure = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = 'sb-access-token=' + encodeURIComponent(token) +
          '; Max-Age=900; Path=/; SameSite=Lax' + secure;
      }
    }
  } catch (err) {
    console.warn('[preview-link] could not read session:', err);
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}, true);

function renderCrumbs(...parts) {
  const c = $('#studio-crumbs');
  c.innerHTML = parts.map((p, i) =>
    p.href
      ? `<a href="${p.href}">${escapeHtml(p.label)}</a>${i < parts.length - 1 ? '<span class="sep">/</span>' : ''}`
      : `<span>${escapeHtml(p.label)}</span>${i < parts.length - 1 ? '<span class="sep">/</span>' : ''}`
  ).join('');
}

// =====================================================================
// DASHBOARD VIEW
// =====================================================================
async function renderDashboard(view, coursesOnly) {
  console.log('[studio] renderDashboard: start (coursesOnly=' + !!coursesOnly + ')');
  try {
    await _renderDashboardInner(view, coursesOnly);
    console.log('[studio] renderDashboard: done');
  } catch (err) {
    console.error('[studio] renderDashboard: unhandled error', err);
    const msg = err && (err.message || String(err)) || 'unknown error';
    const errHtml =
      `<div class="studio-empty-state">
         <p><strong>Dashboard failed to load.</strong> ${escapeHtml(msg)}</p>
         <p><button class="studio-btn" id="dash-fatal-retry" type="button">Retry</button></p>
       </div>`;
    const kpis = $('#dash-kpis'); if (kpis) kpis.innerHTML = errHtml;
    const cs = $('#dash-courses'); if (cs) cs.innerHTML = errHtml;
    const fd = $('#dash-feed');    if (fd) fd.innerHTML = errHtml;
    const btn = $('#dash-fatal-retry');
    if (btn) btn.addEventListener('click', () => { view.innerHTML = ''; renderDashboard(view, coursesOnly); });
  }
}

async function _renderDashboardInner(view, coursesOnly) {
  renderCrumbs({ label: 'Studio', href: '/studio' }, { label: coursesOnly ? 'Courses' : 'Dashboard' });
  const tpl = document.getElementById('tpl-dashboard');
  view.appendChild(tpl.content.cloneNode(true));
  $('#dash-greeting').textContent = `signed in as ${state.profile.full_name || state.profile.email}`;

  // Loading state — visible until the first batch of queries resolves.
  // Without this the dash briefly shows empty KPI/course slots which look
  // identical to a "no data" state.
  $('#dash-kpis').innerHTML = '<div class="studio-empty-state"><p>Loading dashboard…</p></div>';
  $('#dash-courses').innerHTML = '<div class="studio-empty-state"><p>Loading courses…</p></div>';
  $('#dash-feed').innerHTML = '<div class="studio-empty-state"><p>Loading recent edits…</p></div>';

  // Defensive: re-await authReady at the panel level. router() already gates
  // on state.authReady, but if any caller bypasses that we still won't fire
  // RLS-bound queries before the session is hydrated.
  console.log('[studio] dashboard: awaiting authReady');
  if (window.authReady && typeof window.authReady.then === 'function') {
    await _studioAwait('authReady', window.authReady, 8000);
  }
  console.log('[studio] dashboard: authReady satisfied; firing queries');

  // ---- Hard render-watchdog (v0.4.71) ---------------------------------
  // Belt-and-braces: even if an await deep in this function never settles,
  // we MUST not leave the user staring at "Loading dashboard…" forever.
  // After 12s, swap any still-loading placeholder for an error + Retry.
  // We clear this timer at the end of _renderDashboardInner once we've
  // rendered everything we can.
  const _watchdog = setTimeout(() => {
    console.warn('[studio] dashboard watchdog: 12s elapsed, panels still loading — surfacing error');
    const stuckHtml =
      `<div class="studio-empty-state">
         <p><strong>Dashboard is taking longer than expected.</strong></p>
         <p style="font-size:12px;color:var(--st-muted)">The server didn't respond within 12s. This usually means a stale session or a temporary Supabase hiccup.</p>
         <p>
           <button class="studio-btn primary" id="dash-watchdog-retry" type="button">Retry</button>
           <button class="studio-btn" id="dash-watchdog-reload" type="button">Hard reload</button>
         </p>
       </div>`;
    function _swapIfLoading(sel) {
      const el = $(sel);
      if (el && /Loading/i.test(el.textContent || '')) el.innerHTML = stuckHtml;
    }
    _swapIfLoading('#dash-kpis');
    _swapIfLoading('#dash-courses');
    _swapIfLoading('#dash-feed');
    const retry = $('#dash-watchdog-retry');
    if (retry) retry.addEventListener('click', () => { view.innerHTML = ''; renderDashboard(view, coursesOnly); });
    const reload = $('#dash-watchdog-reload');
    if (reload) reload.addEventListener('click', () => window.location.reload());
  }, 12000);

  // ---- Session validity check (v0.4.70, bounded in v0.4.71) -----------
  // Background: when the browser tab has been idle, the persisted Supabase
  // session can be expired (or within the refresh grace window) by the
  // time the user clicks back in. PostgREST then either hangs the OPTIONS
  // preflight or returns 401 silently, and all 12 parallel dashboard
  // queries time out together. Validate (and refresh if needed) BEFORE
  // firing the batch so the queries always go out with a live JWT.
  //
  // v0.4.71: both getSession() and refreshSession() are now bounded by
  // _studioAwait. v0.4.70 awaited them naked, and the GoTrue client can
  // hang those calls indefinitely (network blip, CORS, locked storage
  // mutex) — which left the dashboard panels stuck on "Loading…".
  try {
    const sessR = await _studioAwait('auth.getSession', sb.auth.getSession(), 4000);
    if (sessR.__studioTimeout) {
      console.warn('[studio] auth.getSession timed out — proceeding with whatever JWT supabase-js holds');
    } else {
      const sessData = sessR.value?.data;
      const sessErr  = sessR.value?.error || sessR.error;
      if (sessErr) console.warn('[studio] getSession error', sessErr);
      let session = sessData?.session || null;
      const expMs  = session?.expires_at ? session.expires_at * 1000 : 0;
      const nearExpiry = !session || (expMs - Date.now() < 30000);
      if (nearExpiry) {
        console.log('[studio] session refresh attempt');
        const refR = await _studioAwait('auth.refreshSession', sb.auth.refreshSession(), 4000);
        if (refR.__studioTimeout) {
          console.warn('[studio] auth.refreshSession timed out — proceeding anyway');
        } else {
          const refreshed   = refR.value?.data;
          const refreshErr  = refR.value?.error || refR.error;
          if (refreshErr || !refreshed?.session) {
            console.warn('[studio] session refresh failed:', refreshErr || 'null session');
            clearTimeout(_watchdog);
            const errHtml =
              `<div class="studio-empty-state">
                 <p><strong>Session expired — please sign in again.</strong></p>
                 <p>
                   <button class="studio-btn" id="dash-signin-btn" type="button">Sign in</button>
                   <button class="studio-btn" id="dash-reload-btn" type="button">Reload</button>
                 </p>
               </div>`;
            const k = $('#dash-kpis');    if (k) k.innerHTML = errHtml;
            const c = $('#dash-courses'); if (c) c.innerHTML = errHtml;
            const f = $('#dash-feed');    if (f) f.innerHTML = errHtml;
            const signIn = $('#dash-signin-btn');
            if (signIn) signIn.addEventListener('click', () => {
              try { if (typeof window.signOut === 'function') window.signOut(); else window.location.href = '/'; }
              catch (_e) { window.location.href = '/'; }
            });
            const reload = $('#dash-reload-btn');
            if (reload) reload.addEventListener('click', () => window.location.reload());
            return;
          }
          session = refreshed.session;
          console.log('[studio] session refresh ok');
        }
      }
      if (session?.expires_at) {
        console.log('[studio] session check ok exp=' + new Date(session.expires_at * 1000).toISOString());
      } else {
        console.log('[studio] session check ok (no expires_at)');
      }
    }
  } catch (e) {
    console.warn('[studio] session check threw — proceeding with queries', e);
  }

  // Load all data in parallel ----------------------------------------
  const today = new Date(); today.setHours(0,0,0,0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  // Per-query timeout (8s). We use Promise.allSettled semantics via
  // _studioAwait so one hung/blocked query cannot stall the whole dashboard.
  // Bumped from 5s in v0.4.70 — 12 parallel queries on cold cache can be slow.
  const QT = 8000;
  function _q(label, builder) {
    console.log('[studio] q:start', label);
    let p;
    try { p = builder(); } catch (e) {
      console.error('[studio] q:throw', label, e);
      return Promise.resolve({ __studioTimeout: false, error: e });
    }
    return _studioAwait(label, p, QT).then(r => {
      if (r.__studioTimeout) { console.warn('[studio] q:timeout', label); return r; }
      if (r.error)           console.error('[studio] q:reject', label, r.error);
      else                   console.log('[studio] q:ok', label,
        (r.value && (r.value.error ? 'sb-error' : (r.value.data ? `rows=${(r.value.data||[]).length}` : `count=${r.value.count ?? '?'}`))) || '');
      return r;
    });
  }
  // unwrap a _studioAwait result to a Supabase-like { data, count, error } shape
  function _val(r, fallback = { data: [], count: 0, error: null }) {
    if (!r) return fallback;
    if (r.__studioTimeout) return { ...fallback, error: new Error('timeout') };
    if (r.error)            return { ...fallback, error: r.error };
    return r.value || fallback;
  }

  const [coursesR, modulesR, lessonsR, pagesR, profilesR, enrollR,
         requestsR, attemptsR, assetsR, recentPagesR, recentKcR, recentFinalR]
    = await Promise.all([
      _q('courses',         () => sb.from('courses').select('id, slug, title, current_version_id, visibility, pass_threshold, updated_at, created_at, archived_at, deleted_at').is('deleted_at', null)),
      _q('modules.count',   () => sb.from('modules').select('id, course_version_id', { count: 'exact', head: true })),
      _q('lessons.count',   () => sb.from('lessons').select('id', { count: 'exact', head: true })),
      _q('pages.count',     () => sb.from('pages').select('id', { count: 'exact', head: true })),
      _q('profiles.count',  () => sb.from('profiles').select('id', { count: 'exact', head: true })),
      _q('enrollments.7d',  () => sb.from('enrollments').select('id, enrolled_at', { count: 'exact' }).gte('enrolled_at', sevenDaysAgo)),
      _q('requests.pending',() => sb.from('access_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')),
      _q('attempts.7d',     () => sb.from('quiz_attempts').select('id', { count: 'exact', head: true }).gte('submitted_at', sevenDaysAgo)),
      _q('assets',          () => sb.from('course_assets').select('id, byte_size')),
      _q('recent.pages',    () => sb.from('pages').select('id, title, lesson_id, updated_at, lessons!inner(title, module_id, modules!inner(title, course_version_id, course_versions!inner(course_id, courses!course_versions_course_id_fkey!inner(slug, title))))').order('updated_at', { ascending: false }).limit(10)),
      _q('recent.kc',       () => sb.from('module_quiz_questions').select('id, question, updated_at, modules!inner(title, course_version_id, course_versions!inner(course_id, courses!course_versions_course_id_fkey!inner(slug, title)))').order('updated_at', { ascending: false }).limit(5)),
      _q('recent.final',    () => sb.from('final_exam_questions').select('id, question, updated_at, course_version_id, course_versions!inner(course_id, courses!course_versions_course_id_fkey!inner(slug, title))').order('updated_at', { ascending: false }).limit(5)),
    ]);

  const coursesRes      = _val(coursesR);
  const modulesRes      = _val(modulesR);
  const lessonsRes      = _val(lessonsR);
  const pagesRes        = _val(pagesR);
  const profilesRes     = _val(profilesR);
  const enrollRes       = _val(enrollR);
  const requestsRes     = _val(requestsR);
  const attemptsRes     = _val(attemptsR);
  const assetsRes       = _val(assetsR);
  const recentPagesRes  = _val(recentPagesR);
  const recentKcRes     = _val(recentKcR);
  const recentFinalRes  = _val(recentFinalR);

  // Track per-panel error visibility so we can replace the "Loading…"
  // placeholder with something diagnostic instead of leaving it stuck.
  function _errMsg(res, label) {
    if (!res) return null;
    if (res.error) {
      const m = res.error.message || String(res.error);
      return `Failed to load ${label}: ${m}`;
    }
    return null;
  }

  const courses = coursesRes.data || [];
  state.allCoursesMeta = courses;

  // If we're authed but came back empty across the board, that's almost
  // always a hydration race or RLS misconfiguration — flag it loudly so
  // it doesn't masquerade as "this account legitimately has no data".
  if (state.user && !courses.length && !(profilesRes.count || 0) && !(recentPagesRes.data || []).length) {
    console.warn('[studio:dashboard] queries returned empty for authed user — possible auth/RLS race');
  }

  // Per-course stats (modules / lessons / pages) — flat IN-clause queries (no nested embed filters).
  // Each step is also bounded so a hang here cannot wedge the dashboard.
  const versionIds = courses.map(c => c.current_version_id).filter(Boolean);
  let perCourseModulesData = [];
  let perCourseLessonsData = [];
  let perCoursePagesData = [];
  const moduleIdToVersion = {};
  const lessonIdToVersion = {};
  if (versionIds.length) {
    const modsRes = _val(await _q('per-course.modules',
      () => sb.from('modules').select('id, course_version_id').in('course_version_id', versionIds)));
    if (modsRes.error) console.error('[studio] dashboard modules', modsRes.error);
    perCourseModulesData = modsRes.data || [];
    for (const m of perCourseModulesData) moduleIdToVersion[m.id] = m.course_version_id;
    const moduleIds = perCourseModulesData.map(m => m.id);
    if (moduleIds.length) {
      const lessRes = _val(await _q('per-course.lessons',
        () => sb.from('lessons').select('id, module_id').in('module_id', moduleIds)));
      if (lessRes.error) console.error('[studio] dashboard lessons', lessRes.error);
      perCourseLessonsData = lessRes.data || [];
      for (const l of perCourseLessonsData) lessonIdToVersion[l.id] = moduleIdToVersion[l.module_id];
      const lessonIds = perCourseLessonsData.map(l => l.id);
      if (lessonIds.length) {
        const pgsRes = _val(await _q('per-course.pages',
          () => sb.from('pages').select('id, lesson_id').in('lesson_id', lessonIds)));
        if (pgsRes.error) console.error('[studio] dashboard pages', pgsRes.error);
        perCoursePagesData = pgsRes.data || [];
      }
    }
  }
  const perCourseModules = { data: perCourseModulesData };
  const perCourseLessons = { data: perCourseLessonsData };
  const perCoursePages   = { data: perCoursePagesData };

  const statsByVersion = {};
  for (const m of perCourseModulesData) {
    statsByVersion[m.course_version_id] = statsByVersion[m.course_version_id] || { modules: 0, lessons: 0, pages: 0 };
    statsByVersion[m.course_version_id].modules++;
  }
  for (const l of perCourseLessonsData) {
    const v = moduleIdToVersion[l.module_id]; if (!v) continue;
    statsByVersion[v] = statsByVersion[v] || { modules: 0, lessons: 0, pages: 0 };
    statsByVersion[v].lessons++;
  }
  for (const p of perCoursePagesData) {
    const v = lessonIdToVersion[p.lesson_id]; if (!v) continue;
    statsByVersion[v] = statsByVersion[v] || { modules: 0, lessons: 0, pages: 0 };
    statsByVersion[v].pages++;
  }

  // KPIs ------------------------------------------------------------
  const totalBytes = (assetsRes.data || []).reduce((a, b) => a + (b.byte_size || 0), 0);
  const published = courses.filter(c => c.visibility === 'public').length;
  const draftCount = courses.length - published;

  const kpis = [
    { label: 'Courses',          value: courses.length,                sub: `${published} public · ${draftCount} draft`, kind: 'accent' },
    { label: 'Modules',          value: (perCourseModules.data || []).length, sub: 'across all courses' },
    { label: 'Lessons',          value: (perCourseLessons.data || []).length, sub: 'authored' },
    { label: 'Pages',            value: (perCoursePages.data || []).length,   sub: 'editable in Studio' },
    { label: 'Profiles',         value: profilesRes.count || 0,         sub: 'registered users', kind: 'gold' },
    { label: 'Enrolled · 7d',    value: enrollRes.count || 0,           sub: 'new enrollments this week', kind: 'good' },
    { label: 'Quiz attempts · 7d', value: attemptsRes.count || 0,       sub: 'student attempts' },
    { label: 'Pending requests', value: requestsRes.count || 0,         sub: 'awaiting approval', kind: 'warn' },
    { label: 'Storage used',     value: fmtBytes(totalBytes),           sub: `${(assetsRes.data || []).length} assets` },
  ];
  // KPI panel: if ALL KPI-feeding queries failed/timed out, show a single
  // error block instead of a sea of zeros. Otherwise render the cards with
  // the values we got (zeros for missing inputs).
  const kpiErrs = [coursesRes, profilesRes, enrollRes, requestsRes, attemptsRes, assetsRes]
    .map((r, i) => r.error && ['courses','profiles','enrollments','requests','attempts','assets'][i] + ': ' + (r.error.message || r.error))
    .filter(Boolean);
  const allKpiFailed = kpiErrs.length >= 5;  // tolerate a couple of misses
  if (allKpiFailed) {
    console.warn('[studio] dashboard KPIs: all queries failed', kpiErrs);
    $('#dash-kpis').innerHTML =
      `<div class="studio-empty-state">
         <p><strong>Failed to load dashboard.</strong></p>
         <p style="font-size:12px;color:var(--st-muted)">${escapeHtml(kpiErrs.join(' · '))}</p>
         <p><button class="studio-btn" id="dash-retry-btn" type="button">Retry</button></p>
       </div>`;
    const btn = $('#dash-retry-btn');
    if (btn) btn.addEventListener('click', () => { view.innerHTML = ''; renderDashboard(view, coursesOnly); });
  } else {
    if (kpiErrs.length) console.warn('[studio] dashboard KPIs: partial failure', kpiErrs);
    $('#dash-kpis').innerHTML = kpis.map(k =>
      `<div class="dash-kpi ${k.kind ? 'is-' + k.kind : ''}">
         <div class="dash-kpi-label">${escapeHtml(k.label)}</div>
         <div class="dash-kpi-value">${escapeHtml(String(k.value))}</div>
         <div class="dash-kpi-sub">${escapeHtml(k.sub || '')}</div>
       </div>`
    ).join('');
    console.log('[studio] dashboard: KPIs rendered');
  }

  // Course grid -----------------------------------------------------
  const coursesErr = _errMsg(coursesRes, 'courses');
  function renderCourseGrid(filter) {
    if (coursesErr) {
      console.warn('[studio] dashboard courses panel error:', coursesErr);
      $('#dash-courses').innerHTML =
        `<div class="studio-empty-state">
           <p><strong>${escapeHtml(coursesErr)}.</strong> Try refreshing.</p>
           <p><button class="studio-btn" id="dash-courses-retry" type="button">Retry</button></p>
         </div>`;
      const btn = $('#dash-courses-retry');
      if (btn) btn.addEventListener('click', () => { view.innerHTML = ''; renderDashboard(view, coursesOnly); });
      return;
    }
    const f = (filter || '').toLowerCase();
    const items = courses.filter(c =>
      !f || c.slug.toLowerCase().includes(f) || (c.title || '').toLowerCase().includes(f)
    );
    $('#dash-courses').innerHTML = items.length ? items.map(c => {
      const stats = statsByVersion[c.current_version_id] || { modules: 0, lessons: 0, pages: 0 };
      const status = c.visibility || 'private';
      const statusLabel = status === 'restricted' ? 'LE only' : status;
      const archived = !!c.archived_at;
      const archBadge = archived ? `<span class="dash-status is-archived" style="margin-left:6px">Archived</span>` : '';
      return `<div class="dash-course-card${archived ? ' is-archived' : ''}">
        <div>
          <span class="dash-status is-${status}">${statusLabel}</span>${archBadge}
          <h3 style="margin-top:6px">${escapeHtml(c.title)}</h3>
          <div class="dash-cc-meta">slug: <code>${escapeHtml(c.slug)}</code> · pass ${c.pass_threshold ?? 80}% · updated ${fmtRelTime(c.updated_at)}</div>
        </div>
        <div class="dash-cc-stats">
          <div><strong>${stats.modules}</strong>modules</div>
          <div><strong>${stats.lessons}</strong>lessons</div>
          <div><strong>${stats.pages}</strong>pages</div>
        </div>
        <div class="dash-cc-actions">
          <a href="/studio/edit/${escapeHtml(c.slug)}" class="studio-btn primary">Edit</a>
          <a href="/courses/${escapeHtml(c.slug)}?preview=1" class="studio-btn" target="_blank" rel="noopener">Preview</a>
        </div>
      </div>`;
    }).join('') : '<div class="studio-empty-state"><p>No courses match.</p></div>';
  }
  renderCourseGrid('');
  if (!coursesErr) console.log('[studio] dashboard: courses rendered (n=' + courses.length + ')');
  $('#dash-course-filter').addEventListener('input', e => renderCourseGrid(e.target.value));

  // Recent edits feed ----------------------------------------------
  // If ALL three "recent" queries failed, surface an error block. If only
  // some failed we degrade gracefully and render whatever rows we have.
  const feedErrs = [
    _errMsg(recentPagesRes, 'recent pages'),
    _errMsg(recentKcR && _val(recentKcR), 'recent knowledge-check'),
    _errMsg(recentFinalR && _val(recentFinalR), 'recent final-exam'),
  ].filter(Boolean);
  const feedAllFailed = feedErrs.length === 3;
  if (feedAllFailed) {
    console.warn('[studio] dashboard recent-edits panel: all queries failed', feedErrs);
    $('#dash-feed').innerHTML =
      `<div class="studio-empty-state">
         <p><strong>Failed to load recent edits.</strong></p>
         <p style="font-size:12px;color:var(--st-muted)">${escapeHtml(feedErrs.join(' · '))}</p>
         <p><button class="studio-btn" id="dash-feed-retry" type="button">Retry</button></p>
       </div>`;
    const btn = $('#dash-feed-retry');
    if (btn) btn.addEventListener('click', () => { view.innerHTML = ''; renderDashboard(view, coursesOnly); });
    clearTimeout(_watchdog);
    return;
  }
  if (feedErrs.length) console.warn('[studio] dashboard recent-edits: partial failure', feedErrs);

  const feedRows = [];
  for (const p of (recentPagesRes.data || [])) {
    const courseTitle = p.lessons?.modules?.course_versions?.courses?.title || '';
    const courseSlug  = p.lessons?.modules?.course_versions?.courses?.slug || '';
    feedRows.push({
      tag: 'page', tagClass: 'is-page',
      label: `Page edited · <strong>${escapeHtml(p.title || 'Untitled page')}</strong>`,
      sub: `${escapeHtml(p.lessons?.modules?.title || '')} → ${escapeHtml(p.lessons?.title || '')}`,
      ts: p.updated_at, courseSlug,
    });
  }
  for (const q of (recentKcRes.data || [])) {
    const courseSlug = q.modules?.course_versions?.courses?.slug || '';
    feedRows.push({
      tag: 'quiz', tagClass: 'is-quiz',
      label: `KC question · <strong>${escapeHtml((q.question || '').slice(0,80))}</strong>`,
      sub: escapeHtml(q.modules?.title || ''),
      ts: q.updated_at, courseSlug,
    });
  }
  for (const q of (recentFinalRes.data || [])) {
    const courseSlug = q.course_versions?.courses?.slug || '';
    feedRows.push({
      tag: 'quiz', tagClass: 'is-quiz',
      label: `Final-exam · <strong>${escapeHtml((q.question || '').slice(0,80))}</strong>`,
      sub: escapeHtml(q.course_versions?.courses?.title || ''),
      ts: q.updated_at, courseSlug,
    });
  }
  feedRows.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  $('#dash-feed').innerHTML = feedRows.length ? feedRows.slice(0, 15).map(r =>
    `<div class="dash-feed-row">
       <span class="feed-tag ${r.tagClass}">${r.tag}</span>
       <div class="feed-text">${r.label}<br><span style="font-size:11.5px;color:var(--st-muted)">${r.sub}</span></div>
       <span class="feed-when">${fmtRelTime(r.ts)}</span>
     </div>`
  ).join('') : '<div class="studio-empty-state"><p>No recent edits.</p></div>';
  console.log('[studio] dashboard: recent edits rendered (n=' + feedRows.length + ')');
  clearTimeout(_watchdog);
}

// =====================================================================
// MEDIA LIBRARY
// =====================================================================
function assetTypeCategory(asset) {
  const mt = String(asset?.mime_type || '').toLowerCase();
  const kind = String(asset?.kind || '').toLowerCase();
  const name = String(asset?.filename || '').toLowerCase();
  if (mt.startsWith('image/') || kind === 'image') return 'image';
  if (mt.startsWith('audio/') || kind === 'audio') return 'audio';
  if (mt.startsWith('video/') || kind === 'video') return 'video';
  if (mt === 'application/pdf' || kind === 'pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mt === 'application/msword'
      || mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || kind === 'docx' || kind === 'doc'
      || name.endsWith('.doc') || name.endsWith('.docx')) return 'word';
  return 'other';
}

async function renderMedia(view) {
  renderCrumbs({ label: 'Studio', href: '/studio' }, { label: 'Media Library' });
  const tpl = document.getElementById('tpl-media');
  view.appendChild(tpl.content.cloneNode(true));

  // load courses for filter (and cache for uploadFiles)
  const { data: courses, error: coursesErr } = await sb.from('courses').select('id, slug, title').is('deleted_at', null).order('slug');
  if (coursesErr) console.warn('media: courses fetch failed', coursesErr);
  state.allCoursesMeta = courses || state.allCoursesMeta || [];
  const sel = $('#media-course-filter');
  // 'All courses' (default), then 'Shared (no course)', then one option per course
  sel.innerHTML =
    '<option value="">All courses</option>' +
    '<option value="__shared__">Shared (no course)</option>' +
    (state.allCoursesMeta || []).map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');

  // map id -> course meta for chip rendering
  const courseById = {};
  for (const c of state.allCoursesMeta || []) courseById[c.id] = c;

  let assets = [];
  let courseIdFilter = '';   // '' = all, '__shared__' = course_id IS NULL, else uuid
  let textFilter = '';
  const TYPE_FILTER_KEY = 'mediaLibraryFilter';
  const TYPE_LABELS = { image: 'Image', audio: 'Audio', video: 'Video', pdf: 'PDF', word: 'Word', other: 'Other' };
  let typeFilter = '';
  try {
    const stored = localStorage.getItem(TYPE_FILTER_KEY) || '';
    if (stored === '' || stored in TYPE_LABELS) typeFilter = stored;
  } catch (_) { /* localStorage unavailable */ }
  const typeSel = $('#media-type-filter');
  if (typeSel) typeSel.value = typeFilter;

  async function load() {
    // Always fetch ALL accessible assets (RLS already filters); we filter client-side
    // so the "All courses" / "Shared" / per-course toggle is instant and rows with
    // course_id = NULL are never silently dropped by an .eq() filter.
    const { data, error } = await sb.from('course_assets')
      .select('id, course_id, kind, storage_path, public_url, filename, mime_type, byte_size, width, height, duration_seconds, alt_text, uploaded_by, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) { toast('Load failed: ' + error.message, 'is-error'); return; }
    assets = data || [];
    render();
  }
  function render() {
    const f = textFilter.toLowerCase();
    const items = assets.filter(a => {
      // Course filter
      if (courseIdFilter === '__shared__') {
        if (a.course_id) return false;
      } else if (courseIdFilter) {
        if (a.course_id !== courseIdFilter) return false;
      }
      // Text filter (filename or alt)
      if (f && !((a.filename || '').toLowerCase().includes(f) ||
                 (a.alt_text || '').toLowerCase().includes(f))) return false;
      // Type filter
      if (typeFilter && assetTypeCategory(a) !== typeFilter) return false;
      return true;
    });
    const emptyEl = $('#media-empty');
    emptyEl.classList.toggle('hidden', items.length > 0);
    if (items.length === 0) {
      const label = TYPE_LABELS[typeFilter];
      const heading = label ? `No ${label} files yet` : 'No assets yet';
      const sub = label
        ? 'Try a different type filter, or upload one with the button above.'
        : 'Drop a file above to get started.';
      emptyEl.innerHTML = `<h2>${escapeHtml(heading)}</h2><p>${escapeHtml(sub)}</p>`;
    }
    $('#media-grid').innerHTML = items.map(a => {
      const isImg = (a.mime_type || '').startsWith('image/');
      const thumb = isImg
        ? `<img src="${escapeHtml(a.public_url)}" alt="${escapeHtml(a.alt_text || '')}" loading="lazy" />`
        : `<span>${escapeHtml((a.mime_type || 'file').split('/')[0])}</span>`;
      const courseLabel = a.course_id
        ? (courseById[a.course_id]?.title || courseById[a.course_id]?.slug || '—')
        : 'Shared';
      return `<div class="media-card" data-id="${a.id}">
        <div class="media-thumb">${thumb}</div>
        <div class="media-meta">
          <div class="media-name" title="${escapeHtml(a.filename || '')}">${escapeHtml(a.filename || 'untitled')}</div>
          <div class="media-info">
            <span class="media-course">${escapeHtml(courseLabel)}</span>
            <span>${fmtBytes(a.byte_size)}</span>
            ${a.width ? `<span>${a.width}×${a.height}</span>` : ''}
            <span>${fmtRelTime(a.created_at)}</span>
          </div>
        </div>
        <div class="media-actions">
          <button data-act="copy">Copy URL</button>
          <button data-act="alt">Alt</button>
          <button data-act="delete" class="danger">Delete</button>
        </div>
      </div>`;
    }).join('');
    $$('#media-grid .media-card').forEach(card => {
      const id = card.dataset.id;
      const a = assets.find(x => x.id === id);
      card.querySelector('[data-act="copy"]').addEventListener('click', () => {
        navigator.clipboard.writeText(a.public_url);
        toast('URL copied');
      });
      card.querySelector('[data-act="alt"]').addEventListener('click', async () => {
        const next = prompt('Alt text:', a.alt_text || '');
        if (next === null) return;
        const { error } = await sb.from('course_assets').update({ alt_text: next }).eq('id', a.id);
        if (error) toast('Update failed: ' + error.message, 'is-error');
        else { a.alt_text = next; render(); toast('Alt updated'); }
      });
      card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm(`Delete "${a.filename}"?\n\nThe storage file and DB row will both be removed.`)) return;
        const { error: rmErr } = await sb.storage.from(STORAGE_BUCKET).remove([a.storage_path]);
        if (rmErr) { toast('Storage delete failed: ' + rmErr.message, 'is-error'); return; }
        const { error: dbErr } = await sb.from('course_assets').delete().eq('id', a.id);
        if (dbErr) { toast('DB delete failed: ' + dbErr.message, 'is-error'); return; }
        toast('Deleted');
        load();
      });
    });
  }

  $('#media-filter').addEventListener('input', e => { textFilter = e.target.value; render(); });
  sel.addEventListener('change', e => { courseIdFilter = e.target.value; render(); });
  if (typeSel) {
    typeSel.addEventListener('change', e => {
      typeFilter = e.target.value;
      try { localStorage.setItem(TYPE_FILTER_KEY, typeFilter); } catch (_) {}
      render();
    });
  }

  // When uploading from this page, pass the *real* course_id only when a single
  // course is selected. 'All courses' and 'Shared (no course)' both upload
  // shared (course_id = NULL).
  function uploadCourseId() {
    return (courseIdFilter && courseIdFilter !== '__shared__') ? courseIdFilter : null;
  }

  // Click-upload
  $('#media-upload-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFiles(files, uploadCourseId());
    load();
  });

  // Drag-drop on the dropzone
  const dz = $('#media-dropzone');
  ['dragenter','dragover'].forEach(t => dz.addEventListener(t, ev => {
    ev.preventDefault(); dz.classList.add('is-drag');
  }));
  ['dragleave','drop'].forEach(t => dz.addEventListener(t, ev => {
    ev.preventDefault(); dz.classList.remove('is-drag');
  }));
  dz.addEventListener('drop', async (ev) => {
    try {
      const files = Array.from(ev.dataTransfer?.files || []);
      if (!files.length) return;
      await uploadFiles(files, uploadCourseId());
      load();
    } catch (err) {
      console.error('media drop handler', err);
      toast('Upload failed: ' + (err?.message || err), 'is-error');
    }
  });

  load();
}

// =====================================================================
// USERS (admin)
// =====================================================================
async function renderUsers(view) {
  renderCrumbs({ label: 'Studio', href: '/studio' }, { label: 'Users' });
  const tpl = document.getElementById('tpl-users');
  view.appendChild(tpl.content.cloneNode(true));

  let rows = [];
  let textFilter = '';
  let roleFilter = '';

  async function load() {
    const { data, error } = await sb.from('profiles')
      .select('id, email, full_name, badge_number, agency_name, role, created_at')
      .order('created_at', { ascending: false }).limit(500);
    if (error) { toast('Load failed: ' + error.message, 'is-error'); return; }
    rows = data || [];
    render();
  }
  function render() {
    const f = textFilter.toLowerCase();
    const items = rows.filter(r =>
      (!roleFilter || r.role === roleFilter) &&
      (!f || (r.email || '').toLowerCase().includes(f)
          || (r.full_name || '').toLowerCase().includes(f)
          || (r.agency_name || '').toLowerCase().includes(f))
    );
    const isSuper = state.profile.role === 'super_admin';
    $('#users-table').innerHTML = `<table>
      <thead><tr>
        <th>Name</th><th>Email</th><th>Agency</th><th>Badge</th><th>Role</th><th>Joined</th>
      </tr></thead>
      <tbody>${items.map(r => `<tr data-id="${r.id}">
        <td>${escapeHtml(r.full_name || '—')}</td>
        <td>${escapeHtml(r.email || '')}</td>
        <td>${escapeHtml(r.agency_name || '—')}</td>
        <td>${escapeHtml(r.badge_number || '—')}</td>
        <td>${isSuper
          ? `<select data-role>
              <option value="student"      ${r.role==='student'?'selected':''}>Student</option>
              <option value="instructor"   ${r.role==='instructor'?'selected':''}>Instructor</option>
              <option value="tenant_admin" ${r.role==='tenant_admin'?'selected':''}>Tenant admin</option>
              <option value="super_admin"  ${r.role==='super_admin'?'selected':''}>Super admin</option>
            </select>`
          : escapeHtml(r.role || '')}</td>
        <td>${fmtRelTime(r.created_at)}</td>
      </tr>`).join('')}</tbody>
    </table>`;

    if (isSuper) {
      $$('#users-table select[data-role]').forEach(s => {
        s.addEventListener('change', async () => {
          const id = s.closest('tr').dataset.id;
          const next = s.value;
          if (id === state.profile.id && next !== 'super_admin') {
            if (!confirm('You are about to demote yourself out of super_admin. Continue?')) {
              s.value = 'super_admin'; return;
            }
          }
          const { error } = await sb.from('profiles').update({ role: next }).eq('id', id);
          if (error) toast('Role update failed: ' + error.message, 'is-error');
          else toast('Role updated');
        });
      });
    }
  }

  $('#users-filter').addEventListener('input', e => { textFilter = e.target.value; render(); });
  $('#users-role-filter').addEventListener('change', e => { roleFilter = e.target.value; render(); });
  load();
}

// =====================================================================
// EDITOR VIEW
// =====================================================================
async function renderEditor(view, slug) {
  const tpl = document.getElementById('tpl-editor');
  view.appendChild(tpl.content.cloneNode(true));

  // show editor-only header buttons
  $('#btn-toggle-preview').classList.remove('hidden');
  $('#btn-discard').classList.remove('hidden');
  $('#btn-save').classList.remove('hidden');

  await loadCourses();

  // pick the requested course (by slug)
  const target = state.courses.find(c => c.slug === slug) || state.courses[0];
  if (!target) {
    view.innerHTML = '<div class="studio-empty-state" style="padding:40px"><h2>No courses yet</h2><p>Run the import script to seed.</p></div>';
    return;
  }
  // course picker change
  $('#course-picker').addEventListener('change', () => {
    const id = $('#course-picker').value;
    const c = state.courses.find(x => x.id === id);
    if (c) navigate('/studio/edit/' + c.slug);
  });
  await loadCourse(target.id);

  // wire editor-level buttons
  $('#btn-toggle-preview').onclick = () => $('#pane-preview').classList.toggle('hidden');
  $('#btn-close-preview').onclick = () => $('#pane-preview').classList.add('hidden');
  $('#btn-save').onclick = saveDirty;
  $('#btn-discard').onclick = () => {
    if (!state.dirty.size) return;
    if (!confirm('Discard all unsaved changes?')) return;
    state.dirty.clear();
    refreshDirtyButtons();
    if (state.course) loadCourse(state.course.id);
  };
  $('#btn-add-module').onclick  = onAddModule;
  $('#btn-validate').onclick    = runValidationModal;

  // wire find/replace bar
  wireFindBar();

  // global shortcuts (active only on editor route)
  document.addEventListener('keydown', editorShortcuts);

  // start autosave timer
  startAutosave();
}

function editorShortcuts(e) {
  if (state.route?.name !== 'editor') return;
  const meta = e.ctrlKey || e.metaKey;
  if (!meta) return;
  // ignore in form fields except contenteditable
  const tag = e.target.tagName;
  const isCE = e.target.isContentEditable;
  if (e.key === 's' || e.key === 'S') { e.preventDefault(); saveDirty(); return; }
  if (!isCE && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;
  switch (e.key.toLowerCase()) {
    case 'b': e.preventDefault(); document.execCommand('bold'); flushHtml(); break;
    case 'i': e.preventDefault(); document.execCommand('italic'); flushHtml(); break;
    case 'k': e.preventDefault(); { const url = prompt('Link URL:', 'https://'); if (url) { document.execCommand('createLink', false, url); flushHtml(); } } break;
    case '1': e.preventDefault(); document.execCommand('formatBlock', false, '<h2>'); flushHtml(); break;
    case '2': e.preventDefault(); document.execCommand('formatBlock', false, '<h3>'); flushHtml(); break;
    case '3': e.preventDefault(); document.execCommand('formatBlock', false, '<p>'); flushHtml(); break;
    case 'f': e.preventDefault(); $('#find-bar').classList.remove('hidden'); $('#find-q').focus(); break;
  }
}

function flushHtml() {
  const ed = $('#html-editor');
  if (!ed) return;
  const ref = state.selection?.kind === 'page' ? findPage(state.selection.id) : null;
  if (ref) stagePagePatch(ref.page.id, { body_html: ed.innerHTML });
  renderPreview();
  refreshStatusBar();
}

// ---------- data loaders ------------------------------------------
async function loadCourses() {
  const { data, error } = await sb
    .from('courses')
    .select('id, slug, title, current_version_id, visibility, pass_threshold, includes_disclaimer, description, description_html, hero_image_url, hero_image_alt, archived_at, deleted_at')
    .is('deleted_at', null)
    .order('slug');
  if (error) { toast('Load courses failed: ' + error.message, 'is-error'); return; }
  state.courses = data || [];
  const sel = $('#course-picker');
  sel.innerHTML = state.courses.map(c => {
    const label = `${c.slug} — ${c.title}`;
    return `<option value="${c.id}" title="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
  }).join('');
  // Reflect the full current selection in a tooltip on the select itself,
  // since the visible row truncates when the title is long.
  const syncSelTitle = () => {
    const opt = sel.options[sel.selectedIndex];
    if (opt) sel.title = opt.textContent || '';
  };
  syncSelTitle();
  sel.addEventListener('change', syncSelTitle, { once: false });
}

async function loadCourse(courseId) {
  if (state.dirty.size && !confirm('You have unsaved changes. Discard them and switch courses?')) {
    $('#course-picker').value = state.course?.id;
    return;
  }
  state.dirty.clear();
  refreshDirtyButtons();

  state.course = state.courses.find(c => c.id === courseId);
  if (!state.course?.current_version_id) {
    toast('Selected course has no published version', 'is-error');
    return;
  }
  $('#course-picker').value = courseId;
  renderCrumbs({ label: 'Studio', href: '/studio' }, { label: 'Editor', href: '/studio/courses' }, { label: state.course.title });

  const versionId = state.course.current_version_id;

  // Step 1: version + modules + final exam (depend only on versionId)
  // Final exam questions are loaded via the author_list_final_questions RPC
  // because answer_index is REVOKEd from authenticated at the column level
  // (migration 0025, SOC 2 F-11). The RPC is SECURITY DEFINER + author-gated
  // and returns full rows including answer_index for the studio editor.
  const [versionRes, modulesRes, finalRes] = await Promise.all([
    sb.from('course_versions').select('*').eq('id', versionId).maybeSingle(),
    sb.from('modules').select('*').eq('course_version_id', versionId).order('position'),
    sb.rpc('author_list_final_questions', { p_course_version_id: versionId }),
  ]);
  for (const r of [versionRes, modulesRes, finalRes]) {
    if (r.error) { toast('Load failed: ' + r.error.message, 'is-error'); console.error('loadCourse step1', r.error); return; }
  }
  state.version = versionRes.data;
  const moduleRows = modulesRes.data || [];
  const moduleIds = moduleRows.map(m => m.id);

  // Step 2: lessons + KC questions + appendix items (filter by module_id IN moduleIds)
  let lessonRows = [];
  let kcRows = [];
  let appendixRows = [];
  if (moduleIds.length) {
    // module_quiz_questions go through author_list_module_questions RPC —
    // answer_index is column-REVOKEd from authenticated (migration 0025).
    // Pass NULL to fetch every module the caller can author, then filter to
    // this course's moduleIds in JS.
    const [lessonsRes, kcRes, apxRes] = await Promise.all([
      sb.from('lessons').select('*').in('module_id', moduleIds).order('position'),
      sb.rpc('author_list_module_questions', { p_module_id: null }),
      sb.from('module_appendix_items')
        .select('id, module_id, kind, title, position, body_html, asset_id, url, description, created_at, updated_at, course_assets(public_url, filename, byte_size, mime_type)')
        .in('module_id', moduleIds).order('position'),
    ]);
    for (const r of [lessonsRes, kcRes, apxRes]) {
      if (r.error) { toast('Load failed: ' + r.error.message, 'is-error'); console.error('loadCourse step2', r.error); return; }
    }
    lessonRows = lessonsRes.data || [];
    const moduleIdSet = new Set(moduleIds);
    kcRows = (kcRes.data || []).filter(r => moduleIdSet.has(r.module_id));
    appendixRows = apxRes.data || [];
  }
  const lessonIds = lessonRows.map(l => l.id);

  // Step 3: pages (filter by lesson_id IN lessonIds)
  let pageRows = [];
  if (lessonIds.length) {
    const pagesRes = await sb.from('pages').select('*').in('lesson_id', lessonIds).order('position');
    if (pagesRes.error) { toast('Load failed: ' + pagesRes.error.message, 'is-error'); console.error('loadCourse step3', pagesRes.error); return; }
    pageRows = pagesRes.data || [];
  }

  // Group lessons by module, pages by lesson, KC by module
  const lessonsByModule = new Map();
  for (const l of lessonRows) {
    if (!lessonsByModule.has(l.module_id)) lessonsByModule.set(l.module_id, []);
    lessonsByModule.get(l.module_id).push(l);
    l.pages = []; l._kc = [];
  }
  const pagesByLesson = new Map();
  for (const p of pageRows) {
    if (!pagesByLesson.has(p.lesson_id)) pagesByLesson.set(p.lesson_id, []);
    pagesByLesson.get(p.lesson_id).push(p);
  }
  const kcByModule = new Map();
  for (const q of kcRows) {
    if (!kcByModule.has(q.module_id)) kcByModule.set(q.module_id, []);
    kcByModule.get(q.module_id).push(q);
  }
  const apxByModule = new Map();
  for (const a of appendixRows) {
    if (!apxByModule.has(a.module_id)) apxByModule.set(a.module_id, []);
    apxByModule.get(a.module_id).push(a);
  }
  const modulesRowsForState = moduleRows;
  state.modules = modulesRowsForState.map(m => ({
    ...m,
    lessons: (lessonsByModule.get(m.id) || []).map(l => ({
      ...l,
      pages: pagesByLesson.get(l.id) || [],
    })),
    kc: kcByModule.get(m.id) || [],
    appendix: apxByModule.get(m.id) || [],
  }));
  state.finalQs = finalRes.data || [];

  renderOutline();
  const firstPage = state.modules.find(m => m.lessons.length)?.lessons[0]?.pages[0];
  if (firstPage) selectNode('page', firstPage.id);
  else clearEditor();
}

// ---------- outline -----------------------------------------------
function renderOutline() {
  const root = $('#outline-tree');
  if (!root) return;
  const html = [];
  html.push(`<div class="outline-node outline-course is-course-root" data-kind="course" data-id="${state.course.id}" title="${escapeHtml(state.course.title)}">
    <span class="outline-icon">C</span>
    <span class="outline-label" data-rename="course" title="${escapeHtml(state.course.title)}">${escapeHtml(state.course.title)}</span>
  </div>`);
  for (const m of state.modules) {
    const moduleWf = moduleRollupStatus(m);
    const mWfCls = moduleWf ? ` wf-${moduleWf}` : '';
    const mWfDot = moduleWf ? `<span class="outline-wf-dot" title="${moduleWf}"></span>` : '';
    html.push(`<div class="outline-children" data-module-id="${m.id}">`);
    html.push(`<div class="outline-node outline-module${mWfCls}" data-kind="module" data-id="${m.id}" title="${escapeHtml(m.title)}">
      <span class="outline-handle" draggable="true" role="button" tabindex="0" aria-label="Drag to reorder module" title="Drag to reorder">≡</span>
      <span class="outline-icon">M</span>
      ${mWfDot}
      <span class="outline-label" data-rename="module" title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</span>
      <span class="outline-meta">${m.lessons.length}L</span>
      <span class="outline-node-actions">
        <button data-act="add-lesson" title="Add lesson">+L</button>
        <button data-act="add-kc" title="Add KC question">+Q</button>
        <button data-act="dup" title="Duplicate module">⎘</button>
        <button data-act="del" title="Delete">✕</button>
      </span>
    </div>`);
    for (const l of m.lessons) {
      const lessonWf = lessonRollupStatus(l);
      const wfCls = lessonWf ? ` wf-${lessonWf}` : '';
      const wfDot = lessonWf ? `<span class="outline-wf-dot" title="${lessonWf}"></span>` : '';
      html.push(`<div class="outline-node outline-lesson${wfCls}" data-kind="lesson" data-id="${l.id}" data-parent-id="${m.id}" title="${escapeHtml(l.title)}">
        <span class="outline-handle" draggable="true" role="button" tabindex="0" aria-label="Drag to reorder lesson" title="Drag to reorder">≡</span>
        <span class="outline-icon">L</span>
        ${wfDot}
        <span class="outline-label" data-rename="lesson" title="${escapeHtml(l.title)}">${escapeHtml(l.title)}</span>
        <span class="outline-meta">${l.pages.length}p</span>
        <span class="outline-node-actions">
          <button data-act="add-page" title="Add page">+P</button>
          <button data-act="dup" title="Duplicate">⎘</button>
          <button data-act="del" title="Delete">✕</button>
        </span>
      </div>`);
      for (let i = 0; i < l.pages.length; i++) {
        const p = l.pages[i];
        const pageLabel = derivePageTitle(p);
        const isDerived = !(p.title && p.title.trim());
        const pWf = p.workflow_status || null;
        const pWfCls = pWf ? ` wf-${pWf}` : '';
        const pWfDot = pWf ? `<span class="outline-wf-dot" title="${pWf}"></span>` : '';
        html.push(`<div class="outline-node outline-page${pWfCls}" data-kind="page" data-id="${p.id}" data-parent-id="${l.id}" title="${escapeHtml(pageLabel)}">
          <span class="outline-handle" draggable="true" role="button" tabindex="0" aria-label="Drag to reorder page" title="Drag to reorder">≡</span>
          <span class="outline-icon">${i+1}</span>
          ${pWfDot}
          <span class="outline-label${isDerived ? ' is-derived' : ''}" data-rename="page" title="${escapeHtml(pageLabel)}">${escapeHtml(pageLabel)}</span>
          <span class="outline-node-actions">
            <button data-act="dup" title="Duplicate">⎘</button>
            <button data-act="del" title="Delete">✕</button>
          </span>
        </div>`);
      }
    }
    if (m.kc.length) {
      html.push(`<div class="outline-node outline-quiz" data-kind="kc-list" data-id="${m.id}">
        <span class="outline-icon">Q</span>
        <span class="outline-label">Knowledge check (${m.kc.length}q)</span>
      </div>`);
      for (let i = 0; i < m.kc.length; i++) {
        const q = m.kc[i];
        html.push(`<div class="outline-node outline-page" data-kind="kc" data-id="${q.id}">
          <span class="outline-icon">?</span>
          <span class="outline-label">Q${i+1}: ${escapeHtml((q.question||'').slice(0, 60))}</span>
          <span class="outline-node-actions">
            <button data-act="del" title="Delete">✕</button>
          </span>
        </div>`);
      }
    }
    const apxCount = (m.appendix || []).length;
    html.push(`<div class="outline-node outline-appendix" data-kind="appendix" data-id="${m.id}" title="Module appendix — reference material">
      <span class="outline-icon">A</span>
      <span class="outline-label">Appendix (${apxCount})</span>
    </div>`);
    html.push(`</div>`);
  }
  if (state.finalQs.length) {
    html.push(`<div class="outline-node outline-final" data-kind="final-list" data-id="final">
      <span class="outline-icon">F</span>
      <span class="outline-label">Final exam (${state.finalQs.length}q)</span>
      <span class="outline-node-actions">
        <button data-act="add-final" title="Add final question">+Q</button>
      </span>
    </div>`);
    html.push(`<div class="outline-children">`);
    for (let i = 0; i < state.finalQs.length; i++) {
      const q = state.finalQs[i];
      html.push(`<div class="outline-node outline-finalq" data-kind="finalq" data-id="${q.id}">
        <span class="outline-icon">?</span>
        <span class="outline-label">Q${i+1}: ${escapeHtml((q.question||'').slice(0, 60))}</span>
        <span class="outline-node-actions">
          <button data-act="del" title="Delete">✕</button>
        </span>
      </div>`);
    }
    html.push(`</div>`);
  } else {
    html.push(`<div class="outline-node outline-final" data-kind="final-list" data-id="final">
      <span class="outline-icon">F</span>
      <span class="outline-label">Final exam (0q)</span>
      <span class="outline-node-actions">
        <button data-act="add-final" title="Add final question">+Q</button>
      </span>
    </div>`);
  }
  root.innerHTML = html.join('');

  // wire clicks + actions
  root.querySelectorAll('.outline-node').forEach(n => {
    n.addEventListener('click', (e) => {
      // ignore action-button clicks (handled below)
      if (e.target.closest('.outline-node-actions')) return;
      // ignore label clicks while in inline-rename mode
      if (e.target.closest('.outline-label.is-renaming')) return;
      // ignore clicks on the drag handle — it's a drag affordance, not a selector
      if (e.target.closest('.outline-handle')) return;
      selectNode(n.dataset.kind, n.dataset.id);
    });
  });
  root.querySelectorAll('.outline-node-actions button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const node = btn.closest('.outline-node');
      handleOutlineAction(node.dataset.kind, node.dataset.id, btn.dataset.act);
    });
  });
  // double-click on a label → inline rename (course/module/lesson/page)
  root.querySelectorAll('.outline-label[data-rename]').forEach(label => {
    label.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      startInlineRename(label);
    });
  });

  // drag-and-drop reorder
  wireOutlineReorder(root);
}

// Inline rename: replace the <span> with an <input>, save on Enter/blur, cancel on Esc.
// Stages the change via the appropriate stage*Patch and refreshes labels.
function startInlineRename(labelEl) {
  if (!labelEl || labelEl.classList.contains('is-renaming')) return;
  const node = labelEl.closest('.outline-node');
  if (!node) return;
  const kind = labelEl.dataset.rename;       // 'course' | 'module' | 'lesson' | 'page'
  const id   = node.dataset.id;

  // Resolve current title from state (not the label, which may show a derived snippet for pages)
  let current = '';
  if (kind === 'course') current = state.course.title || '';
  else if (kind === 'module') current = (findModule(id)?.title) || '';
  else if (kind === 'lesson') current = (findLesson(id)?.lesson.title) || '';
  else if (kind === 'page')   current = (findPage(id)?.page.title) || '';

  const original = labelEl.innerHTML;
  labelEl.classList.add('is-renaming');
  labelEl.innerHTML = `<input type="text" class="outline-rename-input" value="${escapeHtml(current)}" placeholder="${kind === 'page' ? 'Page title (optional)' : 'Title'}" />`;
  const input = labelEl.querySelector('input');
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const next = (input.value || '').trim();
    labelEl.classList.remove('is-renaming');
    if (!commit || next === current) {
      labelEl.innerHTML = original;
      return;
    }
    // For pages, an empty value clears the title (falls back to derived).
    // For course/module/lesson, an empty value is rejected.
    if (kind !== 'page' && !next) {
      labelEl.innerHTML = original;
      toast('Title cannot be empty', 'is-error');
      return;
    }
    if (kind === 'course') stageCoursePatch({ title: next });
    else if (kind === 'module') stageModulePatch(id, { title: next });
    else if (kind === 'lesson') stageLessonPatch(id, { title: next });
    else if (kind === 'page')   stagePagePatch(id, { title: next || null });
    // Re-render outline so labels (incl. derived page titles) refresh.
    renderOutline();
    // Auto-save the rename so the user doesn't have to hit Save.
    saveDirty();
    // If the renamed node is currently selected, refresh its meta pane too.
    if (state.selection && state.selection.kind === kind && state.selection.id === id) {
      renderMeta();
    }
    toast('Renamed', 'is-saved');
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function wireOutlineReorder(root) {
  // Drag is initiated only from .outline-handle (≡ grip), so clicks on the
  // rest of the row continue to select/edit normally.
  let dragSrc = null;       // { kind, id, node, parentId }

  root.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('.outline-handle');
    if (!handle) return;
    const n = handle.closest('.outline-node');
    if (!n) return;
    const kind = n.dataset.kind;
    if (kind !== 'lesson' && kind !== 'page' && kind !== 'module') return;
    dragSrc = { kind, id: n.dataset.id, node: n, parentId: n.dataset.parentId };
    n.setAttribute('aria-grabbed', 'true');
    n.classList.add('is-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.dataset.id);
      // Use the whole row as the drag image so the user sees what they're moving.
      const rect = n.getBoundingClientRect();
      e.dataTransfer.setDragImage(n, e.clientX - rect.left, e.clientY - rect.top);
    } catch (_) {}
  });

  root.addEventListener('dragend', () => {
    if (dragSrc?.node) {
      dragSrc.node.classList.remove('is-dragging');
      dragSrc.node.setAttribute('aria-grabbed', 'false');
    }
    $$('.outline-node.is-drag-over', root).forEach(x => x.classList.remove('is-drag-over'));
    $$('.outline-node.is-drag-over-after', root).forEach(x => x.classList.remove('is-drag-over-after'));
    dragSrc = null;
  });

  root.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    // Pages: drop onto a sibling page in the same lesson (BETWEEN indicator).
    // Lessons: drop onto another lesson (BETWEEN — same module reorder OR
    //   cross-module insert at that index) OR onto a module row (ONTO — move
    //   to end of that module).
    // Modules: drop onto another module (BETWEEN indicator).
    let target = e.target.closest('.outline-node[data-kind="' + dragSrc.kind + '"]');
    let intoModule = null;
    if (!target && dragSrc.kind === 'lesson') {
      intoModule = e.target.closest('.outline-node[data-kind="module"]');
      if (!intoModule) return;
    } else if (!target) {
      return;
    }
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    $$('.outline-node.is-drag-over', root).forEach(x => x.classList.remove('is-drag-over'));
    $$('.outline-node.is-drag-over-after', root).forEach(x => x.classList.remove('is-drag-over-after'));
    if (target && target.dataset.id !== dragSrc.id) {
      // Decide above-vs-below based on cursor position within the row.
      const rect = target.getBoundingClientRect();
      const isAfter = (e.clientY - rect.top) > rect.height / 2;
      target.classList.add(isAfter ? 'is-drag-over-after' : 'is-drag-over');
    } else if (intoModule) {
      intoModule.classList.add('is-drag-over');
    }
  });

  root.addEventListener('dragleave', (e) => {
    const n = e.target.closest('.outline-node');
    if (n) { n.classList.remove('is-drag-over'); n.classList.remove('is-drag-over-after'); }
  });

  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragSrc) return;
    const src = dragSrc;
    dragSrc = null;
    if (src.node) {
      src.node.classList.remove('is-dragging');
      src.node.setAttribute('aria-grabbed', 'false');
    }
    $$('.outline-node.is-drag-over', root).forEach(x => x.classList.remove('is-drag-over'));
    $$('.outline-node.is-drag-over-after', root).forEach(x => x.classList.remove('is-drag-over-after'));

    const sameKindTarget = e.target.closest('.outline-node[data-kind="' + src.kind + '"]');
    if (sameKindTarget && sameKindTarget.dataset.id !== src.id) {
      const rect = sameKindTarget.getBoundingClientRect();
      const isAfter = (e.clientY - rect.top) > rect.height / 2;
      // Lessons dropped onto another lesson: dispatch by module.
      // Same module → reorderSibling; different module → cross-module insert
      // at the target's position (not just append).
      if (src.kind === 'lesson') {
        const dstRef = findLesson(sameKindTarget.dataset.id);
        const srcRef = findLesson(src.id);
        if (dstRef && srcRef) {
          if (dstRef.module.id === srcRef.module.id) {
            await reorderSibling('lesson', src.id, sameKindTarget.dataset.id, isAfter);
          } else {
            await moveLessonToModule(src.id, dstRef.module.id, {
              beforeLessonId: sameKindTarget.dataset.id,
              placeAfter: isAfter,
            });
          }
          return;
        }
      }
      await reorderSibling(src.kind, src.id, sameKindTarget.dataset.id, isAfter);
      return;
    }
    if (src.kind === 'lesson') {
      const moduleTarget = e.target.closest('.outline-node[data-kind="module"]');
      if (moduleTarget && moduleTarget.dataset.id !== src.parentId) {
        await moveLessonToModule(src.id, moduleTarget.dataset.id);
        return;
      }
    }
  });
}

// Reorder a lesson or page within its current parent, placing the dragged
// item before/after the target. Optimistic UI: snapshot positions, mutate the
// in-memory state, re-render, then call the RPC (with a per-row UPDATE
// fallback if the RPC isn't deployed yet). On failure, restore the snapshot
// and re-render.
async function reorderSibling(kind, srcId, targetId, placeAfter) {
  let arr, parentId, rpcName, rpcParentArg, tableName;
  if (kind === 'lesson') {
    const ref = findLesson(srcId); if (!ref) return;
    arr = ref.module.lessons; parentId = ref.module.id;
    rpcName = 'reorder_lessons'; rpcParentArg = 'p_module_id';
    tableName = 'lessons';
  } else if (kind === 'page') {
    const ref = findPage(srcId); if (!ref) return;
    arr = ref.lesson.pages; parentId = ref.lesson.id;
    rpcName = 'reorder_pages'; rpcParentArg = 'p_lesson_id';
    tableName = 'pages';
  } else if (kind === 'module') {
    const m = findModule(srcId); if (!m) return;
    arr = state.modules; parentId = state.version.id;
    rpcName = 'reorder_modules'; rpcParentArg = 'p_course_version_id';
    tableName = 'modules';
  } else {
    return;
  }
  const srcIdx = arr.findIndex(x => x.id === srcId);
  let dstIdx = arr.findIndex(x => x.id === targetId);
  if (srcIdx < 0 || dstIdx < 0) return;

  // Snapshot positions so we can roll back on failure.
  const snapshot = arr.map(x => ({ id: x.id, position: x.position }));

  const [moved] = arr.splice(srcIdx, 1);
  if (srcIdx < dstIdx) dstIdx -= 1;
  if (placeAfter) dstIdx += 1;
  arr.splice(dstIdx, 0, moved);
  arr.forEach((x, i) => { x.position = i; });

  // Optimistic render with the dragged row highlighted briefly.
  renderOutline();
  if (state.selection) {
    document.querySelectorAll('.outline-node').forEach(n => {
      n.classList.toggle('is-selected', n.dataset.kind === state.selection.kind && n.dataset.id === state.selection.id);
    });
  }
  const movedEl = document.querySelector(`.outline-node[data-kind="${kind}"][data-id="${srcId}"]`);
  if (movedEl) {
    movedEl.classList.add('is-just-dropped');
    setTimeout(() => movedEl.classList.remove('is-just-dropped'), 600);
  }

  setSaveState('saving', 'Saving order…');
  const orderedIds = arr.map(x => x.id);
  const rpcArgs = { p_ordered_ids: orderedIds };
  rpcArgs[rpcParentArg] = parentId;
  const { error: rpcErr } = await sb.rpc(rpcName, rpcArgs);

  let finalErr = rpcErr;
  if (rpcErr && _isMissingRpc(rpcErr)) {
    // Fallback: per-row UPDATEs (no transaction, but better than nothing).
    finalErr = await _fallbackUpdatePositions(tableName, arr);
  }

  if (finalErr) {
    // Roll back: restore positions and re-render.
    for (const snap of snapshot) {
      const row = arr.find(x => x.id === snap.id);
      if (row) row.position = snap.position;
    }
    arr.sort((a, b) => a.position - b.position);
    renderOutline();
    setSaveState('error', 'Reorder failed');
    toast('Reorder failed: ' + (finalErr.message || finalErr), 'is-error');
    return;
  }
  setSaveState('saved', 'Order saved');
  toast('Reordered');
}

// Stretch goal: move a lesson to a different module (same course version).
// Places the lesson at the end of the destination module's lesson list.
async function moveLessonToModule(lessonId, targetModuleId, opts) {
  const ref = findLesson(lessonId);
  const target = findModule(targetModuleId);
  if (!ref || !target) return;
  if (ref.module.id === targetModuleId) return;

  // Snapshot the source and destination lesson arrays for rollback.
  const srcModule = ref.module;
  const srcSnap = srcModule.lessons.map(x => ({ id: x.id, position: x.position }));
  const dstSnap = target.lessons.map(x => ({ id: x.id, position: x.position }));
  const srcModuleIdBefore = ref.lesson.module_id;

  // Mutate in-memory state: remove from source, insert into destination.
  // If opts.beforeLessonId is provided, insert at that index (above or below
  // based on opts.placeAfter); otherwise append to the end.
  const srcIdx = srcModule.lessons.findIndex(x => x.id === lessonId);
  const [moved] = srcModule.lessons.splice(srcIdx, 1);
  moved.module_id = targetModuleId;
  let insertIdx = target.lessons.length;
  if (opts && opts.beforeLessonId) {
    const refIdx = target.lessons.findIndex(x => x.id === opts.beforeLessonId);
    if (refIdx >= 0) insertIdx = opts.placeAfter ? refIdx + 1 : refIdx;
  }
  target.lessons.splice(insertIdx, 0, moved);
  srcModule.lessons.forEach((x, i) => { x.position = i; });
  target.lessons.forEach((x, i) => { x.position = i; });

  renderOutline();
  if (state.selection) {
    document.querySelectorAll('.outline-node').forEach(n => {
      n.classList.toggle('is-selected', n.dataset.kind === state.selection.kind && n.dataset.id === state.selection.id);
    });
  }
  const movedEl = document.querySelector(`.outline-node[data-kind="lesson"][data-id="${lessonId}"]`);
  if (movedEl) {
    movedEl.classList.add('is-just-dropped');
    setTimeout(() => movedEl.classList.remove('is-just-dropped'), 600);
  }

  setSaveState('saving', 'Moving lesson…');
  const orderedIds = target.lessons.map(x => x.id);
  const { error: rpcErr } = await sb.rpc('move_lesson_to_module', {
    p_lesson_id: lessonId,
    p_target_module_id: targetModuleId,
    p_ordered_ids: orderedIds,
  });

  let finalErr = rpcErr;
  if (rpcErr && _isMissingRpc(rpcErr)) {
    // Fallback: update the lesson's module_id + reorder both modules with
    // per-row UPDATEs. Not transactional, but the RPC is the preferred path.
    // Use the lesson's current optimistic position (set above) so we land
    // in the right slot, not always at the end.
    const movedPos = (moved.position != null) ? moved.position : target.lessons.length - 1;
    const moveRes = await sb.from('lessons')
      .update({ module_id: targetModuleId, position: movedPos })
      .eq('id', lessonId);
    if (moveRes.error) {
      finalErr = moveRes.error;
    } else {
      const e1 = await _fallbackUpdatePositions('lessons', srcModule.lessons);
      const e2 = await _fallbackUpdatePositions('lessons', target.lessons);
      finalErr = e1 || e2 || null;
    }
  }

  if (finalErr) {
    // Roll back: restore both arrays.
    const restored = target.lessons.find(x => x.id === lessonId);
    if (restored) {
      target.lessons = target.lessons.filter(x => x.id !== lessonId);
      restored.module_id = srcModuleIdBefore;
      srcModule.lessons.push(restored);
    }
    for (const snap of srcSnap) {
      const row = srcModule.lessons.find(x => x.id === snap.id);
      if (row) row.position = snap.position;
    }
    for (const snap of dstSnap) {
      const row = target.lessons.find(x => x.id === snap.id);
      if (row) row.position = snap.position;
    }
    srcModule.lessons.sort((a, b) => a.position - b.position);
    target.lessons.sort((a, b) => a.position - b.position);
    renderOutline();
    setSaveState('error', 'Move failed');
    toast('Move failed: ' + (finalErr.message || finalErr), 'is-error');
    return;
  }
  setSaveState('saved', 'Lesson moved');
  toast('Moved to ' + (target.title || 'module'));
}

// Heuristic: detect Postgres "function does not exist" / "schema cache" misses
// from the supabase-js error shape so we can fall back to per-row UPDATEs
// until migration 0031 is applied.
function _isMissingRpc(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg  = (err.message || '').toLowerCase();
  return code === 'PGRST202'
    || code === '42883'
    || msg.includes('could not find the function')
    || msg.includes('does not exist');
}

async function _fallbackUpdatePositions(table, rows) {
  const results = await Promise.all(
    rows.map(x => sb.from(table).update({ position: x.position }).eq('id', x.id))
  );
  const err = results.find(r => r.error)?.error;
  return err || null;
}

// ---------- outline actions (add/dup/del) -------------------------
async function handleOutlineAction(kind, id, act) {
  try {
    if (kind === 'module' && act === 'add-lesson')   return await addLesson(id);
    if (kind === 'module' && act === 'add-kc')       return await addKc(id);
    if (kind === 'module' && act === 'dup')          return await duplicateModule(id);
    if (kind === 'module' && act === 'del')          return await deleteRow('modules', id, 'module');
    if (kind === 'lesson' && act === 'add-page')     return await addPage(id);
    if (kind === 'lesson' && act === 'dup')          return await duplicateLesson(id);
    if (kind === 'lesson' && act === 'del')          return await deleteRow('lessons', id, 'lesson');
    if (kind === 'page'   && act === 'dup')          return await duplicatePage(id);
    if (kind === 'page'   && act === 'del')          return await deleteRow('pages', id, 'page');
    if (kind === 'kc'     && act === 'del')          return await deleteRow('module_quiz_questions', id, 'KC question');
    if (kind === 'finalq' && act === 'del')          return await deleteRow('final_exam_questions', id, 'final question');
    if (kind === 'final-list' && act === 'add-final')return await addFinalQ();
  } catch (err) {
    toast(err.message || String(err), 'is-error');
  }
}

async function deleteRow(table, id, label) {
  if (!confirm(`Delete this ${label}? This cannot be undone.`)) return;
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) throw error;
  toast(`${label} deleted`);
  await loadCourse(state.course.id);
}

async function onAddModule() {
  const title = prompt('New module title:', 'Untitled module');
  if (!title) return;
  const slug = prompt('Module slug (a-z0-9 hyphens, must be unique within course):', title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''));
  if (!slug) return;
  const position = state.modules.length;
  const { error } = await sb.from('modules').insert({
    course_version_id: state.version.id, slug, title, position, has_knowledge_check: false,
  });
  if (error) return toast('Add failed: ' + error.message, 'is-error');
  toast('Module added');
  await loadCourse(state.course.id);
}

async function addLesson(moduleId) {
  const title = prompt('New lesson title:', 'Untitled lesson');
  if (!title) return;
  const slug = prompt('Lesson slug:', title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''));
  if (!slug) return;
  const m = findModule(moduleId);
  const position = m.lessons.length;
  const { error } = await sb.from('lessons').insert({ module_id: moduleId, slug, title, position });
  if (error) return toast('Add failed: ' + error.message, 'is-error');
  toast('Lesson added');
  await loadCourse(state.course.id);
}

async function addPage(lessonId) {
  const ref = findLesson(lessonId);
  const position = ref.lesson.pages.length;
  const { data, error } = await sb.from('pages').insert({
    lesson_id: lessonId, position, page_type: 'text', title: '', body_html: '<p></p>',
  }).select().single();
  if (error) return toast('Add failed: ' + error.message, 'is-error');
  toast('Page added');
  await loadCourse(state.course.id);
  if (data) selectNode('page', data.id);
}

async function addKc(moduleId) {
  const m = findModule(moduleId);
  const position = m.kc.length;
  // Explicit column projection — answer_index is not selectable for
  // authenticated (migration 0025); we already know it because we just
  // inserted it (default 0).
  const { data, error } = await sb.from('module_quiz_questions').insert({
    module_id: moduleId, position, question: '', options: ['', '', '', ''], answer_index: 0, reference: '',
  }).select('id, module_id, position, question, options, reference, created_at, updated_at').single();
  if (error) return toast('Add failed: ' + error.message, 'is-error');
  toast('KC question added');
  if (!m.has_knowledge_check) {
    await sb.from('modules').update({ has_knowledge_check: true }).eq('id', moduleId);
  }
  await loadCourse(state.course.id);
  if (data) selectNode('kc', data.id);
}

async function addFinalQ() {
  const position = state.finalQs.length;
  // Explicit column projection — answer_index is not selectable for
  // authenticated (migration 0025); we already know the inserted value.
  const { data, error } = await sb.from('final_exam_questions').insert({
    course_version_id: state.version.id, position,
    question: '', options: ['', '', '', ''], answer_index: 0, reference: '',
  }).select('id, course_version_id, position, question, options, reference, source_module_slug, created_at, updated_at').single();
  if (error) return toast('Add failed: ' + error.message, 'is-error');
  toast('Final question added');
  await loadCourse(state.course.id);
  if (data) selectNode('finalq', data.id);
}

async function duplicatePage(id) {
  const ref = findPage(id);
  if (!ref) return;
  const p = ref.page;
  const position = ref.lesson.pages.length;
  const { error } = await sb.from('pages').insert({
    lesson_id: p.lesson_id, position,
    page_type: p.page_type, title: (p.title || '') + ' (copy)',
    body_html: p.body_html, audio_url: p.audio_url,
  });
  if (error) return toast('Duplicate failed: ' + error.message, 'is-error');
  toast('Page duplicated');
  await loadCourse(state.course.id);
}

async function duplicateLesson(id) {
  const ref = findLesson(id);
  if (!ref) return;
  const l = ref.lesson;
  const newSlug = l.slug + '-copy';
  const { data: newL, error } = await sb.from('lessons').insert({
    module_id: l.module_id,
    slug: newSlug,
    title: l.title + ' (copy)',
    position: ref.module.lessons.length,
  }).select().single();
  if (error) return toast('Duplicate failed: ' + error.message, 'is-error');
  // copy pages
  if (l.pages.length) {
    const rows = l.pages.map((p, i) => ({
      lesson_id: newL.id, position: i,
      page_type: p.page_type, title: p.title, body_html: p.body_html, audio_url: p.audio_url,
    }));
    await sb.from('pages').insert(rows);
  }
  toast('Lesson duplicated');
  await loadCourse(state.course.id);
}

async function duplicateModule(id) {
  const m = findModule(id);
  if (!m) return;
  const newSlug = m.slug + '-copy';
  const { data: newM, error } = await sb.from('modules').insert({
    course_version_id: state.version.id,
    slug: newSlug, title: m.title + ' (copy)',
    description: m.description, position: state.modules.length,
    has_knowledge_check: m.has_knowledge_check,
  }).select().single();
  if (error) return toast('Duplicate failed: ' + error.message, 'is-error');

  for (const l of m.lessons) {
    const { data: newL, error: lErr } = await sb.from('lessons').insert({
      module_id: newM.id, slug: l.slug, title: l.title, position: l.position,
    }).select().single();
    if (lErr) continue;
    if (l.pages.length) {
      const rows = l.pages.map((p, i) => ({
        lesson_id: newL.id, position: i,
        page_type: p.page_type, title: p.title, body_html: p.body_html, audio_url: p.audio_url,
      }));
      await sb.from('pages').insert(rows);
    }
  }
  if (m.kc.length) {
    const rows = m.kc.map((q, i) => ({
      module_id: newM.id, position: i,
      question: q.question, options: q.options, answer_index: q.answer_index, reference: q.reference,
    }));
    await sb.from('module_quiz_questions').insert(rows);
  }
  if ((m.appendix || []).length) {
    const rows = m.appendix.map((a, i) => ({
      module_id: newM.id, position: i,
      kind: a.kind, title: a.title, body_html: a.body_html,
      asset_id: a.asset_id, url: a.url, description: a.description,
      created_by: state.user?.id || null,
    }));
    await sb.from('module_appendix_items').insert(rows);
  }
  toast('Module duplicated');
  await loadCourse(state.course.id);
}

// ---------- selection helpers -------------------------------------
function findPage(pageId) {
  for (const m of state.modules)
    for (const l of m.lessons)
      for (const p of l.pages)
        if (p.id === pageId) return { module: m, lesson: l, page: p };
  return null;
}
function findLesson(id) {
  for (const m of state.modules)
    for (const l of m.lessons)
      if (l.id === id) return { module: m, lesson: l };
  return null;
}
function findModule(id) { return state.modules.find(m => m.id === id) || null; }
function findKc(id) {
  for (const m of state.modules)
    for (const q of m.kc)
      if (q.id === id) return { module: m, q };
  return null;
}
function findFinal(id) {
  const q = state.finalQs.find(x => x.id === id);
  return q ? { q } : null;
}

function selectNode(kind, id) {
  if (state.dirty.size && !confirm('You have unsaved changes. Discard them and select another item?')) return;
  state.dirty.clear();
  refreshDirtyButtons();
  state.htmlMode = false;
  state.selection = { kind, id };
  document.querySelectorAll('.outline-node').forEach(n => {
    n.classList.toggle('is-selected', n.dataset.kind === kind && n.dataset.id === id);
  });
  renderEditorBody();
  renderMeta();
  renderPreview();
}

// ---------- editor body ------------------------------------------
function clearEditor() {
  $('#editor-host').innerHTML = `<div class="studio-empty-state">
    <h2>Select an item</h2>
    <p>Pick a page, lesson, module, or question from the outline.</p>
    <p class="studio-shortcuts-hint">Shortcuts: <kbd>Ctrl/⌘+S</kbd> save · <kbd>Ctrl+B/I</kbd> bold/italic · <kbd>Ctrl+K</kbd> link · <kbd>Ctrl+1/2/3</kbd> heading · <kbd>Ctrl+F</kbd> find</p>
  </div>`;
  $('#editor-toolbar').innerHTML = '';
  $('#meta-host').innerHTML = '';
  $('#meta-title').textContent = 'Metadata';
  $('#stat-words').textContent = '0 words'; $('#stat-chars').textContent = '0 chars'; $('#stat-read').textContent = '0 min read';
  $('#stat-validation').textContent = '';
  syncWorkflowWidget(null);
  if ($('#preview-card')) $('#preview-card').innerHTML = `<div class="studio-empty-state"><p>Edit a page to see a live preview here.</p></div>`;
}

function renderEditorBody() {
  const host = $('#editor-host');
  const toolbar = $('#editor-toolbar');
  if (!state.selection) { clearEditor(); return; }
  const { kind, id } = state.selection;
  // Hide the workflow widget by default; page/lesson branches re-show it below.
  syncWorkflowWidget(null);

  if (kind === 'page') {
    const ref = findPage(id);
    if (!ref) return clearEditor();
    toolbar.innerHTML = renderPageToolbar();
    wirePageToolbar();
    syncWorkflowWidget(ref.page);
    if (state.htmlMode) {
      host.innerHTML = `<textarea id="html-source" class="studio-html-editor" spellcheck="false"
        style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;width:100%;height:100%;border:0;padding:18px 24px;resize:none;outline:none;">${escapeHtml(ref.page.body_html || '')}</textarea>`;
      $('#html-source').addEventListener('input', () => {
        stagePagePatch(ref.page.id, { body_html: $('#html-source').value });
        renderPreview();
        refreshStatusBar();
      });
    } else {
      host.innerHTML = `<div id="html-editor" class="studio-html-editor" contenteditable="true" spellcheck="true">${ref.page.body_html || ''}</div>`;
      const ed = $('#html-editor');
      ed.addEventListener('input', () => {
        const next = ed.innerHTML;
        if (next === (ref.page.body_html || '')) return;
        stagePagePatch(ref.page.id, { body_html: next });
        renderPreview();
        refreshStatusBar();
      });
      wireDropAndPaste(ed, ref.page);
      wireInlineAudioControls(ed, ref.page);
      wireInlineImageControls(ed);
      wireInlineBlockControls(ed);
      // Sync any inline [n] markers' numbers to the current citation list
      recomputeCiteMarkers(ed, ref.page.citations || []);
    }
    refreshStatusBar();
    return;
  }

  if (kind === 'kc' || kind === 'finalq') {
    const ref = kind === 'kc' ? findKc(id) : findFinal(id);
    if (!ref) return clearEditor();
    const q = ref.q;
    toolbar.innerHTML = `<button id="btn-delete-q" class="studio-btn danger" type="button">Delete question</button>`;
    $('#btn-delete-q').onclick = () => deleteRow(kind === 'kc' ? 'module_quiz_questions' : 'final_exam_questions', q.id, 'question');
    host.innerHTML = renderQuizForm(q);
    wireQuizForm(q, kind);
    return;
  }

  if (kind === 'module') {
    const m = findModule(id);
    if (!m) return clearEditor();
    toolbar.innerHTML = renderTitlePageToolbar();
    wireTitlePageToolbar();
    host.innerHTML = renderTitlePageBody({ kind: 'module', node: m });
    wireTitlePageBody({ kind: 'module', node: m });
    return;
  }

  if (kind === 'appendix') {
    const m = findModule(id);
    if (!m) return clearEditor();
    toolbar.innerHTML = '';
    renderAppendixEditor(host, m);
    return;
  }

  if (kind === 'lesson') {
    const ref = findLesson(id);
    if (!ref) return clearEditor();
    toolbar.innerHTML = '';
    host.innerHTML = `<div class="studio-empty-state">
      <h2>${escapeHtml(ref.lesson.title)}</h2>
      <p>${ref.lesson.pages.length} page${ref.lesson.pages.length===1?'':'s'} in this lesson. Select one from the outline to edit.</p>
    </div>`;
    // Workflow widget is per-page now — hide on lesson selection.
    syncWorkflowWidget(null);
    return;
  }

  if (kind === 'course') {
    toolbar.innerHTML = renderTitlePageToolbar();
    wireTitlePageToolbar();
    host.innerHTML = renderTitlePageBody({ kind: 'course', node: state.course });
    wireTitlePageBody({ kind: 'course', node: state.course });
    return;
  }

  if (kind === 'kc-list' || kind === 'final-list') {
    toolbar.innerHTML = '';
    const list = kind === 'kc-list' ? findModule(id).kc : state.finalQs;
    host.innerHTML = `<div class="studio-empty-state">
      <h2>${kind === 'kc-list' ? 'Knowledge check' : 'Final exam'}</h2>
      <p>${list.length} questions. Select one to edit.</p>
    </div>`;
    return;
  }
}

// ---------- inline font / size / color helpers (shared by all editors) ----
// Maps the toolbar's data-cmd to the CSS property it applies.
const __INLINE_STYLE_PROP = {
  'font-family':      'fontFamily',
  'font-size':        'fontSize',
  'color':            'color',
  'background-color': 'backgroundColor',
};
const __INLINE_STYLE_CSS  = {
  'font-family':      'font-family',
  'font-size':        'font-size',
  'color':            'color',
  'background-color': 'background-color',
};

// Ensure the current selection is inside `editor`. Returns true if so.
function __selectionInside(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  return editor.contains(r.commonAncestorContainer);
}

// Strip a single inline style (font-family or font-size) from every element
// inside `root` that has it set inline. If the resulting span has no style
// attribute, unwrap it (replace with its children) to keep markup clean.
function __stripInlineStyleIn(root, cssProp) {
  if (!root || !root.querySelectorAll) return;
  const candidates = root.querySelectorAll(`[style*="${cssProp}"]`);
  candidates.forEach(el => {
    if (el.style && el.style.getPropertyValue(cssProp)) {
      el.style.removeProperty(cssProp);
    }
    // unwrap empty <span> with no other useful attrs
    const isPlainSpan = el.tagName === 'SPAN'
      && (!el.getAttribute('style') || el.getAttribute('style').trim() === '')
      && !el.className
      && !el.id;
    if (isPlainSpan) {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    } else if (el.getAttribute('style') === '') {
      el.removeAttribute('style');
    }
  });
}

// Wrap the current selection in <span style="prop: value"> — or clear the
// style entirely when `value` is empty. Works on contenteditable selections.
function applyInlineStyle(editor, cmd, value) {
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;

  const jsProp  = __INLINE_STYLE_PROP[cmd];
  const cssProp = __INLINE_STYLE_CSS[cmd];
  if (!jsProp || !cssProp) return;

  // Collapsed selection: stash a pending format and apply it to the next typed text.
  if (range.collapsed) {
    editor.__pendingInlineStyle = editor.__pendingInlineStyle || {};
    if (value) editor.__pendingInlineStyle[jsProp] = value;
    else delete editor.__pendingInlineStyle[jsProp];
    return;
  }

  // "Default" — unwrap any inline font-family / font-size inside the range.
  if (!value) {
    // Expand to a temp wrapper so we can sweep descendants safely.
    const wrap = document.createElement('span');
    try {
      wrap.appendChild(range.extractContents());
      range.insertNode(wrap);
      __stripInlineStyleIn(wrap, cssProp);
      // Unwrap our temp wrapper
      const parent = wrap.parentNode;
      const newRange = document.createRange();
      const first = wrap.firstChild, last = wrap.lastChild;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      parent.removeChild(wrap);
      if (first && last) { newRange.setStartBefore(first); newRange.setEndAfter(last); }
      sel.removeAllRanges(); sel.addRange(newRange);
    } catch (_) { /* no-op */ }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  // Apply: wrap selection in <span style="prop: value">.
  const span = document.createElement('span');
  span.style[jsProp] = value;
  try {
    range.surroundContents(span);
  } catch (_) {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.removeAllRanges();
  sel.addRange(newRange);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

// Wire keystroke handler on `editor` so a pending inline style applies to
// freshly typed text when the user types after picking a font with a
// collapsed cursor.
function wirePendingInlineStyle(editor) {
  if (!editor || editor.__pendingWired) return;
  editor.__pendingWired = true;
  editor.addEventListener('keydown', (e) => {
    const pending = editor.__pendingInlineStyle;
    if (!pending) return;
    const hasAny = pending.fontFamily || pending.fontSize || pending.color || pending.backgroundColor;
    if (!hasAny) return;
    // only printable single-character keys
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const span = document.createElement('span');
    if (pending.fontFamily)     span.style.fontFamily     = pending.fontFamily;
    if (pending.fontSize)       span.style.fontSize       = pending.fontSize;
    if (pending.color)          span.style.color          = pending.color;
    if (pending.backgroundColor)span.style.backgroundColor= pending.backgroundColor;
    span.appendChild(document.createTextNode(e.key));
    range.deleteContents();
    range.insertNode(span);
    // Move caret to end of inserted span
    const after = document.createRange();
    after.setStartAfter(span); after.setEndAfter(span);
    sel.removeAllRanges(); sel.addRange(after);
    // One-shot: clear pending after first applied character
    editor.__pendingInlineStyle = null;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Sanitize HTML pasted from Word / Google Docs by stripping MS-Office
// classes, <font> tags, and inline styles that are mostly noise.
function cleanPastedHTML(html) {
  if (!html) return '';
  // Drop <meta>, <link>, <style>, <script>, MS conditional comments
  let s = String(html)
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<(meta|link|style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(meta|link)[^>]*>/gi, '');
  const tpl = document.createElement('template');
  tpl.innerHTML = s;
  // Drop <font> wrappers (preserve children)
  tpl.content.querySelectorAll('font').forEach(el => {
    const p = el.parentNode;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
  });
  // Strip noisy attrs from every element
  const NOISE_STYLE = /(mso-[^:;]+:[^;]+;?|font-family\s*:\s*[^;]*(Calibri|Cambria|Times New Roman)[^;]*;?|background\s*:\s*white\s*;?|color\s*:\s*windowtext\s*;?)/gi;
  tpl.content.querySelectorAll('*').forEach(el => {
    // remove MS class names + lang/xml attrs
    if (el.className && /\bMso/.test(el.className)) el.removeAttribute('class');
    el.removeAttribute('lang');
    el.removeAttribute('xml:lang');
    if (el.hasAttribute('style')) {
      const cleaned = el.getAttribute('style').replace(NOISE_STYLE, '').trim();
      if (cleaned) el.setAttribute('style', cleaned);
      else el.removeAttribute('style');
    }
  });
  return tpl.innerHTML;
}

// True when an HTML clipboard payload looks like Word / Google Docs noise
// we want to clean automatically.
function __isOfficeHTML(html) {
  if (!html) return false;
  return /mso-|<o:p|class=("|')?Mso|font-family\s*:\s*['"]?Calibri/i.test(html);
}

// ---------- font family / size options (shared by page + title editors) ----
const FONT_FAMILY_OPTIONS = [
  { label: 'Default',            value: '' },
  { label: 'Inter',              value: 'Inter, system-ui, sans-serif' },
  { label: 'System Sans',        value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: 'Helvetica / Arial',  value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'Georgia',            value: 'Georgia, "Times New Roman", serif' },
  { label: 'Cormorant Garamond', value: '"Cormorant Garamond", Garamond, Georgia, serif' },
  { label: 'JetBrains Mono',     value: '"JetBrains Mono", Menlo, Consolas, monospace' },
];
const FONT_SIZE_OPTIONS = [
  { label: 'Default', value: '' },
  { label: '12px', value: '12px' },
  { label: '14px', value: '14px' },
  { label: '16px', value: '16px' },
  { label: '18px', value: '18px' },
  { label: '20px', value: '20px' },
  { label: '24px', value: '24px' },
  { label: '28px', value: '28px' },
  { label: '32px', value: '32px' },
];
function renderFontControlsHTML() {
  const famOpts = FONT_FAMILY_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  const sizeOpts = FONT_SIZE_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  return `
    <select class="toolbar-select" data-cmd="font-family" aria-label="Font" title="Font family">${famOpts}</select>
    <select class="toolbar-select toolbar-select-size" data-cmd="font-size" aria-label="Size" title="Font size">${sizeOpts}</select>
    <span class="toolbar-divider"></span>
    <button data-cmd="paste-plain" type="button" title="Paste from clipboard as plain text">Paste plain</button>
    <span class="toolbar-divider"></span>
  `;
}

// Curated palettes for the text-color and highlight popovers.
const TEXT_COLOR_SWATCHES = [
  { label: 'Default', value: '' },
  { label: 'Black',   value: '#0f172a' },
  { label: 'Slate',   value: '#475569' },
  { label: 'Red',     value: '#dc2626' },
  { label: 'Orange',  value: '#ea580c' },
  { label: 'Amber',   value: '#d97706' },
  { label: 'Green',   value: '#16a34a' },
  { label: 'Cyan',    value: '#0891b2' },
  { label: 'Blue',    value: '#2563eb' },
  { label: 'Indigo',  value: '#4f46e5' },
  { label: 'Purple',  value: '#7c3aed' },
  { label: 'Pink',    value: '#db2777' },
];
const HIGHLIGHT_SWATCHES = [
  { label: 'No highlight', value: '' },
  { label: 'Yellow',  value: '#fef08a' },
  { label: 'Green',   value: '#bbf7d0' },
  { label: 'Cyan',    value: '#a5f3fc' },
  { label: 'Blue',    value: '#bfdbfe' },
  { label: 'Pink',    value: '#fbcfe8' },
  { label: 'Orange',  value: '#fed7aa' },
  { label: 'Red',     value: '#fecaca' },
];

function __renderSwatchPopover(kind, swatches) {
  const items = swatches.map((s, i) => {
    const isClear = !s.value;
    const swatchStyle = isClear
      ? 'background:#fff;border:1px dashed #94a3b8;'
      : `background:${s.value};`;
    return `<button type="button" class="rt-swatch ${isClear ? 'is-clear' : ''}"
              data-value="${escapeHtml(s.value)}"
              tabindex="${i === 0 ? '0' : '-1'}"
              aria-label="${escapeHtml(s.label)}"
              title="${escapeHtml(s.label)}"
              style="${swatchStyle}">${isClear ? '×' : ''}</button>`;
  }).join('');
  return `<div class="rt-popover" data-popover="${kind}" role="dialog" aria-label="${kind === 'color' ? 'Text color' : 'Highlight color'}" hidden>
    <div class="rt-swatch-grid">${items}</div>
    <div class="rt-popover-footer">
      <label class="rt-custom">Custom <input type="color" data-cmd="${kind}-custom" /></label>
    </div>
  </div>`;
}

function renderAlignAndColorHTML() {
  const colorPop = __renderSwatchPopover('color', TEXT_COLOR_SWATCHES);
  const hlPop    = __renderSwatchPopover('highlight', HIGHLIGHT_SWATCHES);
  // Inline SVGs match toolbar icon weight (12px stroke set on body, 1.8 width)
  const alignLeft   = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M2 6h8M2 9h12M2 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`;
  const alignCenter = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M4 6h8M2 9h12M4 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`;
  const alignRight  = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M6 6h8M2 9h12M6 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`;
  return `
    <button data-cmd="align-left"   type="button" title="Align left"   aria-label="Align left">${alignLeft}</button>
    <button data-cmd="align-center" type="button" title="Align center" aria-label="Align center">${alignCenter}</button>
    <button data-cmd="align-right"  type="button" title="Align right"  aria-label="Align right">${alignRight}</button>
    <span class="toolbar-divider"></span>
    <span class="rt-popover-wrap">
      <button data-cmd="color-toggle" type="button" class="rt-color-btn" title="Text color" aria-label="Text color" aria-haspopup="dialog">
        <span class="rt-color-glyph">A</span><span class="rt-color-bar" data-color-bar="color"></span>
      </button>
      ${colorPop}
    </span>
    <span class="rt-popover-wrap">
      <button data-cmd="highlight-toggle" type="button" class="rt-color-btn" title="Highlight" aria-label="Highlight" aria-haspopup="dialog">
        <span class="rt-color-glyph">▮</span><span class="rt-color-bar" data-color-bar="highlight"></span>
      </button>
      ${hlPop}
    </span>
    <span class="toolbar-divider"></span>
  `;
}

// ---------- toolbar -----------------------------------------------
function renderPageToolbar() {
  return `
    ${renderFontControlsHTML()}
    <button data-cmd="h2"             type="button" title="Heading (Ctrl+1)">H2</button>
    <button data-cmd="h3"             type="button" title="Sub-heading (Ctrl+2)">H3</button>
    <button data-cmd="p"              type="button" title="Paragraph (Ctrl+3)">¶</button>
    <button data-cmd="bold"           type="button" title="Bold (Ctrl+B)"><b>B</b></button>
    <button data-cmd="italic"         type="button" title="Italic (Ctrl+I)"><i>I</i></button>
    <button data-cmd="ul"             type="button" title="Bulleted list">• List</button>
    <button data-cmd="ol"             type="button" title="Numbered list">1. List</button>
    <button data-cmd="link"           type="button" title="Link (Ctrl+K)">Link</button>
    <span class="toolbar-divider"></span>
    ${renderAlignAndColorHTML()}
    <button data-cmd="callout-info"    type="button" title="Info callout">Info</button>
    <button data-cmd="callout-warn"    type="button" title="Warning callout">Warn</button>
    <button data-cmd="callout-danger"  type="button" title="Danger callout">Danger</button>
    <button data-cmd="callout-success" type="button" title="Success callout">Success</button>
    <button data-cmd="badge-panel"     type="button" title="Badge panel">Badge</button>
    <button data-cmd="compare-cards"   type="button" title="Compare cards">Compare</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="image"           type="button" title="Insert image (library, upload, or URL)">🖼 Image</button>
    <button data-cmd="audio"           type="button" title="Insert audio (library, upload, or URL)">Audio</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="undo"            type="button" title="Undo (Ctrl+Z)">↶</button>
    <button data-cmd="redo"            type="button" title="Redo (Ctrl+Y)">↷</button>
    <button data-cmd="find"            type="button" title="Find/replace (Ctrl+F)">Find</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="html-toggle"     type="button" title="Toggle HTML source">${state.htmlMode ? 'Rich' : 'HTML'}</button>
  `;
}

// Wire font/size selects, alignment buttons, and color/highlight popovers
// against `toolbarEl` so they target the editor returned by `getEditor()`.
// CRITICAL: clicking a <select> or <button> in the toolbar blurs the editor
// which collapses the selection. We capture the editor's range on mousedown
// (BEFORE the dropdown opens) and restore it before applying the style, so
// the user's actual text selection survives.
function wireInlineFormatControls(toolbarEl, getEditor) {
  if (!toolbarEl) return;
  let savedRange = null;

  const saveSelection = () => {
    const ed = getEditor();
    if (!ed) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (ed.contains(r.commonAncestorContainer)) {
        savedRange = r.cloneRange();
      }
    }
  };
  const restoreSelection = () => {
    const ed = getEditor();
    if (!ed) return;
    ed.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      try { sel.addRange(savedRange); } catch (_) {}
    }
  };

  // Capture the editor's selection BEFORE any toolbar interaction steals focus.
  // The capture phase ensures we run before the browser opens the native
  // <select> dropdown (which blurs the editor and collapses the selection).
  toolbarEl.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.closest('select, .rt-popover-wrap, .rt-swatch, .rt-color-btn, [data-cmd="align-left"], [data-cmd="align-center"], [data-cmd="align-right"]')) {
      saveSelection();
    }
  }, true);

  // Font + size dropdowns
  toolbarEl.querySelectorAll('select.toolbar-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const cmd = sel.dataset.cmd;
      const ed = getEditor();
      if (!ed) return;
      restoreSelection();
      applyInlineStyle(ed, cmd, sel.value);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  // Justify buttons
  toolbarEl.querySelectorAll('[data-cmd="align-left"], [data-cmd="align-center"], [data-cmd="align-right"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const ed = getEditor();
      if (!ed) return;
      restoreSelection();
      const cmd = btn.dataset.cmd;
      const map = { 'align-left': 'left', 'align-center': 'center', 'align-right': 'right' };
      applyTextAlign(ed, map[cmd]);
      refreshActiveAlign(toolbarEl, ed);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  // Reflect current cursor block's alignment when focus returns to the editor.
  const ed0 = getEditor();
  if (ed0 && !ed0.__alignSyncWired) {
    ed0.__alignSyncWired = true;
    const sync = () => refreshActiveAlign(toolbarEl, ed0);
    ed0.addEventListener('keyup', sync);
    ed0.addEventListener('mouseup', sync);
    ed0.addEventListener('focus', sync);
  }

  // Color & highlight popovers
  ['color', 'highlight'].forEach(kind => {
    const wrap = toolbarEl.querySelector(`.rt-popover-wrap [data-popover="${kind}"]`)?.parentElement;
    if (!wrap) return;
    const trigger = wrap.querySelector(`[data-cmd="${kind}-toggle"]`);
    const popover = wrap.querySelector(`[data-popover="${kind}"]`);
    if (!trigger || !popover) return;

    const closeAll = () => {
      toolbarEl.querySelectorAll('.rt-popover').forEach(p => { p.hidden = true; });
    };
    trigger.addEventListener('mousedown', () => { saveSelection(); });
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      const wasOpen = !popover.hidden;
      closeAll();
      popover.hidden = wasOpen;
      if (!wasOpen) {
        const first = popover.querySelector('.rt-swatch');
        if (first) first.focus();
      }
    });

    popover.addEventListener('mousedown', (e) => {
      if (e.target.closest('.rt-swatch, input[type="color"]')) {
        saveSelection();
      }
    });

    // Swatch click
    popover.querySelectorAll('.rt-swatch').forEach(sw => {
      sw.addEventListener('click', (e) => {
        e.preventDefault();
        const val = sw.dataset.value || '';
        const ed = getEditor();
        if (!ed) { popover.hidden = true; return; }
        restoreSelection();
        const cssCmd = kind === 'color' ? 'color' : 'background-color';
        applyInlineStyle(ed, cssCmd, val);
        updateColorBar(toolbarEl, kind, val);
        popover.hidden = true;
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    // Keyboard nav inside popover: arrows + Enter
    popover.addEventListener('keydown', (e) => {
      const swatches = Array.from(popover.querySelectorAll('.rt-swatch'));
      const cur = swatches.indexOf(document.activeElement);
      if (e.key === 'Escape') { popover.hidden = true; trigger.focus(); return; }
      if (e.key === 'Enter' && cur >= 0) { swatches[cur].click(); return; }
      const cols = 4;
      let next = cur;
      if (e.key === 'ArrowRight') next = Math.min(swatches.length - 1, cur + 1);
      else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
      else if (e.key === 'ArrowDown') next = Math.min(swatches.length - 1, cur + cols);
      else if (e.key === 'ArrowUp') next = Math.max(0, cur - cols);
      else return;
      e.preventDefault();
      swatches.forEach(s => s.setAttribute('tabindex', '-1'));
      if (swatches[next]) { swatches[next].setAttribute('tabindex', '0'); swatches[next].focus(); }
    });

    // Custom color picker
    const customInp = popover.querySelector('input[type="color"]');
    if (customInp) {
      customInp.addEventListener('mousedown', () => { saveSelection(); });
      customInp.addEventListener('input', (e) => {
        const val = e.target.value || '';
        const ed = getEditor();
        if (!ed) return;
        restoreSelection();
        const cssCmd = kind === 'color' ? 'color' : 'background-color';
        applyInlineStyle(ed, cssCmd, val);
        updateColorBar(toolbarEl, kind, val);
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      });
      customInp.addEventListener('change', () => { popover.hidden = true; });
    }

    // Close popover on outside click
    document.addEventListener('mousedown', (e) => {
      if (popover.hidden) return;
      if (!wrap.contains(e.target)) popover.hidden = true;
    });
  });
}

// Apply text-align to the nearest block ancestor of each top-level node in
// the current selection. We avoid execCommand('justifyX') because in some
// browsers it emits deprecated <div align="..."> markup.
function applyTextAlign(editor, align) {
  if (!editor) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;

  const BLOCK_TAGS = /^(P|H1|H2|H3|H4|H5|H6|LI|DIV|BLOCKQUOTE|FIGCAPTION|PRE|TD|TH)$/;
  const blockOf = (node) => {
    let n = node.nodeType === 1 ? node : node.parentNode;
    while (n && n !== editor) {
      if (n.nodeType === 1 && BLOCK_TAGS.test(n.tagName)) return n;
      n = n.parentNode;
    }
    return null;
  };

  // Walk every element/text node in the range; collect unique blocks.
  const blocks = new Set();
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const r = document.createRange();
      try {
        r.selectNode(n);
      } catch (_) { return NodeFilter.FILTER_REJECT; }
      // Intersection check
      if (range.compareBoundaryPoints(Range.END_TO_START, r) <= 0 &&
          range.compareBoundaryPoints(Range.START_TO_END, r) >= 0) {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_REJECT;
    }
  });
  let node = walker.currentNode;
  // include the start container itself
  const startBlock = blockOf(range.startContainer);
  if (startBlock) blocks.add(startBlock);
  while ((node = walker.nextNode())) {
    const b = blockOf(node);
    if (b) blocks.add(b);
  }
  if (blocks.size === 0) {
    // Fallback: wrap-less selection in editor root — wrap in <p>
    const b = blockOf(range.startContainer) || editor;
    if (b !== editor) blocks.add(b);
  }
  blocks.forEach(b => {
    if (align === 'left') b.style.removeProperty('text-align');
    else b.style.textAlign = align;
  });
}

// Highlight the active alignment button reflecting the cursor's block.
function refreshActiveAlign(toolbarEl, editor) {
  if (!toolbarEl || !editor) return;
  const sel = window.getSelection();
  let align = 'left';
  if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    while (n && n !== editor) {
      if (n.nodeType === 1) {
        const ta = n.style && n.style.textAlign;
        if (ta) { align = ta; break; }
        const css = window.getComputedStyle(n).textAlign;
        if (css && /center|right/.test(css)) { align = css.startsWith('right') ? 'right' : 'center'; break; }
      }
      n = n.parentNode;
    }
  }
  toolbarEl.querySelectorAll('[data-cmd^="align-"]').forEach(b => {
    const want = b.dataset.cmd.replace('align-', '');
    b.classList.toggle('is-active', want === align);
  });
}

// Reflect the most-recently-picked color on the trigger button's color bar.
function updateColorBar(toolbarEl, kind, value) {
  const bar = toolbarEl.querySelector(`[data-color-bar="${kind}"]`);
  if (!bar) return;
  if (value) bar.style.backgroundColor = value;
  else bar.style.backgroundColor = '';
}

// Back-compat shim — legacy callers (older flows) used wireFontControls;
// keep the same name working but route through the new wiring.
function wireFontControls(getEditor) {
  wireInlineFormatControls($('#editor-toolbar'), getEditor);
}

function wirePageToolbar() {
  const ed = () => $('#html-editor');
  const exec = (cmd, val=null) => { const e = ed(); if (!e) return; e.focus(); document.execCommand(cmd, false, val); };
  const insertHTML = (html) => { const e = ed(); if (!e) return; e.focus(); document.execCommand('insertHTML', false, html); };
  const trigger = () => { const e = ed(); if (e) e.dispatchEvent(new Event('input', { bubbles: true })); };

  wireInlineFormatControls($('#editor-toolbar'), ed);
  const _ed0 = ed(); if (_ed0) wirePendingInlineStyle(_ed0);

  $('#editor-toolbar').querySelectorAll('button[data-cmd]').forEach(btn => {
    const cmdName = btn.dataset.cmd;
    // Skip controls already owned by wireInlineFormatControls.
    if (/^(align-|color-toggle$|highlight-toggle$|color-custom$|highlight-custom$)/.test(cmdName)) return;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'h2': exec('formatBlock', '<h2>'); break;
        case 'h3': exec('formatBlock', '<h3>'); break;
        case 'p':  exec('formatBlock', '<p>');  break;
        case 'bold':   exec('bold');   break;
        case 'italic': exec('italic'); break;
        case 'ul': exec('insertUnorderedList'); break;
        case 'ol': exec('insertOrderedList');   break;
        case 'undo': exec('undo'); break;
        case 'redo': exec('redo'); break;
        case 'link': {
          const url = prompt('Link URL:', 'https://');
          if (url) exec('createLink', url);
          break;
        }
        case 'image': {
          openImageInsertModal({
            mode: 'inline',
            editor: ed(),
            courseId: state.course?.id || null,
            courseSlug: state.course?.slug || null,
            onInsert: (html) => { insertHTML(html); trigger(); },
          });
          break;
        }
        case 'audio': {
          const ref = state.selection?.kind === 'page' ? findPage(state.selection.id) : null;
          openAudioInsertModal({
            editor: ed(),
            page: ref?.page || null,
            courseId: state.course?.id || null,
            courseSlug: state.course?.slug || null,
            onInsert: (html) => { insertHTML(html); trigger(); },
          });
          break;
        }
        case 'callout-info':    insertHTML('<div class="callout"><p><strong>Note:</strong> </p></div>'); break;
        case 'callout-warn':    insertHTML('<div class="callout callout-warn"><p><strong>Warning:</strong> </p></div>'); break;
        case 'callout-danger':  insertHTML('<div class="callout callout-danger"><p><strong>Critical:</strong> </p></div>'); break;
        case 'callout-success': insertHTML('<div class="callout callout-success"><p><strong>Success:</strong> </p></div>'); break;
        case 'badge-panel':     insertHTML('<div class="badge-panel"><span class="badge-label">INVESTIGATIVE NOTE</span> </div>'); break;
        case 'compare-cards':
          insertHTML(`<div class="compare-cards">
  <div class="compare-card compare-safe"><h3>Do</h3><ul><li>Safe practice</li></ul></div>
  <div class="compare-card compare-danger"><h3>Don't</h3><ul><li>Risky practice</li></ul></div>
</div>`);
          break;
        case 'find': $('#find-bar').classList.remove('hidden'); $('#find-q').focus(); break;
        case 'paste-plain': {
          try {
            const text = await navigator.clipboard.readText();
            if (text) { ed()?.focus(); document.execCommand('insertText', false, text); }
            else toast('Clipboard is empty or unreadable', 'is-error');
          } catch (err) {
            toast('Clipboard read denied — use Ctrl+Shift+V', 'is-error');
          }
          break;
        }
        case 'html-toggle':
          state.htmlMode = !state.htmlMode;
          renderEditorBody();
          break;
      }
      trigger();
    });
  });
}

// ---------- title-page editor (course + module) -------------------
// Renders a hero-image control + rich-text directions editor in the
// main editor host when a course or module is selected. Mirrors the
// page-body editor wiring (audio, image insert, autosave) so authors
// can drop inline images and audio into the directions copy.
function renderTitlePageToolbar() {
  return `
    ${renderFontControlsHTML()}
    <button data-cmd="h2"             type="button" title="Heading (Ctrl+1)">H2</button>
    <button data-cmd="h3"             type="button" title="Sub-heading (Ctrl+2)">H3</button>
    <button data-cmd="p"              type="button" title="Paragraph (Ctrl+3)">¶</button>
    <button data-cmd="bold"           type="button" title="Bold (Ctrl+B)"><b>B</b></button>
    <button data-cmd="italic"         type="button" title="Italic (Ctrl+I)"><i>I</i></button>
    <button data-cmd="ul"             type="button" title="Bulleted list">• List</button>
    <button data-cmd="ol"             type="button" title="Numbered list">1. List</button>
    <button data-cmd="link"           type="button" title="Link (Ctrl+K)">Link</button>
    <span class="toolbar-divider"></span>
    ${renderAlignAndColorHTML()}
    <button data-cmd="callout-info"    type="button" title="Info callout">Info</button>
    <button data-cmd="callout-warn"    type="button" title="Warning callout">Warn</button>
    <button data-cmd="callout-success" type="button" title="Success callout">Success</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="image"           type="button" title="Insert image (library, upload, or URL)">🖼 Image</button>
    <button data-cmd="audio"           type="button" title="Insert audio (library, upload, or URL)">Audio</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="undo"            type="button" title="Undo (Ctrl+Z)">↶</button>
    <button data-cmd="redo"            type="button" title="Redo (Ctrl+Y)">↷</button>
  `;
}

function wireTitlePageToolbar() {
  const ed = () => $('#title-html-editor');
  const exec = (cmd, val=null) => { const e = ed(); if (!e) return; e.focus(); document.execCommand(cmd, false, val); };
  const insertHTML = (html) => { const e = ed(); if (!e) return; e.focus(); document.execCommand('insertHTML', false, html); };
  const trigger = () => { const e = ed(); if (e) e.dispatchEvent(new Event('input', { bubbles: true })); };

  wireInlineFormatControls($('#editor-toolbar'), ed);
  const _ted0 = ed(); if (_ted0) wirePendingInlineStyle(_ted0);

  $('#editor-toolbar').querySelectorAll('button[data-cmd]').forEach(btn => {
    const cmdName = btn.dataset.cmd;
    if (/^(align-|color-toggle$|highlight-toggle$|color-custom$|highlight-custom$)/.test(cmdName)) return;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'h2': exec('formatBlock', '<h2>'); break;
        case 'h3': exec('formatBlock', '<h3>'); break;
        case 'p':  exec('formatBlock', '<p>');  break;
        case 'bold':   exec('bold');   break;
        case 'italic': exec('italic'); break;
        case 'ul': exec('insertUnorderedList'); break;
        case 'ol': exec('insertOrderedList');   break;
        case 'undo': exec('undo'); break;
        case 'redo': exec('redo'); break;
        case 'link': {
          const url = prompt('Link URL:', 'https://');
          if (url) exec('createLink', url);
          break;
        }
        case 'image': {
          openImageInsertModal({
            mode: 'inline',
            editor: ed(),
            courseId: state.course?.id || null,
            courseSlug: state.course?.slug || null,
            onInsert: (html) => { insertHTML(html); trigger(); },
          });
          break;
        }
        case 'audio': {
          openAudioInsertModal({
            editor: ed(),
            page: null,
            courseId: state.course?.id || null,
            courseSlug: state.course?.slug || null,
            onInsert: (html) => { insertHTML(html); trigger(); },
          });
          break;
        }
        case 'callout-info':    insertHTML('<div class="callout"><p><strong>Note:</strong> </p></div>'); break;
        case 'callout-warn':    insertHTML('<div class="callout callout-warn"><p><strong>Warning:</strong> </p></div>'); break;
        case 'callout-success': insertHTML('<div class="callout callout-success"><p><strong>Success:</strong> </p></div>'); break;
        case 'paste-plain': {
          try {
            const text = await navigator.clipboard.readText();
            if (text) { ed()?.focus(); document.execCommand('insertText', false, text); }
            else toast('Clipboard is empty or unreadable', 'is-error');
          } catch (err) {
            toast('Clipboard read denied — use Ctrl+Shift+V', 'is-error');
          }
          break;
        }
      }
      trigger();
    });
  });
}

function renderTitlePageBody({ kind, node }) {
  const isCourse = kind === 'course';
  const heroUrl = node.hero_image_url || '';
  const heroAlt = node.hero_image_alt || '';
  const initialHtml = (node.description_html != null && node.description_html !== '')
    ? node.description_html
    : (node.description ? `<p>${escapeHtml(node.description)}</p>` : '');
  const labelTitle = isCourse ? 'Course title page' : 'Module title page';
  const heroBlock = heroUrl
    ? `
        <div class="title-hero-preview">
          <img src="${escapeHtml(heroUrl)}" alt="${escapeHtml(heroAlt)}" loading="lazy" />
        </div>
        <div class="title-hero-actions">
          <button type="button" class="studio-btn" data-act="hero-replace">Replace image</button>
          <button type="button" class="studio-btn is-danger" data-act="hero-remove">Remove</button>
          <label class="title-hero-alt">
            <span>Alt text</span>
            <input type="text" id="title-hero-alt" value="${escapeHtml(heroAlt)}" placeholder="Describe the image for screen readers" />
          </label>
        </div>`
    : `
        <div class="title-hero-empty">
          <p>No hero image set.</p>
          <button type="button" class="studio-btn primary" data-act="hero-set">Set hero image</button>
        </div>`;
  return `
    <div class="title-page-editor">
      <div class="title-page-section">
        <h3 class="title-page-section-label">${escapeHtml(labelTitle)} · Hero image</h3>
        <div class="title-hero ${heroUrl ? 'has-image' : 'is-empty'}" id="title-hero">
          ${heroBlock}
        </div>
      </div>
      <div class="title-page-section">
        <h3 class="title-page-section-label">Directions</h3>
        <p class="title-page-hint">Shown beneath the title on the published title page. Supports inline images and audio narration.</p>
        <div id="title-html-editor" class="studio-html-editor title-page-html-editor" contenteditable="true" spellcheck="true">${initialHtml}</div>
      </div>
    </div>
  `;
}

function wireTitlePageBody({ kind, node }) {
  const isCourse = kind === 'course';
  const stage = (patch) => {
    if (isCourse) stageCoursePatch(patch);
    else stageModulePatch(node.id, patch);
  };

  const ed = $('#title-html-editor');
  if (ed) {
    // Seed description_html from legacy description on first edit so existing
    // content is preserved while we transition to the rich-text body.
    let seeded = (node.description_html != null && node.description_html !== '');
    ed.addEventListener('input', () => {
      const html = ed.innerHTML;
      stage({ description_html: html });
      seeded = true;
    });
    wireDropAndPasteOnTitleEditor(ed);
    wireInlineAudioControlsForTitle(ed);
    wireInlineImageControlsForTitle(ed);
    wireInlineBlockControls(ed);
  }

  const heroEl = $('#title-hero');
  if (!heroEl) return;
  const onHeroSetOrReplace = () => {
    openImageInsertModal({
      mode: 'hero',
      courseId: state.course?.id || null,
      courseSlug: isCourse ? (state.course?.slug || null) : (state.course?.slug || null),
      onPickHero: ({ url, alt }) => {
        const patch = { hero_image_url: url || null };
        if (alt) patch.hero_image_alt = alt;
        stage(patch);
        // Re-render the body so the new hero shows + actions update.
        renderEditorBody();
      },
    });
  };
  heroEl.querySelectorAll('[data-act="hero-set"], [data-act="hero-replace"]').forEach(b => {
    b.addEventListener('click', onHeroSetOrReplace);
  });
  const removeBtn = heroEl.querySelector('[data-act="hero-remove"]');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      if (!confirm('Remove the hero image? The image file itself stays in the media library.')) return;
      stage({ hero_image_url: null, hero_image_alt: null });
      renderEditorBody();
    });
  }
  const altInp = heroEl.querySelector('#title-hero-alt');
  if (altInp) {
    altInp.addEventListener('input', e => stage({ hero_image_alt: e.target.value || null }));
  }
}

// Drag-drop / paste image onto a title-page directions editor.
// Mirrors wireDropAndPaste but doesn't depend on a `page` row.
function wireDropAndPasteOnTitleEditor(editor) {
  ['dragenter','dragover'].forEach(t => editor.addEventListener(t, (e) => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      e.preventDefault(); editor.classList.add('is-dragging');
    }
  }));
  ['dragleave','drop'].forEach(t => editor.addEventListener(t, (e) => {
    e.preventDefault(); editor.classList.remove('is-dragging');
  }));
  editor.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('audio/'));
    if (!files.length) return;
    e.preventDefault();
    await insertUploadedFilesIntoEditor(files, editor);
  });
  editor.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter(it => it.kind === 'file' && (it.type.startsWith('image/') || it.type.startsWith('audio/')));
    if (!fileItems.length) return;
    e.preventDefault();
    const files = fileItems.map(it => it.getAsFile()).filter(Boolean);
    if (files.length) await insertUploadedFilesIntoEditor(files, editor);
  });
}

async function insertUploadedFilesIntoEditor(files, editor) {
  const courseId = state.course?.id;
  const courseSlug = state.course?.slug;
  for (const f of files) {
    setSaveState('saving', `Uploading ${f.name}…`);
    try {
      const row = await uploadOne(f, courseId, courseSlug);
      let alt = '';
      if (row.kind === 'image') {
        alt = prompt('Alt text for screen readers (recommended):', '') || '';
        if (alt) await sb.from('course_assets').update({ alt_text: alt }).eq('id', row.id);
      }
      const html = row.kind === 'image'
        ? `<img src="${escapeHtml(row.public_url)}" alt="${escapeHtml(alt)}" loading="lazy" />`
        : `<audio controls src="${escapeHtml(row.public_url)}"></audio>`;
      editor.focus();
      document.execCommand('insertHTML', false, html);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      setSaveState('saved', 'Uploaded');
    } catch (err) {
      console.error(err);
      setSaveState('error', 'Upload failed');
      toast('Upload failed: ' + err.message, 'is-error');
    }
  }
}

// Inline-audio overlay controls work on any contenteditable; the existing
// global delegate hooks #html-editor specifically. Reuse the existing init
// and just decorate audios in the title editor.
function wireInlineAudioControlsForTitle(editor) {
  if (!editor) return;
  __inlineAudioInitOnce();
  const decorate = () => {
    editor.querySelectorAll('audio:not([data-decorated])').forEach(a => {
      a.setAttribute('data-decorated', '1');
      a.setAttribute('contenteditable', 'false');
      a.setAttribute('controls', '');
      a.style.cursor = 'pointer';
    });
  };
  decorate();
  const mo = new MutationObserver(decorate);
  mo.observe(editor, { childList: true, subtree: true });
}

// ---------- module appendix --------------------------------------
// Per-module reference material: HTML blocks, PDF/DOCX uploads, external
// links. Backed by public.module_appendix_items (migration 0019). All
// writes go through the standard supabase-js client; RLS enforces tenant
// scoping. Files reuse the course-assets bucket via uploadOne().
const APPENDIX_KIND_LABEL = { html: 'HTML', pdf: 'PDF', docx: 'Word', link: 'Link' };
const APPENDIX_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function renderAppendixEditor(host, m) {
  const items = (m.appendix || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  host.innerHTML = `
    <div class="appendix-editor" style="padding:18px 24px; max-width:880px; margin:0 auto;">
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:8px;">
        <h2 style="margin:0; font-size:18px;">Appendix · ${escapeHtml(m.title)}</h2>
        <span style="font-size:12px; color:var(--studio-muted, #5b6788);">${items.length} item${items.length===1?'':'s'}</span>
      </div>
      <p style="margin:0 0 16px; color:var(--studio-muted, #5b6788); font-size:13px;">Reference material learners can open from any page in this module. HTML blocks, PDFs, Word documents, and external links.</p>
      <div class="appendix-add-bar" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px;">
        <button type="button" class="studio-btn primary" data-apx-add="html">+ Add HTML block</button>
        <button type="button" class="studio-btn"        data-apx-add="pdf">+ Add PDF</button>
        <button type="button" class="studio-btn"        data-apx-add="docx">+ Add Word doc</button>
        <button type="button" class="studio-btn"        data-apx-add="link">+ Add link</button>
      </div>
      <div id="apx-list" class="appendix-list" style="display:flex; flex-direction:column; gap:12px;">
        ${items.length ? items.map(it => renderAppendixItem(it)).join('') : '<div class="studio-empty-state"><p>No appendix items yet. Add one above.</p></div>'}
      </div>
    </div>
  `;
  wireAppendixEditor(host, m);
}

function renderAppendixItem(it) {
  const kindLabel = APPENDIX_KIND_LABEL[it.kind] || it.kind;
  const asset = it.course_assets || null;
  let detail = '';
  if (it.kind === 'html') {
    const snippet = htmlToPlainText(it.body_html || '').slice(0, 140);
    detail = `<div class="appendix-item-detail">${escapeHtml(snippet) || '<em>(empty)</em>'}</div>`;
  } else if ((it.kind === 'pdf' || it.kind === 'docx') && asset) {
    detail = `<div class="appendix-item-detail"><a href="${escapeHtml(asset.public_url || '')}" target="_blank" rel="noopener noreferrer">${escapeHtml(asset.filename || 'file')}</a> · ${fmtBytes(asset.byte_size || 0)}</div>`;
  } else if (it.kind === 'link') {
    detail = `<div class="appendix-item-detail"><a href="${escapeHtml(it.url || '')}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.url || '')}</a></div>`;
  } else if (it.kind === 'pdf' || it.kind === 'docx') {
    detail = `<div class="appendix-item-detail"><em>(file missing)</em></div>`;
  }
  const desc = it.description ? `<div class="appendix-item-desc" style="font-size:12px; color:var(--studio-muted, #5b6788); margin-top:4px;">${escapeHtml(it.description)}</div>` : '';
  return `
    <div class="appendix-item" data-apx-id="${escapeHtml(it.id)}" draggable="true"
         style="display:flex; gap:10px; align-items:flex-start; padding:12px 14px; background:#fff; border:1px solid var(--studio-line, #d9dfee); border-radius:8px;">
      <span class="appendix-handle" title="Drag to reorder" style="cursor:grab; color:var(--studio-muted, #5b6788); font-size:16px; user-select:none; padding-top:2px;">⋮⋮</span>
      <span class="appendix-kind-chip" style="font-size:11px; font-weight:700; letter-spacing:.5px; padding:2px 8px; border-radius:999px; background:#eef3ff; color:#0a3d91; text-transform:uppercase;">${escapeHtml(kindLabel)}</span>
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600; font-size:14px;">${escapeHtml(it.title || '(untitled)')}</div>
        ${desc}
        ${detail}
      </div>
      <div class="appendix-item-actions" style="display:flex; gap:6px;">
        <button type="button" class="studio-btn" data-apx-edit="${escapeHtml(it.id)}" title="Edit">Edit</button>
        <button type="button" class="studio-btn is-danger" data-apx-del="${escapeHtml(it.id)}" title="Delete">✕</button>
      </div>
    </div>
  `;
}

function wireAppendixEditor(host, m) {
  host.querySelectorAll('[data-apx-add]').forEach(btn => {
    btn.addEventListener('click', () => onAppendixAdd(m, btn.dataset.apxAdd));
  });
  host.querySelectorAll('[data-apx-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.apxEdit;
      const it = (m.appendix || []).find(x => x.id === id);
      if (it) onAppendixEdit(m, it);
    });
  });
  host.querySelectorAll('[data-apx-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.apxDel;
      const it = (m.appendix || []).find(x => x.id === id);
      if (it) onAppendixDelete(m, it);
    });
  });
  wireAppendixReorder(host, m);
}

function wireAppendixReorder(host, m) {
  const list = host.querySelector('#apx-list');
  if (!list) return;
  let dragId = null;
  list.querySelectorAll('.appendix-item').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      dragId = row.dataset.apxId;
      row.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); dragId = null; });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === row.dataset.apxId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const fromId = dragId; const toId = row.dataset.apxId;
      if (!fromId || !toId || fromId === toId) return;
      const arr = (m.appendix || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
      const fromIdx = arr.findIndex(x => x.id === fromId);
      const toIdx   = arr.findIndex(x => x.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      arr.forEach((x, i) => { x.position = i; });
      m.appendix = arr;
      renderAppendixEditor(host, m);
      try {
        const updates = arr.map(x => sb.from('module_appendix_items').update({ position: x.position }).eq('id', x.id));
        const results = await Promise.all(updates);
        const errs = results.filter(r => r.error);
        if (errs.length) throw errs[0].error;
        toast('Reordered', 'is-success');
      } catch (err) {
        console.error(err);
        toast('Reorder failed: ' + err.message, 'is-error');
      }
    });
  });
}

async function onAppendixAdd(m, kind) {
  if (kind === 'html') {
    const title = (prompt('Title for this HTML block:') || '').trim();
    if (!title) return;
    await insertAppendixItem(m, { kind: 'html', title, body_html: '<p></p>', position: (m.appendix || []).length });
    return;
  }
  if (kind === 'link') {
    const title = (prompt('Title for this link:') || '').trim();
    if (!title) return;
    const url = (prompt('URL (must start with http:// or https://):') || '').trim();
    if (!isSafeExternalUrl(url)) { toast('URL must start with http:// or https://', 'is-error'); return; }
    const description = (prompt('Optional short description (or leave blank):') || '').trim() || null;
    await insertAppendixItem(m, { kind: 'link', title, url, description, position: (m.appendix || []).length });
    return;
  }
  if (kind === 'pdf' || kind === 'docx') {
    pickAppendixFile(kind, async (file) => {
      const title = (prompt('Title shown to learners:', file.name.replace(/\.[a-z0-9]+$/i, '')) || '').trim();
      if (!title) return;
      try {
        setSaveState('saving', `Uploading ${file.name}…`);
        const row = await uploadOne(file, state.course?.id || null, state.course?.slug || null);
        // Mark the asset as an attachment (uploadOne defaults non-image/audio to 'file' which isn't a valid kind)
        await sb.from('course_assets').update({ kind: 'attachment' }).eq('id', row.id);
        await insertAppendixItem(m, {
          kind, title, asset_id: row.id, position: (m.appendix || []).length,
        });
        setSaveState('saved', 'Uploaded');
      } catch (err) {
        console.error(err);
        setSaveState('error', 'Upload failed');
        toast('Upload failed: ' + err.message, 'is-error');
      }
    });
    return;
  }
}

function pickAppendixFile(kind, cb) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = kind === 'pdf' ? 'application/pdf' : APPENDIX_DOCX_MIME + ',.docx';
  inp.style.display = 'none';
  inp.addEventListener('change', () => {
    const file = inp.files && inp.files[0];
    inp.remove();
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast(`File exceeds ${Math.round(MAX_UPLOAD_BYTES / (1024*1024))}MB limit`, 'is-error');
      return;
    }
    if (kind === 'pdf' && file.type !== 'application/pdf') {
      toast('Selected file is not a PDF', 'is-error'); return;
    }
    if (kind === 'docx' && file.type !== APPENDIX_DOCX_MIME) {
      toast('Selected file is not a Word .docx document', 'is-error'); return;
    }
    cb(file);
  });
  document.body.appendChild(inp);
  inp.click();
}

function isSafeExternalUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  return /^https?:\/\//i.test(u);
}

async function insertAppendixItem(m, patch) {
  const row = {
    module_id: m.id,
    created_by: state.user?.id || null,
    ...patch,
  };
  const { data, error } = await sb.from('module_appendix_items')
    .insert(row)
    .select('id, module_id, kind, title, position, body_html, asset_id, url, description, created_at, updated_at, course_assets(public_url, filename, byte_size, mime_type)')
    .single();
  if (error) { toast('Add failed: ' + error.message, 'is-error'); console.error(error); return; }
  m.appendix = (m.appendix || []).concat([data]);
  refreshOutlineLabels();
  if (state.selection?.kind === 'appendix' && state.selection.id === m.id) {
    renderAppendixEditor($('#editor-host'), m);
  }
  toast('Added to appendix', 'is-success');
}

async function onAppendixDelete(m, it) {
  if (!confirm(`Delete "${it.title}" from the appendix? This cannot be undone.`)) return;
  const { error } = await sb.from('module_appendix_items').delete().eq('id', it.id);
  if (error) { toast('Delete failed: ' + error.message, 'is-error'); return; }
  m.appendix = (m.appendix || []).filter(x => x.id !== it.id);
  refreshOutlineLabels();
  if (state.selection?.kind === 'appendix' && state.selection.id === m.id) {
    renderAppendixEditor($('#editor-host'), m);
  }
  toast('Deleted', 'is-success');
}

async function onAppendixEdit(m, it) {
  if (it.kind === 'html') {
    openAppendixHtmlEditor(m, it);
    return;
  }
  // For link/pdf/docx, allow editing title + description (and URL for links)
  const newTitle = prompt('Title:', it.title || '');
  if (newTitle == null) return;
  const trimmedTitle = newTitle.trim();
  if (!trimmedTitle) { toast('Title is required', 'is-error'); return; }
  const patch = { title: trimmedTitle };
  if (it.kind === 'link') {
    const newUrl = prompt('URL (http or https):', it.url || '');
    if (newUrl == null) return;
    if (!isSafeExternalUrl(newUrl.trim())) { toast('URL must start with http:// or https://', 'is-error'); return; }
    patch.url = newUrl.trim();
  }
  const newDesc = prompt('Description (optional):', it.description || '');
  if (newDesc != null) patch.description = newDesc.trim() || null;
  await updateAppendixItem(m, it.id, patch);
}

// Toolbar for the appendix HTML editor (#apx-body). Same control palette as
// the page / title-page toolbars: font/size, alignment, color, highlight,
// plus core formatting buttons. Wired against #apx-toolbar so the saved-
// selection pattern targets the appendix editor specifically.
function renderAppendixToolbar() {
  return `
    ${renderFontControlsHTML()}
    <button data-cmd="h2"     type="button" title="Heading">H2</button>
    <button data-cmd="h3"     type="button" title="Sub-heading">H3</button>
    <button data-cmd="p"      type="button" title="Paragraph">¶</button>
    <button data-cmd="bold"   type="button" title="Bold"><b>B</b></button>
    <button data-cmd="italic" type="button" title="Italic"><i>I</i></button>
    <button data-cmd="ul"     type="button" title="Bulleted list">• List</button>
    <button data-cmd="ol"     type="button" title="Numbered list">1. List</button>
    <button data-cmd="link"   type="button" title="Link">Link</button>
    <span class="toolbar-divider"></span>
    ${renderAlignAndColorHTML()}
    <button data-cmd="undo" type="button" title="Undo">↶</button>
    <button data-cmd="redo" type="button" title="Redo">↷</button>
  `;
}
function wireAppendixToolbar() {
  const tb = $('#apx-toolbar');
  if (!tb) return;
  const ed = () => $('#apx-body');
  const exec = (cmd, val = null) => { const e = ed(); if (!e) return; e.focus(); document.execCommand(cmd, false, val); };
  wireInlineFormatControls(tb, ed);
  tb.querySelectorAll('button[data-cmd]').forEach(btn => {
    const cmd = btn.dataset.cmd;
    if (/^(align-|color-toggle$|highlight-toggle$|color-custom$|highlight-custom$)/.test(cmd)) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      switch (cmd) {
        case 'h2': exec('formatBlock', '<h2>'); break;
        case 'h3': exec('formatBlock', '<h3>'); break;
        case 'p':  exec('formatBlock', '<p>');  break;
        case 'bold':   exec('bold');   break;
        case 'italic': exec('italic'); break;
        case 'ul': exec('insertUnorderedList'); break;
        case 'ol': exec('insertOrderedList');   break;
        case 'undo': exec('undo'); break;
        case 'redo': exec('redo'); break;
        case 'link': {
          const url = prompt('Link URL:', 'https://');
          if (url) exec('createLink', url);
          break;
        }
        case 'paste-plain': (async () => {
          try {
            const text = await navigator.clipboard.readText();
            if (text) { ed()?.focus(); document.execCommand('insertText', false, text); }
          } catch (_) {}
        })();
        break;
      }
    });
  });
}

function openAppendixHtmlEditor(m, it) {
  const host = $('#editor-host');
  host.innerHTML = `
    <div class="appendix-html-editor" style="padding:18px 24px; max-width:880px; margin:0 auto;">
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
        <button type="button" class="studio-btn" id="apx-back">← Back</button>
        <h2 style="margin:0; font-size:16px; flex:1;">Edit HTML block</h2>
        <button type="button" class="studio-btn primary" id="apx-save">Save</button>
      </div>
      <label style="display:block; font-size:12px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--studio-muted, #5b6788); margin-bottom:4px;">Title</label>
      <input id="apx-title" type="text" value="${escapeHtml(it.title || '')}"
             style="width:100%; padding:8px 10px; border:1px solid var(--studio-line, #d9dfee); border-radius:6px; margin-bottom:10px; font-size:14px;">
      <label style="display:block; font-size:12px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--studio-muted, #5b6788); margin-bottom:4px;">Description (optional)</label>
      <input id="apx-desc" type="text" value="${escapeHtml(it.description || '')}" placeholder="Short note shown under the title"
             style="width:100%; padding:8px 10px; border:1px solid var(--studio-line, #d9dfee); border-radius:6px; margin-bottom:10px; font-size:14px;">
      <label style="display:block; font-size:12px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--studio-muted, #5b6788); margin-bottom:4px;">Body</label>
      <div class="studio-pane-head studio-toolbar" id="apx-toolbar" style="border:1px solid var(--studio-line, #d9dfee); border-bottom:0; border-radius:6px 6px 0 0;">${renderAppendixToolbar()}</div>
      <div id="apx-body" class="studio-html-editor" contenteditable="true" spellcheck="true"
           style="min-height:200px; max-height:480px; overflow:auto; padding:14px; border:1px solid var(--studio-line, #d9dfee); border-radius:0 0 6px 6px; background:#fff;">${it.body_html || ''}</div>
    </div>
  `;
  // Wire the same inline-image overlay (Move / Replace / Alt / Delete) on
  // the appendix body so authors can edit/remove images here too.
  const apxBodyEl = $('#apx-body');
  if (apxBodyEl) {
    wireInlineImageControls(apxBodyEl);
    wireInlineBlockControls(apxBodyEl);
    wireAppendixToolbar();
    wirePendingInlineStyle(apxBodyEl);
  }

  $('#apx-back').addEventListener('click', () => {
    state.selection = { kind: 'appendix', id: m.id };
    renderEditorBody();
  });
  $('#apx-save').addEventListener('click', async () => {
    const title = $('#apx-title').value.trim();
    if (!title) { toast('Title is required', 'is-error'); return; }
    const description = ($('#apx-desc').value || '').trim() || null;
    const body_html = $('#apx-body').innerHTML;
    await updateAppendixItem(m, it.id, { title, description, body_html });
    state.selection = { kind: 'appendix', id: m.id };
    renderEditorBody();
  });
}

async function updateAppendixItem(m, id, patch) {
  const { data, error } = await sb.from('module_appendix_items')
    .update(patch).eq('id', id)
    .select('id, module_id, kind, title, position, body_html, asset_id, url, description, created_at, updated_at, course_assets(public_url, filename, byte_size, mime_type)')
    .single();
  if (error) { toast('Save failed: ' + error.message, 'is-error'); return; }
  const idx = (m.appendix || []).findIndex(x => x.id === id);
  if (idx >= 0) m.appendix[idx] = data;
  toast('Saved', 'is-success');
  refreshOutlineLabels();
}

// ---------- quiz form (unchanged) ---------------------------------
function renderQuizForm(q) {
  const opts = (Array.isArray(q.options) ? q.options : []).slice(0, 4);
  while (opts.length < 4) opts.push('');
  const ans = Number(q.answer_index ?? 0);
  return `<form class="quiz-form" id="quiz-form" autocomplete="off">
    <div class="field">
      <label for="qf-question">Question stem</label>
      <textarea id="qf-question">${escapeHtml(q.question || '')}</textarea>
    </div>
    <div class="field">
      <label>Options</label>
      <div class="quiz-options">
        ${opts.map((opt, i) => `
          <div class="quiz-option ${i === ans ? 'is-correct' : ''}" data-i="${i}">
            <label><input type="radio" name="qf-answer" value="${i}" ${i===ans?'checked':''}/> ${String.fromCharCode(65+i)}</label>
            <input type="text" data-opt="${i}" value="${escapeHtml(opt)}" />
          </div>`).join('')}
      </div>
    </div>
    <div class="field">
      <label for="qf-ref">Reference</label>
      <input type="text" id="qf-ref" value="${escapeHtml(q.reference || '')}" />
    </div>
  </form>`;
}

function wireQuizForm(q, kind) {
  const form = $('#quiz-form');
  const table = kind === 'kc' ? 'module_quiz_questions' : 'final_exam_questions';
  const stage = (patch) => stageQuizPatch(table, q.id, patch);

  $('#qf-question').addEventListener('input', (e) => stage({ question: e.target.value }));
  $('#qf-ref').addEventListener('input',      (e) => stage({ reference: e.target.value }));

  form.querySelectorAll('input[type="text"][data-opt]').forEach(inp => {
    inp.addEventListener('input', () => {
      const opts = Array.from(form.querySelectorAll('input[type="text"][data-opt]')).map(i => i.value);
      stage({ options: opts });
    });
  });
  form.querySelectorAll('input[name="qf-answer"]').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = Number(form.querySelector('input[name="qf-answer"]:checked').value);
      stage({ answer_index: idx });
      form.querySelectorAll('.quiz-option').forEach((opt, i) => opt.classList.toggle('is-correct', i === idx));
    });
  });
}

// ---------- citations helpers ------------------------------------
// Stable client-side id for a citation. Falls back to a random hex string
// when crypto.randomUUID is unavailable (e.g. in older Safari).
function cryptoRandomId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch (_) {}
  // 16 random bytes → 32 hex chars
  const bytes = new Uint8Array(16);
  (window.crypto || { getRandomValues: (a) => { for (let i=0;i<a.length;i++) a[i] = Math.floor(Math.random()*256); } }).getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
}

// Allow only http/https/mailto schemes. Returns the original URL when safe,
// or null when not. Used by both the editor [n] markers and the public
// References renderer to avoid javascript: / data: scheme XSS.
function safeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Allow protocol-relative and absolute http(s)/mailto only
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  // Bare domain like "example.com" — treat as https
  if (/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(\/.*)?$/i.test(s)) return 'https://' + s;
  return null;
}

// Format one citation as plain text/HTML segments. n is the 1-indexed position.
// Returns an HTMLElement (a <span>) containing escaped content. Safe to append
// to the DOM. Used by the studio preview and any other in-page renderer.
function formatCitationNode(c, n) {
  const span = document.createElement('span');
  span.className = 'ref-text';
  const parts = [];
  const authors = String(c.authors || '').trim();
  const year    = String(c.year || '').trim();
  const title   = String(c.title || '').trim();
  const source  = String(c.source || '').trim();
  const url     = safeUrl(c.url);

  if (authors) parts.push({ kind: 'text', text: authors + ' ' });
  if (year)    parts.push({ kind: 'text', text: '(' + year + '). ' });
  if (title) {
    if (url) parts.push({ kind: 'link', text: title, href: url, trailing: '. ' });
    else     parts.push({ kind: 'text', text: title + '. ' });
  }
  if (source)  parts.push({ kind: 'em', text: source + '. ' });
  if (url && !title) parts.push({ kind: 'link', text: url, href: url, trailing: ' ' });

  for (const p of parts) {
    if (p.kind === 'text') {
      span.appendChild(document.createTextNode(p.text));
    } else if (p.kind === 'em') {
      const em = document.createElement('em');
      em.textContent = p.text;
      span.appendChild(em);
    } else if (p.kind === 'link') {
      const a = document.createElement('a');
      a.href = p.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = p.text;
      span.appendChild(a);
      if (p.trailing) span.appendChild(document.createTextNode(p.trailing));
    }
  }
  const notes = String(c.notes || '').trim();
  if (notes) {
    const br = document.createElement('br');
    span.appendChild(br);
    const small = document.createElement('span');
    small.className = 'ref-notes';
    small.textContent = notes;
    span.appendChild(small);
  }
  return span;
}

// String version (for places that need a string). Builds via DOM then reads
// outerHTML — guaranteed escaped. Used by the static public renderer where
// we splice into innerHTML strings.
function formatCitation(c, n) {
  return formatCitationNode(c, n).outerHTML;
}

// Walk the editor body and update each [data-cite] marker's number + href so
// they reflect the citation's CURRENT position. Also marks orphans as
// .cite-missing with [?]. Idempotent — safe to call many times.
function recomputeCiteMarkers(editor, citations) {
  if (!editor) return;
  const list = Array.isArray(citations) ? citations : [];
  const idToIdx = new Map();
  list.forEach((c, i) => { if (c && c.id) idToIdx.set(c.id, i + 1); });
  editor.querySelectorAll('[data-cite]').forEach(node => {
    const cid = node.getAttribute('data-cite');
    const n = idToIdx.get(cid);
    let a = node.querySelector('a');
    if (!a) {
      a = document.createElement('a');
      node.appendChild(a);
    }
    if (n) {
      if (node.classList.contains('cite-missing')) node.classList.remove('cite-missing');
      if (node.hasAttribute('title')) node.removeAttribute('title');
      const want = '[' + n + ']';
      if (a.textContent !== want) a.textContent = want;
      const href = '#cite-' + cid;
      if (a.getAttribute('href') !== href) a.setAttribute('href', href);
    } else {
      if (!node.classList.contains('cite-missing')) node.classList.add('cite-missing');
      const titleWant = 'Citation deleted — remove or re-add';
      if (node.getAttribute('title') !== titleWant) node.setAttribute('title', titleWant);
      if (a.textContent !== '[?]') a.textContent = '[?]';
      if (a.hasAttribute('href')) a.removeAttribute('href');
    }
  });
}

// Render the Citations card body (#cite-list) for a given page object. Wires
// up all per-row events (drag, reorder, edit, insert marker, delete).
function renderCitationsCard(page) {
  const list = $('#cite-list');
  if (!list) return;
  const citations = Array.isArray(page.citations) ? page.citations : [];
  const countEl = $('#cite-count');
  if (countEl) countEl.textContent = String(citations.length);

  if (!citations.length) {
    list.innerHTML = `<div class="cite-empty">No citations yet. Click <strong>+ Add citation</strong> to create one.</div>`;
    // still recompute markers in case the user just deleted everything
    const ed = $('#html-editor');
    if (ed) recomputeCiteMarkers(ed, citations);
    return;
  }

  list.innerHTML = '';
  citations.forEach((c, idx) => {
    const n = idx + 1;
    const row = document.createElement('div');
    row.className = 'cite-card';
    row.setAttribute('draggable', 'true');
    row.dataset.citeId = c.id || '';
    row.dataset.idx = String(idx);
    row.innerHTML = `
      <div class="cite-card-head">
        <span class="cite-handle" title="Drag to reorder">⋮⋮</span>
        <span class="cite-num">[${n}]</span>
        <button type="button" class="studio-btn cite-insert" data-act="insert">Insert [${n}]</button>
        <span class="cite-spacer"></span>
        <button type="button" class="studio-btn-icon cite-up"   data-act="up"   title="Move up">▲</button>
        <button type="button" class="studio-btn-icon cite-down" data-act="down" title="Move down">▼</button>
        <button type="button" class="studio-btn-icon cite-del"  data-act="del"  title="Remove">✕</button>
      </div>
      <div class="cite-card-body">
        <label class="cite-field">
          <span class="cite-label">Title<span class="cite-req">*</span></span>
          <input type="text" class="cite-title" data-field="title" value="" placeholder="e.g. The 2024 Internet Crime Report" />
        </label>
        <label class="cite-field">
          <span class="cite-label">Authors</span>
          <input type="text" class="cite-authors" data-field="authors" value="" placeholder="Smith, J., Jones, K." />
        </label>
        <label class="cite-field">
          <span class="cite-label">Source</span>
          <input type="text" class="cite-source" data-field="source" value="" placeholder="FBI IC3 Report 2024" />
        </label>
        <div class="cite-field cite-row">
          <label class="cite-sub">
            <span class="cite-label">URL</span>
            <input type="url" class="cite-url" data-field="url" value="" placeholder="https://…" />
          </label>
          <label class="cite-sub cite-sub-narrow">
            <span class="cite-label">Year</span>
            <input type="text" class="cite-year" data-field="year" value="" placeholder="2024" maxlength="4" />
          </label>
        </div>
        <label class="cite-field">
          <span class="cite-label">Notes</span>
          <textarea class="cite-notes" data-field="notes" rows="2" placeholder="Optional"></textarea>
        </label>
      </div>
    `;
    // Set values via .value / .textContent (no innerHTML interpolation = no XSS surface)
    row.querySelector('[data-field="title"]').value   = String(c.title   || '');
    row.querySelector('[data-field="authors"]').value = String(c.authors || '');
    row.querySelector('[data-field="source"]').value  = String(c.source  || '');
    row.querySelector('[data-field="url"]').value     = String(c.url     || '');
    row.querySelector('[data-field="year"]').value    = String(c.year    || '');
    row.querySelector('[data-field="notes"]').value   = String(c.notes   || '');
    list.appendChild(row);
  });

  // Wire field edits — debounced patch + (no re-render) to keep focus
  list.querySelectorAll('.cite-card').forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelectorAll('[data-field]').forEach(input => {
      input.addEventListener('input', () => {
        const cur = Array.isArray(page.citations) ? page.citations.slice() : [];
        if (!cur[idx]) return;
        cur[idx] = { ...cur[idx], [input.dataset.field]: input.value };
        stagePagePatch(page.id, { citations: cur });
        // No full re-render — just update markers (numbers are unchanged here)
      });
    });
    // Per-row actions
    row.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const act = btn.dataset.act;
        const cur = Array.isArray(page.citations) ? page.citations.slice() : [];
        if (act === 'insert') {
          insertCitationMarker(cur[idx], idx + 1);
          return;
        }
        if (act === 'del') {
          const target = cur[idx] || {};
          const label = String(target.title || target.source || target.authors || `[${idx + 1}]`).slice(0, 80);
          if (!confirm(`Delete citation "${label}"?\n\nThe entry is removed from this page. Any [n] markers in the body that point to it become [?] until you remove them.\n\nThis cannot be undone in the current session.`)) return;
          cur.splice(idx, 1);
          stagePagePatch(page.id, { citations: cur });
          renderCitationsCard(page);
          const ed = $('#html-editor');
          if (ed) recomputeCiteMarkers(ed, cur);
          renderPreview();
          try { toast(`Citation removed (${cur.length} remaining)`, 'is-ok'); } catch (_) {}
          return;
        }
        if (act === 'up' && idx > 0) {
          const tmp = cur[idx-1]; cur[idx-1] = cur[idx]; cur[idx] = tmp;
          stagePagePatch(page.id, { citations: cur });
          renderCitationsCard(page);
          const ed = $('#html-editor');
          if (ed) recomputeCiteMarkers(ed, cur);
          renderPreview();
          return;
        }
        if (act === 'down' && idx < cur.length - 1) {
          const tmp = cur[idx+1]; cur[idx+1] = cur[idx]; cur[idx] = tmp;
          stagePagePatch(page.id, { citations: cur });
          renderCitationsCard(page);
          const ed = $('#html-editor');
          if (ed) recomputeCiteMarkers(ed, cur);
          renderPreview();
          return;
        }
      });
    });
    // Drag-and-drop reorder
    row.addEventListener('dragstart', (e) => {
      row.classList.add('cite-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(row.dataset.idx)); } catch(_) {}
    });
    row.addEventListener('dragend', () => row.classList.remove('cite-dragging'));
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('cite-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('cite-drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('cite-drop-target');
      const fromIdxStr = e.dataTransfer.getData('text/plain');
      const fromIdx = Number(fromIdxStr);
      const toIdx = Number(row.dataset.idx);
      if (Number.isNaN(fromIdx) || fromIdx === toIdx) return;
      const cur = Array.isArray(page.citations) ? page.citations.slice() : [];
      const [moved] = cur.splice(fromIdx, 1);
      cur.splice(toIdx, 0, moved);
      stagePagePatch(page.id, { citations: cur });
      renderCitationsCard(page);
      const ed = $('#html-editor');
      if (ed) recomputeCiteMarkers(ed, cur);
      renderPreview();
    });
  });

  // Update markers in the editor to reflect current numbering
  const ed = $('#html-editor');
  if (ed) recomputeCiteMarkers(ed, citations);
}

// Insert a [n] sup marker at the editor caret pointing to a citation by id.
function insertCitationMarker(citation, n) {
  if (!citation || !citation.id) return;
  const ed = $('#html-editor');
  if (!ed) {
    toast('Switch to a page in WYSIWYG mode to insert a citation marker.', 'is-warn');
    return;
  }
  const cid = String(citation.id);
  const html = `<sup class="cite-marker" data-cite="${escapeHtml(cid)}"><a href="#cite-${escapeHtml(cid)}">[${n}]</a></sup>`;
  ed.focus();
  // If the current selection isn't inside the editor, place caret at end.
  const sel = window.getSelection();
  let inside = false;
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    inside = ed.contains(r.commonAncestorContainer);
  }
  if (!inside) {
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  document.execCommand('insertHTML', false, html);
  // Trigger autosave/dirty path the same way the editor input event does
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  // Recompute (in case other markers exist; numbering is unchanged for this op
  // but ensures consistency with the latest list).
  const ref = state.selection?.kind === 'page' ? findPage(state.selection.id) : null;
  if (ref) recomputeCiteMarkers(ed, ref.page.citations || []);
}

// ---------- metadata pane ----------------------------------------
function renderMeta() {
  const host = $('#meta-host');
  const titleEl = $('#meta-title');
  if (!host) return;
  if (!state.selection) { titleEl.textContent = 'Metadata'; host.innerHTML = ''; return; }
  const { kind, id } = state.selection;

  if (kind === 'page') {
    const ref = findPage(id);
    if (!ref) return;
    titleEl.textContent = 'Page';
    const metaCollapsed = localStorage.getItem('studio.meta.collapsed.metadata') === '1';
    const citeCollapsed = localStorage.getItem('studio.meta.collapsed.citations') === '1';
    host.innerHTML = `
      <section class="meta-card ${metaCollapsed ? 'is-collapsed' : ''}" data-card="metadata">
        <button type="button" class="meta-card-head" data-toggle="metadata" aria-expanded="${metaCollapsed?'false':'true'}">
          <span class="meta-card-chev" aria-hidden="true">▾</span>
          <span class="meta-card-title">Page Metadata</span>
        </button>
        <div class="meta-card-body">
          <form class="meta-form">
            <div class="field"><label>Title</label><input id="meta-title-in" type="text" value="${escapeHtml(ref.page.title || '')}" placeholder="(optional)"/></div>
            <div class="field"><label>Type</label>
              <select id="meta-type">
                <option value="text"        ${ref.page.page_type==='text'?'selected':''}>Text</option>
                <option value="case-study"  ${ref.page.page_type==='case-study'?'selected':''}>Case study</option>
                <option value="interactive" ${ref.page.page_type==='interactive'?'selected':''}>Interactive</option>
              </select>
            </div>
            <div class="field audio-field">
              <label>Audio narration</label>
              <div id="meta-audio-player" class="meta-audio-player ${ref.page.audio_url ? '' : 'is-empty'}">
                ${ref.page.audio_url
                  ? `<audio controls preload="metadata" src="${escapeHtml(ref.page.audio_url)}" style="width:100%"></audio>`
                  : `<div class="meta-audio-empty">No narration assigned to this page.</div>`}
              </div>
              <input id="meta-audio" type="text" value="${escapeHtml(ref.page.audio_url || '')}" placeholder="https://&hellip; or pick from library" spellcheck="false"/>
              <div class="meta-audio-actions">
                <button type="button" class="studio-btn" id="meta-audio-pick">${ref.page.audio_url ? 'Replace from library' : 'Pick from library'}</button>
                ${ref.page.audio_url ? `<button type="button" class="studio-btn is-danger" id="meta-audio-clear">Remove narration</button>` : ''}
                ${ref.page.audio_url ? `<a class="studio-btn-link" href="${escapeHtml(ref.page.audio_url)}" target="_blank" rel="noopener">Open in new tab</a>` : ''}
              </div>
            </div>
            <div class="meta-info">
              Lesson: <strong>${escapeHtml(ref.lesson.title)}</strong><br>
              Module: ${escapeHtml(ref.module.title)}<br>
              Position: ${ref.page.position + 1}<br>
              Updated: ${fmtRelTime(ref.page.updated_at)}
            </div>
          </form>
        </div>
      </section>
      <section class="meta-card ${citeCollapsed ? 'is-collapsed' : ''}" data-card="citations">
        <button type="button" class="meta-card-head" data-toggle="citations" aria-expanded="${citeCollapsed?'false':'true'}">
          <span class="meta-card-chev" aria-hidden="true">▾</span>
          <span class="meta-card-title">Citations</span>
          <span class="meta-card-count" id="cite-count">${(Array.isArray(ref.page.citations)?ref.page.citations.length:0)}</span>
        </button>
        <div class="meta-card-body">
          <div id="cite-list" class="cite-list"></div>
          <div class="cite-actions">
            <button type="button" class="studio-btn" id="cite-add">+ Add citation</button>
          </div>
          <p class="cite-help">Citations save with the page. Use <code>[n]</code> markers in the body to point to them. The References section auto-renders below the page when published.</p>
        </div>
      </section>
    `;
    // Card collapse toggles
    host.querySelectorAll('.meta-card-head').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.meta-card');
        const which = btn.dataset.toggle;
        const wasCollapsed = card.classList.toggle('is-collapsed');
        btn.setAttribute('aria-expanded', wasCollapsed ? 'false' : 'true');
        try { localStorage.setItem(`studio.meta.collapsed.${which}`, wasCollapsed ? '1' : '0'); } catch(_) {}
      });
    });
    renderCitationsCard(ref.page);
    $('#cite-add').addEventListener('click', () => {
      const list = Array.isArray(ref.page.citations) ? ref.page.citations.slice() : [];
      list.push({ id: cryptoRandomId(), title: '', authors: '', source: '', url: '', year: '', notes: '' });
      stagePagePatch(ref.page.id, { citations: list });
      renderCitationsCard(ref.page);
      // focus the new title input
      setTimeout(() => {
        const inputs = $$('#cite-list .cite-title');
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
      }, 0);
    });
    $('#meta-title-in').addEventListener('input', e => stagePagePatch(ref.page.id, { title: e.target.value }));
    $('#meta-type').addEventListener('change',     e => stagePagePatch(ref.page.id, { page_type: e.target.value }));
    const refreshAudioBlock = (newUrl) => {
      stagePagePatch(ref.page.id, { audio_url: newUrl || null });
      // Re-render the meta pane so the player + buttons reflect the new value.
      // Schedule on next tick so the patch is applied before re-render reads state.
      setTimeout(() => renderMeta('page', ref.page.id), 0);
    };
    $('#meta-audio').addEventListener('input', e => {
      // Live URL edit: update the staged patch and the player src without
      // re-rendering the whole meta pane (so focus stays in the input).
      const v = e.target.value.trim();
      stagePagePatch(ref.page.id, { audio_url: v || null });
      const player = $('#meta-audio-player');
      if (player) {
        if (v) {
          player.classList.remove('is-empty');
          player.innerHTML = `<audio controls preload="metadata" src="${escapeHtml(v)}" style="width:100%"></audio>`;
        } else {
          player.classList.add('is-empty');
          player.innerHTML = `<div class="meta-audio-empty">No narration assigned to this page.</div>`;
        }
      }
    });
    const pickBtn = $('#meta-audio-pick');
    if (pickBtn) pickBtn.addEventListener('click', () => openAudioPicker(ref.page.id, refreshAudioBlock));
    const clearBtn = $('#meta-audio-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (!confirm('Remove the audio narration from this page? The audio file itself will not be deleted from the media library.')) return;
      refreshAudioBlock(null);
      toast('Narration removed (save to apply)');
    });
    return;
  }

  if (kind === 'lesson') {
    const ref = findLesson(id);
    if (!ref) return;
    titleEl.textContent = 'Lesson metadata';
    host.innerHTML = `<form class="meta-form">
      <div class="field"><label>Title</label><input id="meta-title-in" type="text" value="${escapeHtml(ref.lesson.title)}"/></div>
      <div class="meta-info">
        Module: ${escapeHtml(ref.module.title)}<br>
        Slug: <code>${escapeHtml(ref.lesson.slug)}</code><br>
        ${ref.lesson.pages.length} page(s)
      </div>
    </form>`;
    $('#meta-title-in').addEventListener('input', e => stageLessonPatch(ref.lesson.id, { title: e.target.value }));
    return;
  }

  if (kind === 'module') {
    const m = findModule(id);
    if (!m) return;
    titleEl.textContent = 'Module metadata';
    host.innerHTML = `<form class="meta-form">
      <div class="field"><label>Title</label><input id="meta-title-in" type="text" value="${escapeHtml(m.title)}"/></div>
      <div class="meta-info">Slug: <code>${escapeHtml(m.slug)}</code><br>${m.lessons.length} lesson(s) · ${m.kc.length} KC question(s)<br><span class="meta-hint">Hero image &amp; directions are edited in the main pane.</span></div>
    </form>`;
    $('#meta-title-in').addEventListener('input', e => stageModulePatch(m.id, { title: e.target.value }));
    return;
  }

  if (kind === 'course') {
    titleEl.textContent = 'Course metadata';
    host.innerHTML = `<form class="meta-form">
      <div class="field"><label>Title</label><input id="meta-title-in" type="text" value="${escapeHtml(state.course.title)}"/></div>
      <div class="field"><label>Pass threshold (%)</label><input id="meta-thresh" type="number" min="0" max="100" value="${state.course.pass_threshold}"/></div>
      <div class="field"><label>Visibility</label>
        <select id="meta-vis">
          <option value="private"    ${state.course.visibility==='private'   ?'selected':''}>Private</option>
          <option value="preview"    ${state.course.visibility==='preview'   ?'selected':''}>Preview</option>
          <option value="public"     ${state.course.visibility==='public'    ?'selected':''}>Public</option>
          <option value="restricted" ${state.course.visibility==='restricted'?'selected':''}>Restricted (LE only)</option>
        </select>
        <div class="meta-hint" style="margin-top:4px;font-size:12px;color:var(--studio-muted,#5b6788);">
          Restricted courses are visible only to authenticated users with an approved access request.
        </div>
      </div>
      <div class="meta-info">Slug: <code>${escapeHtml(state.course.slug)}</code>${state.course.archived_at ? ' · <strong style="color:#b58a00">Archived</strong>' : ''}${state.course.deleted_at ? ' · <strong style="color:#b42318">Soft-deleted</strong>' : ''}<br><span class="meta-hint">Hero image &amp; directions are edited in the main pane.</span></div>
    </form>
    <div id="course-danger-host"></div>`;
    $('#meta-title-in').addEventListener('input', e => stageCoursePatch({ title: e.target.value }));
    $('#meta-thresh').addEventListener('input',    e => stageCoursePatch({ pass_threshold: Number(e.target.value) }));
    $('#meta-vis').addEventListener('change',      e => stageCoursePatch({ visibility: e.target.value }));
    renderCourseDangerZone();
    return;
  }

  if (kind === 'kc' || kind === 'finalq') {
    const ref = kind === 'kc' ? findKc(id) : findFinal(id);
    titleEl.textContent = kind === 'kc' ? 'KC question' : 'Final-exam question';
    host.innerHTML = `<div class="meta-info">${kind === 'kc' ? 'Knowledge-check question on module: <strong>' + escapeHtml(ref.module.title) + '</strong>' : 'Final-exam question'}</div>`;
    return;
  }

  titleEl.textContent = 'Metadata';
  host.innerHTML = '';
}

// ---------- course danger zone (archive / soft-delete / hard-delete) -----
// Visible to super_admin only. Progressive flow:
//   active     -> Archive
//   archived   -> Unarchive | Soft-delete (slug-typed confirm)
//   soft-del'd -> Permanently delete (double slug-typed confirm)
function renderCourseDangerZone() {
  const host = $('#course-danger-host');
  if (!host || !state.course) return;
  if (state.profile?.role !== 'super_admin') { host.innerHTML = ''; return; }

  const c = state.course;
  const archived = !!c.archived_at;
  const softDeleted = !!c.deleted_at;

  let actionsHtml = '';
  if (softDeleted) {
    actionsHtml = `
      <p class="dz-help">This course is soft-deleted. It is hidden from all views. Permanently delete to remove it from the database.</p>
      <button type="button" class="studio-btn dz-btn dz-hard" id="dz-hard-delete">Permanently delete</button>`;
  } else if (archived) {
    actionsHtml = `
      <p class="dz-help">This course is archived. Unarchive to restore, or soft-delete to hide it from all views (still recoverable by a super_admin).</p>
      <button type="button" class="studio-btn dz-btn dz-unarchive" id="dz-unarchive">Unarchive</button>
      <button type="button" class="studio-btn dz-btn dz-soft" id="dz-soft-delete">Delete (soft)</button>`;
  } else {
    actionsHtml = `
      <p class="dz-help">Archive a course to mark it inactive without deleting any data. Archived courses remain visible to authors with an "Archived" badge.</p>
      <button type="button" class="studio-btn dz-btn dz-archive" id="dz-archive">Archive</button>`;
  }

  host.innerHTML = `
    <section class="meta-card dz-card">
      <div class="meta-card-head" style="cursor:default">
        <span class="meta-card-title" style="color:#b42318">⚠ Danger zone</span>
      </div>
      <div class="meta-card-body">
        ${actionsHtml}
      </div>
    </section>`;

  const arc = $('#dz-archive');
  if (arc) arc.addEventListener('click', () => runArchive(c));
  const una = $('#dz-unarchive');
  if (una) una.addEventListener('click', () => runUnarchive(c));
  const sd = $('#dz-soft-delete');
  if (sd) sd.addEventListener('click', () => runSoftDelete(c));
  const hd = $('#dz-hard-delete');
  if (hd) hd.addEventListener('click', () => runHardDelete(c));
}

async function runArchive(c) {
  if (!confirm(`Archive course "${c.title}"? It will be marked archived but no data is deleted.`)) return;
  const { error } = await sb.rpc('archive_course', { p_course_id: c.id });
  if (error) { toast('Archive failed: ' + error.message, 'is-error'); return; }
  toast('Course archived');
  c.archived_at = new Date().toISOString();
  renderCourseDangerZone();
  renderMeta();
}

async function runUnarchive(c) {
  const { error } = await sb.rpc('unarchive_course', { p_course_id: c.id });
  if (error) { toast('Unarchive failed: ' + error.message, 'is-error'); return; }
  toast('Course unarchived');
  c.archived_at = null;
  renderCourseDangerZone();
  renderMeta();
}

function runSoftDelete(c) {
  openModal({
    title: 'Soft-delete course',
    bodyHtml: `
      <p>Soft-delete <strong>${escapeHtml(c.title)}</strong>?</p>
      <p>It will be hidden from all views but can be restored by an admin.</p>
      <p style="margin-top:12px">Type the course slug <code>${escapeHtml(c.slug)}</code> to confirm:</p>
      <input id="dz-slug-input" type="text" autocomplete="off" spellcheck="false"
             style="width:100%;padding:8px;border:1px solid #d0d7de;border-radius:6px;margin-top:6px"/>`,
    footHtml: `
      <button type="button" class="studio-btn" id="dz-cancel">Cancel</button>
      <button type="button" class="studio-btn dz-btn dz-soft" id="dz-confirm" disabled>Soft-delete</button>`,
    onMount: (root) => {
      const input = root.querySelector('#dz-slug-input');
      const btn = root.querySelector('#dz-confirm');
      input.addEventListener('input', () => { btn.disabled = input.value !== c.slug; });
      root.querySelector('#dz-cancel').addEventListener('click', closeModal);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const { error } = await sb.rpc('soft_delete_course', { p_course_id: c.id });
        if (error) { toast('Soft-delete failed: ' + error.message, 'is-error'); btn.disabled = false; return; }
        closeModal();
        toast('Course soft-deleted');
        navigate('/studio/courses');
      });
      input.focus();
    }
  });
}

function runHardDelete(c) {
  openModal({
    title: 'Permanently delete course',
    bodyHtml: `
      <p style="color:#b42318"><strong>This action cannot be undone.</strong></p>
      <p>Permanently deleting <strong>${escapeHtml(c.title)}</strong> will remove the course and ALL associated data:</p>
      <ul style="margin:8px 0 12px 22px">
        <li>Versions, modules, lessons, pages</li>
        <li>Knowledge-check and final-exam questions</li>
        <li>Course assets (images, audio)</li>
        <li>Enrollments, quiz attempts, ToS acceptances</li>
      </ul>`,
    footHtml: `
      <button type="button" class="studio-btn" id="dz-cancel">Cancel</button>
      <button type="button" class="studio-btn dz-btn dz-hard" id="dz-next">I understand — continue</button>`,
    onMount: (root) => {
      root.querySelector('#dz-cancel').addEventListener('click', closeModal);
      root.querySelector('#dz-next').addEventListener('click', () => hardDeleteSecondConfirm(c));
    }
  });
}

function hardDeleteSecondConfirm(c) {
  openModal({
    title: 'Final confirmation',
    bodyHtml: `
      <p style="color:#b42318"><strong>Last chance.</strong> Type the course slug to permanently delete:</p>
      <p><code>${escapeHtml(c.slug)}</code></p>
      <input id="dz-slug-input2" type="text" autocomplete="off" spellcheck="false"
             style="width:100%;padding:8px;border:1px solid #d0d7de;border-radius:6px;margin-top:6px"/>`,
    footHtml: `
      <button type="button" class="studio-btn" id="dz-cancel">Cancel</button>
      <button type="button" class="studio-btn dz-btn dz-hard" id="dz-confirm-hard" disabled>Permanently delete</button>`,
    onMount: (root) => {
      const input = root.querySelector('#dz-slug-input2');
      const btn = root.querySelector('#dz-confirm-hard');
      input.addEventListener('input', () => { btn.disabled = input.value !== c.slug; });
      root.querySelector('#dz-cancel').addEventListener('click', closeModal);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const { error } = await sb.rpc('hard_delete_course', { p_course_id: c.id });
        if (error) { toast('Permanent delete failed: ' + error.message, 'is-error'); btn.disabled = false; return; }
        closeModal();
        toast('Course permanently deleted');
        navigate('/studio/courses');
      });
      input.focus();
    }
  });
}

// ---------- audio narration picker -------------------------------
// Opens a modal listing audio assets in course_assets for the current course.
// onPick(url) is invoked with the chosen public_url, or null if cleared.
async function openAudioPicker(pageId, onPick) {
  const courseId = state.course?.id;
  openModal({
    title: 'Pick audio narration',
    bodyHtml: `
      <div class="audio-picker">
        <div class="audio-picker-toolbar">
          <input id="audio-picker-search" type="search" placeholder="Search by filename…" />
          <button type="button" class="studio-btn" id="audio-picker-upload">Upload new…</button>
        </div>
        <div id="audio-picker-list" class="audio-picker-list"><div class="studio-empty-state"><p>Loading…</p></div></div>
      </div>
    `,
    footHtml: `
      <button type="button" class="studio-btn" id="modal-cancel">Cancel</button>
    `,
    onMount: async (host) => {
      host.querySelector('#modal-cancel').addEventListener('click', closeModal);
      const listEl = host.querySelector('#audio-picker-list');
      const searchEl = host.querySelector('#audio-picker-search');
      const uploadBtn = host.querySelector('#audio-picker-upload');

      // Show ALL audio assets the current user can access (RLS scopes
      // them to courses the user authors). Narration is often reusable
      // across courses, so we don't filter to the current course only.
      let rows = [];
      try {
        const { data, error } = await sb.from('course_assets')
          .select('id, filename, public_url, byte_size, mime_type, created_at, course_id')
          .eq('kind', 'audio')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        rows = data || [];
      } catch (err) {
        console.error('audio picker load', err);
        listEl.innerHTML = `<div class="studio-empty-state is-error"><p>Could not load audio assets: ${escapeHtml(err.message)}</p></div>`;
        return;
      }

      const render = (filter = '') => {
        try {
        const f = filter.trim().toLowerCase();
        const filtered = f ? rows.filter(r => (r.filename || '').toLowerCase().includes(f)) : rows;
        if (!filtered.length) {
          listEl.innerHTML = `<div class="studio-empty-state"><p>No audio assets ${f ? 'match that search' : 'in the library yet'}.</p><p>Use “Upload new…” above to add one.</p></div>`;
          return;
        }
        listEl.innerHTML = filtered.map(r => {
          const fromOther = courseId && r.course_id && r.course_id !== courseId;
          const tag = fromOther ? '<span class="audio-picker-tag" title="From a different course">other course</span>' : (r.course_id ? '' : '<span class="audio-picker-tag">shared</span>');
          return `
          <div class="audio-picker-row" data-url="${escapeHtml(r.public_url)}">
            <div class="audio-picker-meta">
              <div class="audio-picker-name">${escapeHtml(r.filename || '(untitled)')} ${tag}</div>
              <div class="audio-picker-sub">${formatBytes(r.byte_size)} · ${escapeHtml(r.mime_type || 'audio')} · ${fmtRelTime(r.created_at)}</div>
              <audio controls preload="none" src="${escapeHtml(r.public_url)}" style="width:100%; margin-top:6px;"></audio>
            </div>
            <div class="audio-picker-actions">
              <button type="button" class="studio-btn is-primary" data-act="pick">Use this</button>
            </div>
          </div>`;
        }).join('');
        listEl.querySelectorAll('.audio-picker-row').forEach(rowEl => {
          rowEl.querySelector('[data-act="pick"]').addEventListener('click', () => {
            const url = rowEl.getAttribute('data-url');
            onPick(url);
            toast('Narration assigned (save to apply)', 'is-saved');
            closeModal();
          });
        });
        } catch (err) {
          console.error('audio picker render', err);
          listEl.innerHTML = `<div class="studio-empty-state is-error"><p>Could not render list: ${escapeHtml(err.message)}</p></div>`;
        }
      };
      render();
      searchEl.addEventListener('input', () => render(searchEl.value));

      uploadBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          listEl.innerHTML = `<div class="studio-empty-state"><p>Uploading “${escapeHtml(file.name)}”…</p></div>`;
          try {
            const row = await uploadOne(file, courseId, state.course?.slug);
            onPick(row.public_url);
            toast('Audio uploaded and assigned (save to apply)', 'is-saved');
            closeModal();
          } catch (err) {
            listEl.innerHTML = `<div class="studio-empty-state is-error"><p>Upload failed: ${escapeHtml(err.message)}</p></div>`;
          }
        });
        input.click();
      });
    }
  });
}

// ---------- in-editor audio insert modal -------------------------
// Three-tab modal (Library / Upload / Paste URL) used by the page-editor
// toolbar Audio button. Inserts <audio controls src="…"></audio> at the
// current caret. Singleton state via module-level vars.
let __audioInsertCtx = null;        // { editor, page, courseId, courseSlug, onInsert }
let __audioInsertActiveTab = 'library';
let __audioInsertChosenUrl = null;
let __audioInsertChosenName = '';
let __audioInsertLibraryRows = null;        // cached rows
let __audioInsertCoursesMeta = null;        // cached course list for filter
let __audioInsertLibraryFilters = { text: '', course: '' };

function openAudioInsertModal(ctx) {
  __audioInsertCtx = ctx || {};
  __audioInsertActiveTab = 'library';
  __audioInsertChosenUrl = null;
  __audioInsertChosenName = '';
  __audioInsertLibraryFilters = { text: '', course: '' };

  openModal({
    title: 'Insert audio',
    bodyHtml: `
      <div class="audio-insert-modal">
        <div class="audio-insert-tabs" role="tablist">
          <button type="button" class="audio-insert-tab" data-tab="library" role="tab" aria-selected="true">Library</button>
          <button type="button" class="audio-insert-tab" data-tab="upload" role="tab" aria-selected="false">Upload</button>
          <button type="button" class="audio-insert-tab" data-tab="url" role="tab" aria-selected="false">Paste URL</button>
        </div>
        <div id="audio-insert-panel" class="audio-insert-panel"></div>
      </div>
    `,
    footHtml: `
      <span id="audio-insert-chosen" class="audio-insert-chosen"></span>
      <button type="button" class="studio-btn" id="audio-insert-cancel">Cancel</button>
      <button type="button" class="studio-btn primary" id="audio-insert-commit" disabled>Insert</button>
    `,
    onMount: (host) => {
      host.querySelector('#audio-insert-cancel').addEventListener('click', closeModal);
      host.querySelector('#audio-insert-commit').addEventListener('click', () => {
        if (!__audioInsertChosenUrl) return;
        __audioInsertCommit(__audioInsertChosenUrl);
      });
      host.querySelectorAll('.audio-insert-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          __audioInsertActiveTab = btn.dataset.tab;
          __audioInsertRender();
        });
      });
      // ESC handler scoped to this modal lifetime
      const escHandler = (e) => {
        if (e.key === 'Escape' && !host.classList.contains('hidden')) {
          closeModal();
        }
        if (host.classList.contains('hidden')) {
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);
      __audioInsertRender();
    },
  });
}

function __audioInsertSetChosen(url, name) {
  __audioInsertChosenUrl = url || null;
  __audioInsertChosenName = name || '';
  const commit = document.querySelector('#audio-insert-commit');
  const chosen = document.querySelector('#audio-insert-chosen');
  if (commit) commit.disabled = !url;
  if (chosen) chosen.textContent = url ? `Selected: ${name || url}` : '';
}

function __audioInsertRender() {
  const panel = document.querySelector('#audio-insert-panel');
  if (!panel) return;
  document.querySelectorAll('.audio-insert-tab').forEach(b => {
    const on = b.dataset.tab === __audioInsertActiveTab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.classList.toggle('is-active', on);
  });
  if (__audioInsertActiveTab === 'library') {
    panel.innerHTML = `
      <div class="audio-insert-toolbar">
        <input id="audio-insert-search" type="search" placeholder="Search by filename or alt text…" />
        <select id="audio-insert-course"><option value="">All courses</option></select>
      </div>
      <div id="audio-insert-list" class="audio-picker-list"><div class="studio-empty-state"><p>Loading…</p></div></div>
    `;
    panel.querySelector('#audio-insert-search').value = __audioInsertLibraryFilters.text || '';
    panel.querySelector('#audio-insert-search').addEventListener('input', e => {
      __audioInsertLibraryFilters.text = e.target.value;
      __audioInsertRenderLibraryList();
    });
    panel.querySelector('#audio-insert-course').addEventListener('change', e => {
      __audioInsertLibraryFilters.course = e.target.value;
      __audioInsertRenderLibraryList();
    });
    __audioInsertLoadLibrary();
  } else if (__audioInsertActiveTab === 'upload') {
    const ctx = __audioInsertCtx || {};
    const target = ctx.courseSlug ? `course “${escapeHtml(ctx.courseSlug)}”` : 'shared library';
    panel.innerHTML = `
      <div class="audio-insert-upload">
        <div class="public-asset-warning public-asset-warning--inline" role="note">
          ⚠️ Anything uploaded here is publicly accessible to anyone with the URL. Do not upload sensitive material (PII, internal documents, evidence files).
        </div>
        <div id="audio-insert-drop" class="audio-insert-drop">
          <p>Drag &amp; drop an audio file here</p>
          <p class="muted">or</p>
          <button type="button" class="studio-btn" id="audio-insert-choose">Choose file…</button>
          <input id="audio-insert-file" type="file" accept="audio/*" hidden />
          <p class="muted" style="margin-top:10px">Will be saved to the ${target}.</p>
        </div>
        <div id="audio-insert-progress" class="audio-insert-progress hidden">
          <div class="audio-insert-progress-label">Uploading…</div>
          <div class="audio-insert-progress-bar"><div class="audio-insert-progress-fill"></div></div>
        </div>
      </div>
    `;
    const fileInp = panel.querySelector('#audio-insert-file');
    panel.querySelector('#audio-insert-choose').addEventListener('click', () => fileInp.click());
    fileInp.addEventListener('change', () => {
      const f = fileInp.files && fileInp.files[0];
      if (f) __audioInsertHandleUpload(f);
    });
    const dz = panel.querySelector('#audio-insert-drop');
    ['dragenter','dragover'].forEach(t => dz.addEventListener(t, ev => { ev.preventDefault(); dz.classList.add('is-drag'); }));
    ['dragleave','drop'].forEach(t => dz.addEventListener(t, ev => { ev.preventDefault(); dz.classList.remove('is-drag'); }));
    dz.addEventListener('drop', ev => {
      const f = Array.from(ev.dataTransfer?.files || []).find(x => (x.type || '').startsWith('audio/'));
      if (f) __audioInsertHandleUpload(f);
      else toast('Drop an audio file', 'is-error');
    });
  } else if (__audioInsertActiveTab === 'url') {
    panel.innerHTML = `
      <div class="audio-insert-url">
        <label for="audio-insert-url-input">Audio URL</label>
        <input id="audio-insert-url-input" type="text" placeholder="https://example.com/clip.mp3" spellcheck="false" />
        <p class="muted">Paste a URL to an external audio file (e.g., a CDN you own).</p>
      </div>
    `;
    const inp = panel.querySelector('#audio-insert-url-input');
    if (__audioInsertActiveTab === 'url' && __audioInsertChosenUrl && !__audioInsertChosenName) {
      inp.value = __audioInsertChosenUrl;
    }
    inp.addEventListener('input', () => {
      const v = inp.value.trim();
      if (v) __audioInsertSetChosen(v, v.split('/').pop() || v);
      else __audioInsertSetChosen(null, '');
    });
    setTimeout(() => inp.focus(), 0);
  }
}

async function __audioInsertLoadLibrary() {
  const listEl = document.querySelector('#audio-insert-list');
  const courseSel = document.querySelector('#audio-insert-course');
  if (!listEl) return;
  try {
    if (!__audioInsertLibraryRows) {
      const { data, error } = await sb.from('course_assets')
        .select('id, filename, public_url, byte_size, mime_type, duration_seconds, created_at, course_id, alt_text')
        .eq('kind', 'audio')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      __audioInsertLibraryRows = data || [];
    }
    if (!__audioInsertCoursesMeta) {
      if (Array.isArray(state.allCoursesMeta) && state.allCoursesMeta.length) {
        __audioInsertCoursesMeta = state.allCoursesMeta;
      } else {
        const { data: courses } = await sb.from('courses').select('id, slug, title').order('slug');
        __audioInsertCoursesMeta = courses || [];
      }
    }
    if (courseSel && courseSel.options.length <= 1) {
      courseSel.innerHTML =
        '<option value="">All courses</option>' +
        '<option value="__shared__">Shared (no course)</option>' +
        (__audioInsertCoursesMeta || []).map(c => `<option value="${c.id}">${escapeHtml(c.title || c.slug)}</option>`).join('');
      if (__audioInsertLibraryFilters.course) courseSel.value = __audioInsertLibraryFilters.course;
    }
  } catch (err) {
    console.error('audio insert library load', err);
    listEl.innerHTML = `<div class="studio-empty-state is-error"><p>Could not load audio assets: ${escapeHtml(err.message)}</p></div>`;
    return;
  }
  __audioInsertRenderLibraryList();
}

function __audioInsertRenderLibraryList() {
  const listEl = document.querySelector('#audio-insert-list');
  if (!listEl) return;
  const rows = __audioInsertLibraryRows || [];
  const courseById = {};
  for (const c of (__audioInsertCoursesMeta || [])) courseById[c.id] = c;
  const f = (__audioInsertLibraryFilters.text || '').trim().toLowerCase();
  const cf = __audioInsertLibraryFilters.course || '';
  const filtered = rows.filter(r => {
    if (cf === '__shared__') { if (r.course_id) return false; }
    else if (cf) { if (r.course_id !== cf) return false; }
    if (f) {
      const hay = ((r.filename || '') + ' ' + (r.alt_text || '')).toLowerCase();
      if (!hay.includes(f)) return false;
    }
    return true;
  });
  if (!filtered.length) {
    listEl.innerHTML = `<div class="studio-empty-state"><p>No audio assets ${f || cf ? 'match those filters' : 'in the library yet'}.</p><p>Use the Upload tab to add one.</p></div>`;
    return;
  }
  listEl.innerHTML = filtered.map(r => {
    const courseLabel = r.course_id
      ? (courseById[r.course_id]?.title || courseById[r.course_id]?.slug || '—')
      : 'Shared';
    const dur = (r.duration_seconds != null && !Number.isNaN(Number(r.duration_seconds)))
      ? ` · ${Math.round(Number(r.duration_seconds))}s` : '';
    const isChosen = __audioInsertChosenUrl === r.public_url;
    return `
    <div class="audio-picker-row audio-insert-row${isChosen ? ' is-chosen' : ''}" data-url="${escapeHtml(r.public_url)}" data-name="${escapeHtml(r.filename || '')}">
      <div class="audio-picker-meta">
        <div class="audio-picker-name">${escapeHtml(r.filename || '(untitled)')} <span class="audio-picker-tag">${escapeHtml(courseLabel)}</span></div>
        <div class="audio-picker-sub">${formatBytes(r.byte_size)} · ${escapeHtml(r.mime_type || 'audio')}${dur} · ${fmtRelTime(r.created_at)}</div>
        <audio controls preload="none" src="${escapeHtml(r.public_url)}" style="width:100%; margin-top:6px;"></audio>
      </div>
      <div class="audio-picker-actions">
        <button type="button" class="studio-btn" data-act="choose">${isChosen ? 'Selected' : 'Select'}</button>
      </div>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.audio-insert-row').forEach(rowEl => {
    rowEl.querySelector('[data-act="choose"]').addEventListener('click', () => {
      const url = rowEl.getAttribute('data-url');
      const name = rowEl.getAttribute('data-name') || url;
      __audioInsertSetChosen(url, name);
      __audioInsertRenderLibraryList();
    });
  });
}

async function __audioInsertHandleUpload(file) {
  const panel = document.querySelector('#audio-insert-panel');
  const prog = document.querySelector('#audio-insert-progress');
  const fill = panel && panel.querySelector('.audio-insert-progress-fill');
  const drop = panel && panel.querySelector('#audio-insert-drop');
  if (!panel) return;
  if (!(file.type || '').startsWith('audio/')) { toast('Not an audio file', 'is-error'); return; }
  if (drop) drop.classList.add('is-busy');
  if (prog) {
    prog.classList.remove('hidden');
    if (fill) fill.style.width = '15%';
  }
  try {
    const ctx = __audioInsertCtx || {};
    if (fill) fill.style.width = '40%';
    const row = await uploadOne(file, ctx.courseId || null, ctx.courseSlug || null);
    if (fill) fill.style.width = '100%';
    // refresh library cache so the new row appears when user switches tabs
    __audioInsertLibraryRows = null;
    __audioInsertSetChosen(row.public_url, row.filename || file.name);
    toast('Audio uploaded', 'is-saved');
    __audioInsertActiveTab = 'library';
    __audioInsertRender();
  } catch (err) {
    console.error('audio insert upload', err);
    if (drop) drop.classList.remove('is-busy');
    if (prog) prog.classList.add('hidden');
    toast('Upload failed: ' + err.message, 'is-error');
  }
}

function __audioInsertCommit(url) {
  const ctx = __audioInsertCtx || {};
  const editor = ctx.editor;
  const html = `<audio controls src="${escapeHtml(url)}"></audio><p><br></p>`;
  if (editor) {
    editor.focus();
    document.execCommand('insertHTML', false, html);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (typeof ctx.onInsert === 'function') {
    ctx.onInsert(html);
  }
  closeModal();
}

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- in-editor image insert modal --------------------------
// Mirror of openAudioInsertModal. Three tabs (Library / Upload / Paste
// URL). Two modes:
//   - mode: 'inline'  → commit via ctx.onInsert(html) for caret insertion
//                        into the active rich-text editor
//   - mode: 'hero'    → commit via ctx.onPickHero({ url, alt }) for the
//                        hero-image slot on a course or module title page
let __imageInsertCtx = null;
let __imageInsertActiveTab = 'library';
let __imageInsertChosen = null;   // { url, name, alt }
let __imageInsertLibraryRows = null;
let __imageInsertCoursesMeta = null;
let __imageInsertLibraryFilters = { text: '', course: '' };

function openImageInsertModal(ctx) {
  __imageInsertCtx = ctx || {};
  __imageInsertActiveTab = 'library';
  __imageInsertChosen = null;
  __imageInsertLibraryFilters = { text: '', course: '' };

  openModal({
    title: (ctx && ctx.mode === 'hero') ? 'Choose hero image' : 'Insert image',
    bodyHtml: `
      <div class="audio-insert-modal image-insert-modal">
        <div class="audio-insert-tabs" role="tablist">
          <button type="button" class="audio-insert-tab" data-tab="library" role="tab" aria-selected="true">Library</button>
          <button type="button" class="audio-insert-tab" data-tab="upload"  role="tab" aria-selected="false">Upload</button>
          <button type="button" class="audio-insert-tab" data-tab="url"     role="tab" aria-selected="false">Paste URL</button>
        </div>
        <div id="image-insert-panel" class="audio-insert-panel"></div>
      </div>
    `,
    footHtml: `
      <span id="image-insert-chosen" class="audio-insert-chosen"></span>
      <button type="button" class="studio-btn" id="image-insert-cancel">Cancel</button>
      <button type="button" class="studio-btn primary" id="image-insert-commit" disabled>${(ctx && ctx.mode === 'hero') ? 'Use as hero' : 'Insert'}</button>
    `,
    onMount: (host) => {
      host.querySelector('#image-insert-cancel').addEventListener('click', closeModal);
      host.querySelector('#image-insert-commit').addEventListener('click', () => {
        if (!__imageInsertChosen || !__imageInsertChosen.url) return;
        __imageInsertCommit(__imageInsertChosen);
      });
      host.querySelectorAll('.audio-insert-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          __imageInsertActiveTab = btn.dataset.tab;
          __imageInsertRender();
        });
      });
      const escHandler = (e) => {
        if (e.key === 'Escape' && !host.classList.contains('hidden')) closeModal();
        if (host.classList.contains('hidden')) document.removeEventListener('keydown', escHandler);
      };
      document.addEventListener('keydown', escHandler);
      __imageInsertRender();
    },
  });
}

function __imageInsertSetChosen(chosen) {
  __imageInsertChosen = chosen || null;
  const commit = document.querySelector('#image-insert-commit');
  const chosenEl = document.querySelector('#image-insert-chosen');
  if (commit) commit.disabled = !chosen || !chosen.url;
  if (chosenEl) chosenEl.textContent = chosen && chosen.url ? `Selected: ${chosen.name || chosen.url}` : '';
}

function __imageInsertRender() {
  const panel = document.querySelector('#image-insert-panel');
  if (!panel) return;
  document.querySelectorAll('.image-insert-modal .audio-insert-tab').forEach(b => {
    const on = b.dataset.tab === __imageInsertActiveTab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.classList.toggle('is-active', on);
  });
  if (__imageInsertActiveTab === 'library') {
    panel.innerHTML = `
      <div class="audio-insert-toolbar">
        <input id="image-insert-search" type="search" placeholder="Search by filename or alt text…" />
        <select id="image-insert-course"><option value="">All courses</option></select>
      </div>
      <div id="image-insert-list" class="image-insert-list"><div class="studio-empty-state"><p>Loading…</p></div></div>
    `;
    panel.querySelector('#image-insert-search').value = __imageInsertLibraryFilters.text || '';
    panel.querySelector('#image-insert-search').addEventListener('input', e => {
      __imageInsertLibraryFilters.text = e.target.value;
      __imageInsertRenderLibraryList();
    });
    panel.querySelector('#image-insert-course').addEventListener('change', e => {
      __imageInsertLibraryFilters.course = e.target.value;
      __imageInsertRenderLibraryList();
    });
    __imageInsertLoadLibrary();
  } else if (__imageInsertActiveTab === 'upload') {
    const ctx = __imageInsertCtx || {};
    const target = ctx.courseSlug ? `course “${escapeHtml(ctx.courseSlug)}”` : 'shared library';
    panel.innerHTML = `
      <div class="audio-insert-upload">
        <div class="public-asset-warning public-asset-warning--inline" role="note">
          ⚠️ Anything uploaded here is publicly accessible to anyone with the URL. Do not upload sensitive material (PII, internal documents, evidence files).
        </div>
        <div id="image-insert-drop" class="audio-insert-drop">
          <p>Drag &amp; drop an image here</p>
          <p class="muted">or</p>
          <button type="button" class="studio-btn" id="image-insert-choose">Choose file…</button>
          <input id="image-insert-file" type="file" accept="image/*" hidden />
          <p class="muted" style="margin-top:10px">Will be saved to the ${target}. Large images are auto-downscaled.</p>
        </div>
        <div id="image-insert-progress" class="audio-insert-progress hidden">
          <div class="audio-insert-progress-label">Uploading…</div>
          <div class="audio-insert-progress-bar"><div class="audio-insert-progress-fill"></div></div>
        </div>
      </div>
    `;
    const fileInp = panel.querySelector('#image-insert-file');
    panel.querySelector('#image-insert-choose').addEventListener('click', () => fileInp.click());
    fileInp.addEventListener('change', () => {
      const f = fileInp.files && fileInp.files[0];
      if (f) __imageInsertHandleUpload(f);
    });
    const dz = panel.querySelector('#image-insert-drop');
    ['dragenter','dragover'].forEach(t => dz.addEventListener(t, ev => { ev.preventDefault(); dz.classList.add('is-drag'); }));
    ['dragleave','drop'].forEach(t => dz.addEventListener(t, ev => { ev.preventDefault(); dz.classList.remove('is-drag'); }));
    dz.addEventListener('drop', ev => {
      const f = Array.from(ev.dataTransfer?.files || []).find(x => (x.type || '').startsWith('image/'));
      if (f) __imageInsertHandleUpload(f);
      else toast('Drop an image file', 'is-error');
    });
  } else if (__imageInsertActiveTab === 'url') {
    const existingAlt = __imageInsertChosen?.alt || '';
    const existingUrl = __imageInsertChosen?.url || '';
    panel.innerHTML = `
      <div class="audio-insert-url">
        <label for="image-insert-url-input">Image URL</label>
        <input id="image-insert-url-input" type="text" placeholder="https://example.com/image.jpg" spellcheck="false" value="${escapeHtml(existingUrl)}" />
        <label for="image-insert-url-alt" style="margin-top:10px">Alt text</label>
        <input id="image-insert-url-alt" type="text" placeholder="Describe the image for screen readers" value="${escapeHtml(existingAlt)}" />
        <p class="muted">Paste a URL to an external image. The alt text is stored with the inserted image.</p>
      </div>
    `;
    const urlInp = panel.querySelector('#image-insert-url-input');
    const altInp = panel.querySelector('#image-insert-url-alt');
    const sync = () => {
      const u = urlInp.value.trim();
      const a = altInp.value.trim();
      if (u) __imageInsertSetChosen({ url: u, name: u.split('/').pop() || u, alt: a });
      else __imageInsertSetChosen(null);
    };
    urlInp.addEventListener('input', sync);
    altInp.addEventListener('input', sync);
    setTimeout(() => urlInp.focus(), 0);
  }
}

async function __imageInsertLoadLibrary() {
  const listEl = document.querySelector('#image-insert-list');
  const courseSel = document.querySelector('#image-insert-course');
  if (!listEl) return;
  try {
    if (!__imageInsertLibraryRows) {
      const { data, error } = await sb.from('course_assets')
        .select('id, filename, public_url, byte_size, mime_type, created_at, course_id, alt_text, width, height')
        .eq('kind', 'image')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      __imageInsertLibraryRows = data || [];
    }
    if (!__imageInsertCoursesMeta) {
      if (Array.isArray(state.allCoursesMeta) && state.allCoursesMeta.length) {
        __imageInsertCoursesMeta = state.allCoursesMeta;
      } else {
        const { data: courses } = await sb.from('courses').select('id, slug, title').order('slug');
        __imageInsertCoursesMeta = courses || [];
      }
    }
    if (courseSel && courseSel.options.length <= 1) {
      courseSel.innerHTML =
        '<option value="">All courses</option>' +
        '<option value="__shared__">Shared (no course)</option>' +
        (__imageInsertCoursesMeta || []).map(c => `<option value="${c.id}">${escapeHtml(c.title || c.slug)}</option>`).join('');
      if (__imageInsertLibraryFilters.course) courseSel.value = __imageInsertLibraryFilters.course;
    }
  } catch (err) {
    console.error('image insert library load', err);
    listEl.innerHTML = `<div class="studio-empty-state is-error"><p>Could not load images: ${escapeHtml(err.message)}</p></div>`;
    return;
  }
  __imageInsertRenderLibraryList();
}

function __imageInsertRenderLibraryList() {
  const listEl = document.querySelector('#image-insert-list');
  if (!listEl) return;
  const rows = __imageInsertLibraryRows || [];
  const courseById = {};
  for (const c of (__imageInsertCoursesMeta || [])) courseById[c.id] = c;
  const f = (__imageInsertLibraryFilters.text || '').trim().toLowerCase();
  const cf = __imageInsertLibraryFilters.course || '';
  const filtered = rows.filter(r => {
    if (cf === '__shared__') { if (r.course_id) return false; }
    else if (cf) { if (r.course_id !== cf) return false; }
    if (f) {
      const hay = ((r.filename || '') + ' ' + (r.alt_text || '')).toLowerCase();
      if (!hay.includes(f)) return false;
    }
    return true;
  });
  if (!filtered.length) {
    listEl.innerHTML = `<div class="studio-empty-state"><p>No images ${f || cf ? 'match those filters' : 'in the library yet'}.</p><p>Use the Upload tab to add one.</p></div>`;
    return;
  }
  listEl.innerHTML = filtered.map(r => {
    const courseLabel = r.course_id
      ? (courseById[r.course_id]?.title || courseById[r.course_id]?.slug || '—')
      : 'Shared';
    const isChosen = __imageInsertChosen && __imageInsertChosen.url === r.public_url;
    const dim = (r.width && r.height) ? `${r.width}×${r.height}` : '';
    return `
    <div class="image-insert-card${isChosen ? ' is-chosen' : ''}" data-url="${escapeHtml(r.public_url)}" data-name="${escapeHtml(r.filename || '')}" data-alt="${escapeHtml(r.alt_text || '')}">
      <div class="image-insert-thumb"><img loading="lazy" src="${escapeHtml(r.public_url)}" alt="${escapeHtml(r.alt_text || '')}" /></div>
      <div class="image-insert-meta">
        <div class="image-insert-name" title="${escapeHtml(r.filename || '')}">${escapeHtml(r.filename || '(untitled)')}</div>
        <div class="image-insert-sub">${formatBytes(r.byte_size)} · ${dim ? dim + ' · ' : ''}<span class="audio-picker-tag">${escapeHtml(courseLabel)}</span></div>
        ${r.alt_text ? `<div class="image-insert-alt" title="Alt text">“${escapeHtml(r.alt_text)}”</div>` : ''}
      </div>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.image-insert-card').forEach(card => {
    card.addEventListener('click', () => {
      __imageInsertSetChosen({
        url: card.getAttribute('data-url'),
        name: card.getAttribute('data-name') || '',
        alt: card.getAttribute('data-alt') || '',
      });
      __imageInsertRenderLibraryList();
    });
  });
}

async function __imageInsertHandleUpload(file) {
  const panel = document.querySelector('#image-insert-panel');
  const prog = document.querySelector('#image-insert-progress');
  const fill = panel && panel.querySelector('.audio-insert-progress-fill');
  const drop = panel && panel.querySelector('#image-insert-drop');
  if (!panel) return;
  if (!(file.type || '').startsWith('image/')) { toast('Not an image file', 'is-error'); return; }
  if (drop) drop.classList.add('is-busy');
  if (prog) { prog.classList.remove('hidden'); if (fill) fill.style.width = '15%'; }
  try {
    const ctx = __imageInsertCtx || {};
    if (fill) fill.style.width = '40%';
    const row = await uploadOne(file, ctx.courseId || null, ctx.courseSlug || null);
    if (fill) fill.style.width = '100%';
    __imageInsertLibraryRows = null;
    __imageInsertSetChosen({ url: row.public_url, name: row.filename || file.name, alt: row.alt_text || '' });
    toast('Image uploaded', 'is-saved');
    __imageInsertActiveTab = 'library';
    __imageInsertRender();
  } catch (err) {
    console.error('image insert upload', err);
    if (drop) drop.classList.remove('is-busy');
    if (prog) prog.classList.add('hidden');
    toast('Upload failed: ' + err.message, 'is-error');
  }
}

function __imageInsertCommit(chosen) {
  const ctx = __imageInsertCtx || {};
  if (ctx.mode === 'hero') {
    if (typeof ctx.onPickHero === 'function') ctx.onPickHero({ url: chosen.url, alt: chosen.alt || '' });
    closeModal();
    return;
  }
  const html = `<img src="${escapeHtml(chosen.url)}" alt="${escapeHtml(chosen.alt || '')}" loading="lazy" />`;
  const editor = ctx.editor;
  if (editor) {
    editor.focus();
    document.execCommand('insertHTML', false, html);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (typeof ctx.onInsert === 'function') {
    ctx.onInsert(html);
  }
  closeModal();
}

// ---------- preview pane -----------------------------------------
function studioSanitize(s) {
  if (typeof window.DOMPurify === 'undefined') return s == null ? '' : String(s);
  return window.DOMPurify.sanitize(String(s == null ? '' : s), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe'],
    FORBID_ATTR: ['onerror','onload','onclick','onmouseover','onfocus','onblur','onchange']
  });
}

function renderPreview() {
  const host = $('#preview-card');
  if (!host) return;
  if (!state.selection) return;
  if (state.selection.kind === 'page') {
    const ref = findPage(state.selection.id);
    if (!ref) return;
    // Author HTML — sanitize before injecting into the preview pane.
    // The contenteditable #html-editor is intentionally NOT sanitized
    // (would clobber the author's in-flight edits).
    host.innerHTML = studioSanitize(ref.page.body_html || '<p><em>(empty page)</em></p>');
    // Append a References section that mirrors the public renderer
    const cites = Array.isArray(ref.page.citations) ? ref.page.citations : [];
    if (cites.length) {
      const sec = renderReferencesSection(cites);
      if (sec) host.appendChild(sec);
    }
    // Make sure markers reflect current numbering in the preview body too
    recomputeCiteMarkers(host, cites);
  } else {
    host.innerHTML = `<div class="studio-empty-state"><p>Live preview is shown for pages.</p></div>`;
  }
}

// Build a <section.page-references> from a citations array. Returns null if
// there are no citations. Built via DOM nodes (no innerHTML interpolation).
function renderReferencesSection(citations) {
  if (!Array.isArray(citations) || !citations.length) return null;
  const section = document.createElement('section');
  section.className = 'page-references';
  const h = document.createElement('h3');
  h.textContent = 'References';
  section.appendChild(h);
  const ol = document.createElement('ol');
  ol.className = 'references-list';
  citations.forEach((c, i) => {
    const li = document.createElement('li');
    li.id = 'cite-' + (c && c.id ? String(c.id) : ('idx-' + (i+1)));
    const num = document.createElement('span');
    num.className = 'ref-number';
    num.textContent = '[' + (i + 1) + ']';
    li.appendChild(num);
    li.appendChild(document.createTextNode(' '));
    li.appendChild(formatCitationNode(c, i + 1));
    ol.appendChild(li);
  });
  section.appendChild(ol);
  return section;
}

// =====================================================================
// IMAGE UPLOAD — drag-drop on editor, paste-image, toolbar, library
// =====================================================================

// Downscale a File/Blob to MAX_IMAGE_DIM, return new Blob (jpg/png) + dims
async function downscaleImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.type === 'image/gif') {
    // skip downscale for vector & animated
    return { blob: file, width: null, height: null, mime: file.type };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    let { width, height } = img;
    if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
      const r = Math.min(MAX_IMAGE_DIM / width, MAX_IMAGE_DIM / height);
      width = Math.round(width * r); height = Math.round(height * r);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    const isPng = file.type === 'image/png';
    const mime = isPng ? 'image/png' : 'image/jpeg';
    const quality = isPng ? undefined : 0.86;
    const blob = await new Promise(res => canvas.toBlob(res, mime, quality));
    return { blob, width, height, mime };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function genStoragePath(courseSlug, filename) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const safe = String(filename || 'file').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g,'').slice(0, 48);
  const folder = courseSlug || 'shared';
  return `${folder}/${ts}-${rand}-${safe}`;
}

async function uploadOne(file, courseId, courseSlug) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} exceeds 50MB limit`);
  }
  let payload, width = null, height = null, mime = file.type;
  if (file.type.startsWith('image/')) {
    const r = await downscaleImage(file);
    payload = r.blob; width = r.width; height = r.height; mime = r.mime;
  } else {
    payload = file;
  }
  const path = genStoragePath(courseSlug, file.name);
  const { error: upErr } = await sb.storage.from(STORAGE_BUCKET).upload(path, payload, {
    contentType: mime, cacheControl: '31536000', upsert: false,
  });
  if (upErr) throw upErr;
  const { data: { publicUrl } } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file';
  const { data: row, error: dbErr } = await sb.from('course_assets').insert({
    course_id: courseId || null, kind, storage_path: path, public_url: publicUrl,
    filename: file.name, mime_type: mime, byte_size: payload.size || file.size,
    width, height, alt_text: '', uploaded_by: state.user.id,
  }).select().single();
  if (dbErr) {
    // best-effort cleanup if DB insert fails
    sb.storage.from(STORAGE_BUCKET).remove([path]);
    throw dbErr;
  }
  return row;
}

async function uploadFiles(files, courseId) {
  // Resolve course slug from any cache that happens to be populated.
  // Both state.allCoursesMeta (dashboard/media) and state.courses (editor)
  // can be undefined depending on which page the user visited first.
  let courseSlug = null;
  if (courseId) {
    const meta = Array.isArray(state.allCoursesMeta) ? state.allCoursesMeta : [];
    const editorList = Array.isArray(state.courses) ? state.courses : [];
    courseSlug =
      meta.find(c => c.id === courseId)?.slug ||
      editorList.find(c => c.id === courseId)?.slug ||
      null;
    // Last-resort lookup if neither cache had it
    if (!courseSlug) {
      try {
        const { data } = await sb.from('courses').select('slug').eq('id', courseId).maybeSingle();
        courseSlug = data?.slug || null;
      } catch (e) { /* non-fatal: upload still works without a slug */ }
    }
  }
  let success = 0, fail = 0;
  const total = files.length;
  for (let i = 0; i < total; i++) {
    setSaveState('saving', `Uploading ${i+1}/${total}…`);
    try {
      await uploadOne(files[i], courseId, courseSlug);
      success++;
    } catch (err) {
      console.error(err);
      fail++;
      toast(`Upload failed: ${err.message}`, 'is-error');
    }
  }
  setSaveState(fail ? 'error' : 'saved', fail ? `${fail} failed` : `Uploaded ${success}`);
  if (success) toast(`Uploaded ${success}${fail ? ` (${fail} failed)` : ''}`, fail ? 'is-error' : 'is-success');
}

// ---------- inline-audio overlay controls -----------------------
// Adds Move up / Move down / Edit URL / Delete buttons to every <audio>
// element inside the editor. Implemented as a one-time global init so
// repeated page navigation doesn't pile up stale listeners.
const __INLINE_AUDIO_DEBUG = false;
let __inlineAudioInit = false;
let __inlineAudioActive = null;
let __inlineAudioHideTimer = null;

function __inlineAudioBar() {
  let bar = document.getElementById('inline-audio-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'inline-audio-bar';
  bar.className = 'inline-audio-bar hidden';
  bar.setAttribute('contenteditable', 'false');
  bar.innerHTML = `
    <button type="button" data-act="up"     title="Move up">▲</button>
    <button type="button" data-act="down"   title="Move down">▼</button>
    <button type="button" data-act="edit"   title="Edit URL">Edit URL</button>
    <button type="button" data-act="delete" class="danger" title="Delete">Delete</button>
  `;
  document.body.appendChild(bar);
  return bar;
}

function __inlineAudioPosition() {
  const bar = __inlineAudioBar();
  const a = __inlineAudioActive;
  if (!a || !document.body.contains(a)) {
    bar.classList.add('hidden');
    __inlineAudioActive = null;
    return;
  }
  bar.classList.remove('hidden');
  // measure after un-hiding so offsetHeight is real
  const ar = a.getBoundingClientRect();
  const top = window.scrollY + ar.top - bar.offsetHeight - 6;
  bar.style.top  = (top < window.scrollY + 4 ? window.scrollY + ar.bottom + 6 : top) + 'px';
  bar.style.left = (window.scrollX + ar.left) + 'px';
}

function __inlineAudioHide() {
  __inlineAudioActive = null;
  __inlineAudioBar().classList.add('hidden');
}

function __inlineAudioShow(audio) {
  if (__inlineAudioHideTimer) { clearTimeout(__inlineAudioHideTimer); __inlineAudioHideTimer = null; }
  __inlineAudioActive = audio;
  if (__INLINE_AUDIO_DEBUG) console.log('[inline-audio] show', audio);
  __inlineAudioPosition();
}

function __inlineAudioResolveAudio(e) {
  // 1) Direct closest from click target
  let audio = e.target && e.target.closest && e.target.closest('audio');
  if (audio) return audio;
  // 2) Activeelement (focused audio)
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('audio')) return ae.closest('audio');
  // 3) elementFromPoint at click coordinates (handles shadow-DOM retargeting)
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.closest) {
      const a = el.closest('audio');
      if (a) return a;
    }
  }
  return null;
}

function __inlineAudioInitOnce() {
  if (__inlineAudioInit) return;
  __inlineAudioInit = true;
  __inlineAudioBar(); // ensure created
  if (__INLINE_AUDIO_DEBUG) console.log('[inline-audio] init');

  // Capture-phase listener on document: if the click target is an <audio>
  // inside the live editor, show the bar. We do NOT call preventDefault so
  // the native player still plays/pauses normally.
  document.addEventListener('click', (e) => {
    const audio = __inlineAudioResolveAudio(e);
    const inEditor = audio && audio.closest && (audio.closest('#html-editor') || audio.closest('#title-html-editor'));
    if (__INLINE_AUDIO_DEBUG) console.log('[inline-audio] click', { target: e.target, audio, inEditor: !!inEditor });
    if (audio && inEditor) {
      __inlineAudioShow(audio);
      return;
    }
    // Click landed outside editor and outside the bar -> hide
    const t = e.target;
    if (t && t.closest && !t.closest('#html-editor') && !t.closest('#title-html-editor') && !t.closest('#inline-audio-bar')) {
      __inlineAudioHide();
    }
  }, true);

  // Focus-based fallback. Native <audio controls> sometimes consume clicks
  // inside their shadow-DOM controls — but a focusin still fires on the
  // <audio> host element when the user clicks it.
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    const audio = t && t.closest && t.closest('audio');
    const inEditor = audio && audio.closest && (audio.closest('#html-editor') || audio.closest('#title-html-editor'));
    if (__INLINE_AUDIO_DEBUG) console.log('[inline-audio] focusin', { target: t, audio, inEditor: !!inEditor });
    if (audio && inEditor) __inlineAudioShow(audio);
  }, true);

  // Hide when focus moves outside both the editor audio and the toolbar.
  // Small timeout lets focus move INTO the toolbar buttons before we hide.
  document.addEventListener('focusout', (e) => {
    if (__inlineAudioHideTimer) clearTimeout(__inlineAudioHideTimer);
    __inlineAudioHideTimer = setTimeout(() => {
      const ae = document.activeElement;
      const stillOnAudio = ae && ae.closest && ae.closest('audio') && (ae.closest('#html-editor') || ae.closest('#title-html-editor'));
      const onToolbar    = ae && ae.closest && ae.closest('#inline-audio-bar');
      if (__INLINE_AUDIO_DEBUG) console.log('[inline-audio] focusout settle', { ae, stillOnAudio: !!stillOnAudio, onToolbar: !!onToolbar });
      if (!stillOnAudio && !onToolbar) __inlineAudioHide();
    }, 150);
  }, true);

  // Toolbar button clicks
  __inlineAudioBar().addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const audio = __inlineAudioActive;
    if (!audio || !document.body.contains(audio)) { __inlineAudioHide(); return; }
    const act = btn.dataset.act;
    // The element to physically move/delete is the wrapping figure/p if the audio
    // is its only child; otherwise the audio itself.
    const parent = audio.parentElement;
    const target = (parent && parent.id !== 'html-editor' && parent.children.length === 1) ? parent : audio;
    const editor = (audio.closest('#html-editor') || audio.closest('#title-html-editor'));

    if (act === 'up') {
      const prev = target.previousElementSibling;
      if (prev) target.parentElement.insertBefore(target, prev);
    } else if (act === 'down') {
      const next = target.nextElementSibling;
      if (next) target.parentElement.insertBefore(next, target);
    } else if (act === 'edit') {
      const cur = audio.getAttribute('src') || '';
      const url = prompt('Audio URL (mp3 / wav / m4a):', cur);
      if (url === null) return;
      const trimmed = String(url).trim();
      if (!trimmed) { toast('URL cannot be empty', 'is-error'); return; }
      audio.setAttribute('src', trimmed);
      try { audio.load(); } catch (_) {}
    } else if (act === 'delete') {
      if (!confirm('Delete this audio narration block from the page?\n\nThe file in the media library is not affected.')) return;
      target.remove();
      __inlineAudioHide();
    }
    if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(__inlineAudioPosition, 0);
  });

  // Reposition on scroll/resize
  window.addEventListener('scroll', __inlineAudioPosition, true);
  window.addEventListener('resize', __inlineAudioPosition);

  // Esc to dismiss
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && __inlineAudioActive) __inlineAudioHide();
  });
}

function wireInlineAudioControls(editor, _page) {
  if (!editor) return;
  __inlineAudioInitOnce();
  // Decorate existing audio elements so the cursor doesn't get trapped inside them
  const decorate = () => {
    editor.querySelectorAll('audio:not([data-decorated])').forEach(a => {
      a.setAttribute('data-decorated', '1');
      a.setAttribute('contenteditable', 'false');
      a.setAttribute('controls', '');
      a.style.cursor = 'pointer';
    });
  };
  decorate();
  const mo = new MutationObserver(decorate);
  mo.observe(editor, { childList: true, subtree: true });
  // Hide bar when this editor instance is removed from DOM
  __inlineAudioHide();
}

// Install global audio listeners unconditionally at module load so the
// toolbar works on first render — independent of editor wiring path.
try { __inlineAudioInitOnce(); } catch (_) {}

// =====================================================================
// Inline-image overlay controls (mirror of inline-audio).
//
// Clicking any <img> inside a wired contenteditable shows a floating
// toolbar: ▲ ▼ Replace / Alt / Delete. The same global delegate is
// shared across the lesson editor (#html-editor), the title-page
// editor (#title-html-editor), and the appendix item editor
// (#apx-body) — anything wired through wireInlineImageControls or
// wireInlineImageControlsForTitle.
//
// Replace re-uses the existing openImageInsertModal so authors get the
// same Library / Upload / URL flow they used to insert. Alt text uses a
// modal (NOT prompt()) because Chrome blocks sequential prompt() calls
// and that bug already bit issue #3.
// =====================================================================
const __INLINE_IMAGE_DEBUG = false;
let __inlineImageInit = false;
let __inlineImageActive = null;
let __inlineImageHideTimer = null;

function __inlineImageBar() {
  let bar = document.getElementById('inline-image-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'inline-image-bar';
  bar.className = 'inline-image-bar hidden';
  bar.setAttribute('contenteditable', 'false');
  bar.innerHTML = `
    <button type="button" data-act="up"      title="Move up">▲</button>
    <button type="button" data-act="down"    title="Move down">▼</button>
    <button type="button" data-act="replace" title="Replace image">Replace</button>
    <button type="button" data-act="alt"     title="Edit alt text">Alt</button>
    <button type="button" data-act="delete"  class="danger" title="Delete">Delete</button>
  `;
  document.body.appendChild(bar);
  return bar;
}

function __inlineImageEditorOf(img) {
  if (!img || !img.closest) return null;
  return img.closest('#html-editor')
      || img.closest('#title-html-editor')
      || img.closest('#apx-body');
}

function __inlineImagePosition() {
  const bar = __inlineImageBar();
  const a = __inlineImageActive;
  if (!a || !document.body.contains(a)) {
    bar.classList.add('hidden');
    __inlineImageActive = null;
    return;
  }
  bar.classList.remove('hidden');
  const ar = a.getBoundingClientRect();
  const top = window.scrollY + ar.top - bar.offsetHeight - 6;
  bar.style.top  = (top < window.scrollY + 4 ? window.scrollY + ar.bottom + 6 : top) + 'px';
  bar.style.left = (window.scrollX + ar.left) + 'px';
}

function __inlineImageHide() {
  __inlineImageActive = null;
  __inlineImageBar().classList.add('hidden');
}

function __inlineImageShow(img) {
  if (__inlineImageHideTimer) { clearTimeout(__inlineImageHideTimer); __inlineImageHideTimer = null; }
  __inlineImageActive = img;
  if (__INLINE_IMAGE_DEBUG) console.log('[inline-image] show', img);
  __inlineImagePosition();
}

// Open a tiny modal to edit alt text. Resolves to the new value (string,
// possibly empty) or null if the user cancelled.
function __inlineImageEditAltModal(currentAlt) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; closeModal(); resolve(val); };
    openModal({
      title: 'Edit alt text',
      bodyHtml: `
        <div style="padding:6px 2px;">
          <label for="inline-image-alt-input" style="display:block; font-size:12px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--studio-muted, #5b6788); margin-bottom:6px;">Alt text (for screen readers)</label>
          <input id="inline-image-alt-input" type="text" value="${escapeHtml(currentAlt || '')}"
                 placeholder="Describe the image"
                 style="width:100%; padding:8px 10px; border:1px solid var(--studio-line, #d9dfee); border-radius:6px; font-size:14px;" />
          <p class="muted" style="margin-top:8px; font-size:12px;">Leave blank for purely decorative images.</p>
        </div>
      `,
      footHtml: `
        <button type="button" class="studio-btn" id="inline-image-alt-cancel">Cancel</button>
        <button type="button" class="studio-btn primary" id="inline-image-alt-save">Save</button>
      `,
      onMount: (host) => {
        const inp = host.querySelector('#inline-image-alt-input');
        if (inp) { inp.focus(); inp.select(); }
        host.querySelector('#inline-image-alt-cancel').addEventListener('click', () => finish(null));
        host.querySelector('#inline-image-alt-save').addEventListener('click', () => {
          finish(inp ? inp.value : '');
        });
        const onKey = (e) => {
          if (host.classList.contains('hidden')) {
            document.removeEventListener('keydown', onKey);
            if (!settled) finish(null);
            return;
          }
          if (e.key === 'Enter')  { e.preventDefault(); finish(inp ? inp.value : ''); }
          if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        };
        document.addEventListener('keydown', onKey);
      },
    });
  });
}

function __inlineImageInitOnce() {
  if (__inlineImageInit) return;
  __inlineImageInit = true;
  __inlineImageBar();

  // Click on an <img> inside a wired editor → show toolbar.
  document.addEventListener('click', (e) => {
    let img = e.target && e.target.closest && e.target.closest('img');
    if (!img && typeof e.clientX === 'number') {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && el.closest) img = el.closest('img');
    }
    const editor = __inlineImageEditorOf(img);
    if (img && editor) {
      __inlineImageShow(img);
      return;
    }
    // Click outside both editor and bar → hide.
    const t = e.target;
    if (t && t.closest
        && !t.closest('#html-editor')
        && !t.closest('#title-html-editor')
        && !t.closest('#apx-body')
        && !t.closest('#inline-image-bar')
        && !t.closest('#modal-host')) {
      __inlineImageHide();
    }
  }, true);

  // Toolbar button clicks.
  __inlineImageBar().addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const img = __inlineImageActive;
    if (!img || !document.body.contains(img)) { __inlineImageHide(); return; }
    const act = btn.dataset.act;
    // The element to physically move/delete is the wrapping figure/p if the
    // image is its only child; otherwise the image itself.
    const parent = img.parentElement;
    const isWrapper = parent
      && parent.id !== 'html-editor'
      && parent.id !== 'title-html-editor'
      && parent.id !== 'apx-body'
      && parent.children.length === 1;
    const target = isWrapper ? parent : img;
    const editor = __inlineImageEditorOf(img);

    if (act === 'up') {
      const prev = target.previousElementSibling;
      if (prev) target.parentElement.insertBefore(target, prev);
    } else if (act === 'down') {
      const next = target.nextElementSibling;
      if (next) target.parentElement.insertBefore(next, target);
    } else if (act === 'replace') {
      // Re-use the existing image insert modal. We pass an onInsert that
      // swaps the active <img>'s src/alt instead of inserting new HTML.
      const captured = img;
      // Determine course context for upload tab — best-effort, mirrors how
      // toolbar Image button is wired in the page editors.
      const courseId   = state.course?.id   || null;
      const courseSlug = state.course?.slug || null;
      openImageInsertModal({
        mode: 'inline',
        courseId,
        courseSlug,
        // Special replace hook: __imageInsertCommit calls onInsert(html)
        // for inline mode. We parse out the new src/alt from that HTML and
        // mutate the existing element in place, preserving surrounding
        // markup (e.g. captions) and caret position.
        onInsert: (html) => {
          try {
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const fresh = tmp.querySelector('img');
            if (!fresh) return;
            const newSrc = fresh.getAttribute('src') || '';
            const newAlt = fresh.getAttribute('alt') || '';
            if (newSrc) captured.setAttribute('src', newSrc);
            // Only overwrite alt if the new picker provided one; preserve
            // the existing alt otherwise so authors don't silently lose it.
            if (newAlt) captured.setAttribute('alt', newAlt);
            // Reset width/height attrs that may have been set by a previous
            // image so the new asset's natural dimensions take over.
            captured.removeAttribute('width');
            captured.removeAttribute('height');
          } catch (err) {
            console.error('[inline-image] replace failed:', err);
            toast('Replace failed: ' + (err.message || err), 'is-error');
            return;
          }
          if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(__inlineImagePosition, 0);
        },
      });
      return; // modal flow owns the rest; don't fire input event below
    } else if (act === 'alt') {
      const cur = img.getAttribute('alt') || '';
      const next = await __inlineImageEditAltModal(cur);
      if (next === null) return; // cancelled
      img.setAttribute('alt', next);
    } else if (act === 'delete') {
      if (!confirm('Delete this image from the page?\n\nThe file in the media library is not affected.')) return;
      target.remove();
      __inlineImageHide();
    }
    if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(__inlineImagePosition, 0);
  });

  // Reposition / dismiss.
  window.addEventListener('scroll', __inlineImagePosition, true);
  window.addEventListener('resize', __inlineImagePosition);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && __inlineImageActive) __inlineImageHide();
  });
}

function wireInlineImageControls(editor) {
  if (!editor) return;
  __inlineImageInitOnce();
  // Decorate so the cursor doesn't get awkwardly trapped on the image and
  // so authors get a pointer affordance.
  const decorate = () => {
    editor.querySelectorAll('img:not([data-img-decorated])').forEach(img => {
      img.setAttribute('data-img-decorated', '1');
      img.style.cursor = 'pointer';
    });
  };
  decorate();
  const mo = new MutationObserver(decorate);
  mo.observe(editor, { childList: true, subtree: true });
  __inlineImageHide();
}

// Same as wireInlineImageControls, kept as a separate name for symmetry
// with wireInlineAudioControlsForTitle in case future divergence is
// needed (e.g. blocking replace on hero images).
function wireInlineImageControlsForTitle(editor) {
  wireInlineImageControls(editor);
}

// Install global image listeners at module load (matches audio pattern).
try { __inlineImageInitOnce(); } catch (_) {}

// =====================================================================
// Inline block controls — delete affordance for callouts / badge / compare
// blocks the author can insert from the toolbar. Mirrors the inline-image
// pattern: a floating bar lives in document.body (contenteditable="false"),
// so the button is never part of body_html when the editor is saved.
// =====================================================================
const __INLINE_BLOCK_SELECTOR = '.callout, .badge-panel, .compare-cards';
let __inlineBlockInit = false;
let __inlineBlockActive = null;

function __inlineBlockEditorOf(node) {
  if (!node || !node.closest) return null;
  return node.closest('#html-editor')
      || node.closest('#title-html-editor')
      || node.closest('#apx-body');
}

function __inlineBlockLabel(node) {
  if (!node) return 'block';
  if (node.classList.contains('badge-panel'))   return 'badge';
  if (node.classList.contains('compare-cards')) return 'compare block';
  if (node.classList.contains('callout-warn'))    return 'warning';
  if (node.classList.contains('callout-danger'))  return 'critical callout';
  if (node.classList.contains('callout-success')) return 'success callout';
  if (node.classList.contains('callout')) return 'note';
  return 'block';
}

function __inlineBlockBar() {
  let bar = document.getElementById('inline-block-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'inline-block-bar';
  bar.className = 'inline-image-bar hidden';
  bar.setAttribute('contenteditable', 'false');
  bar.innerHTML = `
    <span class="inline-block-label" data-role="label">block</span>
    <button type="button" data-act="delete" class="danger" title="Delete this block">✕ Delete</button>
  `;
  document.body.appendChild(bar);
  return bar;
}

function __inlineBlockPosition() {
  const bar = __inlineBlockBar();
  const a = __inlineBlockActive;
  if (!a || !document.body.contains(a)) {
    bar.classList.add('hidden');
    __inlineBlockActive = null;
    return;
  }
  bar.classList.remove('hidden');
  const ar = a.getBoundingClientRect();
  // Anchor top-right of the block; flip below if it'd be off-screen.
  let top = window.scrollY + ar.top - bar.offsetHeight - 6;
  if (top < window.scrollY + 4) top = window.scrollY + ar.top + 6;
  let left = window.scrollX + ar.right - bar.offsetWidth;
  if (left < window.scrollX + 4) left = window.scrollX + 4;
  bar.style.top  = top + 'px';
  bar.style.left = left + 'px';
}

function __inlineBlockHide() {
  __inlineBlockActive = null;
  __inlineBlockBar().classList.add('hidden');
}

function __inlineBlockShow(node) {
  __inlineBlockActive = node;
  const bar = __inlineBlockBar();
  const lbl = bar.querySelector('[data-role="label"]');
  if (lbl) lbl.textContent = __inlineBlockLabel(node);
  __inlineBlockPosition();
}

function __inlineBlockInitOnce() {
  if (__inlineBlockInit) return;
  __inlineBlockInit = true;
  __inlineBlockBar();

  // Click inside (or on) a callout/badge/compare block → show toolbar.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#inline-block-bar')) return;
    let node = t && t.closest && t.closest(__INLINE_BLOCK_SELECTOR);
    const editor = __inlineBlockEditorOf(node);
    if (node && editor) { __inlineBlockShow(node); return; }
    // Click outside a wired editor and outside the bar → hide.
    if (t && t.closest
        && !t.closest('#html-editor')
        && !t.closest('#title-html-editor')
        && !t.closest('#apx-body')
        && !t.closest('#inline-block-bar')
        && !t.closest('#modal-host')) {
      __inlineBlockHide();
    }
  }, true);

  // Toolbar button.
  __inlineBlockBar().addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const node = __inlineBlockActive;
    if (!node || !document.body.contains(node)) { __inlineBlockHide(); return; }
    const editor = __inlineBlockEditorOf(node);
    const act = btn.dataset.act;
    if (act === 'delete') {
      const lbl = __inlineBlockLabel(node);
      if (!confirm(`Delete this ${lbl}? This cannot be undone in the current session.`)) return;
      node.remove();
      __inlineBlockHide();
      if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Keyboard delete: Cmd/Ctrl+Shift+Backspace when caret is inside a block.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && __inlineBlockActive) { __inlineBlockHide(); return; }
    const isCombo = (e.metaKey || e.ctrlKey) && e.shiftKey
                    && (e.key === 'Backspace' || e.key === 'Delete');
    if (!isCombo) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const editor = r.commonAncestorContainer
                 && r.commonAncestorContainer.nodeType === 1
                 ? r.commonAncestorContainer.closest && (r.commonAncestorContainer.closest('#html-editor') || r.commonAncestorContainer.closest('#title-html-editor') || r.commonAncestorContainer.closest('#apx-body'))
                 : (r.commonAncestorContainer.parentElement && (r.commonAncestorContainer.parentElement.closest('#html-editor') || r.commonAncestorContainer.parentElement.closest('#title-html-editor') || r.commonAncestorContainer.parentElement.closest('#apx-body')));
    if (!editor) return;
    const startEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const block = startEl && startEl.closest && startEl.closest(__INLINE_BLOCK_SELECTOR);
    if (!block || !editor.contains(block)) return;
    e.preventDefault();
    const lbl = __inlineBlockLabel(block);
    if (!confirm(`Delete this ${lbl}? This cannot be undone in the current session.`)) return;
    block.remove();
    __inlineBlockHide();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });

  window.addEventListener('scroll', __inlineBlockPosition, true);
  window.addEventListener('resize', __inlineBlockPosition);
}

function wireInlineBlockControls(editor) {
  if (!editor) return;
  __inlineBlockInitOnce();
  __inlineBlockHide();
}

try { __inlineBlockInitOnce(); } catch (_) {}

function wireDropAndPaste(editor, page) {
  // drag over highlight
  ['dragenter','dragover'].forEach(t => editor.addEventListener(t, (e) => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      e.preventDefault(); editor.classList.add('is-dragging');
    }
  }));
  ['dragleave','drop'].forEach(t => editor.addEventListener(t, (e) => {
    e.preventDefault(); editor.classList.remove('is-dragging');
  }));
  editor.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('audio/'));
    if (!files.length) return;
    e.preventDefault();
    await insertUploadedFiles(files, page);
  });
  // paste image from clipboard, or sanitize Office/Google-Docs HTML
  editor.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter(it => it.kind === 'file' && (it.type.startsWith('image/') || it.type.startsWith('audio/')));
    if (fileItems.length) {
      e.preventDefault();
      const files = fileItems.map(it => it.getAsFile()).filter(Boolean);
      if (files.length) await insertUploadedFiles(files, page);
      return;
    }
    const html = e.clipboardData?.getData('text/html') || '';
    if (html && __isOfficeHTML(html)) {
      e.preventDefault();
      const cleaned = cleanPastedHTML(html);
      editor.focus();
      document.execCommand('insertHTML', false, cleaned);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

async function insertUploadedFiles(files, page) {
  const courseId = state.course?.id;
  const courseSlug = state.course?.slug;
  for (const f of files) {
    setSaveState('saving', `Uploading ${f.name}…`);
    try {
      const row = await uploadOne(f, courseId, courseSlug);
      // prompt for alt text (skip for audio)
      let alt = '';
      if (row.kind === 'image') {
        alt = prompt('Alt text for screen readers (recommended):', '') || '';
        if (alt) {
          await sb.from('course_assets').update({ alt_text: alt }).eq('id', row.id);
        }
      }
      const html = row.kind === 'image'
        ? `<figure><img src="${escapeHtml(row.public_url)}" alt="${escapeHtml(alt)}" /><figcaption></figcaption></figure>`
        : `<audio controls src="${escapeHtml(row.public_url)}"></audio>`;
      const ed = $('#html-editor');
      ed.focus();
      document.execCommand('insertHTML', false, html);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      setSaveState('saved', 'Uploaded');
    } catch (err) {
      console.error(err);
      setSaveState('error', 'Upload failed');
      toast('Upload failed: ' + err.message, 'is-error');
    }
  }
}

// =====================================================================
// FIND & REPLACE
// =====================================================================
function wireFindBar() {
  const bar = $('#find-bar'); if (!bar) return;
  let matches = [], idx = -1;

  function rebuild() {
    const q = $('#find-q').value;
    const ed = $('#html-editor');
    if (!ed || !q) { matches = []; idx = -1; $('#find-count').textContent = ''; return; }
    const text = ed.textContent || '';
    matches = [];
    let m;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    while ((m = re.exec(text)) !== null) matches.push({ index: m.index, length: m[0].length });
    idx = matches.length ? 0 : -1;
    update();
  }
  function update() {
    $('#find-count').textContent = matches.length ? `${idx+1}/${matches.length}` : '0/0';
  }
  function go(delta) {
    if (!matches.length) return;
    idx = (idx + delta + matches.length) % matches.length;
    update();
  }
  function replaceOne() {
    const q = $('#find-q').value, r = $('#find-r').value;
    if (!q) return;
    const ed = $('#html-editor');
    if (!ed) return;
    // simple text-level replace at current match using textContent reconstruction is risky;
    // for v1, do regex replace on innerHTML *text nodes* only via a TreeWalker:
    replaceInTextNodes(ed, q, r, false);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    rebuild();
  }
  function replaceAll() {
    const q = $('#find-q').value, r = $('#find-r').value;
    if (!q) return;
    const ed = $('#html-editor');
    if (!ed) return;
    replaceInTextNodes(ed, q, r, true);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    rebuild();
  }

  $('#find-q').addEventListener('input', rebuild);
  $('#find-next').onclick = () => go(1);
  $('#find-prev').onclick = () => go(-1);
  $('#find-replace-one').onclick = replaceOne;
  $('#find-replace-all').onclick = replaceAll;
  $('#find-close').onclick = () => bar.classList.add('hidden');
}

function replaceInTextNodes(root, find, replace, all) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), all ? 'gi' : 'i');
  let n, replaced = 0;
  while ((n = walker.nextNode())) {
    if (re.test(n.nodeValue)) {
      n.nodeValue = n.nodeValue.replace(re, replace);
      replaced++;
      if (!all) break;
    }
  }
  return replaced;
}

// =====================================================================
// VALIDATION (broken images, empty pages, missing alt, unbalanced tags)
// =====================================================================
function validatePage(html) {
  const issues = [];
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const text = tmp.textContent.trim();
  if (!text && !tmp.querySelector('img,audio,video,iframe')) issues.push('Page is empty');
  // missing alt
  tmp.querySelectorAll('img').forEach(img => {
    if (!img.getAttribute('alt')) issues.push('Image without alt text');
    const src = img.getAttribute('src') || '';
    if (!src) issues.push('Image with empty src');
    if (src.includes('base44.app/cdn')) issues.push('base44 CDN image (legacy URL)');
  });
  // unbalanced tags — quick heuristic: count opening vs closing div/section
  const opens = (html.match(/<div\b/gi) || []).length;
  const closes = (html.match(/<\/div>/gi) || []).length;
  if (opens !== closes) issues.push(`Unbalanced <div> tags (${opens} open / ${closes} close)`);
  return issues;
}

function refreshStatusBar() {
  const ref = state.selection?.kind === 'page' ? findPage(state.selection.id) : null;
  if (!ref) {
    $('#stat-words').textContent = '0 words';
    $('#stat-chars').textContent = '0 chars';
    $('#stat-read').textContent  = '0 min read';
    $('#stat-validation').textContent = '';
    syncWorkflowWidget(null);
    return;
  }
  syncWorkflowWidget(ref.page);
  const html = ref.page.body_html || '';
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  const text = tmp.textContent.trim();
  const words = text ? text.split(/\s+/).length : 0;
  $('#stat-words').textContent = `${words.toLocaleString()} words`;
  $('#stat-chars').textContent = `${text.length.toLocaleString()} chars`;
  $('#stat-read').textContent = `${Math.max(1, Math.round(words / 220))} min read`;
  const issues = validatePage(html);
  const stat = $('#stat-validation');
  if (issues.length) {
    stat.className = 'has-issues';
    stat.textContent = `⚠ ${issues.length} issue${issues.length===1?'':'s'}`;
    stat.title = issues.join('\n');
  } else {
    stat.className = 'is-clean';
    stat.textContent = '✓ clean';
    stat.title = '';
  }
}

// =====================================================================
// PAGE WORKFLOW STATUS — three-state indicator beside "✓ clean".
// State lives on pages.workflow_status (working|reviewed|ready|NULL).
// The lesson row's tint in the outline is computed via lessonRollupStatus,
// and the module row's tint via moduleRollupStatus. Persisted directly
// (not via dirty-staging) — optimistic UI + revert-on-failure.
// =====================================================================

// Rollup: lesson is green only if every page is ready; amber if every page
// is ready/reviewed (with at least one reviewed); red if any page is
// working; null otherwise (no pages, or mixed null + ready/reviewed).
// A page with NULL status counts as "not ready" — one unset page is enough
// to prevent the lesson from going green.
function lessonRollupStatus(lesson) {
  const pages = lesson.pages || [];
  if (pages.length === 0) return lesson.workflow_status || null;
  const statuses = pages.map(p => p.workflow_status || null);
  if (statuses.some(s => s === 'working')) return 'working';
  if (statuses.every(s => s === 'ready')) return 'ready';
  if (statuses.every(s => s === 'ready' || s === 'reviewed') && statuses.some(s => s === 'reviewed')) return 'reviewed';
  return null;
}

// Same logic, one level up — module rolls up from its child lessons.
function moduleRollupStatus(mod) {
  const lessons = mod.lessons || [];
  if (lessons.length === 0) return null;
  const statuses = lessons.map(l => lessonRollupStatus(l));
  if (statuses.some(s => s === 'working')) return 'working';
  if (statuses.every(s => s === 'ready')) return 'ready';
  if (statuses.every(s => s === 'ready' || s === 'reviewed') && statuses.some(s => s === 'reviewed')) return 'reviewed';
  return null;
}

function syncWorkflowWidget(page) {
  const root = document.getElementById('lesson-workflow');
  if (!root) return;
  if (!page) { root.hidden = true; return; }
  root.hidden = false;
  root.dataset.pageId = page.id;
  const status = page.workflow_status || null;
  root.querySelectorAll('.wf-box').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.wf === status ? 'true' : 'false');
  });
}

async function setPageWorkflowStatus(pageId, next) {
  const ref = findPage(pageId);
  if (!ref) {
    console.warn('[studio] setPageWorkflowStatus: page not found', pageId);
    return;
  }
  const prev = ref.page.workflow_status || null;
  if (prev === next) return;
  console.log('[studio] page workflow_status', pageId, prev, '→', next);
  // Optimistic update — local state + outline tints (page, lesson, module) + widget.
  ref.page.workflow_status = next;
  syncWorkflowWidget(ref.page);
  applyOutlinePageTint(ref.page);
  applyOutlineLessonTint(ref.lesson);
  applyOutlineModuleTint(ref.module);

  try {
    const { data, error } = await sb.from('pages')
      .update({ workflow_status: next })
      .eq('id', pageId)
      .select('id, workflow_status');

    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('No rows updated — RLS may be denying the write');
    }
    // Reconcile with what the DB actually wrote (defensive — should equal `next`).
    ref.page.workflow_status = data[0].workflow_status || null;
    syncWorkflowWidget(ref.page);
    applyOutlinePageTint(ref.page);
    applyOutlineLessonTint(ref.lesson);
    applyOutlineModuleTint(ref.module);
    toast(next ? `Page marked ${next}` : 'Page status cleared');
  } catch (err) {
    console.error('[studio] page workflow_status update failed', err);
    ref.page.workflow_status = prev;
    syncWorkflowWidget(ref.page);
    applyOutlinePageTint(ref.page);
    applyOutlineLessonTint(ref.lesson);
    applyOutlineModuleTint(ref.module);
    const msg = err && (err.message || err.hint || err.details) || 'permission denied';
    toast(`Could not update status: ${msg}`, 'is-error');
  }
}

// Shared DOM helper: re-apply wf-* class + dot on one outline row, given
// the kind selector and a status string (or null to clear).
function _applyRowWf(selector, status) {
  const row = document.querySelector(selector);
  if (!row) return;
  row.classList.remove('wf-working', 'wf-reviewed', 'wf-ready');
  row.querySelectorAll(':scope > .outline-wf-dot').forEach(d => d.remove());
  if (status) {
    row.classList.add(`wf-${status}`);
    const label = row.querySelector(':scope > .outline-label');
    if (label) {
      const dot = document.createElement('span');
      dot.className = 'outline-wf-dot';
      dot.title = status;
      label.parentNode.insertBefore(dot, label);
    }
  }
}

function applyOutlinePageTint(page) {
  _applyRowWf(`.outline-page[data-id="${page.id}"]`, page.workflow_status || null);
}

function applyOutlineLessonTint(lesson) {
  _applyRowWf(`.outline-lesson[data-id="${lesson.id}"]`, lessonRollupStatus(lesson));
}

function applyOutlineModuleTint(mod) {
  _applyRowWf(`.outline-module[data-id="${mod.id}"]`, moduleRollupStatus(mod));
}

function wireLessonWorkflowWidget() {
  // Delegate on document — #lesson-workflow lives inside <template id="tpl-editor">,
  // so it isn't in the DOM until renderEditor() clones it. Works across re-mounts.
  if (document.__wfWired) return;
  document.__wfWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.wf-box');
    if (!btn) return;
    const root = btn.closest('#lesson-workflow');
    if (!root) return;
    e.preventDefault();
    e.stopPropagation();
    const pageId = root.dataset.pageId;
    if (!pageId) {
      console.warn('[studio] wf-box clicked but no pageId on root');
      return;
    }
    const clicked = btn.dataset.wf;
    const ref = findPage(pageId);
    const current = ref ? (ref.page.workflow_status || null) : null;
    const next = current === clicked ? null : clicked;
    setPageWorkflowStatus(pageId, next);
  });
}

async function runValidationModal() {
  // Walk every page, every quiz; collect issues.
  const findings = [];
  for (const m of state.modules) {
    if (m.kc.length) {
      m.kc.forEach((q, i) => {
        if (!q.question?.trim()) findings.push({ where: `KC · ${m.title} · Q${i+1}`, msg: 'Empty stem' });
        if ((q.options || []).filter(o => o?.trim()).length < 2) findings.push({ where: `KC · ${m.title} · Q${i+1}`, msg: 'Fewer than 2 non-empty options' });
      });
    }
    for (const l of m.lessons) {
      l.pages.forEach((p, i) => {
        const issues = validatePage(p.body_html);
        issues.forEach(msg => findings.push({ where: `${m.title} → ${l.title} → Page ${i+1}`, msg, pageId: p.id }));
      });
    }
  }
  state.finalQs.forEach((q, i) => {
    if (!q.question?.trim()) findings.push({ where: `Final · Q${i+1}`, msg: 'Empty stem' });
    if ((q.options || []).filter(o => o?.trim()).length < 2) findings.push({ where: `Final · Q${i+1}`, msg: 'Fewer than 2 non-empty options' });
  });

  openModal({
    title: `Validation — ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
    bodyHtml: findings.length
      ? `<div style="display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto">
          ${findings.map(f => `<div style="border-left:3px solid var(--st-warn);padding:6px 10px;background:#fdf6e3;border-radius:4px;font-size:13px">
            <strong>${escapeHtml(f.where)}</strong><br>
            <span style="color:var(--st-muted)">${escapeHtml(f.msg)}</span>
            ${f.pageId ? `<br><a href="#" data-jump="${f.pageId}" style="font-size:12px">Jump to page →</a>` : ''}
          </div>`).join('')}
        </div>`
      : '<div class="studio-empty-state"><p>✓ All clean. No issues found.</p></div>',
    footHtml: '<button class="studio-btn" id="modal-cancel">Close</button>',
    onMount: (host) => {
      host.querySelector('#modal-cancel').addEventListener('click', closeModal);
      host.querySelectorAll('a[data-jump]').forEach(a => a.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal();
        selectNode('page', a.dataset.jump);
      }));
    }
  });
}

// =====================================================================
// DIRTY-STATE STAGING + SAVE
// =====================================================================
function refreshDirtyButtons() {
  const has = state.dirty.size > 0;
  $('#btn-save').disabled = !has;
  $('#btn-discard').disabled = !has;
  if (has) setSaveState('dirty', `Unsaved (${state.dirty.size})`);
  else if ($('#studio-savestate').textContent.startsWith('Unsaved')) setSaveState('saved', 'All saved');
}

function stageGeneric(table, id, patch) {
  const current = currentRecord(table, id);
  const filtered = {};
  let hasChange = false;
  for (const k in patch) {
    if (!current || current[k] !== patch[k]) {
      filtered[k] = patch[k];
      hasChange = true;
    }
  }
  if (!hasChange) return;
  const key = `${table}:${id}`;
  const existing = state.dirty.get(key) || { table, id, patch: {} };
  Object.assign(existing.patch, filtered);
  state.dirty.set(key, existing);
  refreshDirtyButtons();
}

function currentRecord(table, id) {
  if (table === 'pages')                    { const r = findPage(id);   return r ? r.page : null; }
  if (table === 'lessons')                  { const r = findLesson(id); return r ? r.lesson : null; }
  if (table === 'modules')                  { return findModule(id) || null; }
  if (table === 'courses')                  { return state.course && state.course.id === id ? state.course : null; }
  if (table === 'module_quiz_questions')    { const r = findKc(id);     return r ? r.q : null; }
  if (table === 'final_exam_questions')     { const r = findFinal(id);  return r ? r.q : null; }
  return null;
}

function stagePagePatch(id, patch)    { stageGeneric('pages', id, patch); applyLocalPatch('pages', id, patch); }
function stageLessonPatch(id, patch)  { stageGeneric('lessons', id, patch); applyLocalPatch('lessons', id, patch); refreshOutlineLabels(); }
function stageModulePatch(id, patch)  { stageGeneric('modules', id, patch); applyLocalPatch('modules', id, patch); refreshOutlineLabels(); }
function stageCoursePatch(patch)      { stageGeneric('courses', state.course.id, patch); Object.assign(state.course, patch); }
function stageQuizPatch(table, id, patch) {
  stageGeneric(table, id, patch);
  applyLocalPatch(table, id, patch);
  refreshOutlineLabels();
}

function applyLocalPatch(table, id, patch) {
  if (table === 'pages') {
    const ref = findPage(id); if (ref) Object.assign(ref.page, patch);
  } else if (table === 'lessons') {
    const ref = findLesson(id); if (ref) Object.assign(ref.lesson, patch);
  } else if (table === 'modules') {
    const m = findModule(id); if (m) Object.assign(m, patch);
  } else if (table === 'module_quiz_questions') {
    const ref = findKc(id); if (ref) Object.assign(ref.q, patch);
  } else if (table === 'final_exam_questions') {
    const ref = findFinal(id); if (ref) Object.assign(ref.q, patch);
  }
}

function refreshOutlineLabels() {
  const sel = state.selection;
  renderOutline();
  if (sel) {
    document.querySelectorAll('.outline-node').forEach(n => {
      n.classList.toggle('is-selected', n.dataset.kind === sel.kind && n.dataset.id === sel.id);
    });
  }
}

async function saveDirty() {
  if (!state.dirty.size) return;
  const patches = Array.from(state.dirty.values());
  $('#btn-save').disabled = true;
  setSaveState('saving', `Saving ${patches.length}…`);
  console.info('[studio] saveDirty: patches', patches.map(p => ({
    table: p.table, id: p.id, fields: Object.keys(p.patch || {})
  })));
  try {
    // For quiz tables we cannot project * because answer_index is column-
    // REVOKEd from authenticated (migration 0025, SOC 2 F-11). Project the
    // remaining columns explicitly; we already know answer_index locally
    // because we just wrote it.
    const results = await Promise.all(patches.map(p => {
      const q = sb.from(p.table).update(p.patch).eq('id', p.id);
      if (p.table === 'module_quiz_questions') {
        return q.select('id, module_id, position, question, options, reference, created_at, updated_at').single();
      }
      if (p.table === 'final_exam_questions') {
        return q.select('id, course_version_id, position, question, options, reference, source_module_slug, created_at, updated_at').single();
      }
      return q.select().single();
    }));
    console.info('[studio] saveDirty: results', results.map((r, i) => ({
      table: patches[i].table,
      id:    patches[i].id,
      ok:    !r.error,
      returned: r.data ? 1 : 0,
      err:   r.error && r.error.message
    })));

    // Detect ghost saves: a 200 with zero rows returned means the UPDATE
    // matched no rows under RLS or the WHERE clause. supabase-js's .single()
    // *should* error on 0 rows, but defensively also flag (data == null
    // && !error).
    const errs = results
      .map((r, i) => ({ ...r, _patch: patches[i] }))
      .filter(r => r.error || r.data == null);

    if (errs.length) {
      console.error('[studio] saves failed:', errs);
      setSaveState('error', `Save failed: ${errs.length}`);
      const msg = errs[0].error && errs[0].error.message
        ? errs[0].error.message
        : 'no rows updated — check RLS';
      toast(`Save failed for ${errs.length}/${results.length}: ${msg}`, 'is-error');
      return;
    }

    state.dirty.clear();
    refreshDirtyButtons();
    setSaveState('saved', `Saved ${patches.length}`);
    toast(`Saved ${patches.length} change${patches.length===1?'':'s'}.`, 'is-success');

    // Refresh affected records from the DB so the editor's cached state
    // reflects what actually landed (catches "ghost" saves that returned a
    // row but didn't change updated_at, or RLS-row-rewriting policies).
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i];
      const fresh = results[i] && results[i].data;
      if (!fresh) continue;
      const cached = currentRecord(p.table, p.id);
      if (cached && typeof cached === 'object') Object.assign(cached, fresh);
    }
  } catch (err) {
    console.error('[studio] saveDirty exception:', err);
    setSaveState('error', 'Save failed');
    toast('Save failed: ' + err.message, 'is-error');
  } finally {
    refreshDirtyButtons();
  }
}

function startAutosave() {
  stopAutosave();
  state.autosaveTimer = setInterval(() => {
    if (state.dirty.size) saveDirty();
  }, AUTOSAVE_INTERVAL_MS);
}
function stopAutosave() {
  if (state.autosaveTimer) clearInterval(state.autosaveTimer);
  state.autosaveTimer = null;
}

// Warn before navigating away
window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size) { e.preventDefault(); e.returnValue = ''; }
});

// Window-level drag guard: prevent the browser from navigating to / opening
// files when the user drops slightly outside an in-app dropzone. Without
// this, off-target drops cause the browser to load the file as a new page,
// which looks like "drag-and-drop stopped working".
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    e.preventDefault();
  }
}, false);
window.addEventListener('drop', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    // If the drop landed on a real dropzone (media-dropzone or html-editor),
    // those handlers already ran and called preventDefault on their own bubbling event.
    // For anything else, swallow the event so the browser doesn't open the file.
    const onMediaDz = e.target && e.target.closest && e.target.closest('#media-dropzone');
    const onEditor  = e.target && e.target.closest && e.target.closest('#html-editor');
    if (!onMediaDz && !onEditor) {
      e.preventDefault();
    }
  }
}, false);

// =====================================================================
// BOOTSTRAP
// =====================================================================
console.log('[studio] boot v0.4.78' + (_STUDIO_DEBUG ? ' (debug=1)' : ''));
_debugLog('boot v0.4.78');
wireLessonWorkflowWidget();
bootstrapAuth().catch(err => {
  console.error(err);
  _debugLog('bootstrapAuth threw: ' + (err?.message || err), 'err');
  toast('Boot error: ' + err.message, 'is-error');
});
