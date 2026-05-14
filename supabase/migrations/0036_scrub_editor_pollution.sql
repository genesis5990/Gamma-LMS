-- 0036_scrub_editor_pollution.sql
-- v0.4.95: one-time cleanup of inline style pollution in pages.body_html.
-- These declarations were dropped into the document by Google Docs / Notion /
-- Outlook web pastes when the editor's paste cleaner only triggered on
-- Microsoft Office signatures. The toolbar code in v0.4.94 wrapped a new
-- outer span on top of these inner spans, so font and size picks had no
-- visible effect on affected pages. v0.4.95 fixes the toolbar logic AND
-- broadens the paste cleaner, but existing pages still carry the residue.
--
-- This migration was already applied to production via Supabase MCP at the
-- time of the v0.4.95 deploy. Keeping it here for migration history.
--
-- Strips:
--   font-family|size|weight|style: inherit
--   font-variant-ligatures|caps|numeric: ...
--   line-height: ...   (only when inside the same declaration block)
--   empty style="" attributes
--   <span> wrappers that end up with no attributes and only text content

BEGIN;

WITH targets AS (
  SELECT id, body_html FROM public.pages
  WHERE body_html ~ 'font-(family|size|weight|style)\s*:\s*inherit'
     OR body_html ~ 'font-variant-(ligatures|caps|numeric)\s*:'
),
scrubbed AS (
  SELECT id,
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
      body_html,
      'font-(family|size|weight|style)\s*:\s*inherit\s*;?\s*', '', 'gi'
    ),
    'font-variant-[a-z-]+\s*:\s*[^;"]+;?\s*', '', 'gi'
    ),
    'style="\s*"', '', 'gi'
    ),
    '<span\s+>', '<span>', 'gi'
    ),
    '<span>([^<]*)</span>', '\1', 'gi'
    ),
    '<span>([^<]*)</span>', '\1', 'gi'
    ) AS new_html
  FROM targets
)
UPDATE public.pages p
SET body_html = s.new_html,
    updated_at = now()
FROM scrubbed s
WHERE p.id = s.id;

-- Tidy leftover whitespace inside opening tags (e.g. "<strong >" becomes "<strong>")
UPDATE public.pages
SET body_html = regexp_replace(body_html, '<(\w+)\s+>', '<\1>', 'gi'),
    updated_at = now()
WHERE body_html ~ '<\w+\s+>';

COMMIT;
