-- 0029_approve_access_request_with_tenant.sql
-- Adds an overloaded variant of approve_access_request that accepts a tenant
-- override, so super-admins can resolve "intake" rows (where access_requests.tenant_id
-- IS NULL) by assigning them to a tenant during approval.
--
-- Behavior:
--   * If the request row already has a tenant_id, p_tenant_id is ignored —
--     existing tenant-scoped flow is unchanged. This keeps tenant_admin
--     behavior identical to the 1-arg form.
--   * If the request row's tenant_id IS NULL (intake), only super_admins
--     may approve, and p_tenant_id is REQUIRED. The function fills in the
--     access_requests row's tenant_id with p_tenant_id so the row reflects
--     the assigned tenant after approval.
--   * Tenant_admins CANNOT assign intake rows to themselves — intake is a
--     super-admin queue.
--
-- The original 1-arg approve_access_request(p_request_id) is left in place
-- unchanged, so existing call sites keep working.

CREATE OR REPLACE FUNCTION public.approve_access_request(
  p_request_id uuid,
  p_tenant_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req            public.access_requests%ROWTYPE;
  v_invite_id      uuid;
  v_tenant_name    text;
  v_tenant_slug    text;
  v_effective_tid  uuid;
BEGIN
  IF NOT (public.is_super_admin() OR public.is_tenant_admin()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_req FROM public.access_requests WHERE id = p_request_id;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Request is not pending (status: %)', v_req.status;
  END IF;

  IF v_req.tenant_id IS NOT NULL THEN
    -- Tenant-scoped row: ignore p_tenant_id, use the row's tenant.
    -- Tenant admins can only approve their own tenant's requests.
    IF public.is_tenant_admin()
       AND NOT public.is_super_admin()
       AND v_req.tenant_id <> public.current_tenant_id() THEN
      RAISE EXCEPTION 'Not authorized for this tenant';
    END IF;
    v_effective_tid := v_req.tenant_id;
  ELSE
    -- Intake row: only super_admins may resolve, and a tenant must be supplied.
    IF NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'Intake requests can only be approved by a super_admin';
    END IF;
    IF p_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Intake request requires a tenant assignment';
    END IF;
    -- Verify the tenant exists
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
      RAISE EXCEPTION 'Tenant not found';
    END IF;
    v_effective_tid := p_tenant_id;
  END IF;

  -- Create or refresh an invitation
  INSERT INTO public.invitations
    (tenant_id, email, role, invited_by, source, request_id, expires_at)
  VALUES
    (v_effective_tid, v_req.email, 'student', auth.uid(),
     'approved_request', v_req.id, now() + interval '30 days')
  ON CONFLICT (email, tenant_id) WHERE accepted_at IS NULL
  DO UPDATE
    SET expires_at = EXCLUDED.expires_at,
        invited_by = EXCLUDED.invited_by,
        request_id = EXCLUDED.request_id,
        source     = EXCLUDED.source
  RETURNING id INTO v_invite_id;

  -- Update request: mark approved, and for intake rows also persist the
  -- assigned tenant_id on the access_requests row.
  UPDATE public.access_requests
     SET status      = 'approved',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         tenant_id   = v_effective_tid
   WHERE id = p_request_id;

  SELECT name, slug INTO v_tenant_name, v_tenant_slug
    FROM public.tenants WHERE id = v_effective_tid;

  RETURN jsonb_build_object(
    'invitation_id', v_invite_id,
    'request_id',    v_req.id,
    'email',         v_req.email,
    'full_name',     v_req.full_name,
    'tenant_id',     v_effective_tid,
    'tenant_name',   v_tenant_name,
    'tenant_slug',   v_tenant_slug
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_access_request(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.approve_access_request(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.approve_access_request(uuid, uuid) IS
  'Overloaded variant of approve_access_request that accepts a tenant override.
   For intake rows (access_requests.tenant_id IS NULL), p_tenant_id is required
   and only super_admins may approve. For tenant-scoped rows, p_tenant_id is
   ignored and tenant_admin authorization rules apply as in the 1-arg form.';
