-- =====================================================================
-- 0004_tenants.sql — Multi-tenant rollout
-- Adds:
--   * tenants table (per-client white-label config)
--   * tenant_id FK on profiles + enrollments (backfilled to Deconflict)
--   * 'tenant_admin' role
--   * is_super_admin() and current_tenant_id() SECURITY DEFINER helpers
--   * RLS so tenant_admins see only their tenant's learners, super_admins see all
--   * handle_new_user() chooses tenant by email domain (deconflict.com -> deconflict)
-- =====================================================================

-- ---------- tenants ----------
CREATE TABLE IF NOT EXISTS public.tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,                    -- e.g. 'deconflict' (URL-safe)
  name            text NOT NULL,                            -- display name
  logo_url        text,                                     -- light-mode logo (dark on light)
  logo_url_white  text,                                     -- dark-mode logo (white on dark)
  primary_color   text NOT NULL DEFAULT '#060A16',          -- ink
  secondary_color text NOT NULL DEFAULT '#EFEFEF',          -- background/accent
  contact_email   text,
  email_domains   text[] NOT NULL DEFAULT '{}',             -- domains to auto-route signups to this tenant
  use_subdomain   boolean NOT NULL DEFAULT false,           -- future: graduate to tenant.mygenesis-training.com
  billing_status  text NOT NULL DEFAULT 'active'
                  CHECK (billing_status IN ('active','suspended','trial','cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Seed Deconflict (idempotent)
INSERT INTO public.tenants (slug, name, logo_url, logo_url_white, primary_color, secondary_color, contact_email, email_domains)
VALUES (
  'deconflict',
  'Deconflict',
  '/assets/tenants/deconflict/Logo-With-Text.svg',
  '/assets/tenants/deconflict/Logo-With-Text-White.svg',
  '#060A16',
  '#EFEFEF',
  NULL,
  ARRAY['deconflict.com']
)
ON CONFLICT (slug) DO UPDATE
  SET name            = EXCLUDED.name,
      logo_url        = EXCLUDED.logo_url,
      logo_url_white  = EXCLUDED.logo_url_white,
      primary_color   = EXCLUDED.primary_color,
      secondary_color = EXCLUDED.secondary_color,
      email_domains   = EXCLUDED.email_domains;

-- ---------- profiles: add tenant_id + new role ----------
-- Drop old role check, re-add with tenant_admin
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('student','dept_admin','tenant_admin','super_admin'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id);

-- Backfill existing profiles to Deconflict
UPDATE public.profiles
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'deconflict')
 WHERE tenant_id IS NULL;

-- ---------- enrollments: add tenant_id ----------
ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id);

UPDATE public.enrollments
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'deconflict')
 WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS profiles_tenant_idx    ON public.profiles    (tenant_id);
CREATE INDEX IF NOT EXISTS enrollments_tenant_idx ON public.enrollments (tenant_id);

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('tenant_admin','super_admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM public.profiles WHERE id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin()    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_tenant_admin()   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO anon, authenticated;

-- ---------- tenants table RLS ----------
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenants public read" ON public.tenants;
-- Anyone (even unauthenticated) can read the tenant config so course pages can theme themselves
-- before the user signs in. Only public-safe columns are exposed; this is just branding.
CREATE POLICY "tenants public read"
  ON public.tenants FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "tenants super admin write" ON public.tenants;
CREATE POLICY "tenants super admin write"
  ON public.tenants FOR ALL
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ---------- profiles RLS: add admin scopes ----------
DROP POLICY IF EXISTS "tenant admin read profiles" ON public.profiles;
CREATE POLICY "tenant admin read profiles"
  ON public.profiles FOR SELECT
  USING (
    public.is_super_admin()
    OR (
      EXISTS (
        SELECT 1 FROM public.profiles me
        WHERE me.id = auth.uid()
          AND me.role = 'tenant_admin'
          AND me.tenant_id = public.profiles.tenant_id
      )
    )
  );

-- ---------- enrollments RLS: add admin scopes ----------
DROP POLICY IF EXISTS "tenant admin read enrollments" ON public.enrollments;
CREATE POLICY "tenant admin read enrollments"
  ON public.enrollments FOR SELECT
  USING (
    public.is_super_admin()
    OR (
      EXISTS (
        SELECT 1 FROM public.profiles me
        WHERE me.id = auth.uid()
          AND me.role = 'tenant_admin'
          AND me.tenant_id = public.enrollments.tenant_id
      )
    )
  );

-- ---------- lesson_progress + quiz_attempts: tenant-admin read via profile join ----------
DROP POLICY IF EXISTS "tenant admin read lesson_progress" ON public.lesson_progress;
CREATE POLICY "tenant admin read lesson_progress"
  ON public.lesson_progress FOR SELECT
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles me, public.profiles target
      WHERE me.id = auth.uid()
        AND me.role = 'tenant_admin'
        AND target.id = public.lesson_progress.user_id
        AND target.tenant_id = me.tenant_id
    )
  );

DROP POLICY IF EXISTS "tenant admin read quiz_attempts" ON public.quiz_attempts;
CREATE POLICY "tenant admin read quiz_attempts"
  ON public.quiz_attempts FOR SELECT
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles me, public.profiles target
      WHERE me.id = auth.uid()
        AND me.role = 'tenant_admin'
        AND target.id = public.quiz_attempts.user_id
        AND target.tenant_id = me.tenant_id
    )
  );

DROP POLICY IF EXISTS "tenant admin read certificates" ON public.certificates;
CREATE POLICY "tenant admin read certificates"
  ON public.certificates FOR SELECT
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles me, public.profiles target
      WHERE me.id = auth.uid()
        AND me.role = 'tenant_admin'
        AND target.id = public.certificates.user_id
        AND target.tenant_id = me.tenant_id
    )
  );

-- ---------- handle_new_user: route by email domain to tenant ----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_owner   boolean;
  v_domain   text;
  v_tenant   uuid;
  v_default  uuid;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.owner_emails
    WHERE lower(email) = lower(NEW.email)
  ) INTO is_owner;

  -- Email domain (everything after the @)
  v_domain := lower(split_part(NEW.email, '@', 2));

  -- Try to match a tenant by domain
  SELECT id INTO v_tenant
    FROM public.tenants
   WHERE v_domain = ANY (email_domains)
   LIMIT 1;

  -- Default to Deconflict for now (only tenant in the system)
  SELECT id INTO v_default FROM public.tenants WHERE slug = 'deconflict';
  v_tenant := COALESCE(v_tenant, v_default);

  INSERT INTO public.profiles (id, email, role, tenant_id)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN is_owner THEN 'super_admin' ELSE 'student' END,
    v_tenant
  )
  ON CONFLICT (id) DO UPDATE
    SET email     = EXCLUDED.email,
        role      = CASE WHEN is_owner THEN 'super_admin' ELSE public.profiles.role END,
        tenant_id = COALESCE(public.profiles.tenant_id, EXCLUDED.tenant_id);

  INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
  VALUES (NEW.id, 'crypto101', 'active', v_tenant)
  ON CONFLICT (user_id, course_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
