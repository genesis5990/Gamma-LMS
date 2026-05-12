-- 0034_reorder_modules_rpc.sql
-- Batched reorder RPC for modules within a course version.
--
-- reorder_modules(p_course_version_id, p_ordered_ids)
--   Updates modules.position for every id in p_ordered_ids based on its
--   index in the array, all in a single transaction. All ids must belong
--   to p_course_version_id. p_ordered_ids must cover every module in
--   the course version (full set). Authorization mirrors reorder_lessons
--   from migration 0031: super_admin OR is_course_author() for the
--   owning tenant.

CREATE OR REPLACE FUNCTION public.reorder_modules(
  p_course_version_id  uuid,
  p_ordered_ids        uuid[]
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
  v_count_in_version integer;
  v_count_in_input   integer;
BEGIN
  IF p_course_version_id IS NULL THEN
    RAISE EXCEPTION 'p_course_version_id is required';
  END IF;
  IF p_ordered_ids IS NULL OR array_length(p_ordered_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_ordered_ids must be non-empty';
  END IF;

  -- Resolve owning course/tenant for the target course version.
  SELECT c.id, c.tenant_id
    INTO v_course_id, v_tenant_id
  FROM public.course_versions cv
  JOIN public.courses c ON c.id = cv.course_id
  WHERE cv.id = p_course_version_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Course version not found';
  END IF;

  -- AuthZ: super admin OR course author for the owning tenant.
  IF NOT public.is_super_admin() THEN
    v_caller_tenant := public.current_tenant_id();
    IF v_caller_tenant IS NULL
       OR v_caller_tenant <> v_tenant_id
       OR NOT public.is_course_author() THEN
      RAISE EXCEPTION 'Not authorized to reorder modules in this course';
    END IF;
  END IF;

  -- Every id in p_ordered_ids must belong to p_course_version_id, AND
  -- p_ordered_ids must include every module currently in the version.
  SELECT count(*) INTO v_count_in_input
  FROM unnest(p_ordered_ids) AS x(id)
  JOIN public.modules m ON m.id = x.id
  WHERE m.course_version_id = p_course_version_id;

  IF v_count_in_input <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'One or more module ids do not belong to course version %', p_course_version_id;
  END IF;

  SELECT count(*) INTO v_count_in_version
  FROM public.modules
  WHERE course_version_id = p_course_version_id;

  IF v_count_in_version <> array_length(p_ordered_ids, 1) THEN
    RAISE EXCEPTION 'p_ordered_ids (% items) does not cover all modules in course version (% items)',
      array_length(p_ordered_ids, 1), v_count_in_version;
  END IF;

  -- Two-phase update to avoid any (course_version_id, position) uniqueness collisions.
  UPDATE public.modules
     SET position = position + 1000000
   WHERE course_version_id = p_course_version_id;

  WITH ordered AS (
    SELECT id, (ord - 1) AS new_pos
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS u(id, ord)
  )
  UPDATE public.modules m
     SET position = ordered.new_pos
    FROM ordered
   WHERE m.id = ordered.id;

  RETURN jsonb_build_object(
    'ok', true,
    'course_version_id', p_course_version_id,
    'count', array_length(p_ordered_ids, 1)
  );
END
$$;

REVOKE ALL ON FUNCTION public.reorder_modules(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_modules(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.reorder_modules(uuid, uuid[]) IS
  'Reorders modules within a course version in one transaction. p_ordered_ids
   must cover every module currently in p_course_version_id. AuthZ: super_admin
   OR is_course_author() for the owning tenant. Added in migration 0034.';
