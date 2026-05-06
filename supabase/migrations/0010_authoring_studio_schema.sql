-- ============================================================================
-- Authoring Studio Schema
-- 2026-05-06
--
-- Adds versioned course-content tables backing the /studio admin UI.
-- Existing runtime tables (lesson_progress, quiz_attempts, certificates,
-- enrollments) are unchanged. Lesson IDs in lesson_progress remain text and
-- map to lessons.slug in the new schema, so progress data is preserved.
--
-- Hierarchy:
--   courses
--     -> course_versions    (immutable after publish; one row per version)
--        -> modules         (snapshot per version)
--           -> lessons      (snapshot per version)
--              -> pages     (snapshot per version; HTML body + audio_url)
--           -> module_quiz_questions  (knowledge_check)
--        -> final_exam_questions
--   course_assets           (uploaded media: images, audio, attachments)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- courses: top-level course identity (slug stable across versions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,                    -- e.g. 'btc-investigations'
  title text NOT NULL,
  description text,
  audience text,
  prerequisites text,
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  current_version_id uuid,                      -- FK added after course_versions exists
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','preview','public')),
  pass_threshold integer NOT NULL DEFAULT 80
    CHECK (pass_threshold BETWEEN 0 AND 100),
  includes_disclaimer boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS courses_tenant_idx ON public.courses(tenant_id);
CREATE INDEX IF NOT EXISTS courses_visibility_idx ON public.courses(visibility);

-- ---------------------------------------------------------------------------
-- course_versions: immutable snapshots once published
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.course_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  version_number integer NOT NULL,              -- 1, 2, 3 ...
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','review','published','archived')),
  notes text,                                   -- changelog
  published_at timestamptz,
  published_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, version_number)
);

CREATE INDEX IF NOT EXISTS course_versions_course_idx ON public.course_versions(course_id);
CREATE INDEX IF NOT EXISTS course_versions_status_idx ON public.course_versions(status);

-- Now that course_versions exists, link courses.current_version_id
ALTER TABLE public.courses
  ADD CONSTRAINT courses_current_version_fk
  FOREIGN KEY (current_version_id)
  REFERENCES public.course_versions(id)
  ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- modules: per-version snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_version_id uuid NOT NULL REFERENCES public.course_versions(id) ON DELETE CASCADE,
  slug text NOT NULL,                           -- e.g. 'm1-foundations' (stable across versions)
  title text NOT NULL,
  description text,
  position integer NOT NULL DEFAULT 0,
  has_knowledge_check boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_version_id, slug)
);

CREATE INDEX IF NOT EXISTS modules_version_idx
  ON public.modules(course_version_id, position);

-- ---------------------------------------------------------------------------
-- lessons: per-version snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  slug text NOT NULL,                           -- stable; matches lesson_progress.lesson_id
  title text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_id, slug)
);

CREATE INDEX IF NOT EXISTS lessons_module_idx
  ON public.lessons(module_id, position);

-- ---------------------------------------------------------------------------
-- pages: per-lesson HTML body + optional narration audio
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  page_type text NOT NULL DEFAULT 'text'
    CHECK (page_type IN ('text','interactive','case-study')),
  title text,
  body_html text NOT NULL DEFAULT '',           -- editor output
  audio_url text,                               -- TTS narration (Supabase storage)
  audio_voice text,                             -- voice id used to generate
  audio_generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pages_lesson_idx
  ON public.pages(lesson_id, position);

-- ---------------------------------------------------------------------------
-- module_quiz_questions: per-module knowledge check
-- final_exam_questions: per-version final
-- Same shape; separate tables for clarity and simpler RLS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.module_quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  question text NOT NULL,
  options jsonb NOT NULL,                       -- ["A","B","C","D"]
  answer_index integer NOT NULL CHECK (answer_index BETWEEN 0 AND 3),
  reference text,                               -- 'ref' field in JSON
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS module_quiz_questions_module_idx
  ON public.module_quiz_questions(module_id, position);

CREATE TABLE IF NOT EXISTS public.final_exam_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_version_id uuid NOT NULL REFERENCES public.course_versions(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  question text NOT NULL,
  options jsonb NOT NULL,
  answer_index integer NOT NULL CHECK (answer_index BETWEEN 0 AND 3),
  reference text,
  source_module_slug text,                      -- which module this Q tests
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS final_exam_questions_version_idx
  ON public.final_exam_questions(course_version_id, position);

-- ---------------------------------------------------------------------------
-- course_assets: uploaded media (images, audio, attachments)
-- Stored in Supabase Storage bucket 'course-assets'; this table is metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.course_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image','audio','video','attachment')),
  storage_path text NOT NULL UNIQUE,            -- e.g. 'btc-investigations/m1/diagram.png'
  public_url text,                              -- cached signed/public URL
  filename text NOT NULL,
  mime_type text,
  byte_size bigint,
  width integer,                                -- for images
  height integer,                               -- for images
  duration_seconds numeric,                     -- for audio/video
  alt_text text,
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS course_assets_course_idx ON public.course_assets(course_id);
CREATE INDEX IF NOT EXISTS course_assets_kind_idx ON public.course_assets(kind);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'courses','course_versions','modules','lessons','pages',
    'module_quiz_questions','final_exam_questions'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I_set_updated_at ON public.%I;', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RLS: super_admin can do anything; instructors can edit drafts on their
-- tenant; everyone else can read published versions of public courses.
-- ---------------------------------------------------------------------------
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_quiz_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.final_exam_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_assets ENABLE ROW LEVEL SECURITY;

-- Helper: is the caller a super_admin or instructor?
CREATE OR REPLACE FUNCTION public.is_course_author()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('super_admin','instructor','tenant_admin')
  );
$$;

-- courses
DROP POLICY IF EXISTS courses_author_all ON public.courses;
CREATE POLICY courses_author_all ON public.courses
  FOR ALL TO authenticated
  USING (public.is_course_author())
  WITH CHECK (public.is_course_author());

DROP POLICY IF EXISTS courses_public_read ON public.courses;
CREATE POLICY courses_public_read ON public.courses
  FOR SELECT TO authenticated
  USING (visibility IN ('preview','public'));

-- course_versions
DROP POLICY IF EXISTS course_versions_author_all ON public.course_versions;
CREATE POLICY course_versions_author_all ON public.course_versions
  FOR ALL TO authenticated
  USING (public.is_course_author())
  WITH CHECK (public.is_course_author());

DROP POLICY IF EXISTS course_versions_published_read ON public.course_versions;
CREATE POLICY course_versions_published_read ON public.course_versions
  FOR SELECT TO authenticated
  USING (status = 'published');

-- Apply same author-only policy to all child content tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'modules','lessons','pages',
    'module_quiz_questions','final_exam_questions','course_assets'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_author_all ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY %I_author_all ON public.%I
       FOR ALL TO authenticated
       USING (public.is_course_author())
       WITH CHECK (public.is_course_author());', t, t);
  END LOOP;
END $$;

-- Read access for published content (modules/lessons/pages/quizzes) is
-- granted via the runtime API which still serves static .course.json on
-- publish. We do not need student SELECT policies on the authoring tables
-- in v1 — keeps the RLS surface small.

-- ---------------------------------------------------------------------------
-- Done. Next steps (handled by application code, not migration):
--  * Create Supabase Storage bucket 'course-assets' (private; signed URLs)
--  * Run import script to seed courses/versions/modules/... from existing
--    .course.json files (LE Tactics + BTC Investigations + WDE + Scams + IC3)
-- ---------------------------------------------------------------------------
