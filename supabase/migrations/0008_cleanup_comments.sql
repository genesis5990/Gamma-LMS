-- =====================================================================
-- 0008_cleanup_comments.sql — Phase 4B
--
-- Pure cleanup migration. NO behavior changes. Adds:
--   * profiles.metadata (jsonb) — used by the tenant_admin welcome modal
--     ("welcome_modal_seen_at") and reserved for future per-user UI state.
--   * COMMENT ON TABLE / COLUMN docs for tables created in 0006/0007 that
--     were missing them (access_requests, invitations, purchases).
--   * COMMENT ON FUNCTION docs for the gating + PPC functions.
--   * public._fulfill_pending_purchases(p_user_id, p_email) — helper that
--     captures the four-times-duplicated PPC catch-up block from 0007 into
--     a single function. handle_new_user() is then re-CREATEd to call it
--     from each of the four RETURN-NEW paths. SQL semantics are identical
--     to the inline blocks in 0007: the same UPDATE (link purchases by
--     email) followed by the same INSERT (enrollments from paid purchases).
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------- profiles.metadata ----------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.metadata IS
  'Free-form per-user UI/preferences state (jsonb). '
  'Currently used keys: welcome_modal_seen_at (ISO timestamp set when a '
  'tenant_admin/super_admin dismisses the post-login welcome modal).';

-- ---------- Table comments ----------
COMMENT ON TABLE public.access_requests IS
  'Phase 3 — anonymous access requests submitted from gated tenant landing '
  'pages. Reviewed by tenant_admin/super_admin via approve_access_request / '
  'deny_access_request RPCs. Approval mints a 30-day invitation row.';

COMMENT ON COLUMN public.access_requests.tenant_id    IS 'Tenant the requester is asking to join.';
COMMENT ON COLUMN public.access_requests.email        IS 'citext (case-insensitive) email of the requesting officer.';
COMMENT ON COLUMN public.access_requests.status       IS 'pending | approved | denied — drives admin review queue.';
COMMENT ON COLUMN public.access_requests.reviewed_by  IS 'auth.users.id of the admin who approved/denied.';
COMMENT ON COLUMN public.access_requests.deny_reason  IS 'Free-text reason shown to requester on denial (optional).';

COMMENT ON TABLE public.invitations IS
  'Phase 3 — pending magic-link invitations for tenant onboarding. Created '
  'directly by admins (admin_invite) or auto-created by approve_access_request '
  '(approved_request). Consumed by handle_new_user() on first sign-in: '
  'matched by email, marks accepted_at, assigns tenant + role to the new profile.';

COMMENT ON COLUMN public.invitations.tenant_id   IS 'Tenant the invitee will be assigned to.';
COMMENT ON COLUMN public.invitations.email       IS 'citext email; unique-per-tenant while accepted_at is null.';
COMMENT ON COLUMN public.invitations.role        IS 'Role to assign on acceptance: student | tenant_admin.';
COMMENT ON COLUMN public.invitations.source      IS 'admin_invite (manual) | approved_request (from access_requests).';
COMMENT ON COLUMN public.invitations.request_id  IS 'FK back to access_requests when source = approved_request.';
COMMENT ON COLUMN public.invitations.expires_at  IS '30-day TTL by default; handle_new_user() rejects expired invites.';
COMMENT ON COLUMN public.invitations.accepted_at IS 'Set by handle_new_user() when the invitee first signs in.';

COMMENT ON TABLE public.purchases IS
  'Phase 3 — Stripe pay-per-course (PPC) purchase records. Inserted by the '
  '/api/checkout endpoint (status=pending) and updated by the Stripe webhook '
  '(status=paid + paid_at). user_id is NULL for guest buyers until '
  'handle_new_user() / _fulfill_pending_purchases backfills it on first sign-in.';

COMMENT ON COLUMN public.purchases.user_id           IS 'Backfilled to auth.users.id once the buyer signs in (Phase 3.5 catch-up).';
COMMENT ON COLUMN public.purchases.email             IS 'citext buyer email captured at checkout — the join key for catch-up.';
COMMENT ON COLUMN public.purchases.course_id         IS 'Course slug (e.g. crypto101). Determines which enrollment is granted.';
COMMENT ON COLUMN public.purchases.stripe_session_id IS 'Stripe Checkout Session id; UNIQUE — webhook idempotency key.';
COMMENT ON COLUMN public.purchases.status            IS 'pending | paid | refunded | failed.';

-- ---------- Function/RPC purpose docs ----------
COMMENT ON FUNCTION public.approve_access_request(uuid) IS
  'Phase 3 — admin RPC: approves a pending access_requests row, upserts a '
  '30-day invitation, and returns identifying fields the Edge Function uses '
  'to send the welcome email. Authorization: super_admin OR tenant_admin '
  'whose current_tenant_id matches the request.';

COMMENT ON FUNCTION public.deny_access_request(uuid, text) IS
  'Phase 3 — admin RPC: marks a pending access_requests row as denied with '
  'an optional reason. Returns fields used by the deny-email Edge Function. '
  'Same authorization rules as approve_access_request.';

-- =====================================================================
-- _fulfill_pending_purchases helper
--
-- Extracts the four-times-duplicated PPC catch-up block from 0007's
-- handle_new_user(). The two statements (UPDATE + INSERT…SELECT) are
-- byte-for-byte the same operation that 0007 inlines at each RETURN NEW
-- site, just parameterised on (user_id, email). Calling it once per
-- code path produces identical row writes to the inline version.
-- =====================================================================
CREATE OR REPLACE FUNCTION public._fulfill_pending_purchases(
  p_user_id uuid,
  p_email   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Link prior guest purchases (user_id was NULL because they paid before signup).
  UPDATE public.purchases
     SET user_id = p_user_id
   WHERE lower(email::text) = lower(p_email)
     AND user_id IS NULL
     AND status  = 'paid';

  -- Grant enrollments for any paid courses now linked to this user.
  INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
  SELECT p_user_id, course_id, 'active', NULL
    FROM public.purchases
   WHERE user_id = p_user_id
     AND status  = 'paid'
  ON CONFLICT (user_id, course_id) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public._fulfill_pending_purchases(uuid, text) IS
  'Phase 3.5 PPC catch-up helper, extracted from 0007. Links any guest '
  'purchases.email → user_id and grants enrollments for paid courses. '
  'Called from each RETURN-NEW path of handle_new_user() so a buyer who '
  'pays before signing up still gets their course access on first login.';

-- =====================================================================
-- handle_new_user — re-CREATEd to call _fulfill_pending_purchases
-- instead of inlining the same block four times. Logic is unchanged.
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

    PERFORM public._fulfill_pending_purchases(NEW.id, NEW.email);
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

      PERFORM public._fulfill_pending_purchases(NEW.id, NEW.email);
      RETURN NEW;
    ELSE
      -- request_approval / invite_only — owner allow-list gets through; everyone else blocked
      IF is_owner THEN
        INSERT INTO public.profiles (id, email, role, tenant_id)
        VALUES (NEW.id, NEW.email, 'super_admin', v_tenant_id)
        ON CONFLICT (id) DO UPDATE
          SET email = EXCLUDED.email, role = 'super_admin', tenant_id = EXCLUDED.tenant_id;

        PERFORM public._fulfill_pending_purchases(NEW.id, NEW.email);
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

  PERFORM public._fulfill_pending_purchases(NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'auth.users INSERT trigger handler. Resolution order: owner allow-list → '
  'invitation match → domain match (open/domain_allowlist auto-join, '
  'request_approval/invite_only RAISE EXCEPTION) → neutral/PPC profile. '
  'After every accepted path, calls _fulfill_pending_purchases() so a '
  'guest who paid before signing up gets their PPC enrollment on first login.';

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
