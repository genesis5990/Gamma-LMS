-- Create public 'course-assets' bucket for images, narration audio, attachments.
-- Public read so /preview/*.html and runtime course pages can <img>/<audio> directly.
-- Write/update/delete restricted to authors via storage policies.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'course-assets',
  'course-assets',
  true,
  52428800,
  ARRAY['image/png','image/jpeg','image/webp','image/gif','image/svg+xml','audio/mpeg','audio/mp4','audio/wav','audio/webm','application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS course_assets_public_read ON storage.objects;
CREATE POLICY course_assets_public_read ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'course-assets');

DROP POLICY IF EXISTS course_assets_author_write ON storage.objects;
CREATE POLICY course_assets_author_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'course-assets' AND public.is_course_author());

DROP POLICY IF EXISTS course_assets_author_update ON storage.objects;
CREATE POLICY course_assets_author_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'course-assets' AND public.is_course_author())
  WITH CHECK (bucket_id = 'course-assets' AND public.is_course_author());

DROP POLICY IF EXISTS course_assets_author_delete ON storage.objects;
CREATE POLICY course_assets_author_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'course-assets' AND public.is_course_author());
