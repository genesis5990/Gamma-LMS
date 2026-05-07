-- ============================================================================
-- 0017_security_hardening_batch3.sql
-- 2026-05-07
--
-- Batch 3 cleanup migration. Sections:
--   #10  add 'instructor' to profiles.role CHECK constraint
--   #11  super_admin-only RLS policies on departments + owner_emails
--   #12  access_requests rate limit (5 inserts per email per 24h)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- #10 — instructor role
-- ----------------------------------------------------------------------------
-- profiles_role_check was last set in migration 0004 to allow
-- ('student','dept_admin','tenant_admin','super_admin'). The studio's
-- is_course_author() helper (migration 0010) already accepts 'instructor',
-- and the Users UI dropdown already lists it. Reconcile by adding 'instructor'
-- to the constraint.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('student','dept_admin','tenant_admin','instructor','super_admin'));


-- ----------------------------------------------------------------------------
-- #11 — departments + owner_emails: super_admin-only policies
-- ----------------------------------------------------------------------------
-- Both tables have RLS enabled (per migrations 0001 + 0003) but no policies,
-- which under Postgres means no rows are visible to anyone except service
-- role. Lock them down explicitly to super_admin so the intent is durable
-- and visible to future readers.

DROP POLICY IF EXISTS departments_super_admin_all ON public.departments;
CREATE POLICY departments_super_admin_all ON public.departments
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON POLICY departments_super_admin_all ON public.departments IS
  'Super admins only. Other access paths must use service role (migration 0017 #11).';

DROP POLICY IF EXISTS owner_emails_super_admin_all ON public.owner_emails;
CREATE POLICY owner_emails_super_admin_all ON public.owner_emails
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON POLICY owner_emails_super_admin_all ON public.owner_emails IS
  'Super admins only. Other access paths must use service role (migration 0017 #11).';


-- ----------------------------------------------------------------------------
-- #12 — access_requests rate limit (5 per email per 24h)
-- ----------------------------------------------------------------------------
-- Self-serve insert path (anonymous "request access" form) is open by RLS
-- design. Add a BEFORE INSERT trigger that throttles to 5 inserts per email
-- per rolling 24 hours. IP-based limiting is not feasible from inside Postgres
-- without a request-context table; this email-based gate is the practical
-- defense.

CREATE OR REPLACE FUNCTION public.access_requests_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recent int;
BEGIN
  SELECT count(*) INTO v_recent
    FROM public.access_requests
   WHERE email = NEW.email
     AND created_at > now() - interval '24 hours';

  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'access_requests rate limit exceeded for %: 5 requests per 24 hours',
      NEW.email
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_requests_rate_limit_trg ON public.access_requests;
CREATE TRIGGER access_requests_rate_limit_trg
  BEFORE INSERT ON public.access_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.access_requests_rate_limit();

COMMENT ON FUNCTION public.access_requests_rate_limit() IS
  'BEFORE INSERT trigger on access_requests: caps to 5 rows per email per
   rolling 24 hours. SECURITY DEFINER so the count query bypasses RLS
   (the table is anon-insertable but only super/tenant admins can SELECT).
   Migration 0017 #12.';
