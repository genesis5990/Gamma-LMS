-- =====================================================================
-- 0005_certificates.sql — Phase 2 certificates
--
-- Schema additions:
--   * cert_hash             — SHA-256 of (full_name | course_id | issued_at)
--                             stored as 64-char lowercase hex; unique
--   * recipient_full_name   — name as printed on the cert (frozen at issue)
--   * revoked_at            — timestamptz, nullable; sentinel for revocation
--   * tenant_id             — link cert to issuing tenant
--
-- A separate public.verify_certificate(text) RPC returns a JSON status
-- (`pass` / `revoked` / `not_found`) with the printable fields, so the
-- /verify/<hash> page can call it anonymously without exposing the table.
-- =====================================================================

ALTER TABLE public.certificates
  ADD COLUMN IF NOT EXISTS cert_hash           text,
  ADD COLUMN IF NOT EXISTS recipient_full_name text,
  ADD COLUMN IF NOT EXISTS revoked_at          timestamptz,
  ADD COLUMN IF NOT EXISTS tenant_id           uuid REFERENCES public.tenants(id);

-- Backfill tenant_id from the user's profile
UPDATE public.certificates c
   SET tenant_id = p.tenant_id
  FROM public.profiles p
 WHERE c.user_id = p.id AND c.tenant_id IS NULL;

-- Hash format: 64-char lowercase hex
ALTER TABLE public.certificates
  DROP CONSTRAINT IF EXISTS cert_hash_format;
ALTER TABLE public.certificates
  ADD CONSTRAINT cert_hash_format
  CHECK (cert_hash IS NULL OR cert_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS certificates_cert_hash_uq
  ON public.certificates (cert_hash) WHERE cert_hash IS NOT NULL;

-- Mirror legacy `revoked` flag onto revoked_at if needed
UPDATE public.certificates
   SET revoked_at = now()
 WHERE revoked = true AND revoked_at IS NULL;

-- =====================================================================
-- Verify RPC — public (anon) callable; returns minimal shape only
-- =====================================================================
CREATE OR REPLACE FUNCTION public.verify_certificate(p_hash text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT c.cert_hash,
         c.recipient_full_name,
         c.course_id,
         c.issued_at,
         c.revoked_at,
         c.final_score,
         t.name AS tenant_name,
         t.slug AS tenant_slug
    INTO r
    FROM public.certificates c
    LEFT JOIN public.tenants t ON t.id = c.tenant_id
   WHERE c.cert_hash = lower(p_hash);

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'status',     CASE WHEN r.revoked_at IS NOT NULL THEN 'revoked' ELSE 'pass' END,
    'cert_hash',  r.cert_hash,
    'name',       r.recipient_full_name,
    'course_id',  r.course_id,
    'issued_at',  r.issued_at,
    'revoked_at', r.revoked_at,
    'score',      r.final_score,
    'tenant',     r.tenant_name,
    'tenant_slug', r.tenant_slug
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_certificate(text) TO anon, authenticated;

-- =====================================================================
-- Storage bucket for cert PDFs (private)
-- =====================================================================
-- Create bucket if it doesn't exist. The Edge Function uses the service-role
-- key to upload here; signed URLs are generated when a learner downloads.
INSERT INTO storage.buckets (id, name, public)
VALUES ('certificates', 'certificates', false)
ON CONFLICT (id) DO NOTHING;

-- No public read policy on storage.objects for this bucket (private).
-- The function below issues short-lived signed URLs.

-- =====================================================================
-- RPC: issue_certificate — called by the Edge Function with service role.
-- We compute the canonical hash here so it's the single source of truth,
-- and return the row + computed hash for the function to pass to pdf-lib.
--
-- Inputs:
--   p_user_id   uuid
--   p_full_name text  (recipient as printed)
--   p_course_id text
--   p_score     int
-- Returns: jsonb { id, cert_hash, recipient_full_name, course_id, issued_at,
--                  tenant_slug, tenant_name }
-- =====================================================================
CREATE OR REPLACE FUNCTION public.issue_certificate(
  p_user_id   uuid,
  p_full_name text,
  p_course_id text,
  p_score     int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing  record;
  v_hash      text;
  v_issued    timestamptz := now();
  v_tenant_id uuid;
  v_tenant    record;
  v_id        uuid;
BEGIN
  IF p_full_name IS NULL OR length(trim(p_full_name)) = 0 THEN
    RAISE EXCEPTION 'full_name required';
  END IF;

  -- Idempotency: if a non-revoked cert already exists for this user+course, return it.
  SELECT id, cert_hash, recipient_full_name, course_id, issued_at, tenant_id, pdf_url
    INTO v_existing
    FROM public.certificates
   WHERE user_id = p_user_id AND course_id = p_course_id AND revoked_at IS NULL
   LIMIT 1;

  IF FOUND AND v_existing.cert_hash IS NOT NULL THEN
    SELECT slug, name INTO v_tenant FROM public.tenants WHERE id = v_existing.tenant_id;
    RETURN jsonb_build_object(
      'id',                  v_existing.id,
      'cert_hash',           v_existing.cert_hash,
      'recipient_full_name', v_existing.recipient_full_name,
      'course_id',           v_existing.course_id,
      'issued_at',           v_existing.issued_at,
      'tenant_id',           v_existing.tenant_id,
      'tenant_slug',         v_tenant.slug,
      'tenant_name',         v_tenant.name,
      'pdf_url',             v_existing.pdf_url,
      'reused',              true
    );
  END IF;

  -- Resolve tenant from profile
  SELECT tenant_id INTO v_tenant_id FROM public.profiles WHERE id = p_user_id;

  -- Compute canonical hash: lowercase(SHA-256( name | course_id | issued_at_iso ))
  v_hash := encode(
    digest(
      trim(p_full_name) || '|' || p_course_id || '|' || to_char(v_issued AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'sha256'
    ),
    'hex'
  );

  IF FOUND AND v_existing.id IS NOT NULL THEN
    -- Existing row but no hash — populate it
    UPDATE public.certificates
       SET cert_hash           = v_hash,
           recipient_full_name = trim(p_full_name),
           final_score         = COALESCE(p_score, final_score),
           issued_at           = v_issued,
           tenant_id           = COALESCE(tenant_id, v_tenant_id)
     WHERE id = v_existing.id
     RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.certificates
      (user_id, course_id, final_score, recipient_full_name, cert_hash, issued_at, tenant_id)
    VALUES
      (p_user_id, p_course_id, p_score, trim(p_full_name), v_hash, v_issued, v_tenant_id)
    RETURNING id INTO v_id;
  END IF;

  SELECT slug, name INTO v_tenant FROM public.tenants WHERE id = v_tenant_id;

  RETURN jsonb_build_object(
    'id',                  v_id,
    'cert_hash',           v_hash,
    'recipient_full_name', trim(p_full_name),
    'course_id',           p_course_id,
    'issued_at',           v_issued,
    'tenant_id',           v_tenant_id,
    'tenant_slug',         v_tenant.slug,
    'tenant_name',         v_tenant.name,
    'reused',              false
  );
END;
$$;

-- Only callable by service role (Edge Function). Don't expose to anon/authenticated.
REVOKE EXECUTE ON FUNCTION public.issue_certificate(uuid, text, text, int) FROM anon, authenticated, public;

-- Required extension for digest()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
