-- ============================================================================
-- 0027_course_tos_acceptances.sql — per-user, per-course Terms of Service
-- acceptance, recorded once and used to bypass the title-page gate on later
-- sessions.
-- 2026-05-10
--
-- Also adds courses.welcome_message (TEXT, nullable) so authors can override
-- the default welcome copy on the new title page.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- courses.welcome_message — optional per-course welcome copy
-- ----------------------------------------------------------------------------
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS welcome_message text;

-- ----------------------------------------------------------------------------
-- course_tos_acceptances — one row per (user, course)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.course_tos_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  course_version_id uuid REFERENCES public.course_versions(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip inet,
  UNIQUE (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS course_tos_acceptances_user_idx
  ON public.course_tos_acceptances(user_id);
CREATE INDEX IF NOT EXISTS course_tos_acceptances_course_idx
  ON public.course_tos_acceptances(course_id);

ALTER TABLE public.course_tos_acceptances ENABLE ROW LEVEL SECURITY;

-- Users can read their own acceptances.
DROP POLICY IF EXISTS tos_self_read ON public.course_tos_acceptances;
CREATE POLICY tos_self_read ON public.course_tos_acceptances
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Users can insert their own acceptances.
DROP POLICY IF EXISTS tos_self_insert ON public.course_tos_acceptances;
CREATE POLICY tos_self_insert ON public.course_tos_acceptances
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Super-admins can read every acceptance row across all tenants.
-- Tenant admins can read acceptances scoped to courses in their own tenant.
-- Mirrors the helper-function pattern from migration 0015.
DROP POLICY IF EXISTS tos_admin_read ON public.course_tos_acceptances;
CREATE POLICY tos_admin_read ON public.course_tos_acceptances
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.is_tenant_admin()
      AND EXISTS (
        SELECT 1 FROM public.courses c
        WHERE c.id = course_tos_acceptances.course_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );
