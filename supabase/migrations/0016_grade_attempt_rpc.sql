-- ============================================================================
-- 0016_grade_attempt_rpc.sql
-- 2026-05-07
--
-- Server-side quiz grading for the new authoring schema (course_versions /
-- module_quiz_questions / final_exam_questions). Companion to migration 0010.
--
-- The legacy v1 LMS (`course_data.json` keyed by lesson_id text) is graded
-- by a separate Express route on the Fly server (server-side too; reads the
-- ground-truth JSON privately and never ships answer keys to the browser).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.grade_attempt(p_course_version_id uuid, p_answers jsonb, p_kind text)
--
-- p_answers shape: {"<question_id>": <selected_index_int>, ...}
-- p_kind:          'module_quiz' | 'final_exam'
--                  'module_quiz' grades against module_quiz_questions for any
--                  module of the version; 'final_exam' against final_exam_questions.
--
-- Returns jsonb { score, total, passed, wrong_qids, threshold }
--
-- Side effect: inserts a quiz_attempts row whose lesson_id is a synthetic
-- string ("v:<course_version_id>:<kind>") so the existing audit trail keeps
-- working without a schema change.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.grade_attempt(
  p_course_version_id uuid,
  p_answers           jsonb,
  p_kind              text DEFAULT 'final_exam'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_threshold   int;
  v_total       int  := 0;
  v_correct     int  := 0;
  v_wrong       uuid[] := ARRAY[]::uuid[];
  v_score_pct   int  := 0;
  v_passed      bool := false;
  v_lesson_key  text;
  v_attempt_no  int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  IF p_course_version_id IS NULL THEN
    RAISE EXCEPTION 'course_version_id required';
  END IF;

  IF p_kind NOT IN ('module_quiz','final_exam') THEN
    RAISE EXCEPTION 'invalid kind (expected module_quiz|final_exam)';
  END IF;

  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' THEN
    RAISE EXCEPTION 'answers must be a jsonb object';
  END IF;

  -- Look up pass_threshold from the course (via course_versions)
  SELECT c.pass_threshold INTO v_threshold
    FROM public.course_versions cv
    JOIN public.courses c ON c.id = cv.course_id
   WHERE cv.id = p_course_version_id;

  IF v_threshold IS NULL THEN
    RAISE EXCEPTION 'course_version not found';
  END IF;

  IF p_kind = 'final_exam' THEN
    SELECT
      count(*),
      count(*) FILTER (WHERE (p_answers ->> q.id::text)::int IS NOT DISTINCT FROM q.answer_index),
      coalesce(
        array_agg(q.id) FILTER (
          WHERE (p_answers ->> q.id::text) IS NULL
             OR (p_answers ->> q.id::text)::int IS DISTINCT FROM q.answer_index
        ),
        ARRAY[]::uuid[]
      )
    INTO v_total, v_correct, v_wrong
    FROM public.final_exam_questions q
    WHERE q.course_version_id = p_course_version_id;
  ELSE
    SELECT
      count(*),
      count(*) FILTER (WHERE (p_answers ->> q.id::text)::int IS NOT DISTINCT FROM q.answer_index),
      coalesce(
        array_agg(q.id) FILTER (
          WHERE (p_answers ->> q.id::text) IS NULL
             OR (p_answers ->> q.id::text)::int IS DISTINCT FROM q.answer_index
        ),
        ARRAY[]::uuid[]
      )
    INTO v_total, v_correct, v_wrong
    FROM public.module_quiz_questions q
    JOIN public.modules m ON m.id = q.module_id
    WHERE m.course_version_id = p_course_version_id;
  END IF;

  IF v_total = 0 THEN
    RAISE EXCEPTION 'no questions found for this version/kind';
  END IF;

  v_score_pct := round((v_correct::numeric / v_total::numeric) * 100)::int;
  v_passed    := v_score_pct >= v_threshold;

  -- Persist attempt (append-only audit). lesson_id is a synthetic key so the
  -- existing quiz_attempts table needs no schema change.
  v_lesson_key := 'v:' || p_course_version_id::text || ':' || p_kind;

  SELECT coalesce(max(attempt_no), 0) + 1
    INTO v_attempt_no
    FROM public.quiz_attempts
   WHERE user_id = v_user_id AND lesson_id = v_lesson_key;

  INSERT INTO public.quiz_attempts (user_id, lesson_id, attempt_no, score, passed, answers)
  VALUES (v_user_id, v_lesson_key, v_attempt_no, v_score_pct, v_passed, p_answers);

  RETURN jsonb_build_object(
    'score',      v_score_pct,
    'total',      v_total,
    'correct',    v_correct,
    'passed',     v_passed,
    'threshold',  v_threshold,
    'attempt_no', v_attempt_no,
    'wrong_qids', to_jsonb(v_wrong)
  );
END;
$$;

-- Lock down: only authenticated callers (the function itself enforces auth.uid()).
REVOKE EXECUTE ON FUNCTION public.grade_attempt(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.grade_attempt(uuid, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.grade_attempt(uuid, jsonb, text) IS
  'Server-side quiz/exam grading for the new authoring schema. Loads keys
   from module_quiz_questions / final_exam_questions, compares against the
   submitted answers map, writes a quiz_attempts row, and returns
   {score,total,correct,passed,threshold,attempt_no,wrong_qids}.
   SECURITY DEFINER + auth.uid() gate. Migration 0016.';
