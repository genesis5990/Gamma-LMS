-- =====================================================================
-- 0006_gating_and_ppc.sql — Phase 3
--
-- Adds:
--   * tenant enrollment_mode (open | domain_allowlist | request_approval | invite_only)
--   * access_requests table (anonymous officers submit; admins review)
--   * invitations table (auto-created on approval; 30-day TTL)
--   * purchases table (Stripe pay-per-course e-commerce)
--   * RLS policies for all three
--   * approve_access_request / deny_access_request RPCs
--   * handle_new_user replacement that enforces gating + invitation acceptance
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------- citext (used for case-insensitive emails) ----------
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- tenant enrollment_mode ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_enrollment_mode') THEN
    CREATE TYPE public.tenant_enrollment_mode AS ENUM
      ('open', 'domain_allowlist', 'request_approval', 'invite_only');
  END IF;
END $$;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS enrollment_mode public.tenant_enrollment_mode
    NOT NULL DEFAULT 'open';

-- Set Deconflict to request_approval (idempotent)
UPDATE public.tenants
   SET enrollment_mode = 'request_approval'
 WHERE slug = 'deconflict';

-- ---------- access_requests ----------
CREATE TABLE IF NOT EXISTS public.access_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  full_name       text NOT NULL,
  agency          text NOT NULL,
  badge_number    text NOT NULL,
  rank            text,
  supervisor_name  text,
  supervisor_email citext,
  note            text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','denied')),
  reviewed_by     uuid REFERENCES auth.users(id),
  reviewed_at     timestamptz,
  deny_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_requests_tenant_status_idx
  ON public.access_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS access_requests_email_idx
  ON public.access_requests (email);

-- ---------- invitations ----------
CREATE TABLE IF NOT EXISTS public.invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        text NOT NULL DEFAULT 'student'
              CHECK (role IN ('student','tenant_admin')),
  invited_by  uuid REFERENCES auth.users(id),
  source      text NOT NULL DEFAULT 'admin_invite'
              CHECK (source IN ('admin_invite','approved_request')),
  request_id  uuid REFERENCES public.access_requests(id),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_email_active_idx
  ON public.invitations (email) WHERE accepted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invitations_email_tenant_pending_uq
  ON public.invitations (email, tenant_id) WHERE accepted_at IS NULL;

-- ---------- purchases (PPC e-commerce) ----------
CREATE TABLE IF NOT EXISTS public.purchases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email                 citext NOT NULL,
  course_id             text NOT NULL,
  stripe_session_id     text UNIQUE NOT NULL,
  stripe_payment_intent text,
  stripe_customer_id    text,
  amount_cents          integer NOT NULL,
  currency              text NOT NULL DEFAULT 'usd',
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','refunded','failed')),
  paid_at               timestamptz,
  refunded_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchases_user_idx          ON public.purchases (user_id);
CREATE INDEX IF NOT EXISTS purchases_email_idx         ON public.purchases (email);
CREATE INDEX IF NOT EXISTS purchases_course_status_idx ON public.purchases (course_id, status);

-- ---------- RLS ----------
ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases       ENABLE ROW LEVEL SECURITY;

-- Anonymous + authenticated can INSERT a pending request (the public form).
-- Status is forced to pending and reviewer fields must be null.
DROP POLICY IF EXISTS access_requests_insert_anon ON public.access_requests;
CREATE POLICY access_requests_insert_anon
  ON public.access_requests FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
  );

-- Tenant admins read/update their tenant's requests; super_admins all
DROP POLICY IF EXISTS access_requests_select_admin ON public.access_requests;
CREATE POLICY access_requests_select_admin
  ON public.access_requests FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR (public.is_tenant_admin() AND tenant_id = public.current_tenant_id())
  );

DROP POLICY IF EXISTS access_requests_update_admin ON public.access_requests;
CREATE POLICY access_requests_update_admin
  ON public.access_requests FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    OR (public.is_tenant_admin() AND tenant_id = public.current_tenant_id())
  )
  WITH CHECK (
    public.is_super_admin()
    OR (public.is_tenant_admin() AND tenant_id = public.current_tenant_id())
  );

-- Invitations: admins read/insert their tenant's
DROP POLICY IF EXISTS invitations_select_admin ON public.invitations;
CREATE POLICY invitations_select_admin
  ON public.invitations FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR (public.is_tenant_admin() AND tenant_id = public.current_tenant_id())
  );

DROP POLICY IF EXISTS invitations_insert_admin ON public.invitations;
CREATE POLICY invitations_insert_admin
  ON public.invitations FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_super_admin()
    OR (public.is_tenant_admin() AND tenant_id = public.current_tenant_id())
  );

-- Purchases: user sees their own; super_admins see all. Webhooks bypass RLS via service role.
DROP POLICY IF EXISTS purchases_select_self ON public.purchases;
CREATE POLICY purchases_select_self
  ON public.purchases FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin());

-- =====================================================================
-- handle_new_user — gating-aware replacement
--
-- Order of resolution:
--   1. Owner allow-list → super_admin (preserved from 0003)
--   2. Active invitation by email → assign tenant + role from invitation, mark accepted
--   3. Domain match against a tenant:
--        - open / domain_allowlist → join automatically
--        - request_approval / invite_only → REJECT (signup forbidden without invite)
--   4. No tenant match → profile with tenant_id = NULL (neutral / PPC user)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  is_owner      boolean;
  v_email_lc    citext := lower(NEW.email)::citext;
  v_domain      text   := lower(split_part(NEW.email, '@', 2));
  v_tenant_id   uuid;
  v_mode        public.tenant_enrollment_mode;
  v_invite_id   uuid;
  v_invite_role text;
  v_role        text;
BEGIN
  -- 1. Owner allow-list
  SELECT EXISTS (
    SELECT 1 FROM public.owner_emails
    WHERE lower(email) = lower(NEW.email)
  ) INTO is_owner;

  -- 2. Active, non-expired invitation by email
  SELECT id, tenant_id, role
    INTO v_invite_id, v_tenant_id, v_invite_role
    FROM public.invitations
   WHERE email = v_email_lc
     AND accepted_at IS NULL
     AND expires_at > now()
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_invite_id IS NOT NULL THEN
    UPDATE public.invitations SET accepted_at = now() WHERE id = v_invite_id;

    v_role := CASE
      WHEN is_owner             THEN 'super_admin'
      WHEN v_invite_role IS NULL THEN 'student'
      ELSE v_invite_role
    END;

    INSERT INTO public.profiles (id, email, role, tenant_id)
    VALUES (NEW.id, NEW.email, v_role, v_tenant_id)
    ON CONFLICT (id) DO UPDATE
      SET email     = EXCLUDED.email,
          role      = CASE WHEN is_owner THEN 'super_admin' ELSE EXCLUDED.role END,
          tenant_id = EXCLUDED.tenant_id;

    INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
    VALUES (NEW.id, 'crypto101', 'active', v_tenant_id)
    ON CONFLICT (user_id, course_id) DO NOTHING;

    RETURN NEW;
  END IF;

  -- 3. Try domain match
  v_tenant_id := NULL;
  SELECT id, enrollment_mode INTO v_tenant_id, v_mode
    FROM public.tenants
   WHERE v_domain = ANY (email_domains)
   LIMIT 1;

  IF v_tenant_id IS NOT NULL THEN
    IF v_mode IN ('open', 'domain_allowlist') THEN
      INSERT INTO public.profiles (id, email, role, tenant_id)
      VALUES (
        NEW.id,
        NEW.email,
        CASE WHEN is_owner THEN 'super_admin' ELSE 'student' END,
        v_tenant_id
      )
      ON CONFLICT (id) DO UPDATE
        SET email     = EXCLUDED.email,
            role      = CASE WHEN is_owner THEN 'super_admin' ELSE public.profiles.role END,
            tenant_id = COALESCE(public.profiles.tenant_id, EXCLUDED.tenant_id);

      INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
      VALUES (NEW.id, 'crypto101', 'active', v_tenant_id)
      ON CONFLICT (user_id, course_id) DO NOTHING;

      RETURN NEW;
    ELSE
      -- request_approval / invite_only — owner allow-list gets through; everyone else blocked
      IF is_owner THEN
        INSERT INTO public.profiles (id, email, role, tenant_id)
        VALUES (NEW.id, NEW.email, 'super_admin', v_tenant_id)
        ON CONFLICT (id) DO UPDATE
          SET email = EXCLUDED.email, role = 'super_admin', tenant_id = EXCLUDED.tenant_id;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'Access to this tenant requires approval or invitation. Please request access at the tenant portal.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 4. No tenant match — neutral / PPC user, profile with NULL tenant_id
  INSERT INTO public.profiles (id, email, role, tenant_id)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN is_owner THEN 'super_admin' ELSE 'student' END,
    NULL
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        role  = CASE WHEN is_owner THEN 'super_admin' ELSE public.profiles.role END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =====================================================================
-- approve_access_request: tenant_admin/super_admin approves a request,
-- creates a 30-day invitation, returns IDs for the Edge Function to email.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.approve_access_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req         public.access_requests%ROWTYPE;
  v_invite_id   uuid;
  v_tenant_name text;
  v_tenant_slug text;
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

  -- Tenant admins can only approve their own tenant's requests
  IF public.is_tenant_admin()
     AND NOT public.is_super_admin()
     AND v_req.tenant_id <> public.current_tenant_id() THEN
    RAISE EXCEPTION 'Not authorized for this tenant';
  END IF;

  -- Create or refresh an invitation
  INSERT INTO public.invitations
    (tenant_id, email, role, invited_by, source, request_id, expires_at)
  VALUES
    (v_req.tenant_id, v_req.email, 'student', auth.uid(),
     'approved_request', v_req.id, now() + interval '30 days')
  ON CONFLICT (email, tenant_id) WHERE accepted_at IS NULL
  DO UPDATE
    SET expires_at = EXCLUDED.expires_at,
        invited_by = EXCLUDED.invited_by,
        request_id = EXCLUDED.request_id,
        source     = EXCLUDED.source
  RETURNING id INTO v_invite_id;

  -- Update request
  UPDATE public.access_requests
     SET status      = 'approved',
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = p_request_id;

  SELECT name, slug INTO v_tenant_name, v_tenant_slug
    FROM public.tenants WHERE id = v_req.tenant_id;

  RETURN jsonb_build_object(
    'invitation_id', v_invite_id,
    'request_id',    v_req.id,
    'email',         v_req.email,
    'full_name',     v_req.full_name,
    'tenant_id',     v_req.tenant_id,
    'tenant_name',   v_tenant_name,
    'tenant_slug',   v_tenant_slug
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_access_request(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.approve_access_request(uuid) TO authenticated;

-- =====================================================================
-- deny_access_request
-- =====================================================================
CREATE OR REPLACE FUNCTION public.deny_access_request(
  p_request_id uuid,
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req         public.access_requests%ROWTYPE;
  v_tenant_name text;
  v_tenant_slug text;
BEGIN
  IF NOT (public.is_super_admin() OR public.is_tenant_admin()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_req FROM public.access_requests WHERE id = p_request_id;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF public.is_tenant_admin()
     AND NOT public.is_super_admin()
     AND v_req.tenant_id <> public.current_tenant_id() THEN
    RAISE EXCEPTION 'Not authorized for this tenant';
  END IF;

  UPDATE public.access_requests
     SET status      = 'denied',
         deny_reason = p_reason,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = p_request_id AND status = 'pending';

  SELECT name, slug INTO v_tenant_name, v_tenant_slug
    FROM public.tenants WHERE id = v_req.tenant_id;

  RETURN jsonb_build_object(
    'request_id',  v_req.id,
    'email',       v_req.email,
    'full_name',   v_req.full_name,
    'tenant_id',   v_req.tenant_id,
    'tenant_name', v_tenant_name,
    'tenant_slug', v_tenant_slug,
    'deny_reason', p_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.deny_access_request(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.deny_access_request(uuid, text) TO authenticated;
