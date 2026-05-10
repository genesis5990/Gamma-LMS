-- ============================================================================
-- 0025_quiz_answer_index_lockdown.sql — SOC 2 F-11 fix
-- 2026-05-10
--
-- Defense-in-depth lockdown of correct-answer exposure on quiz tables.
--
-- Background
--   Migration 0020 added *_published_read SELECT policies on
--   module_quiz_questions and final_exam_questions so authenticated learners
--   can render quizzes via the Supabase REST API. Those policies grant SELECT
--   on every column, including answer_index. The learner code in
--   public/course.html avoids selecting answer_index in its projection, but
--   any authenticated user can hit
--     GET /rest/v1/module_quiz_questions?select=*
--   directly with their own JWT and read every correct answer.
--
-- Fix (column-level revoke + author RPC)
--   1. REVOKE SELECT(answer_index) from anon and authenticated on both quiz
--      tables. Postgres column privileges are role-wide and cannot be
--      conditioned by RLS, so this affects authors too.
--   2. Re-GRANT SELECT on the remaining columns explicitly so PostgREST keeps
--      serving the question / options / reference fields.
--   3. service_role keeps full access (it is BYPASSRLS and not affected by
--      column REVOKEs targeted at anon/authenticated). Verified: SECURITY
--      DEFINER functions owned by postgres (e.g. public.grade_attempt from
--      0016) read answer_index as their owner, so server-side grading is
--      unchanged.
--   4. Provide two SECURITY DEFINER RPCs that authors call from studio.js to
--      fetch question rows including answer_index. Each RPC enforces
--      is_course_author() (or is_super_admin()) and raises otherwise.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Revoke and re-grant column SELECT on module_quiz_questions
-- ---------------------------------------------------------------------------
REVOKE SELECT (answer_index) ON public.module_quiz_questions FROM anon, authenticated;

-- Re-grant SELECT on every other column so PostgREST keeps returning
-- questions/options/reference for the learner course player.
GRANT SELECT (id, module_id, position, question, options, reference, created_at, updated_at)
  ON public.module_quiz_questions TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Revoke and re-grant column SELECT on final_exam_questions
-- ---------------------------------------------------------------------------
REVOKE SELECT (answer_index) ON public.final_exam_questions FROM anon, authenticated;

GRANT SELECT (id, course_version_id, position, question, options, reference, source_module_slug, created_at, updated_at)
  ON public.final_exam_questions TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Author-side RPCs
--   SECURITY DEFINER + is_course_author() gate. These run as the function
--   owner (postgres) so the answer_index REVOKE above does not block them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.author_list_module_questions(p_module_id uuid)
RETURNS SETOF public.module_quiz_questions
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT (public.is_course_author() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'permission denied: course author role required';
  END IF;

  RETURN QUERY
    SELECT *
      FROM public.module_quiz_questions
     WHERE (p_module_id IS NULL OR module_id = p_module_id)
     ORDER BY position;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.author_list_module_questions(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.author_list_module_questions(uuid) TO authenticated;

COMMENT ON FUNCTION public.author_list_module_questions(uuid) IS
  'Author-only fetch of module_quiz_questions including answer_index.
   Pass NULL for p_module_id to fetch every module the caller can author.
   SECURITY DEFINER — bypasses the column-level REVOKE in 0025.
   Authorisation: is_course_author() OR is_super_admin().';


CREATE OR REPLACE FUNCTION public.author_list_final_questions(p_course_version_id uuid)
RETURNS SETOF public.final_exam_questions
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT (public.is_course_author() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'permission denied: course author role required';
  END IF;

  RETURN QUERY
    SELECT *
      FROM public.final_exam_questions
     WHERE (p_course_version_id IS NULL OR course_version_id = p_course_version_id)
     ORDER BY position;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.author_list_final_questions(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.author_list_final_questions(uuid) TO authenticated;

COMMENT ON FUNCTION public.author_list_final_questions(uuid) IS
  'Author-only fetch of final_exam_questions including answer_index.
   Pass NULL for p_course_version_id to fetch every version the caller can author.
   SECURITY DEFINER — bypasses the column-level REVOKE in 0025.
   Authorisation: is_course_author() OR is_super_admin().';
