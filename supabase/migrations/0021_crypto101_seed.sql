-- 0021_crypto101_seed.sql
-- ============================================================================
-- Marker migration for the Crypto 101 course seed (v0.4.43).
--
-- The actual data import is performed by `scripts/seed_crypto101.mjs`, which
-- reads `public/course_data.json` and inserts rows into:
--   - courses (1 row, slug='crypto101')
--   - course_versions (1 row)
--   - modules (3 rows: foundations, bitcoin-genesis, bitcoin-standard)
--   - lessons (18 rows)
--   - pages (~61 rows; counted from per-lesson page arrays)
--   - module_quiz_questions (~67 rows; ~16 m1, ~16 m2, ~11 m3 — one per legacy
--     lesson quiz, A/B/C/D choices, answer_index 0..3, reference text preserved)
--
-- The script uses the Supabase service-role key over PostgREST (bypassing RLS)
-- and is idempotent on slug='crypto101' (deletes the existing course/cascade
-- before re-inserting). Embedding the 143 KB JSON as a jsonb literal in this
-- migration was the original plan, but writing the import as a Node script
-- keeps the SQL audit log clean and lets us re-run the import without
-- introducing a new migration row each time.
--
-- This file is a no-op so the supabase migrations table records that the seed
-- step has been completed in lockstep with the v0.4.43 release commit.
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'crypto101 seed marker — actual data inserted by scripts/seed_crypto101.mjs';
END $$;
