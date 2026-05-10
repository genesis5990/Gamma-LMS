-- 0028_access_requests_intake.sql
-- Allow tenant_id to be NULL on access_requests so prospective students who
-- visit the public landing page (no tenant scope) can submit a request that
-- super-admins triage into the right tenant during review.
--
-- The existing access_requests_insert_anon RLS policy already permits any
-- anon/authenticated insert where status='pending' and reviewer fields are
-- null — it does not constrain tenant_id, so making the column nullable is
-- sufficient. Super-admins already see all rows via access_requests_select_admin
-- (is_super_admin() short-circuits the tenant filter), so NULL-tenant rows
-- surface in their queue automatically.

ALTER TABLE public.access_requests
  ALTER COLUMN tenant_id DROP NOT NULL;
