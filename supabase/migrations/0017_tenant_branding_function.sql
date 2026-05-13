-- ============================================================================
-- Migration 0017: Replace tenants_public view with a SECURITY DEFINER function.
--
-- Why: Supabase linter (0010_security_definer_view) flags the existing
-- public.tenants_public view because the view runs with the owner's
-- privileges rather than the caller's. The original design (migration 0015
-- section #8) is correct in intent: anon callers need a few branding fields
-- (logo, colors, slug, name) from public.tenants without being able to read
-- the table's sensitive columns (billing_status, contact_email,
-- email_domains, use_subdomain, created_at). A plain SECURITY INVOKER view
-- would require granting anon a row-level SELECT policy on public.tenants,
-- which would expose ALL columns through PostgREST.
--
-- Fix: replace the view with a SECURITY DEFINER function. Functions can be
-- granted EXECUTE narrowly, and the function body controls exactly which
-- columns are returned.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_tenant_branding(p_slug text)
RETURNS TABLE (
  id               uuid,
  slug             text,
  name             text,
  logo_url         text,
  logo_url_white   text,
  primary_color    text,
  secondary_color  text,
  enrollment_mode  text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    t.id,
    t.slug,
    t.name,
    t.logo_url,
    t.logo_url_white,
    t.primary_color,
    t.secondary_color,
    t.enrollment_mode
  FROM public.tenants t
  WHERE t.slug = p_slug
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_tenant_branding(text) IS
  'Anon-safe branding lookup by slug. SECURITY DEFINER so callers do not need RLS read access to public.tenants. Returns only id, slug, name, logo_url, logo_url_white, primary_color, secondary_color, enrollment_mode. NOT returned: billing_status, contact_email, email_domains, use_subdomain, created_at. Replaces the public.tenants_public view (migration 0017).';

REVOKE ALL ON FUNCTION public.get_tenant_branding(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tenant_branding(text) TO anon, authenticated;

DROP VIEW IF EXISTS public.tenants_public;
