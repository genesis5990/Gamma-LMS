-- 0038_module_library_archived_and_versions.sql
--
-- v0.6.1 picker improvements.
--
-- Changes from 0037:
--   1. list_pickable_modules() now returns rows from archived courses (the
--      c.archived_at IS NULL filter is dropped). Soft-deleted courses
--      (c.deleted_at IS NOT NULL) remain excluded.
--   2. Adds two new RETURNS TABLE columns: course_archived_at and
--      course_deleted_at. The UI uses course_archived_at to render an
--      "(archived)" tag on the course group and to gate visibility behind
--      the "Include archived courses" checkbox. course_deleted_at is
--      always NULL in the result (we still filter soft-deletes out) but
--      surfacing the column keeps future-proofs the contract.
--   3. ORDER BY flipped to put the newest version of each course first
--      within its group: c.title ASC, cv.version_number DESC, m.position ASC.
--      Combined with is_current_version on each row, the UI can naturally
--      keep "current" floating to the top and collapse older versions
--      under a per-course expander.
--
-- All other behavior preserved: SECURITY DEFINER, search_path = public,
-- super_admin sees everything, course authors see their tenant's courses
-- via is_course_author() + current_tenant_id().

CREATE OR REPLACE FUNCTION public.list_pickable_modules()
RETURNS TABLE (
  module_id            uuid,
  module_slug          text,
  module_title         text,
  module_description   text,
  module_position      integer,
  has_knowledge_check  boolean,
  hero_image_url       text,
  course_id            uuid,
  course_slug          text,
  course_title         text,
  course_visibility    text,
  course_archived_at   timestamptz,
  course_deleted_at    timestamptz,
  course_version_id    uuid,
  course_version_number integer,
  course_version_status text,
  is_current_version   boolean,
  lesson_count         integer,
  page_count           integer,
  ready_page_count     integer,
  appendix_item_count  integer,
  quiz_question_count  integer,
  updated_at           timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH allowed AS (
    SELECT c.id AS course_id, c.tenant_id
    FROM public.courses c
    WHERE c.deleted_at IS NULL
      AND (
        public.is_super_admin()
        OR (
          c.tenant_id IS NOT DISTINCT FROM public.current_tenant_id()
          AND public.is_course_author()
        )
      )
  ),
  page_stats AS (
    SELECT
      l.module_id,
      count(p.id)::int AS page_count,
      count(*) FILTER (WHERE p.workflow_status = 'ready')::int AS ready_page_count
    FROM public.lessons l
    LEFT JOIN public.pages p ON p.lesson_id = l.id
    GROUP BY l.module_id
  ),
  lesson_stats AS (
    SELECT module_id, count(*)::int AS lesson_count
    FROM public.lessons
    GROUP BY module_id
  ),
  appendix_stats AS (
    SELECT module_id, count(*)::int AS appendix_item_count
    FROM public.module_appendix_items
    GROUP BY module_id
  ),
  quiz_stats AS (
    SELECT module_id, count(*)::int AS quiz_question_count
    FROM public.module_quiz_questions
    GROUP BY module_id
  )
  SELECT
    m.id, m.slug, m.title, m.description, m.position,
    m.has_knowledge_check, m.hero_image_url,
    c.id, c.slug, c.title, c.visibility,
    c.archived_at, c.deleted_at,
    cv.id, cv.version_number, cv.status,
    (cv.id = c.current_version_id),
    COALESCE(ls.lesson_count, 0),
    COALESCE(ps.page_count, 0),
    COALESCE(ps.ready_page_count, 0),
    COALESCE(aps.appendix_item_count, 0),
    COALESCE(qs.quiz_question_count, 0),
    m.updated_at
  FROM public.modules m
  JOIN public.course_versions cv ON cv.id = m.course_version_id
  JOIN public.courses c          ON c.id = cv.course_id
  JOIN allowed a                 ON a.course_id = c.id
  LEFT JOIN lesson_stats   ls  ON ls.module_id = m.id
  LEFT JOIN page_stats     ps  ON ps.module_id = m.id
  LEFT JOIN appendix_stats aps ON aps.module_id = m.id
  LEFT JOIN quiz_stats     qs  ON qs.module_id = m.id
  ORDER BY c.title ASC, cv.version_number DESC, m.position ASC;
$$;

REVOKE ALL ON FUNCTION public.list_pickable_modules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_pickable_modules() TO authenticated;
