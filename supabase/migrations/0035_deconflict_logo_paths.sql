-- 0035_deconflict_logo_paths.sql
--
-- v0.4.94 brand rebrand: point the Deconflict tenant at the new canonical
-- logo assets and correct the on-light vs on-dark semantics.
--
-- Semantics:
--   logo_url       = on-light surfaces, uses dark fills (Logo-With-Text-White.svg)
--   logo_url_white = on-dark  surfaces, uses light fills (Logo-With-Text.svg)
--
-- The prior Deconflict row had these swapped; this migration fixes them.
-- Idempotent: re-running is safe (UPDATE with stable target values).

UPDATE public.tenants
SET logo_url       = '/assets/tenants/deconflict/Logo-With-Text-White.svg',
    logo_url_white = '/assets/tenants/deconflict/Logo-With-Text.svg'
WHERE slug = 'deconflict';
