-- ============================================================================
-- 0019_module_appendix.sql
-- 2026-05-07
--
-- Per-module appendix: reference material that learners can open from any
-- page within a module. Authors mix HTML blocks, PDF/DOCX uploads, and
-- external links. Each item belongs to exactly one module.
--
-- Storage: PDF and DOCX files are uploaded to the existing 'course-assets'
-- bucket via the same Media Library path used elsewhere. The DOCX MIME type
-- is added to the bucket allow-list here. The course_assets.kind CHECK
-- constraint already permits 'attachment' which is what we use for both.
--
-- RLS mirrors migration 0015's tenant-scoped author pattern (modules ->
-- course_versions -> courses.tenant_id) for write paths, and adds a learner
-- read path that joins through enrollments.course_id (text) = courses.slug.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.module_appendix_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('html','pdf','docx','link')),
  title text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  body_html text,
  asset_id uuid REFERENCES public.course_assets(id) ON DELETE SET NULL,
  url text,
  description text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_appendix_items_module
  ON public.module_appendix_items(module_id, position);

DROP TRIGGER IF EXISTS module_appendix_items_set_updated_at
  ON public.module_appendix_items;
CREATE TRIGGER module_appendix_items_set_updated_at
  BEFORE UPDATE ON public.module_appendix_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.module_appendix_items ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Author write policy (mirror of pages_author_all in 0015):
-- module_id -> modules -> course_versions -> courses.tenant_id
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS module_appendix_items_author_all ON public.module_appendix_items;
CREATE POLICY module_appendix_items_author_all ON public.module_appendix_items
  FOR ALL TO authenticated
  USING (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.modules m
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE m.id = public.module_appendix_items.module_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_course_author()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.modules m
        JOIN public.course_versions cv ON cv.id = m.course_version_id
        JOIN public.courses c ON c.id = cv.course_id
        WHERE m.id = public.module_appendix_items.module_id
          AND c.tenant_id = public.current_tenant_id()
      )
    )
  );

COMMENT ON POLICY module_appendix_items_author_all ON public.module_appendix_items IS
  'Course authors may CRUD appendix items only within their own tenant. Super admins
   bypass tenant scoping. Mirrors pages_author_all (migration 0015 #5).';

-- ----------------------------------------------------------------------------
-- Learner read policy:
--   * super_admin: all
--   * course author in the same tenant: all (for in-studio preview)
--   * enrolled learner: items belonging to a module of a course they're enrolled in.
--     enrollments.course_id is text and stores the course slug, so we join
--     enrollments.course_id = courses.slug.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS module_appendix_items_learner_read ON public.module_appendix_items;
CREATE POLICY module_appendix_items_learner_read ON public.module_appendix_items
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.modules m
      JOIN public.course_versions cv ON cv.id = m.course_version_id
      JOIN public.courses c ON c.id = cv.course_id
      WHERE m.id = public.module_appendix_items.module_id
        AND (
          (public.is_course_author() AND c.tenant_id = public.current_tenant_id())
          OR EXISTS (
            SELECT 1 FROM public.enrollments e
            WHERE e.user_id = auth.uid()
              AND e.course_id = c.slug
              AND e.status = 'active'
          )
        )
    )
  );

COMMENT ON POLICY module_appendix_items_learner_read ON public.module_appendix_items IS
  'Enrolled learners may SELECT appendix items for modules in courses they are
   actively enrolled in. enrollments.course_id (text) joins to courses.slug.
   Authors within the parent tenant and super admins also have read access
   (covers in-studio preview).';

-- ----------------------------------------------------------------------------
-- Storage: extend the course-assets bucket allow-list to include DOCX.
-- The bucket already accepts PDFs (migration 0012); add Word documents so
-- authors can upload .docx files for appendix entries via the Media Library.
-- ----------------------------------------------------------------------------
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
         'image/png','image/jpeg','image/webp','image/gif','image/svg+xml',
         'audio/mpeg','audio/mp4','audio/wav','audio/webm',
         'application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       ]
 WHERE id = 'course-assets';
