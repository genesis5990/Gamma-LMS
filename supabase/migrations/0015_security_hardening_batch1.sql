-- ============================================================================
-- 0015_security_hardening_batch1.sql
-- 2026-05-07
--
-- Security hardening batch 1. NO frontend behavior changes (apart from
-- swapping `from('tenants')` -> `from('tenants_public')` for branding reads).
--
-- Sections:
--   #1  profiles self-update WITH CHECK (prevent role/tenant escalation)
--   #5  author RLS gated on tenant_id (super_admin bypass preserved)
--   #8  tenants_public branding view + lock down tenants SELECT
-- ============================================================================

-- ----------------------------------------------------------------------------
-- #1 — profiles self-update WITH CHECK
-- ----------------------------------------------------------------------------
-- The original "self update" policy in 0001 only had USING (auth.uid() = id);
-- a self UPDATE could mutate role or tenant_id. Replace with a strict
-- WITH CHECK that pins those columns to their current values for non-admins,
-- and add an explicit super_admin all-rows update path.

DROP POLICY IF EXISTS "self update"               ON public.profiles;
DROP POLICY IF EXISTS "self update profile"        ON public.profiles;
DROP POLICY IF EXISTS profiles_self_update         ON public.profiles;
DROP POLICY IF EXISTS profiles_super_admin_update  ON public.profiles;

CREATE POLICY profiles_self_update
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role      IS NOT DISTINCT FROM (SELECT p.role      FROM public.profiles p WHERE p.id = auth.uid())
    AND tenant_id IS NOT DISTINCT FROM (SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid())
  );

CREATE POLICY profiles_super_admin_update
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON POLICY profiles_self_update ON public.profiles IS
  'Users may update their own profile but cannot change role or tenant_id (anti-escalation; migration 0015 #1).';
COMMENT ON POLICY profiles_super_admin_update ON public.profiles IS
  'Super admins may update any profile, including role and tenant_id (migration 0015 #1).';


-- ----------------------------------------------------------------------------
-- #5 — Tenant scoping in author RLS
-- ----------------------------------------------------------------------------
-- Original policies (0010) used USING (is_course_author()) WITH CHECK (same)
-- with no tenant boundary. Rewrite each authoring policy so it requires the
-- record to belong to the caller's tenant (super_admin bypasses).
--
-- Helper: ensure current_tenant_id() exists (it does in 0004 — re-create
-- defensively in case of a fresh stack).

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM public.profiles WHERE id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO anon, authenticated;

-- courses: tenant_id is on the row itself
DROP POLICY IF EXISTS courses_author_all ON public.courses;
CREATE POLICY courses_author_all ON public.courses
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  )
  WITH CHECK (
    public.is_course_author()
    AND (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  );

-- course_versions: tenant_id derived via parent course
DROP POLICY IF EXISTS course_versions_author_all ON public.course_versions;
CREATE POLICY course_versions_author_all ON public.course_versions
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.courses c
        WHERE c.id = public.course_versions.course_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.courses c
        WHERE c.id = public.course_versions.course_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );

-- modules: course_version_id -> course_versions.course_id -> courses.tenant_id
DROP POLICY IF EXISTS modules_author_all ON public.modules;
CREATE POLICY modules_author_all ON public.modules
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.course_versions cv
        JOIN public.courses c ON c.id = cv.course_id
        WHERE cv.id = public.modules.course_version_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.course_versions cv
        JOIN public.courses c ON c.id = cv.course_id
        WHERE cv.id = public.modules.course_version_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );

-- lessons: module_id -> modules -> course_versions -> courses
DROP POLICY IF EXISTS lessons_author_all ON public.lessons;
CREATE POLICY lessons_author_all ON public.lessons
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.modules m
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE m.id = public.lessons.module_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.modules m
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE m.id = public.lessons.module_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );

-- pages: lesson_id -> lessons -> modules -> course_versions -> courses
DROP POLICY IF EXISTS pages_author_all ON public.pages;
CREATE POLICY pages_author_all ON public.pages
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.lessons l
        JOIN public.modules m ON m.id = l.module_id
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE l.id = public.pages.lesson_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.lessons l
        JOIN public.modules m ON m.id = l.module_id
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE l.id = public.pages.lesson_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );

-- module_quiz_questions: module_id -> modules -> course_versions -> courses
DROP POLICY IF EXISTS module_quiz_questions_author_all ON public.module_quiz_questions;
CREATE POLICY module_quiz_questions_author_all ON public.module_quiz_questions
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.modules m
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE m.id = public.module_quiz_questions.module_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.modules m
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE m.id = public.module_quiz_questions.module_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );

-- final_exam_questions: course_version_id -> course_versions -> courses
DROP POLICY IF EXISTS final_exam_questions_author_all ON public.final_exam_questions;
CREATE POLICY final_exam_questions_author_all ON public.final_exam_questions
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.course_versions cv
        JOIN public.courses c ON c.id = cv.course_id
        WHERE cv.id = public.final_exam_questions.course_version_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.course_versions cv
        JOIN public.courses c ON c.id = cv.course_id
        WHERE cv.id = public.final_exam_questions.course_version_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );

-- course_assets: course_id -> courses.tenant_id
DROP POLICY IF EXISTS course_assets_author_all ON public.course_assets;
CREATE POLICY course_assets_author_all ON public.course_assets
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.courses c
        WHERE c.id = public.course_assets.course_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.courses c
        WHERE c.id = public.course_assets.course_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );


-- ----------------------------------------------------------------------------
-- #8 — tenants_public branding view + lock down tenants SELECT
-- ----------------------------------------------------------------------------
-- Anonymous branding reads now go through a SECURITY DEFINER view that
-- exposes only safe columns. Direct anon SELECT on public.tenants is removed.

-- SECURITY DEFINER view (default): runs with view-owner privileges; anon
-- callers do NOT need RLS read access to public.tenants to read this view.
CREATE OR REPLACE VIEW public.tenants_public AS
SELECT
  id,
  slug,
  name,
  logo_url,
  logo_url_white,
  primary_color,
  secondary_color,
  enrollment_mode
FROM public.tenants;

COMMENT ON VIEW public.tenants_public IS
  'Anon-safe branding columns from tenants. SECURITY DEFINER view (default);
   anon clients read here without needing RLS access to public.tenants.
   Exposes id, slug, name, logo_url, logo_url_white, primary_color,
   secondary_color, enrollment_mode. NOT exposed: billing_status,
   contact_email, email_domains, use_subdomain, created_at (migration 0015 #8).';

-- Reset and re-grant (idempotent)
REVOKE ALL ON public.tenants_public FROM anon, authenticated;
GRANT SELECT ON public.tenants_public TO anon, authenticated;

DROP POLICY IF EXISTS "tenants public read"      ON public.tenants;
DROP POLICY IF EXISTS tenants_anon_branding_read ON public.tenants;
DROP POLICY IF EXISTS tenants_member_read        ON public.tenants;
DROP POLICY IF EXISTS tenants_super_admin_read   ON public.tenants;

-- Authenticated users may read their own tenant row (full columns); super
-- admins may read all. This preserves the admin-requests embedded join
-- (`tenants:tenant_id(name,slug)`) for tenant_admins viewing requests in
-- their own tenant. Anonymous users have NO direct read access to
-- public.tenants — branding goes through tenants_public.
CREATE POLICY tenants_member_read
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR id = public.current_tenant_id()
  );

COMMENT ON POLICY tenants_member_read ON public.tenants IS
  'Authenticated reads on tenants are limited to the caller''s own tenant
   (super_admin sees all). Anonymous branding reads go through the
   tenants_public SECURITY DEFINER view (migration 0015 #8).';
