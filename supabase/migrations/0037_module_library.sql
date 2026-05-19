-- 0037_module_library.sql
-- Module Library v1: pick a module from any course in the same tenant,
-- clone it into a target course version, or create a brand new course
-- composed from a list of cloned modules.
--
-- Hard copy semantics: clones are fully independent. Lessons, pages,
-- module appendix items, and module quiz questions are all duplicated.
-- Audio URLs (audio_url, audio_voice, audio_generated_at) are preserved
-- since storage assets are public and shared by URL. Workflow statuses
-- on lessons and pages are preserved so a "ready" module clones in as
-- "ready" without re-review needed.
--
-- AuthZ: super_admin OR is_course_author() in the same tenant as both
-- the source module and target course version. Cross-tenant cloning is
-- not allowed. Tenant comparison uses IS DISTINCT FROM so a NULL=NULL
-- match (the current single-tenant data shape) passes.
--
-- Functions:
--   list_pickable_modules()                          -- picker feed
--   clone_module_into_version(p_source_module_id,
--                             p_target_course_version_id,
--                             p_position)           -> new module id
--   create_course_from_modules(p_title, p_slug,
--                              p_description,
--                              p_module_ids)        -> new course id
--
-- Audit:
--   module_clones (source_module_id, target_module_id,
--                  target_course_version_id, cloned_by, cloned_at)

-- ===========================================================================
-- Audit table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.module_clones (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_module_id         uuid        NOT NULL,
  target_module_id         uuid        NOT NULL,
  target_course_version_id uuid        NOT NULL,
  cloned_by                uuid,
  cloned_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_clones_target_module_fkey
    FOREIGN KEY (target_module_id) REFERENCES public.modules(id) ON DELETE CASCADE,
  CONSTRAINT module_clones_target_version_fkey
    FOREIGN KEY (target_course_version_id) REFERENCES public.course_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS module_clones_source_idx
  ON public.module_clones (source_module_id);
CREATE INDEX IF NOT EXISTS module_clones_target_version_idx
  ON public.module_clones (target_course_version_id);

ALTER TABLE public.module_clones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS module_clones_read ON public.module_clones;
CREATE POLICY module_clones_read ON public.module_clones
  FOR SELECT
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.course_versions cv
      JOIN public.courses c ON c.id = cv.course_id
      WHERE cv.id = module_clones.target_course_version_id
        AND c.tenant_id IS NOT DISTINCT FROM public.current_tenant_id()
        AND public.is_course_author()
    )
  );

-- ===========================================================================
-- list_pickable_modules
-- ===========================================================================

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
      AND c.archived_at IS NULL
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
  ORDER BY c.title, cv.version_number, m.position;
$$;

REVOKE ALL ON FUNCTION public.list_pickable_modules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_pickable_modules() TO authenticated;

-- ===========================================================================
-- _resolve_unique_module_slug (helper)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public._resolve_unique_module_slug(
  p_course_version_id uuid,
  p_base_slug         text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate text := p_base_slug;
  v_n         integer := 2;
BEGIN
  WHILE EXISTS (
    SELECT 1 FROM public.modules
    WHERE course_version_id = p_course_version_id
      AND slug = v_candidate
  ) LOOP
    v_candidate := p_base_slug || '-' || v_n::text;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_candidate;
END
$$;

REVOKE ALL ON FUNCTION public._resolve_unique_module_slug(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._resolve_unique_module_slug(uuid, text) TO authenticated;

-- ===========================================================================
-- clone_module_into_version
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.clone_module_into_version(
  p_source_module_id         uuid,
  p_target_course_version_id uuid,
  p_position                 integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_src_module      public.modules%ROWTYPE;
  v_src_tenant      uuid;
  v_tgt_tenant      uuid;
  v_tgt_course_id   uuid;
  v_caller_tenant   uuid;
  v_new_module_id   uuid;
  v_new_slug        text;
  v_position        integer;
  v_appendix_count  integer := 0;
  v_quiz_count      integer := 0;
BEGIN
  IF p_source_module_id IS NULL OR p_target_course_version_id IS NULL THEN
    RAISE EXCEPTION 'p_source_module_id and p_target_course_version_id are required';
  END IF;

  SELECT m.* INTO v_src_module FROM public.modules m WHERE m.id = p_source_module_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source module % not found', p_source_module_id;
  END IF;

  SELECT c.tenant_id
    INTO v_src_tenant
  FROM public.course_versions cv
  JOIN public.courses c ON c.id = cv.course_id
  WHERE cv.id = v_src_module.course_version_id;

  SELECT c.id, c.tenant_id
    INTO v_tgt_course_id, v_tgt_tenant
  FROM public.course_versions cv
  JOIN public.courses c ON c.id = cv.course_id
  WHERE cv.id = p_target_course_version_id;

  IF v_tgt_course_id IS NULL THEN
    RAISE EXCEPTION 'Target course version % not found', p_target_course_version_id;
  END IF;

  -- Cross-tenant guard. NULL=NULL allowed via IS NOT DISTINCT FROM.
  IF v_src_tenant IS DISTINCT FROM v_tgt_tenant THEN
    RAISE EXCEPTION 'Cannot clone modules across tenants';
  END IF;

  IF NOT public.is_super_admin() THEN
    v_caller_tenant := public.current_tenant_id();
    IF NOT public.is_course_author() THEN
      RAISE EXCEPTION 'Not authorized to clone this module';
    END IF;
    IF v_caller_tenant IS DISTINCT FROM v_src_tenant THEN
      RAISE EXCEPTION 'Not authorized to clone modules in this tenant';
    END IF;
  END IF;

  v_new_slug := public._resolve_unique_module_slug(p_target_course_version_id, v_src_module.slug);

  IF p_position IS NULL THEN
    SELECT COALESCE(MAX(position), -1) + 1 INTO v_position
    FROM public.modules WHERE course_version_id = p_target_course_version_id;
  ELSE
    v_position := GREATEST(p_position, 0);
    UPDATE public.modules
       SET position = position + 1
     WHERE course_version_id = p_target_course_version_id
       AND position >= v_position;
  END IF;

  INSERT INTO public.modules (
    course_version_id, slug, title, description, position,
    has_knowledge_check, hero_image_url, hero_image_alt, description_html
  )
  VALUES (
    p_target_course_version_id, v_new_slug, v_src_module.title, v_src_module.description, v_position,
    v_src_module.has_knowledge_check, v_src_module.hero_image_url, v_src_module.hero_image_alt, v_src_module.description_html
  )
  RETURNING id INTO v_new_module_id;

  -- Clone lessons + pages with a slug-keyed join (lessons.slug is unique per module).
  WITH src_lessons AS (
    SELECT id, slug, title, position, hero_image_url, hero_image_alt, workflow_status
    FROM public.lessons WHERE module_id = p_source_module_id
  ),
  inserted_lessons AS (
    INSERT INTO public.lessons (
      module_id, slug, title, position, hero_image_url, hero_image_alt, workflow_status
    )
    SELECT v_new_module_id, slug, title, position, hero_image_url, hero_image_alt, workflow_status
    FROM src_lessons
    RETURNING id, slug
  ),
  lesson_map AS (
    SELECT s.id AS src_id, n.id AS new_id
    FROM src_lessons s
    JOIN inserted_lessons n ON n.slug = s.slug
  )
  INSERT INTO public.pages (
    lesson_id, position, page_type, title, body_html,
    audio_url, audio_voice, audio_generated_at,
    citations, hero_image_url, hero_image_alt, workflow_status
  )
  SELECT lm.new_id, p.position, p.page_type, p.title, p.body_html,
         p.audio_url, p.audio_voice, p.audio_generated_at,
         p.citations, p.hero_image_url, p.hero_image_alt, p.workflow_status
  FROM public.pages p
  JOIN lesson_map lm ON lm.src_id = p.lesson_id;

  INSERT INTO public.module_appendix_items (
    module_id, kind, title, position, body_html, asset_id, url, description, created_by
  )
  SELECT v_new_module_id, a.kind, a.title, a.position, a.body_html, a.asset_id, a.url, a.description, auth.uid()
  FROM public.module_appendix_items a
  WHERE a.module_id = p_source_module_id;
  GET DIAGNOSTICS v_appendix_count = ROW_COUNT;

  INSERT INTO public.module_quiz_questions (
    module_id, position, question, options, answer_index, reference
  )
  SELECT v_new_module_id, q.position, q.question, q.options, q.answer_index, q.reference
  FROM public.module_quiz_questions q
  WHERE q.module_id = p_source_module_id;
  GET DIAGNOSTICS v_quiz_count = ROW_COUNT;

  INSERT INTO public.module_clones (
    source_module_id, target_module_id, target_course_version_id, cloned_by
  )
  VALUES (p_source_module_id, v_new_module_id, p_target_course_version_id, auth.uid());

  RETURN v_new_module_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.clone_module_into_version(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_module_into_version(uuid, uuid, integer) TO authenticated;

-- ===========================================================================
-- create_course_from_modules
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.create_course_from_modules(
  p_title        text,
  p_slug         text,
  p_description  text,
  p_module_ids   uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_tenant uuid;
  v_target_tenant uuid;
  v_distinct_count integer;
  v_new_course_id uuid;
  v_new_version_id uuid;
  v_module_id     uuid;
  v_position      integer := 0;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'p_title is required';
  END IF;
  IF p_slug IS NULL OR length(btrim(p_slug)) = 0 THEN
    RAISE EXCEPTION 'p_slug is required';
  END IF;
  IF p_module_ids IS NULL OR array_length(p_module_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_module_ids must be non-empty';
  END IF;

  v_caller_tenant := public.current_tenant_id();
  IF NOT public.is_super_admin() THEN
    IF v_caller_tenant IS NULL OR NOT public.is_course_author() THEN
      RAISE EXCEPTION 'Not authorized to create courses';
    END IF;
  END IF;

  -- All source modules must share the same tenant (NULL counts as one bucket).
  SELECT count(DISTINCT COALESCE(c.tenant_id::text, '__null__'))
    INTO v_distinct_count
  FROM unnest(p_module_ids) AS x(id)
  JOIN public.modules m         ON m.id = x.id
  JOIN public.course_versions cv ON cv.id = m.course_version_id
  JOIN public.courses c          ON c.id = cv.course_id;

  IF v_distinct_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'All source modules must belong to the same tenant';
  END IF;

  -- Pick the (single) source tenant. LIMIT 1 is safe because we just verified one bucket.
  SELECT c.tenant_id
    INTO v_target_tenant
  FROM unnest(p_module_ids) AS x(id)
  JOIN public.modules m         ON m.id = x.id
  JOIN public.course_versions cv ON cv.id = m.course_version_id
  JOIN public.courses c          ON c.id = cv.course_id
  LIMIT 1;

  IF NOT public.is_super_admin() THEN
    IF v_caller_tenant IS DISTINCT FROM v_target_tenant THEN
      RAISE EXCEPTION 'Not authorized to clone modules across tenants';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.courses
    WHERE slug = p_slug
      AND deleted_at IS NULL
      AND tenant_id IS NOT DISTINCT FROM v_target_tenant
  ) THEN
    RAISE EXCEPTION 'A course with slug % already exists in this tenant', p_slug;
  END IF;

  INSERT INTO public.courses (
    slug, title, description, tenant_id, visibility, created_by
  )
  VALUES (p_slug, p_title, p_description, v_target_tenant, 'private', auth.uid())
  RETURNING id INTO v_new_course_id;

  INSERT INTO public.course_versions (course_id, version_number, status, created_by)
  VALUES (v_new_course_id, 1, 'draft', auth.uid())
  RETURNING id INTO v_new_version_id;

  UPDATE public.courses
     SET current_version_id = v_new_version_id
   WHERE id = v_new_course_id;

  FOREACH v_module_id IN ARRAY p_module_ids LOOP
    PERFORM public.clone_module_into_version(v_module_id, v_new_version_id, v_position);
    v_position := v_position + 1;
  END LOOP;

  RETURN v_new_course_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.create_course_from_modules(text, text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_course_from_modules(text, text, text, uuid[]) TO authenticated;
