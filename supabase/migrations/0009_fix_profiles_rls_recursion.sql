-- Fix infinite recursion in 'tenant admin read profiles' policy.
--
-- The previous policy did:
--   EXISTS (SELECT 1 FROM profiles me WHERE me.id = auth.uid() AND me.role = 'tenant_admin' ...)
-- which causes RLS to evaluate profiles' own policies recursively while
-- already evaluating a read on profiles -- Postgres detects the loop and
-- raises 'infinite recursion detected in policy for relation "profiles"'.
--
-- The fix: rewrite using SECURITY DEFINER helpers (is_tenant_admin(),
-- current_tenant_id()) which bypass RLS internally, so policy evaluation
-- stays bounded.

DROP POLICY IF EXISTS "tenant admin read profiles" ON public.profiles;

CREATE POLICY "tenant admin read profiles"
  ON public.profiles
  FOR SELECT
  USING (
    is_super_admin()
    OR (
      is_tenant_admin()
      AND tenant_id IS NOT NULL
      AND tenant_id = current_tenant_id()
    )
  );

COMMENT ON POLICY "tenant admin read profiles" ON public.profiles IS
  'Allow super_admin to read all profiles, and tenant_admin to read profiles in their own tenant. Uses SECURITY DEFINER helpers to avoid recursion (see migration 0009).';
