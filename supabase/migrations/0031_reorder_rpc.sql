-- 0031_reorder_rpc.sql
-- Batched reorder RPCs for the studio drag-and-drop UX.
--
-- reorder_lessons(p_module_id, p_ordered_ids)
--   Updates lessons.position for every id in p_ordered_ids based on its
--   index in the array, all in a single transaction. All ids must belong
--   to p_module_id. Authorization mirrors the existing RLS pattern: super
--   admin OR course author whose tenant owns the parent course.
--
-- reorder_pages(p_lesson_id, p_ordered_ids)
--   Same shape, for pages.position within a lesson.
--
-- move_lesson_to_module(p_lesson_id, p_target_module_id, p_ordered_ids)
--   Moves a lesson to a different module (within the same course version)
--   and rewrites the destination module's lesson positions in one shot.
--   p_ordered_ids must be the destination module's lessons in their new
--   order, with p_lesson_id included.

-- ---------------------------------------------------------------------
-- reorder_lessons
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reorder_lessons(
  p_module_id    uuid,
  p_ordered_ids  uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id       uuid;
  v_course_id       uuid;
  v_caller_tenant   uuid;
  v_count_in_module integer;
  v_count_in_input  integer;
BEGIN
  IF p_module_id IS NULL THEN
    RAISE EXCEPTION 'p_module_id is required';
  END IF;
  IF p_ordered_ids IS NULL OR array_length(p_ordered_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_ordered_ids must be non-empty';
  END IF;

  -- Resolve owning course/tenant for the target module.
  SELECT c.id, c.tenant_id
    INTO v_course_id, v_tenant_id
  FROM public.modules m
  JOIN public.course_versions cv ON cv.id = m.course_version_id
  JOIN public.courses c          ON c.id = cv.course_id
  WHERE m.id = p_module_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Module not found';
  END IF;

  -- AuthZ: super admin OR course author for the owning tenant.
  IF NOT public.is_super_admin() THEN
    v_caller_tenant := public.current_tenant_id();
    IF v_caller_tenant IS NULL
       OR v_caller_tenant <> v_tenant_id
       OR NOT public.is_course_author() THEN
      RAISE EXCEPTION 'Not authorized to reorder lessons in this module';
    END IF;
  END IF;

  -- Every id in p_ordered_ids must belong to p_module_id, AND
  -- p_ordered_ids must include every lesson currently in p_module_id.
  -- (We require the full set so we never leave straggler positions behind.)
  SELECT count(*) INTO v_count_in_input
  FROM unnest(p_ordered_ids) AS x(id)
  JOIN public.lessons l ON l.id = x.id
  WHERE l.module_id = p_module_id;

  IF v_count_in_input <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'One or more lesson ids do not belong to module %', p_module_id;
  END IF;

  SELECT count(*) INTO v_count_in_module
  FROM public.lessons
  WHERE module_id = p_module_id;

  IF v_count_in_module <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'p_ordered_ids (% items) does not cover all lessons in module (% items)',
      array_length(p_ordered_ids, 1), v_count_in_module;
  END IF;

  -- Two-phase update to avoid colliding on any (module_id, position) uniqueness.
  -- Phase 1: push every affected row into a high range (large offset).
  UPDATE public.lessons
     SET position = position + 1000000
   WHERE module_id = p_module_id;

  -- Phase 2: write the new positions in input order.
  WITH ordered AS (
    SELECT id, (ord - 1) AS new_pos
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS u(id, ord)
  )
  UPDATE public.lessons l
     SET position = ordered.new_pos
    FROM ordered
   WHERE l.id = ordered.id;

  RETURN jsonb_build_object(
    'ok', true,
    'module_id', p_module_id,
    'count', array_length(p_ordered_ids, 1)
  );
END
$$;

REVOKE ALL ON FUNCTION public.reorder_lessons(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_lessons(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.reorder_lessons(uuid, uuid[]) IS
  'Reorders lessons within a module in one transaction. p_ordered_ids must
   cover every lesson currently in p_module_id. AuthZ: super_admin OR
   is_course_author() for the owning tenant. Added in migration 0031.';

-- ---------------------------------------------------------------------
-- reorder_pages
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reorder_pages(
  p_lesson_id    uuid,
  p_ordered_ids  uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id        uuid;
  v_course_id        uuid;
  v_caller_tenant    uuid;
  v_count_in_lesson  integer;
  v_count_in_input   integer;
BEGIN
  IF p_lesson_id IS NULL THEN
    RAISE EXCEPTION 'p_lesson_id is required';
  END IF;
  IF p_ordered_ids IS NULL OR array_length(p_ordered_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_ordered_ids must be non-empty';
  END IF;

  SELECT c.id, c.tenant_id
    INTO v_course_id, v_tenant_id
  FROM public.lessons l
  JOIN public.modules m          ON m.id = l.module_id
  JOIN public.course_versions cv ON cv.id = m.course_version_id
  JOIN public.courses c          ON c.id = cv.course_id
  WHERE l.id = p_lesson_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Lesson not found';
  END IF;

  IF NOT public.is_super_admin() THEN
    v_caller_tenant := public.current_tenant_id();
    IF v_caller_tenant IS NULL
       OR v_caller_tenant <> v_tenant_id
       OR NOT public.is_course_author() THEN
      RAISE EXCEPTION 'Not authorized to reorder pages in this lesson';
    END IF;
  END IF;

  SELECT count(*) INTO v_count_in_input
  FROM unnest(p_ordered_ids) AS x(id)
  JOIN public.pages p ON p.id = x.id
  WHERE p.lesson_id = p_lesson_id;

  IF v_count_in_input <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'One or more page ids do not belong to lesson %', p_lesson_id;
  END IF;

  SELECT count(*) INTO v_count_in_lesson
  FROM public.pages
  WHERE lesson_id = p_lesson_id;

  IF v_count_in_lesson <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'p_ordered_ids (% items) does not cover all pages in lesson (% items)',
      array_length(p_ordered_ids, 1), v_count_in_lesson;
  END IF;

  UPDATE public.pages
     SET position = position + 1000000
   WHERE lesson_id = p_lesson_id;

  WITH ordered AS (
    SELECT id, (ord - 1) AS new_pos
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS u(id, ord)
  )
  UPDATE public.pages p
     SET position = ordered.new_pos
    FROM ordered
   WHERE p.id = ordered.id;

  RETURN jsonb_build_object(
    'ok', true,
    'lesson_id', p_lesson_id,
    'count', array_length(p_ordered_ids, 1)
  );
END
$$;

REVOKE ALL ON FUNCTION public.reorder_pages(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_pages(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.reorder_pages(uuid, uuid[]) IS
  'Reorders pages within a lesson in one transaction. p_ordered_ids must
   cover every page currently in p_lesson_id. AuthZ: super_admin OR
   is_course_author() for the owning tenant. Added in migration 0031.';

-- ---------------------------------------------------------------------
-- move_lesson_to_module — stretch goal: cross-module lesson drag
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_lesson_to_module(
  p_lesson_id         uuid,
  p_target_module_id  uuid,
  p_ordered_ids       uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src_module_id       uuid;
  v_src_version_id      uuid;
  v_dst_version_id      uuid;
  v_dst_tenant_id       uuid;
  v_caller_tenant       uuid;
  v_count_in_input      integer;
  v_count_in_dst_after  integer;
BEGIN
  IF p_lesson_id IS NULL OR p_target_module_id IS NULL THEN
    RAISE EXCEPTION 'p_lesson_id and p_target_module_id are required';
  END IF;
  IF p_ordered_ids IS NULL OR array_length(p_ordered_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_ordered_ids must be non-empty';
  END IF;

  -- Look up source lesson and verify same course version.
  SELECT l.module_id, m.course_version_id
    INTO v_src_module_id, v_src_version_id
  FROM public.lessons l
  JOIN public.modules m ON m.id = l.module_id
  WHERE l.id = p_lesson_id;

  IF v_src_module_id IS NULL THEN
    RAISE EXCEPTION 'Lesson not found';
  END IF;

  SELECT m.course_version_id, c.tenant_id
    INTO v_dst_version_id, v_dst_tenant_id
  FROM public.modules m
  JOIN public.course_versions cv ON cv.id = m.course_version_id
  JOIN public.courses c          ON c.id = cv.course_id
  WHERE m.id = p_target_module_id;

  IF v_dst_version_id IS NULL THEN
    RAISE EXCEPTION 'Target module not found';
  END IF;

  IF v_src_version_id <> v_dst_version_id THEN
    RAISE EXCEPTION 'Cannot move lesson to a module in a different course version';
  END IF;

  IF NOT public.is_super_admin() THEN
    v_caller_tenant := public.current_tenant_id();
    IF v_caller_tenant IS NULL
       OR v_caller_tenant <> v_dst_tenant_id
       OR NOT public.is_course_author() THEN
      RAISE EXCEPTION 'Not authorized to move lessons in this course';
    END IF;
  END IF;

  -- Move the lesson over (still under uniqueness pressure if any constraint
  -- on (module_id, position) exists; we'll re-set positions below).
  UPDATE public.lessons
     SET module_id = p_target_module_id,
         position  = position + 2000000
   WHERE id = p_lesson_id;

  -- Now p_ordered_ids must describe the destination module's full lesson set.
  SELECT count(*) INTO v_count_in_input
  FROM unnest(p_ordered_ids) AS x(id)
  JOIN public.lessons l ON l.id = x.id
  WHERE l.module_id = p_target_module_id;

  IF v_count_in_input <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'One or more lesson ids do not belong to target module %', p_target_module_id;
  END IF;

  SELECT count(*) INTO v_count_in_dst_after
  FROM public.lessons WHERE module_id = p_target_module_id;

  IF v_count_in_dst_after <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'p_ordered_ids (% items) does not cover all lessons in target module (% items)',
      array_length(p_ordered_ids, 1), v_count_in_dst_after;
  END IF;

  -- Push destination rows clear, then write final positions.
  UPDATE public.lessons
     SET position = position + 3000000
   WHERE module_id = p_target_module_id;

  WITH ordered AS (
    SELECT id, (ord - 1) AS new_pos
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS u(id, ord)
  )
  UPDATE public.lessons l
     SET position = ordered.new_pos
    FROM ordered
   WHERE l.id = ordered.id;

  -- Compact the source module's remaining lessons so positions stay 0..N-1.
  WITH compact AS (
    SELECT id, (row_number() OVER (ORDER BY position) - 1) AS new_pos
    FROM public.lessons
    WHERE module_id = v_src_module_id
  )
  UPDATE public.lessons l
     SET position = compact.new_pos
    FROM compact
   WHERE l.id = compact.id;

  RETURN jsonb_build_object(
    'ok', true,
    'lesson_id', p_lesson_id,
    'from_module_id', v_src_module_id,
    'to_module_id', p_target_module_id,
    'count', array_length(p_ordered_ids, 1)
  );
END
$$;

REVOKE ALL ON FUNCTION public.move_lesson_to_module(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_lesson_to_module(uuid, uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.move_lesson_to_module(uuid, uuid, uuid[]) IS
  'Moves a lesson into a different module (same course version) and rewrites
   the destination module''s lesson positions in one transaction.
   p_ordered_ids must describe the destination module''s full lesson set in
   its new order (with the moved lesson included). The source module''s
   remaining lessons are compacted to keep positions contiguous. AuthZ:
   super_admin OR is_course_author() for the owning tenant. Added in
   migration 0031.';
