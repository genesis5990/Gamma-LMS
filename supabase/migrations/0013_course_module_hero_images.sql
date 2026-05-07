-- ============================================================================
-- Course + Module hero images and rich-text directions
-- 2026-05-07
--
-- Adds hero image support and a rich-text "directions" body to the course
-- title page and each module title page. The legacy `description` columns
-- stay intact for backwards compatibility / search; renderers prefer
-- `description_html` when present and fall back to `description` otherwise.
-- ============================================================================

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS hero_image_url   text;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS hero_image_alt   text;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS description_html text;

ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS hero_image_url   text;
ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS hero_image_alt   text;
ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS description_html text;
