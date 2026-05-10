-- ============================================================================
-- 0026_quiz_answer_index_lockdown_fix.sql — SOC 2 F-11 follow-up
-- 2026-05-10
--
-- 0025 attempted to revoke SELECT(answer_index) at the column level, but
-- Supabase auto-applies a table-level GRANT SELECT to anon/authenticated on
-- every public table (via 'GRANT ALL ON ALL TABLES IN SCHEMA public ...').
-- In Postgres, table-level privileges trump column REVOKE, so the leak
-- remained open after 0025 ran.
--
-- This migration:
--   1. REVOKEs table-level SELECT/INSERT/UPDATE from anon/authenticated on
--      both quiz tables (DELETE was already implicit via RLS; we keep TRIGGER
--      etc. unchanged).
--   2. Re-GRANTs SELECT only on the safe columns (everything except
--      answer_index).
--   3. Re-GRANTs INSERT/UPDATE on the columns authors need to write,
--      including answer_index (RLS still gates by role).
--
-- After this migration, a learner JWT calling
--   GET /rest/v1/module_quiz_questions?select=*
-- receives 'permission denied for table module_quiz_questions' instead of
-- the row payload. Authors continue to read answer_index via the
-- author_list_*_questions SECURITY DEFINER RPCs added in 0025. Server-side
-- grading via grade_attempt is unaffected (also SECURITY DEFINER, owner postgres).
-- ============================================================================

-- ===== module_quiz_questions =====
REVOKE SELECT, INSERT, UPDATE ON public.module_quiz_questions FROM anon, authenticated;

GRANT SELECT (id, module_id, position, question, options, reference, created_at, updated_at)
  ON public.module_quiz_questions TO anon, authenticated;

-- Author writes still flow through RLS-checked policies; grant on safe + answer_index columns
GRANT INSERT (id, module_id, position, question, options, reference, answer_index)
  ON public.module_quiz_questions TO authenticated;
GRANT UPDATE (position, question, options, reference, answer_index, updated_at)
  ON public.module_quiz_questions TO authenticated;

-- ===== final_exam_questions =====
REVOKE SELECT, INSERT, UPDATE ON public.final_exam_questions FROM anon, authenticated;

GRANT SELECT (id, course_version_id, position, question, options, reference, source_module_slug, created_at, updated_at)
  ON public.final_exam_questions TO anon, authenticated;

GRANT INSERT (id, course_version_id, position, question, options, reference, source_module_slug, answer_index)
  ON public.final_exam_questions TO authenticated;
GRANT UPDATE (position, question, options, reference, source_module_slug, answer_index, updated_at)
  ON public.final_exam_questions TO authenticated;
