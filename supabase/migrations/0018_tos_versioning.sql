-- ============================================================================
-- 0018_tos_versioning.sql, future-proofing for "agree once unless the ToS
-- changes". Adds two nullable text columns:
--
--   public.courses.tos_version
--     The currently published ToS version label for this course (e.g.
--     "2026-05-13" or "v2"). NULL means "no version stamp", which is
--     equivalent to "any prior acceptance is still good".
--
--   public.course_tos_acceptances.accepted_tos_version
--     The ToS version label captured at the moment the user accepted.
--     NULL on rows written before this migration. Treated as "matches" when
--     courses.tos_version is also NULL.
--
-- Until a course author bumps tos_version, hasAcceptedTos() in the player
-- continues to behave exactly as before. Existing acceptance rows are not
-- migrated or touched. This is intentional: rolling out the column should
-- be a no-op for current learners.
--
-- The actual "re-gate when version changes" comparison happens client-side
-- in public/course.html, so this migration is pure schema. No data backfill.
-- 2026-05-13
-- ============================================================================

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS tos_version text;

ALTER TABLE public.course_tos_acceptances
  ADD COLUMN IF NOT EXISTS accepted_tos_version text;

COMMENT ON COLUMN public.courses.tos_version IS
  'Optional ToS version label. When non-NULL, learners whose accepted_tos_version differs (or is NULL) will be re-prompted to accept. NULL disables version-based re-prompting.';

COMMENT ON COLUMN public.course_tos_acceptances.accepted_tos_version IS
  'Snapshot of courses.tos_version at the moment of acceptance. NULL for rows written before migration 0018.';
