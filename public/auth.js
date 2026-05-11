// =====================================================================
// auth.js — Supabase auth + progress sync for Deconflict
// Replaces the localStorage-based progress layer in course.html.
// Exposes:
//   window.authReady       — Promise that resolves when auth state is known
//   window.currentUser()   — returns Supabase user or null
//   window.signOut()       — signs out and reloads
//   window.loadProgress()  — async, returns the same shape as before
//   window.saveLessonProgress(lessonId, viewedPages, complete)
//   window.saveQuizAttempt(lessonId, score, passed, answers)
//   window.markCourseComplete(finalScore)
// =====================================================================

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Project Supabase Auth emits #access_token=... fragments rather than
    // ?code=... query params, so pin the flow type to match. Without this
    // the v2 client occasionally fails to parse the hash and never persists
    // the session to localStorage on first load (see v0.4.37 bug report).
    flowType: 'implicit'
  }
});
// Shared client for other scripts on the same page (e.g. appendix loader).
window.supabaseClient = sb;

let _user = null;
const _onSignInCbs = [];
// Subscribe to the user's null → signed-in transition. Multiple callbacks
// supported. Each is fired once per transition with the new user object.
// Useful for SPA-ish pages (dashboard.html) that hydrate before the
// magic-link hash is finished parsing.
window.onSignedIn = (cb) => { if (typeof cb === 'function') _onSignInCbs.push(cb); };

// Post-sign-in redirect: send users from generic landing pages into their
// dashboard. Only fires on transitions to a signed-in state, and only on
// the bare landing paths so existing /course.html, /admin*, /studio* flows
// stay put. Skips if the URL already targets a dashboard.
//
// Mirrors server.js RESERVED — any first path segment listed here is NOT a
// tenant slug and must not be rewritten to /{seg}/dashboard. Bug from
// v0.4.57: /admin was matching the slug regex and redirecting super-admins
// to /admin/dashboard (a non-existent tenant), rendering a blank dashboard.
const RESERVED_TOP_LEVEL = [
  'admin', 'studio', 'dashboard', 'api', 'auth', 'preview', 'verify',
  'courses', 'health', 'healthz', 'login', 'logout', 'signin', 'signup',
  'signout', 'assets', 'terms', 'privacy',
  'config.js', 'auth.js', 'tenant.js', 'dashboard.js', 'studio.js',
  'admin-nav.js', 'admin-welcome.js',
  'course.html', 'admin.html', 'index.html', 'courses.html',
  'admin-requests.html', 'studio.html', 'dashboard.html', 'verify.html',
  'studio.css', 'tenant-themes.css', 'brand-header.css', 'style.css',
  'course_data.json',
  'favicon.ico', 'robots.txt', 'sitemap.xml',
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'
];
function _postSignInRedirect() {
  const path = window.location.pathname;
  if (/\/dashboard\/?$/.test(path)) return;
  if (path === '/') {
    window.location.replace('/dashboard');
    return;
  }
  // Don't treat reserved top-level routes as tenant slugs.
  const firstSeg = (path.split('/').filter(Boolean)[0] || '').toLowerCase();
  if (RESERVED_TOP_LEVEL.indexOf(firstSeg) !== -1) return;
  // Tenant landing root: /{slug}/ (no further segments)
  const m = path.match(/^\/([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))\/?$/i);
  if (m) {
    window.location.replace('/' + m[1].toLowerCase() + '/dashboard');
  }
}

window.authReady = (async () => {
  // Strip token fragments from the URL eagerly. detectSessionInUrl has
  // already kicked off parsing by the time this script runs, so the hash
  // is just visual noise that makes a hard refresh re-attempt parsing a
  // consumed token.
  function _cleanAuthHash() {
    try {
      const hash = window.location.hash || '';
      if (/(?:^|#|&)(access_token|refresh_token|type|expires_in)=/.test(hash)) {
        const cleanUrl = window.location.origin + window.location.pathname + window.location.search;
        window.history.replaceState({}, '', cleanUrl);
      }
    } catch (_e) { /* noop */ }
  }

  // Register the auth-state listener FIRST so we never miss INITIAL_SESSION
  // (fires once detectSessionInUrl finishes parsing the hash).
  let _initialSessionResolved = false;
  let _resolveInitial = null;
  const _initialSessionPromise = new Promise((resolve) => { _resolveInitial = resolve; });
  sb.auth.onAuthStateChange((event, session) => {
    const wasNull = !_user;
    _user = session?.user || null;
    try {
      const exp = session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : 'none';
      if (event === 'TOKEN_REFRESHED') console.log('[auth] TOKEN_REFRESHED exp=' + exp);
      else if (event === 'SIGNED_OUT')  console.log('[auth] SIGNED_OUT');
      else if (event === 'SIGNED_IN')   console.log('[auth] SIGNED_IN exp=' + exp);
      else if (event === 'INITIAL_SESSION') console.log('[auth] INITIAL_SESSION ' + (session ? 'exp=' + exp : '(no session)'));
      else if (event === 'USER_UPDATED') console.log('[auth] USER_UPDATED');
      else console.log('[auth] event=' + event);
    } catch (_e) { /* noop */ }
    if (event === 'INITIAL_SESSION') {
      _initialSessionResolved = true;
      _cleanAuthHash();
      if (_resolveInitial) _resolveInitial();
    }
    if (wasNull && _user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
      _cleanAuthHash();
      try { _postSignInRedirect(); } catch (_e) { /* noop */ }
      _onSignInCbs.forEach(cb => { try { cb(_user); } catch (err) { console.warn('onSignedIn cb failed:', err); } });
    }
  });

  // Always ask for the current session — covers the no-hash case where
  // INITIAL_SESSION may fire before our listener if the SDK is fast.
  const { data } = await sb.auth.getSession();
  _user = data.session?.user || _user;

  // If the URL has a magic-link hash but our session is still null, wait
  // briefly for INITIAL_SESSION to land. Cap the wait so a malformed hash
  // doesn't block forever.
  const hashHasToken = /(?:^|#|&)(access_token|refresh_token)=/.test(window.location.hash || '');
  if (hashHasToken && !_user && !_initialSessionResolved) {
    await Promise.race([
      _initialSessionPromise,
      new Promise(r => setTimeout(r, 1500))
    ]);
  }

  // Final hash cleanup regardless of whether _user landed — leaving the
  // token in the address bar is always wrong by this point.
  _cleanAuthHash();

  // Phase 3: detect a gating rejection from handle_new_user (insufficient_privilege)
  try {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search);
    const errDesc = params.get('error_description') || params.get('error');
    if (errDesc && /approval|invitation|insufficient_privilege/i.test(errDesc)) {
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
      window._gatingRejection = decodeURIComponent(errDesc.replace(/\+/g, ' '));
    }
  } catch (_e) { /* noop */ }
})();

window.currentUser = () => _user;

window.signOut = async () => {
  try { await sb.auth.signOut(); } catch (_e) { /* noop */ }
  // Belt-and-braces: even if signOut errored or no-op'd, drop the persisted
  // token from localStorage so a reload starts logged-out.
  try {
    const u = (window.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0];
    if (u) localStorage.removeItem('sb-' + u + '-auth-token');
  } catch (_e) { /* noop */ }
  window.location.href = '/';
};

window.signInWithEmail = async (email) => {
  const redirect = window.location.origin + window.location.pathname;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect }
  });
  if (error) throw error;
};

// =====================================================================
// PROGRESS LAYER — same shape the old course.html expected.
// {
//   "<lesson_id>": { viewedPages: [int], complete: bool },
//   "<lesson_id>:quiz": { score: 0..1, passed: bool, when: ms }
// }
// =====================================================================
window.loadProgress = async () => {
  if (!_user) return {};
  const [lessons, quizzes] = await Promise.all([
    sb.from('lesson_progress').select('lesson_id, viewed_pages, complete').eq('user_id', _user.id),
    sb.from('quiz_attempts').select('lesson_id, score, passed, attempt_no, submitted_at')
       .eq('user_id', _user.id).order('attempt_no', { ascending: false })
  ]);

  const out = {};
  for (const r of (lessons.data || [])) {
    out[r.lesson_id] = { viewedPages: r.viewed_pages || [], complete: !!r.complete };
  }
  // Take the latest attempt per lesson
  const seen = new Set();
  for (const a of (quizzes.data || [])) {
    if (seen.has(a.lesson_id)) continue;
    seen.add(a.lesson_id);
    out[a.lesson_id + ':quiz'] = {
      score: (a.score || 0) / 100,
      passed: !!a.passed,
      when: new Date(a.submitted_at).getTime()
    };
  }
  return out;
};

// Debounced lesson-progress writer — avoid hammering the API on every page tick
const _pendingLessonWrites = new Map();
let _flushTimer = null;
function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(async () => {
    _flushTimer = null;
    const rows = Array.from(_pendingLessonWrites.values());
    _pendingLessonWrites.clear();
    if (!rows.length || !_user) return;
    await sb.from('lesson_progress').upsert(rows, { onConflict: 'user_id,lesson_id' });
  }, 600);
}

window.saveLessonProgress = (lessonId, viewedPages, complete) => {
  if (!_user) return;
  _pendingLessonWrites.set(lessonId, {
    user_id: _user.id,
    lesson_id: lessonId,
    viewed_pages: viewedPages,
    complete: !!complete,
    last_viewed_at: new Date().toISOString()
  });
  _scheduleFlush();
};

window.saveQuizAttempt = async (lessonId, score, passed, answers) => {
  if (!_user) return;
  // Get next attempt_no
  const { data: prev } = await sb.from('quiz_attempts')
    .select('attempt_no').eq('user_id', _user.id).eq('lesson_id', lessonId)
    .order('attempt_no', { ascending: false }).limit(1);
  const attemptNo = (prev?.[0]?.attempt_no || 0) + 1;
  await sb.from('quiz_attempts').insert({
    user_id: _user.id,
    lesson_id: lessonId,
    attempt_no: attemptNo,
    score: Math.round(score * 100),
    passed: !!passed,
    answers
  });
};

// markCourseComplete:
//   1. marks enrollment completed
//   2. invokes the issue-certificate Edge Function to generate the PDF
//      (uses the recipient's full_name from their profile as the cert subject)
//   3. returns { cert_hash, pdf_url, verify_url, name, issued_at }  or null on failure
window.markCourseComplete = async (finalScore) => {
  if (!_user) return null;
  const score100 = Math.round((finalScore || 0) * 100);

  await sb.from('enrollments')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('user_id', _user.id).eq('course_id', window.COURSE_ID);

  // Pull the recipient name from their profile.
  const { data: profile } = await sb.from('profiles')
    .select('full_name').eq('id', _user.id).single();
  const fullName = (profile?.full_name || '').trim();
  if (!fullName) {
    console.warn('[cert] no full_name on profile; skipping certificate issue');
    return null;
  }

  // Invoke the Edge Function. Supabase JS attaches the user's JWT automatically.
  const { data: cert, error } = await sb.functions.invoke('issue-certificate', {
    body: { full_name: fullName, course_id: window.COURSE_ID, score: score100 }
  });
  if (error) {
    console.error('[cert] issue failed', error);
    return null;
  }
  return cert;
};

window.updateProfile = async (patch) => {
  if (!_user) throw new Error('not signed in');
  // Select the row back so callers can verify the write actually landed
  // (RLS denial / schema mismatch would otherwise no-op silently).
  const { data, error } = await sb.from('profiles')
    .update(patch).eq('id', _user.id).select('*').single();
  if (error) throw error;
  return data;
};

window.getProfile = async () => {
  // If a magic-link hash is present, the session may not yet be hydrated by
  // the time boot() awaits authReady. Give it one short retry so the gate
  // check doesn't see a null user and flash the completion modal.
  if (!_user) {
    const { data } = await sb.auth.getSession();
    _user = data.session?.user || _user;
  }
  if (!_user) return null;
  const { data, error } = await sb.from('profiles').select('*').eq('id', _user.id).single();
  if (error) {
    console.warn('[profile] read failed', error);
    return null;
  }
  return data;
};

// Returns true iff the profile row has the fields the completion modal asks
// for. This is the CANONICAL completeness check — checking actual field
// presence (not a metadata flag) means existing complete users never get
// trapped by an empty metadata blob.
window.profileIsComplete = (profile) => {
  if (!profile) return false;
  if (profile.metadata && profile.metadata.profile_completed_at) return true;
  return !!(
    (profile.full_name   || '').trim() &&
    (profile.agency_name || '').trim()
  );
};
