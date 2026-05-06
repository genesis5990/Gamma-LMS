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

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

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
  const { data } = await sb.auth.getSession();
  state.user = data.session?.user || null;

  sb.auth.onAuthStateChange(async (_e, session) => {
    state.user = session?.user || null;
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

$('#btn-signout').addEventListener('click', async () => {
  await sb.auth.signOut();
  window.location.href = '/studio';
});

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
  setSaveState('', 'Idle');

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
  renderCrumbs({ label: 'Studio', href: '/studio' }, { label: coursesOnly ? 'Courses' : 'Dashboard' });
  const tpl = document.getElementById('tpl-dashboard');
  view.appendChild(tpl.content.cloneNode(true));
  $('#dash-greeting').textContent = `signed in as ${state.profile.full_name || state.profile.email}`;

  // Load all data in parallel ----------------------------------------
  const today = new Date(); today.setHours(0,0,0,0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [coursesRes, modulesRes, lessonsRes, pagesRes, profilesRes, enrollRes,
         requestsRes, attemptsRes, assetsRes, recentPagesRes, recentKcRes, recentFinalRes]
    = await Promise.all([
      sb.from('courses').select('id, slug, title, current_version_id, visibility, pass_threshold, updated_at, created_at'),
      sb.from('modules').select('id, course_version_id', { count: 'exact', head: true }),
      sb.from('lessons').select('id', { count: 'exact', head: true }),
      sb.from('pages').select('id', { count: 'exact', head: true }),
      sb.from('profiles').select('id', { count: 'exact', head: true }),
      sb.from('enrollments').select('id, enrolled_at', { count: 'exact' }).gte('enrolled_at', sevenDaysAgo),
      sb.from('access_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      sb.from('quiz_attempts').select('id', { count: 'exact', head: true }).gte('submitted_at', sevenDaysAgo),
      sb.from('course_assets').select('id, byte_size'),
      sb.from('pages').select('id, title, lesson_id, updated_at, lessons!inner(title, module_id, modules!inner(title, course_version_id, course_versions!inner(course_id, courses!inner(slug, title))))').order('updated_at', { ascending: false }).limit(10),
      sb.from('module_quiz_questions').select('id, question, updated_at, modules!inner(title, course_version_id, course_versions!inner(course_id, courses!inner(slug, title)))').order('updated_at', { ascending: false }).limit(5),
      sb.from('final_exam_questions').select('id, question, updated_at, course_version_id, course_versions!inner(course_id, courses!inner(slug, title))').order('updated_at', { ascending: false }).limit(5),
    ]);

  const courses = coursesRes.data || [];
  state.allCoursesMeta = courses;

  // Per-course stats (modules / lessons / pages) — flat IN-clause queries (no nested embed filters)
  const versionIds = courses.map(c => c.current_version_id).filter(Boolean);
  let perCourseModulesData = [];
  let perCourseLessonsData = [];
  let perCoursePagesData = [];
  const moduleIdToVersion = {};
  const lessonIdToVersion = {};
  if (versionIds.length) {
    const modsRes = await sb.from('modules').select('id, course_version_id').in('course_version_id', versionIds);
    if (modsRes.error) console.error('dashboard modules', modsRes.error);
    perCourseModulesData = modsRes.data || [];
    for (const m of perCourseModulesData) moduleIdToVersion[m.id] = m.course_version_id;
    const moduleIds = perCourseModulesData.map(m => m.id);
    if (moduleIds.length) {
      const lessRes = await sb.from('lessons').select('id, module_id').in('module_id', moduleIds);
      if (lessRes.error) console.error('dashboard lessons', lessRes.error);
      perCourseLessonsData = lessRes.data || [];
      for (const l of perCourseLessonsData) lessonIdToVersion[l.id] = moduleIdToVersion[l.module_id];
      const lessonIds = perCourseLessonsData.map(l => l.id);
      if (lessonIds.length) {
        const pgsRes = await sb.from('pages').select('id, lesson_id').in('lesson_id', lessonIds);
        if (pgsRes.error) console.error('dashboard pages', pgsRes.error);
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
  $('#dash-kpis').innerHTML = kpis.map(k =>
    `<div class="dash-kpi ${k.kind ? 'is-' + k.kind : ''}">
       <div class="dash-kpi-label">${escapeHtml(k.label)}</div>
       <div class="dash-kpi-value">${escapeHtml(String(k.value))}</div>
       <div class="dash-kpi-sub">${escapeHtml(k.sub || '')}</div>
     </div>`
  ).join('');

  // Course grid -----------------------------------------------------
  function renderCourseGrid(filter) {
    const f = (filter || '').toLowerCase();
    const items = courses.filter(c =>
      !f || c.slug.toLowerCase().includes(f) || (c.title || '').toLowerCase().includes(f)
    );
    $('#dash-courses').innerHTML = items.length ? items.map(c => {
      const stats = statsByVersion[c.current_version_id] || { modules: 0, lessons: 0, pages: 0 };
      const status = c.visibility || 'private';
      return `<div class="dash-course-card">
        <div>
          <span class="dash-status is-${status}">${status}</span>
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
          <a href="/preview/${escapeHtml(c.slug)}" class="studio-btn" target="_blank" rel="noopener">Preview</a>
        </div>
      </div>`;
    }).join('') : '<div class="studio-empty-state"><p>No courses match.</p></div>';
  }
  renderCourseGrid('');
  $('#dash-course-filter').addEventListener('input', e => renderCourseGrid(e.target.value));

  // Recent edits feed ----------------------------------------------
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
}

// =====================================================================
// MEDIA LIBRARY
// =====================================================================
async function renderMedia(view) {
  renderCrumbs({ label: 'Studio', href: '/studio' }, { label: 'Media Library' });
  const tpl = document.getElementById('tpl-media');
  view.appendChild(tpl.content.cloneNode(true));

  // load courses for filter
  const { data: courses } = await sb.from('courses').select('id, slug, title').order('slug');
  const sel = $('#media-course-filter');
  sel.innerHTML = '<option value="">All courses</option>' +
    (courses || []).map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');

  let assets = [];
  let courseIdFilter = '';
  let textFilter = '';

  async function load() {
    const q = sb.from('course_assets')
      .select('id, course_id, kind, storage_path, public_url, filename, mime_type, byte_size, width, height, alt_text, created_at')
      .order('created_at', { ascending: false }).limit(500);
    if (courseIdFilter) q.eq('course_id', courseIdFilter);
    const { data, error } = await q;
    if (error) { toast('Load failed: ' + error.message, 'is-error'); return; }
    assets = data || [];
    render();
  }
  function render() {
    const f = textFilter.toLowerCase();
    const items = assets.filter(a =>
      !f ||
      (a.filename || '').toLowerCase().includes(f) ||
      (a.alt_text || '').toLowerCase().includes(f)
    );
    $('#media-empty').classList.toggle('hidden', items.length > 0);
    $('#media-grid').innerHTML = items.map(a => {
      const isImg = (a.mime_type || '').startsWith('image/');
      const thumb = isImg
        ? `<img src="${escapeHtml(a.public_url)}" alt="${escapeHtml(a.alt_text || '')}" loading="lazy" />`
        : `<span>${escapeHtml((a.mime_type || 'file').split('/')[0])}</span>`;
      return `<div class="media-card" data-id="${a.id}">
        <div class="media-thumb">${thumb}</div>
        <div class="media-meta">
          <div class="media-name" title="${escapeHtml(a.filename || '')}">${escapeHtml(a.filename || 'untitled')}</div>
          <div class="media-info">
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
  sel.addEventListener('change', e => { courseIdFilter = e.target.value; load(); });

  // Click-upload
  $('#media-upload-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFiles(files, courseIdFilter || null);
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
    const files = Array.from(ev.dataTransfer?.files || []);
    if (!files.length) return;
    await uploadFiles(files, courseIdFilter || null);
    load();
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
    .select('id, slug, title, current_version_id, visibility, pass_threshold, includes_disclaimer')
    .order('slug');
  if (error) { toast('Load courses failed: ' + error.message, 'is-error'); return; }
  state.courses = data || [];
  const sel = $('#course-picker');
  sel.innerHTML = state.courses.map(c => `<option value="${c.id}">${escapeHtml(c.slug)} — ${escapeHtml(c.title)}</option>`).join('');
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
  const [versionRes, modulesRes, finalRes] = await Promise.all([
    sb.from('course_versions').select('*').eq('id', versionId).maybeSingle(),
    sb.from('modules').select('*').eq('course_version_id', versionId).order('position'),
    sb.from('final_exam_questions').select('*').eq('course_version_id', versionId).order('position'),
  ]);
  for (const r of [versionRes, modulesRes, finalRes]) {
    if (r.error) { toast('Load failed: ' + r.error.message, 'is-error'); console.error('loadCourse step1', r.error); return; }
  }
  state.version = versionRes.data;
  const moduleRows = modulesRes.data || [];
  const moduleIds = moduleRows.map(m => m.id);

  // Step 2: lessons + KC questions (filter by module_id IN moduleIds)
  let lessonRows = [];
  let kcRows = [];
  if (moduleIds.length) {
    const [lessonsRes, kcRes] = await Promise.all([
      sb.from('lessons').select('*').in('module_id', moduleIds).order('position'),
      sb.from('module_quiz_questions').select('*').in('module_id', moduleIds).order('position'),
    ]);
    for (const r of [lessonsRes, kcRes]) {
      if (r.error) { toast('Load failed: ' + r.error.message, 'is-error'); console.error('loadCourse step2', r.error); return; }
    }
    lessonRows = lessonsRes.data || [];
    kcRows = kcRes.data || [];
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
  const modulesRowsForState = moduleRows;
  state.modules = modulesRowsForState.map(m => ({
    ...m,
    lessons: (lessonsByModule.get(m.id) || []).map(l => ({
      ...l,
      pages: pagesByLesson.get(l.id) || [],
    })),
    kc: kcByModule.get(m.id) || [],
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
  html.push(`<div class="outline-node outline-course is-course-root" data-kind="course" data-id="${state.course.id}" title="Click to edit · double-click to rename">
    <span class="outline-icon">C</span>
    <span class="outline-label" data-rename="course">${escapeHtml(state.course.title)}</span>
  </div>`);
  for (const m of state.modules) {
    html.push(`<div class="outline-children">`);
    html.push(`<div class="outline-node outline-module" draggable="true" data-kind="module" data-id="${m.id}" title="Click to edit · double-click to rename">
      <span class="outline-icon">M</span>
      <span class="outline-label" data-rename="module">${escapeHtml(m.title)}</span>
      <span class="outline-meta">${m.lessons.length}L</span>
      <span class="outline-node-actions">
        <button data-act="add-lesson" title="Add lesson">+L</button>
        <button data-act="add-kc" title="Add KC question">+Q</button>
        <button data-act="dup" title="Duplicate module">⎘</button>
        <button data-act="del" title="Delete">✕</button>
      </span>
    </div>`);
    for (const l of m.lessons) {
      html.push(`<div class="outline-node outline-lesson" draggable="true" data-kind="lesson" data-id="${l.id}" title="Click to edit · double-click to rename">
        <span class="outline-icon">L</span>
        <span class="outline-label" data-rename="lesson">${escapeHtml(l.title)}</span>
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
        html.push(`<div class="outline-node outline-page" draggable="true" data-kind="page" data-id="${p.id}" title="Double-click to rename">
          <span class="outline-icon">${i+1}</span>
          <span class="outline-label${isDerived ? ' is-derived' : ''}" data-rename="page">${escapeHtml(pageLabel)}</span>
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
  let dragSrc = null;
  root.addEventListener('dragstart', (e) => {
    const n = e.target.closest('.outline-node[draggable="true"]');
    if (!n) return;
    dragSrc = { kind: n.dataset.kind, id: n.dataset.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', n.dataset.id);
  });
  root.addEventListener('dragover', (e) => {
    const n = e.target.closest('.outline-node[draggable="true"]');
    if (!n || !dragSrc) return;
    if (n.dataset.kind !== dragSrc.kind) return;   // only reorder among siblings of same kind
    e.preventDefault();
    $$('.outline-node.is-drag-over', root).forEach(x => x.classList.remove('is-drag-over'));
    n.classList.add('is-drag-over');
  });
  root.addEventListener('dragleave', (e) => {
    const n = e.target.closest('.outline-node');
    if (n) n.classList.remove('is-drag-over');
  });
  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    $$('.outline-node.is-drag-over', root).forEach(x => x.classList.remove('is-drag-over'));
    const target = e.target.closest('.outline-node[draggable="true"]');
    if (!target || !dragSrc) return;
    if (target.dataset.kind !== dragSrc.kind) return;
    if (target.dataset.id === dragSrc.id) return;
    await reorderSibling(dragSrc.kind, dragSrc.id, target.dataset.id);
    dragSrc = null;
  });
}

async function reorderSibling(kind, srcId, beforeTargetId) {
  // find sibling array; rebuild positions
  let arr, table, parentKey;
  if (kind === 'module') { arr = state.modules; table = 'modules'; }
  else if (kind === 'lesson') {
    const ref = findLesson(srcId); if (!ref) return;
    arr = ref.module.lessons; table = 'lessons';
  } else if (kind === 'page') {
    const ref = findPage(srcId); if (!ref) return;
    arr = ref.lesson.pages; table = 'pages';
  } else return;

  const srcIdx = arr.findIndex(x => x.id === srcId);
  const dstIdx = arr.findIndex(x => x.id === beforeTargetId);
  if (srcIdx < 0 || dstIdx < 0) return;
  const [moved] = arr.splice(srcIdx, 1);
  arr.splice(dstIdx, 0, moved);
  arr.forEach((x, i) => { x.position = i; });

  const updates = arr.map(x => sb.from(table).update({ position: x.position }).eq('id', x.id));
  setSaveState('saving', 'Saving order…');
  const results = await Promise.all(updates);
  const errs = results.filter(r => r.error);
  if (errs.length) {
    setSaveState('error', 'Reorder failed');
    toast('Reorder failed: ' + errs[0].error.message, 'is-error');
  } else {
    setSaveState('saved', 'Order saved');
    toast('Reordered');
  }
  renderOutline();
  if (state.selection) {
    document.querySelectorAll('.outline-node').forEach(n => {
      n.classList.toggle('is-selected', n.dataset.kind === state.selection.kind && n.dataset.id === state.selection.id);
    });
  }
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
  const { data, error } = await sb.from('module_quiz_questions').insert({
    module_id: moduleId, position, question: '', options: ['', '', '', ''], answer_index: 0, reference: '',
  }).select().single();
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
  const { data, error } = await sb.from('final_exam_questions').insert({
    course_version_id: state.version.id, position,
    question: '', options: ['', '', '', ''], answer_index: 0, reference: '',
  }).select().single();
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
  if ($('#preview-card')) $('#preview-card').innerHTML = `<div class="studio-empty-state"><p>Edit a page to see a live preview here.</p></div>`;
}

function renderEditorBody() {
  const host = $('#editor-host');
  const toolbar = $('#editor-toolbar');
  if (!state.selection) { clearEditor(); return; }
  const { kind, id } = state.selection;

  if (kind === 'page') {
    const ref = findPage(id);
    if (!ref) return clearEditor();
    toolbar.innerHTML = renderPageToolbar();
    wirePageToolbar();
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
        stagePagePatch(ref.page.id, { body_html: ed.innerHTML });
        renderPreview();
        refreshStatusBar();
      });
      wireDropAndPaste(ed, ref.page);
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
    toolbar.innerHTML = '';
    host.innerHTML = `<div class="studio-empty-state">
      <h2>${escapeHtml(m.title)}</h2>
      <p>Module-level metadata is in the right pane. Choose a lesson, page, or KC question to edit content.</p>
    </div>`;
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
    return;
  }

  if (kind === 'course') {
    toolbar.innerHTML = '';
    host.innerHTML = `<div class="studio-empty-state">
      <h2>${escapeHtml(state.course.title)}</h2>
      <p>Course-level metadata is in the right pane.</p>
    </div>`;
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

// ---------- toolbar -----------------------------------------------
function renderPageToolbar() {
  return `
    <button data-cmd="h2"             type="button" title="Heading (Ctrl+1)">H2</button>
    <button data-cmd="h3"             type="button" title="Sub-heading (Ctrl+2)">H3</button>
    <button data-cmd="p"              type="button" title="Paragraph (Ctrl+3)">¶</button>
    <button data-cmd="bold"           type="button" title="Bold (Ctrl+B)"><b>B</b></button>
    <button data-cmd="italic"         type="button" title="Italic (Ctrl+I)"><i>I</i></button>
    <button data-cmd="ul"             type="button" title="Bulleted list">• List</button>
    <button data-cmd="ol"             type="button" title="Numbered list">1. List</button>
    <button data-cmd="link"           type="button" title="Link (Ctrl+K)">Link</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="callout-info"    type="button" title="Info callout">Info</button>
    <button data-cmd="callout-warn"    type="button" title="Warning callout">Warn</button>
    <button data-cmd="callout-danger"  type="button" title="Danger callout">Danger</button>
    <button data-cmd="callout-success" type="button" title="Success callout">Success</button>
    <button data-cmd="badge-panel"     type="button" title="Badge panel">Badge</button>
    <button data-cmd="compare-cards"   type="button" title="Compare cards">Compare</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="image-upload"    type="button" title="Upload + insert image">📷 Image</button>
    <button data-cmd="image-library"   type="button" title="Insert from library">Library</button>
    <button data-cmd="audio"           type="button" title="Insert audio by URL">Audio</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="undo"            type="button" title="Undo (Ctrl+Z)">↶</button>
    <button data-cmd="redo"            type="button" title="Redo (Ctrl+Y)">↷</button>
    <button data-cmd="find"            type="button" title="Find/replace (Ctrl+F)">Find</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="html-toggle"     type="button" title="Toggle HTML source">${state.htmlMode ? 'Rich' : 'HTML'}</button>
  `;
}

function wirePageToolbar() {
  const ed = () => $('#html-editor');
  const exec = (cmd, val=null) => { const e = ed(); if (!e) return; e.focus(); document.execCommand(cmd, false, val); };
  const insertHTML = (html) => { const e = ed(); if (!e) return; e.focus(); document.execCommand('insertHTML', false, html); };
  const trigger = () => { const e = ed(); if (e) e.dispatchEvent(new Event('input', { bubbles: true })); };

  $('#editor-toolbar').querySelectorAll('button').forEach(btn => {
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
        case 'image-upload': await onUploadImageFromToolbar(); break;
        case 'image-library': await onPickFromLibrary(); break;
        case 'audio': {
          const url = prompt('Audio URL (mp3 / wav / m4a):', '');
          if (url) insertHTML(`<audio controls src="${escapeHtml(url)}"></audio>`);
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
        case 'html-toggle':
          state.htmlMode = !state.htmlMode;
          renderEditorBody();
          break;
      }
      trigger();
    });
  });
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
    titleEl.textContent = 'Page metadata';
    host.innerHTML = `<form class="meta-form">
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
    </form>`;
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
      <div class="field"><label>Description</label><textarea id="meta-desc">${escapeHtml(m.description || '')}</textarea></div>
      <div class="meta-info">Slug: <code>${escapeHtml(m.slug)}</code><br>${m.lessons.length} lesson(s) · ${m.kc.length} KC question(s)</div>
    </form>`;
    $('#meta-title-in').addEventListener('input', e => stageModulePatch(m.id, { title: e.target.value }));
    $('#meta-desc').addEventListener('input',      e => stageModulePatch(m.id, { description: e.target.value || null }));
    return;
  }

  if (kind === 'course') {
    titleEl.textContent = 'Course metadata';
    host.innerHTML = `<form class="meta-form">
      <div class="field"><label>Title</label><input id="meta-title-in" type="text" value="${escapeHtml(state.course.title)}"/></div>
      <div class="field"><label>Pass threshold (%)</label><input id="meta-thresh" type="number" min="0" max="100" value="${state.course.pass_threshold}"/></div>
      <div class="field"><label>Visibility</label>
        <select id="meta-vis">
          <option value="private" ${state.course.visibility==='private'?'selected':''}>Private</option>
          <option value="preview" ${state.course.visibility==='preview'?'selected':''}>Preview</option>
          <option value="public"  ${state.course.visibility==='public' ?'selected':''}>Public</option>
        </select>
      </div>
      <div class="meta-info">Slug: <code>${escapeHtml(state.course.slug)}</code></div>
    </form>`;
    $('#meta-title-in').addEventListener('input', e => stageCoursePatch({ title: e.target.value }));
    $('#meta-thresh').addEventListener('input',    e => stageCoursePatch({ pass_threshold: Number(e.target.value) }));
    $('#meta-vis').addEventListener('change',      e => stageCoursePatch({ visibility: e.target.value }));
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

      let rows = [];
      try {
        const q = sb.from('course_assets')
          .select('id, filename, public_url, byte_size, mime_type, created_at, course_id')
          .eq('kind', 'audio')
          .order('created_at', { ascending: false })
          .limit(200);
        if (courseId) q.or(`course_id.eq.${courseId},course_id.is.null`);
        const { data, error } = await q;
        if (error) throw error;
        rows = data || [];
      } catch (err) {
        listEl.innerHTML = `<div class="studio-empty-state is-error"><p>Could not load audio assets: ${escapeHtml(err.message)}</p></div>`;
        return;
      }

      const render = (filter = '') => {
        const f = filter.trim().toLowerCase();
        const filtered = f ? rows.filter(r => (r.filename || '').toLowerCase().includes(f)) : rows;
        if (!filtered.length) {
          listEl.innerHTML = `<div class="studio-empty-state"><p>No audio assets ${f ? 'match that search' : 'in the library yet'}.</p><p>Use “Upload new…” above to add one.</p></div>`;
          return;
        }
        listEl.innerHTML = filtered.map(r => `
          <div class="audio-picker-row" data-url="${escapeHtml(r.public_url)}">
            <div class="audio-picker-meta">
              <div class="audio-picker-name">${escapeHtml(r.filename || '(untitled)')}</div>
              <div class="audio-picker-sub">${formatBytes(r.byte_size)} · ${escapeHtml(r.mime_type || 'audio')} · ${fmtRelTime(r.created_at)}</div>
              <audio controls preload="none" src="${escapeHtml(r.public_url)}" style="width:100%; margin-top:6px;"></audio>
            </div>
            <div class="audio-picker-actions">
              <button type="button" class="studio-btn is-primary" data-act="pick">Use this</button>
            </div>
          </div>
        `).join('');
        listEl.querySelectorAll('.audio-picker-row').forEach(rowEl => {
          rowEl.querySelector('[data-act="pick"]').addEventListener('click', () => {
            const url = rowEl.getAttribute('data-url');
            onPick(url);
            toast('Narration assigned (save to apply)', 'is-saved');
            closeModal();
          });
        });
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

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- preview pane -----------------------------------------
function renderPreview() {
  const host = $('#preview-card');
  if (!host) return;
  if (!state.selection) return;
  if (state.selection.kind === 'page') {
    const ref = findPage(state.selection.id);
    if (!ref) return;
    host.innerHTML = ref.page.body_html || '<p><em>(empty page)</em></p>';
  } else {
    host.innerHTML = `<div class="studio-empty-state"><p>Live preview is shown for pages.</p></div>`;
  }
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
  const courseSlug = courseId
    ? (state.allCoursesMeta.find(c => c.id === courseId)?.slug || state.courses.find(c => c.id === courseId)?.slug)
    : null;
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
  // paste image from clipboard
  editor.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter(it => it.kind === 'file' && (it.type.startsWith('image/') || it.type.startsWith('audio/')));
    if (!fileItems.length) return;
    e.preventDefault();
    const files = fileItems.map(it => it.getAsFile()).filter(Boolean);
    if (files.length) await insertUploadedFiles(files, page);
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

async function onUploadImageFromToolbar() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    const ref = state.selection?.kind === 'page' ? findPage(state.selection.id) : null;
    if (!ref) return;
    await insertUploadedFiles([f], ref.page);
  };
  inp.click();
}

async function onPickFromLibrary() {
  setSaveState('saving', 'Loading library…');
  const { data, error } = await sb.from('course_assets')
    .select('id, public_url, filename, kind, mime_type, byte_size, alt_text, course_id, width, height, created_at')
    .order('created_at', { ascending: false }).limit(200);
  if (error) { setSaveState('error', 'Library load failed'); toast(error.message, 'is-error'); return; }
  setSaveState('', 'Idle');
  const images = (data || []).filter(a => (a.mime_type || '').startsWith('image/'));
  if (!images.length) { toast('No images in library yet', 'is-error'); return; }
  openModal({
    title: 'Insert from Media Library',
    bodyHtml: `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">
      ${images.map(a => `<div class="lib-pick" data-id="${a.id}" style="cursor:pointer;border:1px solid var(--st-line);border-radius:6px;overflow:hidden">
        <div style="aspect-ratio:4/3;background:#f0f2fa;overflow:hidden"><img src="${escapeHtml(a.public_url)}" alt="" style="width:100%;height:100%;object-fit:cover"/></div>
        <div style="font-size:11px;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.filename || '')}</div>
      </div>`).join('')}
    </div>`,
    footHtml: '<button class="studio-btn" id="modal-cancel">Cancel</button>',
    onMount: (host) => {
      host.querySelectorAll('.lib-pick').forEach(el => {
        el.addEventListener('click', () => {
          const a = images.find(x => x.id === el.dataset.id);
          const alt = prompt('Alt text:', a.alt_text || '') || a.alt_text || '';
          const html = `<figure><img src="${escapeHtml(a.public_url)}" alt="${escapeHtml(alt)}" /><figcaption></figcaption></figure>`;
          $('#html-editor').focus();
          document.execCommand('insertHTML', false, html);
          $('#html-editor').dispatchEvent(new Event('input', { bubbles: true }));
          closeModal();
        });
      });
      host.querySelector('#modal-cancel').addEventListener('click', closeModal);
    }
  });
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
    return;
  }
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
  const key = `${table}:${id}`;
  const existing = state.dirty.get(key) || { table, id, patch: {} };
  Object.assign(existing.patch, patch);
  state.dirty.set(key, existing);
  refreshDirtyButtons();
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
  try {
    const results = await Promise.all(patches.map(p =>
      sb.from(p.table).update(p.patch).eq('id', p.id).select().single()
    ));
    const errs = results.filter(r => r.error);
    if (errs.length) {
      console.error(errs);
      setSaveState('error', `Save failed: ${errs.length}`);
      toast(`Save failed for ${errs.length} of ${results.length}: ${errs[0].error.message}`, 'is-error');
    } else {
      state.dirty.clear();
      refreshDirtyButtons();
      setSaveState('saved', `Saved ${patches.length}`);
      toast(`Saved ${patches.length} change${patches.length===1?'':'s'}.`, 'is-success');
    }
  } catch (err) {
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

// =====================================================================
// BOOTSTRAP
// =====================================================================
bootstrapAuth().catch(err => {
  console.error(err);
  toast('Boot error: ' + err.message, 'is-error');
});
