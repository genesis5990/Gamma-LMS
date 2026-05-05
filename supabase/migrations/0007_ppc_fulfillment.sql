-- =====================================================================
-- 0007_ppc_fulfillment.sql — Phase 3.5
--
-- Catch-up logic for pay-per-course (PPC) fulfillment when a new auth.users
-- row is created (e.g., via magic link issued by the Stripe webhook for a
-- guest buyer). The webhook itself handles the synchronous case (link the
-- purchase + insert enrollment when the user already exists). This trigger
-- handles the new-user case: as soon as Supabase creates the auth row, we
-- backfill purchases.user_id and grant enrollments for any paid courses
-- already on file under the buyer's email.
--
-- Idempotent — safe to re-run. The function body is replaced wholesale.
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

    -- PPC fulfillment catch-up (Phase 3.5)
    UPDATE public.purchases
       SET user_id = NEW.id
     WHERE lower(email::text) = lower(NEW.email)
       AND user_id IS NULL
       AND status = 'paid';

    INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
    SELECT NEW.id, course_id, 'active', NULL
      FROM public.purchases
     WHERE user_id = NEW.id
       AND status = 'paid'
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

      -- PPC fulfillment catch-up (Phase 3.5)
      UPDATE public.purchases
         SET user_id = NEW.id
       WHERE lower(email::text) = lower(NEW.email)
         AND user_id IS NULL
         AND status = 'paid';

      INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
      SELECT NEW.id, course_id, 'active', NULL
        FROM public.purchases
       WHERE user_id = NEW.id
         AND status = 'paid'
      ON CONFLICT (user_id, course_id) DO NOTHING;

      RETURN NEW;
    ELSE
      -- request_approval / invite_only — owner allow-list gets through; everyone else blocked
      IF is_owner THEN
        INSERT INTO public.profiles (id, email, role, tenant_id)
        VALUES (NEW.id, NEW.email, 'super_admin', v_tenant_id)
        ON CONFLICT (id) DO UPDATE
          SET email = EXCLUDED.email, role = 'super_admin', tenant_id = EXCLUDED.tenant_id;

        -- PPC fulfillment catch-up (Phase 3.5)
        UPDATE public.purchases
           SET user_id = NEW.id
         WHERE lower(email::text) = lower(NEW.email)
           AND user_id IS NULL
           AND status = 'paid';

        INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
        SELECT NEW.id, course_id, 'active', NULL
          FROM public.purchases
         WHERE user_id = NEW.id
           AND status = 'paid'
        ON CONFLICT (user_id, course_id) DO NOTHING;

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

  -- PPC fulfillment catch-up (Phase 3.5) — primary site for guest buyers
  UPDATE public.purchases
     SET user_id = NEW.id
   WHERE lower(email::text) = lower(NEW.email)
     AND user_id IS NULL
     AND status = 'paid';

  INSERT INTO public.enrollments (user_id, course_id, status, tenant_id)
  SELECT NEW.id, course_id, 'active', NULL
    FROM public.purchases
   WHERE user_id = NEW.id
     AND status = 'paid'
  ON CONFLICT (user_id, course_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
