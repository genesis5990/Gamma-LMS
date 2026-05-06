-- Pin search_path on set_updated_at and revoke anon EXECUTE on is_course_author
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.is_course_author() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_course_author() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_course_author() TO authenticated;
