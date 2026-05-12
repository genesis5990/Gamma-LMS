-- 0032_lesson_workflow_status.sql
-- Adds a three-state workflow status indicator to lessons so admins/course
-- authors can mark each lesson as 'working', 'reviewed', or 'ready' from the
-- studio. NULL = neutral (no status set). Tinting in the studio sidebar
-- gives an at-a-glance view of edit/review progress across a course.
--
-- RLS: the existing `lessons_author_all` policy (see 0010) already covers
-- UPDATE on every column of lessons for callers passing is_course_author()
-- (which includes super_admins). No new policy is required; the column
-- inherits the table-level grant. This migration is intentionally narrow.

ALTER TABLE public.lessons
  ADD COLUMN IF NOT EXISTS workflow_status text
    CHECK (workflow_status IN ('working', 'reviewed', 'ready'));

COMMENT ON COLUMN public.lessons.workflow_status IS
  'Author-facing review state: working | reviewed | ready (NULL = neutral). Set from studio toolbar; tints the lesson row in the outline tree.';

CREATE INDEX IF NOT EXISTS lessons_workflow_status_idx
  ON public.lessons(workflow_status)
  WHERE workflow_status IS NOT NULL;
