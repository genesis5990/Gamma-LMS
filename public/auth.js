// =====================================================================
// auth.js — Supabase auth + progress sync for Crypto 101
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
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

let _user = null;

window.authReady = (async () => {
  // Handle magic-link callback (?code=... or #access_token=...)
  const { data } = await sb.auth.getSession();
  _user = data.session?.user || null;

  sb.auth.onAuthStateChange((_event, session) => {
    _user = session?.user || null;
  });

  // Phase 3: detect a gating rejection from handle_new_user (insufficient_privilege)
  // Supabase surfaces it as ?error=...&error_description=... in the URL after the redirect.
  try {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search);
    const errDesc = params.get('error_description') || params.get('error');
    if (errDesc && /approval|invitation|insufficient_privilege/i.test(errDesc)) {
      // Clear the error from the URL
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
      window._gatingRejection = decodeURIComponent(errDesc.replace(/\+/g, ' '));
    }
  } catch { /* noop */ }
})();

window.currentUser = () => _user;

window.signOut = async () => {
  await sb.auth.signOut();
  window.location.reload();
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
