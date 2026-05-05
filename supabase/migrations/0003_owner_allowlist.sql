-- 0003_owner_allowlist.sql
-- Owner allow-list: emails in this table are always promoted to super_admin.
-- This survives profile deletion / re-creation, and lets the system owner
-- (and any co-owners added later) sign in from a personal email without
-- losing admin access — even if the database is rebuilt from scratch.

CREATE TABLE IF NOT EXISTS public.owner_emails (
  email text PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT now(),
  note text
);

-- RLS: nobody can read or write this table from the client.
-- Only the SECURITY DEFINER trigger below (and the service role) can touch it.
ALTER TABLE public.owner_emails ENABLE ROW LEVEL SECURITY;

-- Seed the owner.
INSERT INTO public.owner_emails (email, note)
VALUES ('robert.whitaker1728@gmail.com', 'Robert Whitaker - system owner')
ON CONFLICT (email) DO NOTHING;

-- Promote any existing matching profile rows right now.
UPDATE public.profiles
   SET role = 'super_admin'
 WHERE lower(email) IN (SELECT lower(email) FROM public.owner_emails)
   AND role IS DISTINCT FROM 'super_admin';

-- Replace handle_new_user so freshly-created profiles are auto-promoted
-- if their email is on the allow-list. Keeps the existing enrollment behavior.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_owner boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.owner_emails
    WHERE lower(email) = lower(NEW.email)
  ) INTO is_owner;

  INSERT INTO public.profiles (id, email, role)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN is_owner THEN 'super_admin' ELSE 'student' END
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        role  = CASE WHEN is_owner THEN 'super_admin' ELSE public.profiles.role END;

  INSERT INTO public.enrollments (user_id, course_id, status)
  VALUES (NEW.id, 'crypto101', 'in_progress')
  ON CONFLICT (user_id, course_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- To add another permanent admin later:
--   INSERT INTO public.owner_emails (email, note) VALUES ('partner@example.com', 'Co-owner');
--   UPDATE public.profiles SET role = 'super_admin' WHERE lower(email) = 'partner@example.com';
