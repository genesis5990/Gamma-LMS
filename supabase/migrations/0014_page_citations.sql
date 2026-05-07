-- 0014_page_citations.sql
-- Adds a JSONB array of structured citations to each page.
-- Each citation: {id, title, authors, source, url, year, notes}
-- Position in the array is the citation number (1-indexed).
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS citations jsonb NOT NULL DEFAULT '[]'::jsonb;
