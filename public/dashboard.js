// =====================================================================
// dashboard.js — student dashboard for Genesis + tenant portals.
// Loaded after auth.js (which exposes window.supabaseClient + helpers).
// Each section hydrates independently so a slow query doesn't block the
// rest of the page.
// =====================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const sb = window.supabaseClient;
  if (!sb) {
    console.error('[dashboard] supabaseClient missing');
    return;
  }

  // ---------- helpers ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function initials(name) {
    if (!name) return 'GD';
    return name.trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase() || 'GD';
  }
  function pct(n, d) {
    if (!d) return 0;
    const v = Math.round((n / d) * 100);
    return Math.max(0, Math.min(100, v));
  }
  function sanitize(html) {
    if (typeof window.DOMPurify === 'undefined') return '';
    return window.DOMPurify.sanitize(String(html == null ? '' : html), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'iframe'],
      FORBID_ATTR: ['onerror','onload','onclick','onmouseover','onfocus','onblur','onchange']
    });
  }
  function errBox(host, label, retryFn) {
    host.innerHTML = `<h2>${escapeHtml(label)}</h2>
      <div class="err"><span>Couldn't load this section.</span><button type="button">Retry</button></div>`;
    host.querySelector('button').addEventListener('click', retryFn);
  }
  function emptyBox(host, label, msg) {
    host.innerHTML = `<h2>${escapeHtml(label)}</h2><div class="empty">${escapeHtml(msg)}</div>`;
  }

  // ---------- tenant scope (set by tenant.js) ----------
  // Wait for tenant resolution so we know which tenant scope to filter by.
  // window.tenant.slug === null means Genesis dashboard.
  async function tenantInfo() {
    if (window.tenantReady) await window.tenantReady;
    return window.tenant || { slug: null, name: 'Genesis Digital Assets Academy' };
  }

  // ---------- sign-in gate ----------
  async function gateOrRender() {
    await window.authReady;
    const u = window.currentUser ? window.currentUser() : null;
    const tenant = await tenantInfo();
    // Update header title with tenant name + dashboard
    $('dashTitle').textContent = (tenant.name ? tenant.name + ' · ' : '') + 'Dashboard';

    if (!u) {
      $('signInGate').hidden = false;
      $('loadStrip').classList.add('is-done');
      wireGate();
      return;
    }
    $('signInGate').hidden = true;
    $('dashboardRoot').hidden = false;
    $('userChip').textContent = u.email || '';
    $('userChip').hidden = false;
    $('signOutBtn').hidden = false;
    $('signOutBtn').addEventListener('click', () => window.signOut && window.signOut());
    hydrate(u, tenant);
  }

  function wireGate() {
    const f = $('gateForm');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('gateEmail').value.trim();
      if (!email) return;
      const msg = $('gateMsg');
      msg.className = 'overlay-msg'; msg.textContent = 'Sending…';
      try {
        await window.signInWithEmail(email);
        msg.classList.add('is-ok');
        msg.textContent = 'Sign-in link sent. Check your inbox.';
      } catch (err) {
        msg.classList.add('is-err');
        msg.textContent = 'Could not send link: ' + (err.message || err);
      }
    });
  }

  // ---------- top-level hydrate ----------
  let _state = null;
  async function hydrate(user, tenant) {
    _state = { user, tenant };
    // Kick off all sections in parallel; each renders independently.
    Promise.all([
      renderProfile().catch(e => errBox($('profileCard'), 'Profile', renderProfile)),
      renderEnrollmentsAndContinue().catch(e => {
        errBox($('enrolledCard'), 'My courses', renderEnrollmentsAndContinue);
        $('continueCard').hidden = true;
      }),
      renderAvailable().catch(e => errBox($('availableCard'), 'Available courses', renderAvailable)),
      renderTesting().catch(e => errBox($('testingCard'), 'Testing center', renderTesting)),
      renderResources().catch(e => errBox($('resourcesCard'), 'Resources', renderResources)),
      renderCertificates().catch(e => errBox($('certificatesCard'), 'Certifications', renderCertificates))
    ]).finally(() => {
      $('loadStrip').classList.add('is-done');
    });
  }

  // ---------- 1. Profile ----------
  async function renderProfile() {
    const host = $('profileCard');
    const { data: profile, error } = await sb.from('profiles')
      .select('id, email, full_name, avatar_url, role, tenant_id, agency_name')
      .eq('id', _state.user.id).maybeSingle();
    if (error) throw error;
    _state.profile = profile || { id: _state.user.id, email: _state.user.email };

    const name = (profile && profile.full_name) || '';
    const av = profile && profile.avatar_url;
    const orgName = _state.tenant && _state.tenant.name;
    host.innerHTML = `
      <h2>Your profile</h2>
      <div class="profile">
        <div class="avatar">${av ? `<img src="${escapeHtml(av)}" alt="">` : escapeHtml(initials(name || _state.user.email))}</div>
        <div class="profile-text">
          <strong>${escapeHtml(name || '(no name set)')}</strong>
          <span>${escapeHtml(_state.user.email)}</span>
          ${orgName ? `<br><span>${escapeHtml(orgName)}</span>` : ''}
        </div>
        <button type="button" class="btn ghost" id="editProfileBtn">Edit profile</button>
      </div>
    `;
    host.querySelector('#editProfileBtn').addEventListener('click', () => openEditProfile(profile || {}));
  }

  function openEditProfile(profile) {
    $('editFullName').value = profile.full_name || '';
    $('editAvatar').value = profile.avatar_url || '';
    $('editMsg').className = 'overlay-msg'; $('editMsg').textContent = '';
    $('editOverlay').classList.add('is-open');
    setTimeout(() => $('editFullName').focus(), 0);
  }
  $('editCancel').addEventListener('click', () => $('editOverlay').classList.remove('is-open'));
  $('editOverlay').addEventListener('click', (e) => { if (e.target === $('editOverlay')) $('editOverlay').classList.remove('is-open'); });
  $('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const full = $('editFullName').value.trim();
    const av = $('editAvatar').value.trim();
    if (!full) return;
    const msg = $('editMsg');
    msg.className = 'overlay-msg'; msg.textContent = 'Saving…';
    try {
      const patch = { full_name: full, avatar_url: av || null };
      await window.updateProfile(patch);
      msg.classList.add('is-ok'); msg.textContent = 'Saved.';
      setTimeout(() => $('editOverlay').classList.remove('is-open'), 600);
      renderProfile().catch(() => {});
    } catch (err) {
      msg.classList.add('is-err'); msg.textContent = 'Save failed: ' + (err.message || err);
    }
  });

  // ---------- 2 + 3. Enrollments + Continue ----------
  async function renderEnrollmentsAndContinue() {
    const host = $('enrolledCard');
    // enrollments self-read RLS exists.
    const { data: enrolls, error } = await sb.from('enrollments')
      .select('id, course_id, status, enrolled_at, completed_at')
      .eq('user_id', _state.user.id);
    if (error) throw error;
    _state.enrollments = enrolls || [];

    // Resolve courses — enrollments.course_id is text (course slug), not the
    // courses.id uuid. courses_public_read requires authenticated, which we are.
    const slugs = Array.from(new Set((enrolls || []).map(e => e.course_id).filter(Boolean)));
    let coursesBySlug = new Map();
    if (slugs.length) {
      const { data: courses } = await sb.from('courses')
        .select('id, slug, title, description, hero_image_url, tenant_id, current_version_id')
        .in('slug', slugs);
      for (const c of (courses || [])) coursesBySlug.set(c.slug, c);
    }
    _state.coursesBySlug = coursesBySlug;

    // Filter to current tenant scope: tenant.slug === null => Genesis (tenant_id IS NULL),
    // else tenant.id matches.
    const tenantId = _state.tenant && _state.tenant.id ? _state.tenant.id : null;
    const inScope = (enrolls || []).filter(e => {
      const c = coursesBySlug.get(e.course_id);
      if (!c) return true; // legacy courses not in new schema (e.g. crypto101) — show anyway
      if (tenantId === null) return c.tenant_id == null;
      return c.tenant_id === tenantId;
    });

    if (!inScope.length) {
      emptyBox(host, 'My courses', 'You haven\'t enrolled in any courses yet — see Available below.');
      $('continueCard').hidden = true;
      return;
    }

    // Compute progress per enrolled course (best-effort — count of completed
    // lessons over total lessons in the current version).
    const progressBySlug = new Map();
    for (const e of inScope) {
      const c = coursesBySlug.get(e.course_id);
      if (!c || !c.current_version_id) { progressBySlug.set(e.course_id, { done: 0, total: 0 }); continue; }
      try {
        const { data: lessons } = await sb.from('lessons')
          .select('id, slug, modules!inner(course_version_id)')
          .eq('modules.course_version_id', c.current_version_id);
        const slugs = (lessons || []).map(l => l.slug);
        let done = 0;
        if (slugs.length) {
          const { data: lp } = await sb.from('lesson_progress')
            .select('lesson_id, complete')
            .eq('user_id', _state.user.id)
            .in('lesson_id', slugs);
          done = (lp || []).filter(r => r.complete).length;
        }
        progressBySlug.set(e.course_id, { done, total: slugs.length });
      } catch {
        progressBySlug.set(e.course_id, { done: 0, total: 0 });
      }
    }
    _state.progressBySlug = progressBySlug;

    // Render the enrolled grid
    host.innerHTML = `
      <h2>My courses <span class="h2-sub">${inScope.length} enrolled</span></h2>
      <div class="grid">
        ${inScope.map(e => {
          const c = coursesBySlug.get(e.course_id);
          const title = c ? c.title : e.course_id;
          const desc = (c && c.description) ? c.description.slice(0, 140) : '';
          const p = progressBySlug.get(e.course_id) || { done: 0, total: 0 };
          const pp = pct(p.done, p.total);
          return `<article class="ccard">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(desc)}</p>
            <div class="progressbar"><div style="width:${pp}%"></div></div>
            <div class="meta"><span>${p.done}/${p.total} lessons · ${pp}%</span>
              <a class="btn gold" href="/courses/${encodeURIComponent(e.course_id)}">Open</a></div>
          </article>`;
        }).join('')}
      </div>
    `;

    // Continue learning: pick the most recently active enrolled course.
    let mostRecent = null; let mostRecentTs = 0;
    try {
      const slugList = inScope.map(e => e.course_id);
      // lesson_progress + quiz_attempts are keyed by lesson slug (text); we don't
      // have a direct course join. Pick the freshest quiz_attempts row's lesson_id
      // and best-match by enrollment if possible.
      const [{ data: qa }, { data: lp }] = await Promise.all([
        sb.from('quiz_attempts').select('lesson_id, submitted_at').eq('user_id', _state.user.id).order('submitted_at', { ascending: false }).limit(20),
        sb.from('lesson_progress').select('lesson_id, last_viewed_at').eq('user_id', _state.user.id).order('last_viewed_at', { ascending: false }).limit(20)
      ]);
      // No direct lesson->course mapping for legacy crypto101 lessons; use
      // most-recently-enrolled fallback unless we can map from new-schema lessons.
      // Map lesson slug -> course slug via lessons table when available.
      const recentSlugs = Array.from(new Set([
        ...((qa || []).map(r => r.lesson_id)),
        ...((lp || []).map(r => r.lesson_id))
      ])).slice(0, 30);
      let lessonToCourse = new Map();
      if (recentSlugs.length) {
        const { data: lessonRows } = await sb.from('lessons')
          .select('slug, modules!inner(course_versions!inner(courses!inner(slug)))')
          .in('slug', recentSlugs);
        for (const r of (lessonRows || [])) {
          const cs = r.modules && r.modules.course_versions && r.modules.course_versions.courses && r.modules.course_versions.courses.slug;
          if (cs) lessonToCourse.set(r.slug, cs);
        }
      }
      function ts(iso) { return iso ? new Date(iso).getTime() : 0; }
      for (const r of (qa || [])) {
        const cs = lessonToCourse.get(r.lesson_id);
        if (!cs || !slugList.includes(cs)) continue;
        const t = ts(r.submitted_at);
        if (t > mostRecentTs) { mostRecentTs = t; mostRecent = cs; }
      }
      for (const r of (lp || [])) {
        const cs = lessonToCourse.get(r.lesson_id);
        if (!cs || !slugList.includes(cs)) continue;
        const t = ts(r.last_viewed_at);
        if (t > mostRecentTs) { mostRecentTs = t; mostRecent = cs; }
      }
    } catch { /* ignore */ }

    // Fallback: if no activity, show the most-recently-enrolled course.
    if (!mostRecent && inScope.length) {
      const sorted = inScope.slice().sort((a, b) => new Date(b.enrolled_at) - new Date(a.enrolled_at));
      mostRecent = sorted[0].course_id;
    }
    if (mostRecent) {
      const c = coursesBySlug.get(mostRecent);
      const title = c ? c.title : mostRecent;
      const p = progressBySlug.get(mostRecent) || { done: 0, total: 0 };
      const pp = pct(p.done, p.total);
      $('continueCard').hidden = false;
      $('continueCard').innerHTML = `
        <h2>Continue learning</h2>
        <div class="continue">
          <div>
            <strong style="font-size:16px;">${escapeHtml(title)}</strong>
            <div class="progressbar"><div style="width:${pp}%"></div></div>
            <div style="font-size:12.5px;color:var(--muted);">${p.done}/${p.total} lessons · ${pp}% complete</div>
          </div>
          <a class="btn primary" href="/courses/${encodeURIComponent(mostRecent)}">Resume →</a>
        </div>
      `;
    }
  }

  // ---------- 4. Available courses ----------
  async function renderAvailable() {
    const host = $('availableCard');
    const tenantId = _state.tenant && _state.tenant.id ? _state.tenant.id : null;

    let q = sb.from('courses')
      .select('id, slug, title, description, hero_image_url, tenant_id, visibility')
      .in('visibility', ['preview', 'public']);
    if (tenantId === null) {
      q = q.is('tenant_id', null);
    } else {
      q = q.eq('tenant_id', tenantId);
    }
    const { data: courses, error } = await q;
    if (error) throw error;

    const enrolled = new Set((_state.enrollments || []).map(e => e.course_id));
    const avail = (courses || []).filter(c => !enrolled.has(c.slug));

    if (!avail.length) {
      emptyBox(host, 'Available courses', 'No new courses available in this catalog right now.');
      return;
    }

    host.innerHTML = `
      <h2>Available courses <span class="h2-sub">${avail.length} in catalog</span></h2>
      <div class="grid">
        ${avail.map(c => `
          <article class="ccard" data-slug="${escapeHtml(c.slug)}">
            <h3>${escapeHtml(c.title || c.slug)}</h3>
            <p>${escapeHtml((c.description || '').slice(0, 160))}</p>
            <div class="meta"><span>&nbsp;</span>
              <button type="button" class="btn gold" data-act="enroll">Enroll</button></div>
          </article>
        `).join('')}
      </div>
    `;
    host.querySelectorAll('button[data-act="enroll"]').forEach(b => {
      b.addEventListener('click', async () => {
        const card = b.closest('.ccard');
        const slug = card.getAttribute('data-slug');
        b.disabled = true; b.textContent = 'Enrolling…';
        const { error } = await sb.from('enrollments').insert({
          user_id: _state.user.id, course_id: slug, tenant_id: tenantId
        });
        if (error) {
          b.disabled = false; b.textContent = 'Enroll';
          alert('Could not enroll: ' + error.message + '\n\nIf this persists, contact your administrator (the enrollments table may not allow self-insert under current RLS).');
          return;
        }
        // Re-hydrate enrollments + available
        await renderEnrollmentsAndContinue().catch(() => {});
        await renderAvailable().catch(() => {});
      });
    });
  }

  // ---------- 5. Testing center ----------
  async function renderTesting() {
    const host = $('testingCard');

    // Recent attempts (last 10)
    const { data: attempts, error } = await sb.from('quiz_attempts')
      .select('lesson_id, score, passed, attempt_no, submitted_at')
      .eq('user_id', _state.user.id)
      .order('submitted_at', { ascending: false })
      .limit(10);
    if (error) throw error;

    // For enrolled courses (new schema), list quizzed lessons + finals.
    const enrolledSlugs = Array.from(new Set((_state.enrollments || []).map(e => e.course_id)));
    let exams = [];
    if (enrolledSlugs.length && _state.coursesBySlug) {
      const courseInfos = enrolledSlugs.map(s => _state.coursesBySlug.get(s)).filter(Boolean);
      const versionIds = courseInfos.map(c => c.current_version_id).filter(Boolean);
      if (versionIds.length) {
        // Quizzed lessons
        try {
          const { data: lessons } = await sb.from('lessons')
            .select('id, slug, title, has_quiz, modules!inner(course_version_id, courses:course_version_id(*))')
            .in('modules.course_version_id', versionIds)
            .eq('has_quiz', true);
          for (const l of (lessons || [])) {
            exams.push({ kind: 'quiz', lesson_id: l.slug, title: l.title, course_slug: courseSlugForVersion(l.modules.course_version_id, courseInfos) });
          }
        } catch { /* table may not have has_quiz column on older schemas */ }
        // Finals
        try {
          const { data: finals } = await sb.from('final_exam_questions')
            .select('course_version_id')
            .in('course_version_id', versionIds);
          const versionsWithFinal = new Set((finals || []).map(r => r.course_version_id));
          for (const v of versionsWithFinal) {
            const c = courseInfos.find(x => x.current_version_id === v);
            if (c) exams.push({ kind: 'final', lesson_id: 'final', title: 'Final exam', course_slug: c.slug });
          }
        } catch { /* noop */ }
      }
    }

    // Best score per lesson_id from attempts
    const bestByLesson = new Map();
    for (const a of (attempts || [])) {
      const cur = bestByLesson.get(a.lesson_id);
      if (!cur || a.score > cur.score) bestByLesson.set(a.lesson_id, a);
    }

    let examRows = '';
    if (exams.length) {
      examRows = exams.map(e => {
        const best = bestByLesson.get(e.lesson_id);
        return `<tr>
          <td>${escapeHtml(e.course_slug || '—')}</td>
          <td>${escapeHtml(e.title || e.lesson_id)} ${e.kind === 'final' ? '<span class="pill muted">Final</span>' : ''}</td>
          <td>${best
            ? `<span class="pill ${best.passed ? 'ok' : 'bad'}">${best.score}%</span> · attempt ${best.attempt_no}`
            : '<span class="pill muted">Not attempted</span>'}</td>
          <td><a class="btn ghost" href="/courses/${encodeURIComponent(e.course_slug || '')}?lesson=${encodeURIComponent(e.lesson_id)}">Take exam</a></td>
        </tr>`;
      }).join('');
    } else {
      examRows = `<tr><td colspan="4" class="empty" style="border-radius:0;">No exams listed for your enrolled courses yet.</td></tr>`;
    }

    let attemptRows = '';
    if (attempts && attempts.length) {
      attemptRows = attempts.map(a => `<tr>
        <td>${escapeHtml(a.lesson_id)}</td>
        <td><span class="pill ${a.passed ? 'ok' : 'bad'}">${a.score}%</span></td>
        <td>${a.attempt_no}</td>
        <td>${escapeHtml(fmtDate(a.submitted_at))}</td>
      </tr>`).join('');
    } else {
      attemptRows = `<tr><td colspan="4" class="empty" style="border-radius:0;">No attempts yet.</td></tr>`;
    }

    host.innerHTML = `
      <h2>Testing center</h2>
      <table class="rows" style="margin-bottom:18px;">
        <thead><tr><th>Course</th><th>Exam</th><th>Best</th><th></th></tr></thead>
        <tbody>${examRows}</tbody>
      </table>
      <h3 style="margin:20px 0 8px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px;">Recent attempts</h3>
      <table class="rows">
        <thead><tr><th>Lesson</th><th>Score</th><th>Attempt</th><th>When</th></tr></thead>
        <tbody>${attemptRows}</tbody>
      </table>
    `;
  }
  function courseSlugForVersion(versionId, courseInfos) {
    const c = (courseInfos || []).find(x => x.current_version_id === versionId);
    return c ? c.slug : '';
  }

  // ---------- 6. Resources ----------
  async function renderResources() {
    const host = $('resourcesCard');
    const enrolledSlugs = Array.from(new Set((_state.enrollments || []).map(e => e.course_id)));
    if (!enrolledSlugs.length || !_state.coursesBySlug) {
      emptyBox(host, 'Resources', 'Resources are listed here once you enrol in a course.');
      return;
    }
    const courses = enrolledSlugs.map(s => _state.coursesBySlug.get(s)).filter(Boolean);
    const versionIds = courses.map(c => c.current_version_id).filter(Boolean);
    if (!versionIds.length) {
      emptyBox(host, 'Resources', 'No reference materials attached to your enrolled courses yet.');
      return;
    }
    // Fetch modules + appendix items.
    const { data: modules, error: mErr } = await sb.from('modules')
      .select('id, title, course_version_id')
      .in('course_version_id', versionIds);
    if (mErr) throw mErr;

    const modIds = (modules || []).map(m => m.id);
    if (!modIds.length) { emptyBox(host, 'Resources', 'No appendix materials yet.'); return; }

    const { data: items, error: aErr } = await sb.from('module_appendix_items')
      .select('id, module_id, kind, title, description, url, asset_id, position')
      .in('module_id', modIds)
      .order('position', { ascending: true });
    if (aErr) throw aErr;

    if (!items || !items.length) { emptyBox(host, 'Resources', 'No appendix materials yet.'); return; }

    // Pull asset metadata for any html/pdf/docx items that reference course_assets.
    const assetIds = (items || []).map(i => i.asset_id).filter(Boolean);
    let assetById = new Map();
    if (assetIds.length) {
      const { data: assets } = await sb.from('course_assets')
        .select('id, kind, storage_path, public_url, filename, mime_type, byte_size')
        .in('id', assetIds);
      for (const a of (assets || [])) assetById.set(a.id, a);
    }
    _state.resAssets = assetById;
    _state.resItems = items;
    _state.resModules = new Map((modules || []).map(m => [m.id, m]));
    _state.resCourses = new Map(courses.map(c => [c.current_version_id, c]));

    drawResources('');

    host.querySelector('#resSearch').addEventListener('input', (e) => drawResources(e.target.value || ''));
  }
  function drawResources(filter) {
    const host = $('resourcesCard');
    const f = filter.toLowerCase();
    const items = (_state.resItems || []).filter(it => {
      if (!f) return true;
      return (it.title || '').toLowerCase().includes(f) || (it.description || '').toLowerCase().includes(f);
    });
    // Group by course -> module
    const byCourse = new Map();
    for (const it of items) {
      const m = _state.resModules.get(it.module_id);
      if (!m) continue;
      const c = _state.resCourses.get(m.course_version_id);
      const courseTitle = c ? (c.title || c.slug) : 'Course';
      if (!byCourse.has(courseTitle)) byCourse.set(courseTitle, new Map());
      const mods = byCourse.get(courseTitle);
      if (!mods.has(m.title)) mods.set(m.title, []);
      mods.get(m.title).push(it);
    }

    if (!byCourse.size) {
      host.innerHTML = `
        <h2>Resources</h2>
        <input type="search" class="res-search" id="resSearch" placeholder="Search title or description…" value="${escapeHtml(filter)}" />
        <div class="empty">No matches.</div>`;
      host.querySelector('#resSearch').addEventListener('input', (e) => drawResources(e.target.value || ''));
      setTimeout(() => host.querySelector('#resSearch').focus(), 0);
      return;
    }

    let html = `<h2>Resources</h2>
      <input type="search" class="res-search" id="resSearch" placeholder="Search title or description…" value="${escapeHtml(filter)}" />`;
    for (const [course, mods] of byCourse) {
      html += `<div class="res-group">
        <h4>${escapeHtml(course)}</h4>`;
      for (const [modTitle, list] of mods) {
        html += `<div style="font-size:13px; color:var(--muted); margin: 8px 0 4px; font-weight:600;">${escapeHtml(modTitle)}</div>`;
        for (const it of list) {
          const k = (it.kind || 'link').toLowerCase();
          html += `<div class="res-row">
            <span class="res-kind ${k}">${k.toUpperCase()}</span>
            <div class="res-info">
              <strong>${escapeHtml(it.title || '(untitled)')}</strong>
              <span>${escapeHtml((it.description || '').slice(0, 200))}</span>
            </div>
            <button type="button" class="btn ghost" data-res-id="${escapeHtml(it.id)}">${k === 'link' ? 'Open' : (k === 'docx' ? 'Download' : 'View')}</button>
          </div>`;
        }
      }
      html += `</div>`;
    }
    host.innerHTML = html;
    host.querySelector('#resSearch').addEventListener('input', (e) => drawResources(e.target.value || ''));
    host.querySelectorAll('button[data-res-id]').forEach(b => {
      b.addEventListener('click', () => openResource(b.getAttribute('data-res-id')));
    });
  }
  async function openResource(id) {
    const it = (_state.resItems || []).find(x => x.id === id);
    if (!it) return;
    const k = (it.kind || 'link').toLowerCase();
    if (k === 'link' && it.url) {
      window.open(it.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (k === 'html') {
      // Item.description may already be the body, or the asset's text content
      // is referenced. Most appendix html bodies live in description (per
      // migration 0019); fall back to fetching the asset if not.
      $('htmlOverlayTitle').textContent = it.title || 'Resource';
      $('htmlOverlayBody').innerHTML = sanitize(it.description || '');
      $('htmlOverlay').classList.add('is-open');
      return;
    }
    // pdf or docx — need a signed URL from the asset
    const asset = it.asset_id ? _state.resAssets.get(it.asset_id) : null;
    if (!asset) {
      alert('This resource has no attached file.');
      return;
    }
    if (k === 'pdf') {
      const { data, error } = await sb.storage.from('course-assets').createSignedUrl(asset.storage_path, 600);
      if (error) { alert('Could not open PDF: ' + error.message); return; }
      $('pdfOverlayTitle').textContent = it.title || asset.filename || 'Document';
      $('pdfOverlayObject').setAttribute('data', data.signedUrl);
      $('pdfOverlayDownload').setAttribute('href', data.signedUrl);
      $('pdfOverlay').classList.add('is-open');
      return;
    }
    if (k === 'docx') {
      const { data, error } = await sb.storage.from('course-assets').createSignedUrl(asset.storage_path, 600);
      if (error) { alert('Could not download: ' + error.message); return; }
      const a = document.createElement('a');
      a.href = data.signedUrl;
      a.download = asset.filename || 'document.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    // Fallback
    if (it.url) window.open(it.url, '_blank', 'noopener,noreferrer');
  }
  $('htmlOverlayClose').addEventListener('click', () => $('htmlOverlay').classList.remove('is-open'));
  $('htmlOverlay').addEventListener('click', (e) => { if (e.target === $('htmlOverlay')) $('htmlOverlay').classList.remove('is-open'); });
  $('pdfOverlayClose').addEventListener('click', () => {
    $('pdfOverlay').classList.remove('is-open');
    $('pdfOverlayObject').setAttribute('data', '');
  });
  $('pdfOverlay').addEventListener('click', (e) => { if (e.target === $('pdfOverlay')) { $('pdfOverlay').classList.remove('is-open'); $('pdfOverlayObject').setAttribute('data', ''); } });

  // ---------- 7. Certifications ----------
  async function renderCertificates() {
    const host = $('certificatesCard');
    const { data: certs, error } = await sb.from('certificates')
      .select('id, course_id, full_name, issued_at, cert_hash')
      .eq('user_id', _state.user.id)
      .order('issued_at', { ascending: false });
    if (error) throw error;

    if (!certs || !certs.length) {
      emptyBox(host, 'Certifications', 'Earn your first certificate by completing a course.');
      return;
    }
    host.innerHTML = `
      <h2>Certifications <span class="h2-sub">${certs.length} earned</span></h2>
      <div class="cert-grid">
        ${certs.map(c => `
          <article class="cert">
            <div class="cert-name">${escapeHtml(c.course_id)}</div>
            <div class="cert-when">Issued ${escapeHtml(fmtDate(c.issued_at))} · for ${escapeHtml(c.full_name || '—')}</div>
            <div class="cert-id">ID ${escapeHtml(c.cert_hash || c.id)}</div>
            <div class="cert-actions">
              <a class="btn primary" href="/verify/${encodeURIComponent(c.cert_hash || '')}" target="_blank" rel="noopener">Verify</a>
              <button type="button" class="btn ghost" data-print="${escapeHtml(c.id)}">Print</button>
            </div>
          </article>`).join('')}
      </div>
    `;
    host.querySelectorAll('button[data-print]').forEach(b => {
      b.addEventListener('click', () => printCert(b.getAttribute('data-print'), certs));
    });
  }
  function printCert(id, certs) {
    const c = certs.find(x => x.id === id);
    if (!c) return;
    $('paName').textContent = c.full_name || '';
    $('paCourse').textContent = c.course_id || '';
    $('paId').textContent = 'ID ' + (c.cert_hash || c.id);
    $('paDate').textContent = fmtDate(c.issued_at);
    window.print();
  }

  // ---------- boot ----------
  gateOrRender().catch(err => {
    console.error('[dashboard] boot failed', err);
    $('loadStrip').classList.add('is-done');
    $('signInGate').hidden = false;
    $('gateMsg').className = 'overlay-msg is-err';
    $('gateMsg').textContent = 'Dashboard failed to load: ' + (err.message || err);
  });
})();
