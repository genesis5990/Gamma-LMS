-- 0030_course_soft_delete.sql
-- Course lifecycle: archive -> soft delete -> hard delete.
--
-- Adds two timestamp columns on public.courses (archived_at, deleted_at) and
-- four super_admin-only RPCs that progress a course through the lifecycle:
--   archive_course      -> sets archived_at
--   unarchive_course    -> clears archived_at
--   soft_delete_course  -> sets deleted_at (requires archived first)
--   hard_delete_course  -> physical delete (requires soft-deleted first)
--
-- hard_delete_course relies on existing ON DELETE CASCADE chains
-- (course_versions, modules, lessons, pages, final_exam_questions,
-- course_assets, course_tos_acceptances all cascade from courses.id).
-- enrollments and quiz_attempts reference course_id as TEXT (slug), so they
-- are cleaned up explicitly by slug.

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ NULL;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_courses_deleted_at
  ON public.courses (deleted_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- archive_course
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_course(p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.courses%ROWTYPE;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_row FROM public.courses WHERE id = p_course_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Course not found';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Course is soft-deleted; cannot archive';
  END IF;

  UPDATE public.courses
     SET archived_at = now()
   WHERE id = p_course_id;

  RETURN jsonb_build_object('ok', true, 'course_id', p_course_id, 'archived_at', now());
END
$$;

-- ---------------------------------------------------------------------
-- unarchive_course
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unarchive_course(p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.courses%ROWTYPE;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_row FROM public.courses WHERE id = p_course_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Course not found';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Course is soft-deleted; restore via hard_delete reversal is not supported';
  END IF;

  UPDATE public.courses
     SET archived_at = NULL
   WHERE id = p_course_id;

  RETURN jsonb_build_object('ok', true, 'course_id', p_course_id);
END
$$;

-- ---------------------------------------------------------------------
-- soft_delete_course (requires archived_at IS NOT NULL)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.soft_delete_course(p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.courses%ROWTYPE;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_row FROM public.courses WHERE id = p_course_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Course not found';
  END IF;
  IF v_row.archived_at IS NULL THEN
    RAISE EXCEPTION 'Course must be archived before soft-delete';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Course is already soft-deleted';
  END IF;

  UPDATE public.courses
     SET deleted_at = now()
   WHERE id = p_course_id;

  RETURN jsonb_build_object('ok', true, 'course_id', p_course_id, 'deleted_at', now());
END
$$;

-- ---------------------------------------------------------------------
-- hard_delete_course (requires deleted_at IS NOT NULL)
-- Single transaction; explicit slug-keyed cleanup for enrollments and
-- quiz_attempts, then DELETE on courses lets ON DELETE CASCADE handle
-- course_versions -> modules -> lessons -> pages -> final_exam_questions,
-- as well as course_assets and course_tos_acceptances.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hard_delete_course(p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     public.courses%ROWTYPE;
  v_slug    text;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_row FROM public.courses WHERE id = p_course_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Course not found';
  END IF;
  IF v_row.deleted_at IS NULL THEN
    RAISE EXCEPTION 'Course must be soft-deleted before permanent delete';
  END IF;

  v_slug := v_row.slug;

  -- Slug-keyed legacy tables (course_id is TEXT, not FK).
  DELETE FROM public.quiz_attempts WHERE course_id = v_slug;
  DELETE FROM public.enrollments   WHERE course_id = v_slug;

  -- Final delete; CASCADE cleans the rest.
  DELETE FROM public.courses WHERE id = p_course_id;

  RETURN jsonb_build_object('ok', true, 'course_id', p_course_id, 'slug', v_slug);
END
$$;

GRANT EXECUTE ON FUNCTION public.archive_course(uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.unarchive_course(uuid)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_course(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.hard_delete_course(uuid)  TO authenticated;
