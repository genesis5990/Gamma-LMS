/* ================================================================
 * Course Studio — Phase 3 v1
 *
 * Talks directly to Supabase via the supabase-js global.
 * RLS enforces author-only writes (super_admin/instructor/tenant_admin).
 *
 * Loads:
 *   - list of courses
 *   - the current_version_id of the selected course
 *   - all child rows under that version (modules, lessons, pages,
 *     module_quiz_questions, final_exam_questions)
 *
 * Edits:
 *   - pages.body_html (HTML editor)
 *   - pages.title, pages.page_type, pages.audio_url (metadata)
 *   - lessons.title (metadata)
 *   - modules.title, modules.description (metadata)
 *   - module_quiz_questions / final_exam_questions: question/options/answer/ref
 *
 * Dirty-tracking: in-memory `dirty` map keyed by row signature; Save button
 * flushes all to Supabase in parallel; toast on success/failure.
 * ================================================================ */

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- state ------------------------------------------------
const state = {
  user:       null,            // supabase auth user
  profile:    null,            // {id, role, ...}
  courses:    [],              // [{id, slug, title, current_version_id, ...}]
  course:     null,            // currently selected course row
  version:    null,            // currently selected course_versions row
  modules:    [],              // [{... lessons:[{... pages:[]}], knowledge_check_questions:[] }]
  finalQs:    [],              // [{...}]
  selection:  null,            // {kind, id} ; kind = 'page'|'lesson'|'module'|'course'|'kc'|'finalq'
  dirty:      new Map(),       // key='page:<uuid>' -> {table:'pages', id:<uuid>, patch:{...}}
};

const TOAST_TIMEOUT = 2400;

// ---------- toast ------------------------------------------------
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

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- auth gate -------------------------------------------
async function bootstrapAuth() {
  // Wait for supabase to settle session (handles magic-link callback)
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
  const gateErr  = $('#studio-gate-error');
  const main     = $('#studio-main');

  if (!state.user) {
    gate.classList.remove('hidden');
    main.classList.add('hidden');
    gateMsg.textContent = 'Sign in with your Studio email to continue.';
    gateForm.classList.remove('hidden');
    return;
  }

  // Look up profile — RLS lets users read their own profile.
  const { data: prof, error } = await sb
    .from('profiles').select('id, role, full_name, email')
    .eq('id', state.user.id).maybeSingle();

  if (error) {
    gate.classList.remove('hidden');
    main.classList.add('hidden');
    gateMsg.textContent = `Profile lookup failed: ${error.message}`;
    return;
  }

  state.profile = prof;
  const ok = prof && ['super_admin','instructor','tenant_admin'].includes(prof.role);
  if (!ok) {
    gate.classList.remove('hidden');
    main.classList.add('hidden');
    gateMsg.textContent = `Access denied. Studio is for super_admin / instructor / tenant_admin only. (Your role: ${prof?.role || 'none'})`;
    gateForm.classList.add('hidden');
    return;
  }

  // We're in.
  gate.classList.add('hidden');
  main.classList.remove('hidden');
  $('#studio-user-label').textContent = prof.full_name || prof.email || state.user.email;
  await loadCourses();
}

// magic-link sign-in form
$('#studio-gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#studio-gate-email').value.trim();
  const errEl = $('#studio-gate-error');
  errEl.classList.add('hidden');
  try {
    const redirect = window.location.origin + window.location.pathname;
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect },
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
  window.location.reload();
});

// ---------- data loaders ----------------------------------------
async function loadCourses() {
  const { data, error } = await sb
    .from('courses')
    .select('id, slug, title, current_version_id, visibility, pass_threshold, includes_disclaimer')
    .order('slug');
  if (error) { toast('Load courses failed: ' + error.message, 'is-error'); return; }
  state.courses = data || [];
  const sel = $('#course-picker');
  sel.innerHTML = state.courses.map(c => `<option value="${c.id}">${escapeHtml(c.slug)} — ${escapeHtml(c.title)}</option>`).join('');
  sel.addEventListener('change', () => loadCourse(sel.value));
  if (state.courses.length) await loadCourse(state.courses[0].id);
  else $('#outline-tree').innerHTML = '<div class="studio-empty-state"><p>No courses yet. Run the import script to seed.</p></div>';
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
  const versionId = state.course.current_version_id;

  // Load version row, modules, lessons, pages, module quiz qs, final exam qs in parallel
  const [versionRes, modulesRes, lessonsRes, pagesRes, kcRes, finalRes] = await Promise.all([
    sb.from('course_versions').select('*').eq('id', versionId).maybeSingle(),
    sb.from('modules').select('*').eq('course_version_id', versionId).order('position'),
    sb.from('lessons').select('*, modules!inner(course_version_id)').eq('modules.course_version_id', versionId).order('position'),
    sb.from('pages').select('*, lessons!inner(module_id, modules!inner(course_version_id))').eq('lessons.modules.course_version_id', versionId).order('position'),
    sb.from('module_quiz_questions').select('*, modules!inner(course_version_id)').eq('modules.course_version_id', versionId).order('position'),
    sb.from('final_exam_questions').select('*').eq('course_version_id', versionId).order('position'),
  ]);

  for (const r of [versionRes, modulesRes, lessonsRes, pagesRes, kcRes, finalRes]) {
    if (r.error) { toast('Load failed: ' + r.error.message, 'is-error'); console.error(r.error); return; }
  }

  state.version = versionRes.data;
  // Stitch hierarchy
  const lessonsByModule = new Map();
  for (const l of (lessonsRes.data || [])) {
    delete l.modules; // strip the join field
    const arr = lessonsByModule.get(l.module_id) || [];
    arr.push(l); l.pages = []; l._kc = [];
    lessonsByModule.set(l.module_id, arr);
  }
  const pagesByLesson = new Map();
  for (const p of (pagesRes.data || [])) {
    const lid = p.lesson_id;
    delete p.lessons;
    (pagesByLesson.get(lid) || pagesByLesson.set(lid, []).get(lid)).push(p);
  }
  const kcByModule = new Map();
  for (const q of (kcRes.data || [])) {
    delete q.modules;
    (kcByModule.get(q.module_id) || kcByModule.set(q.module_id, []).get(q.module_id)).push(q);
  }
  state.modules = (modulesRes.data || []).map(m => ({
    ...m,
    lessons: (lessonsByModule.get(m.id) || []).map(l => ({
      ...l,
      pages: pagesByLesson.get(l.id) || [],
    })),
    kc: kcByModule.get(m.id) || [],
  }));
  state.finalQs = finalRes.data || [];

  renderOutline();
  // Auto-select first page
  const firstPage = state.modules.find(m => m.lessons.length)?.lessons[0]?.pages[0];
  if (firstPage) selectNode('page', firstPage.id);
  else clearEditor();
}

// ---------- outline tree ----------------------------------------
function renderOutline() {
  const root = $('#outline-tree');
  const html = [];
  // Course node
  html.push(`<div class="outline-node outline-course is-course-root" data-kind="course" data-id="${state.course.id}">
    <span class="outline-icon">C</span>
    <span class="outline-label">${escapeHtml(state.course.title)}</span>
  </div>`);
  for (const m of state.modules) {
    html.push(`<div class="outline-children">`);
    html.push(`<div class="outline-node outline-module" data-kind="module" data-id="${m.id}">
      <span class="outline-icon">M</span>
      <span class="outline-label">${escapeHtml(m.title)}</span>
      <span class="outline-meta">${m.lessons.length}L</span>
    </div>`);
    for (const l of m.lessons) {
      html.push(`<div class="outline-node outline-lesson" data-kind="lesson" data-id="${l.id}">
        <span class="outline-icon">L</span>
        <span class="outline-label">${escapeHtml(l.title)}</span>
        <span class="outline-meta">${l.pages.length}p</span>
      </div>`);
      for (let i = 0; i < l.pages.length; i++) {
        const p = l.pages[i];
        html.push(`<div class="outline-node outline-page" data-kind="page" data-id="${p.id}">
          <span class="outline-icon">·</span>
          <span class="outline-label">Page ${i+1}${p.title ? ': ' + escapeHtml(p.title) : ''}</span>
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
        </div>`);
      }
    }
    html.push(`</div>`); // /outline-children
  }
  // Final exam
  if (state.finalQs.length) {
    html.push(`<div class="outline-node outline-final" data-kind="final-list" data-id="final">
      <span class="outline-icon">F</span>
      <span class="outline-label">Final exam (${state.finalQs.length}q)</span>
    </div>`);
    html.push(`<div class="outline-children">`);
    for (let i = 0; i < state.finalQs.length; i++) {
      const q = state.finalQs[i];
      html.push(`<div class="outline-node outline-finalq" data-kind="finalq" data-id="${q.id}">
        <span class="outline-icon">?</span>
        <span class="outline-label">Q${i+1}: ${escapeHtml((q.question||'').slice(0, 60))}</span>
      </div>`);
    }
    html.push(`</div>`);
  }
  root.innerHTML = html.join('');

  root.querySelectorAll('.outline-node').forEach(n => {
    n.addEventListener('click', () => {
      const kind = n.dataset.kind;
      const id   = n.dataset.id;
      selectNode(kind, id);
    });
  });
}

function selectNode(kind, id) {
  if (state.dirty.size && !confirm('You have unsaved changes. Discard them and select another item?')) return;
  state.dirty.clear();
  refreshDirtyButtons();
  state.selection = { kind, id };
  document.querySelectorAll('.outline-node').forEach(n => {
    n.classList.toggle('is-selected', n.dataset.kind === kind && n.dataset.id === id);
  });
  renderEditor();
  renderMeta();
  renderPreview();
}

// ---------- selection helpers -----------------------------------
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

// ---------- editor renderers ------------------------------------
function clearEditor() {
  $('#editor-host').innerHTML = `<div class="studio-empty-state"><h2>Select an item</h2><p>Pick a page, lesson, module, or question from the outline.</p></div>`;
  $('#editor-toolbar').innerHTML = '';
  $('#meta-host').innerHTML = '';
  $('#meta-title').textContent = 'Metadata';
  $('#preview-card').innerHTML = `<div class="studio-empty-state"><p>Edit a page to see a live preview here.</p></div>`;
}

function renderEditor() {
  const host = $('#editor-host');
  const toolbar = $('#editor-toolbar');
  if (!state.selection) { clearEditor(); return; }
  const { kind, id } = state.selection;

  if (kind === 'page') {
    const ref = findPage(id);
    if (!ref) return clearEditor();
    toolbar.innerHTML = renderPageToolbar();
    wirePageToolbar();
    host.innerHTML = `<div id="html-editor" class="studio-html-editor" contenteditable="true" spellcheck="true">${ref.page.body_html || ''}</div>`;
    const ed = $('#html-editor');
    ed.addEventListener('input', () => {
      stagePagePatch(ref.page.id, { body_html: ed.innerHTML });
      renderPreview();
    });
    return;
  }

  if (kind === 'kc' || kind === 'finalq') {
    const ref = kind === 'kc' ? findKc(id) : findFinal(id);
    if (!ref) return clearEditor();
    const q = ref.q;
    toolbar.innerHTML = `<button id="btn-delete-q" class="studio-btn danger" type="button">Delete question</button>`;
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
      <p>Module-level metadata is in the right pane. Choose a lesson, page, or knowledge-check question to edit content.</p>
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

function renderPageToolbar() {
  return `
    <button data-cmd="h2"             type="button" title="Heading">H2</button>
    <button data-cmd="h3"             type="button" title="Sub-heading">H3</button>
    <button data-cmd="p"              type="button" title="Paragraph">¶</button>
    <button data-cmd="bold"           type="button" title="Bold"><b>B</b></button>
    <button data-cmd="italic"         type="button" title="Italic"><i>I</i></button>
    <button data-cmd="ul"             type="button" title="Bulleted list">• List</button>
    <button data-cmd="ol"             type="button" title="Numbered list">1. List</button>
    <button data-cmd="link"           type="button" title="Link">Link</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="callout-info"    type="button" title="Info callout">Info</button>
    <button data-cmd="callout-warn"    type="button" title="Warning callout">Warn</button>
    <button data-cmd="callout-danger"  type="button" title="Danger callout">Danger</button>
    <button data-cmd="callout-success" type="button" title="Success callout">Success</button>
    <button data-cmd="badge-panel"     type="button" title="Badge panel">Badge</button>
    <button data-cmd="compare-cards"   type="button" title="Compare cards (safe vs danger)">Compare</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="image"           type="button" title="Insert image by URL">Image</button>
    <button data-cmd="audio"           type="button" title="Insert audio by URL">Audio</button>
    <span class="toolbar-divider"></span>
    <button data-cmd="undo"            type="button" title="Undo">↶</button>
    <button data-cmd="redo"            type="button" title="Redo">↷</button>
  `;
}

function wirePageToolbar() {
  const ed = () => $('#html-editor');
  const exec = (cmd, val=null) => { ed().focus(); document.execCommand(cmd, false, val); };
  const insertHTML = (html) => { ed().focus(); document.execCommand('insertHTML', false, html); };

  $('#editor-toolbar').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
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
          const url = prompt('Image URL (paste from Supabase storage public URL):', '');
          if (url) {
            const alt = prompt('Alt text (for screen readers):', '') || '';
            insertHTML(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />`);
          }
          break;
        }
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
      }
      // Trigger input event manually so dirty state is captured
      ed().dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

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
      <label for="qf-ref">Reference (e.g. "Module 1.1" or "Ch 12 §3")</label>
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

// ---------- metadata pane (right) -------------------------------
function renderMeta() {
  const host = $('#meta-host');
  const titleEl = $('#meta-title');
  if (!state.selection) { titleEl.textContent = 'Metadata'; host.innerHTML = ''; return; }
  const { kind, id } = state.selection;

  if (kind === 'page') {
    const ref = findPage(id);
    if (!ref) return;
    titleEl.textContent = 'Page metadata';
    host.innerHTML = `<form class="meta-form">
      <div class="field"><label>Title</label><input id="meta-title-in" type="text" value="${escapeHtml(ref.page.title || '')}" placeholder="(optional page title)" /></div>
      <div class="field"><label>Type</label>
        <select id="meta-type">
          <option value="text"        ${ref.page.page_type==='text'?'selected':''}>Text</option>
          <option value="case-study"  ${ref.page.page_type==='case-study'?'selected':''}>Case study</option>
          <option value="interactive" ${ref.page.page_type==='interactive'?'selected':''}>Interactive</option>
        </select>
      </div>
      <div class="field"><label>Audio narration URL</label><input id="meta-audio" type="text" value="${escapeHtml(ref.page.audio_url || '')}" placeholder="(none)" /></div>
      <div class="meta-info">
        Lesson: <strong>${escapeHtml(ref.lesson.title)}</strong><br>
        Module: ${escapeHtml(ref.module.title)}<br>
        Position: ${ref.page.position + 1}
      </div>
    </form>`;
    $('#meta-title-in').addEventListener('input', e => stagePagePatch(ref.page.id, { title: e.target.value }));
    $('#meta-type').addEventListener('change',     e => stagePagePatch(ref.page.id, { page_type: e.target.value }));
    $('#meta-audio').addEventListener('input',     e => stagePagePatch(ref.page.id, { audio_url: e.target.value || null }));
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

// ---------- preview pane ----------------------------------------
function renderPreview() {
  const host = $('#preview-card');
  if (!state.selection) return;
  if (state.selection.kind === 'page') {
    const ref = findPage(state.selection.id);
    if (!ref) return;
    host.innerHTML = ref.page.body_html || '<p><em>(empty page)</em></p>';
  } else {
    host.innerHTML = `<div class="studio-empty-state"><p>Live preview is shown for pages.</p></div>`;
  }
}

$('#btn-toggle-preview').addEventListener('click', () => {
  $('#pane-preview').classList.toggle('hidden');
});
$('#btn-close-preview').addEventListener('click', () => {
  $('#pane-preview').classList.add('hidden');
});

// ---------- dirty-state staging ---------------------------------
function refreshDirtyButtons() {
  const has = state.dirty.size > 0;
  $('#btn-save').disabled = !has;
  $('#btn-discard').disabled = !has;
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
    const ref = findPage(id);
    if (ref) Object.assign(ref.page, patch);
  } else if (table === 'lessons') {
    const ref = findLesson(id);
    if (ref) Object.assign(ref.lesson, patch);
  } else if (table === 'modules') {
    const m = findModule(id);
    if (m) Object.assign(m, patch);
  } else if (table === 'module_quiz_questions') {
    const ref = findKc(id);
    if (ref) Object.assign(ref.q, patch);
  } else if (table === 'final_exam_questions') {
    const ref = findFinal(id);
    if (ref) Object.assign(ref.q, patch);
  }
}

function refreshOutlineLabels() {
  // Cheap full-rerender; outline is small enough to not bother diffing.
  const sel = state.selection;
  renderOutline();
  if (sel) {
    document.querySelectorAll('.outline-node').forEach(n => {
      n.classList.toggle('is-selected', n.dataset.kind === sel.kind && n.dataset.id === sel.id);
    });
  }
}

// ---------- save / discard --------------------------------------
$('#btn-save').addEventListener('click', async () => {
  if (!state.dirty.size) return;
  const patches = Array.from(state.dirty.values());
  $('#btn-save').disabled = true;
  $('#btn-save').textContent = 'Saving…';
  try {
    const results = await Promise.all(patches.map(p =>
      sb.from(p.table).update(p.patch).eq('id', p.id).select().single()
    ));
    const errs = results.filter(r => r.error);
    if (errs.length) {
      console.error(errs);
      toast(`Save failed for ${errs.length} of ${results.length} edits: ${errs[0].error.message}`, 'is-error');
    } else {
      toast(`Saved ${patches.length} change${patches.length===1?'':'s'}.`, 'is-success');
      state.dirty.clear();
      refreshDirtyButtons();
    }
  } catch (err) {
    toast('Save failed: ' + err.message, 'is-error');
  } finally {
    $('#btn-save').textContent = 'Save';
    refreshDirtyButtons();
  }
});

$('#btn-discard').addEventListener('click', () => {
  if (!confirm('Discard all unsaved changes?')) return;
  state.dirty.clear();
  refreshDirtyButtons();
  // Reload current course to undo local mutations
  if (state.course) loadCourse(state.course.id);
});

// Warn before navigating away
window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- bootstrap -------------------------------------------
bootstrapAuth().catch(err => {
  console.error(err);
  toast('Boot error: ' + err.message, 'is-error');
});
