-- 0033_page_workflow_status.sql
-- Moves the workflow status indicator from lesson-level to page-level so each
-- page can be marked 'working' | 'reviewed' | 'ready' independently. The
-- lesson row in the studio sidebar derives its color from a rollup over its
-- pages (see studio.js lessonRollupStatus). lessons.workflow_status from
-- migration 0032 is intentionally kept for now as a future per-lesson
-- override hook, but it is no longer written from the studio UI.
--
-- RLS: the existing `pages_author_all` policy (see 0010) already covers
-- UPDATE on every column of pages for is_course_author() (incl. super_admin).
-- No new policy is needed; the column inherits the table-level grant.

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS workflow_status text
    CHECK (workflow_status IN ('working', 'reviewed', 'ready'));

COMMENT ON COLUMN public.pages.workflow_status IS
  'Author-facing review state per page: working | reviewed | ready (NULL = neutral). Lesson rollup is computed from these.';

CREATE INDEX IF NOT EXISTS pages_workflow_status_idx
  ON public.pages(workflow_status)
  WHERE workflow_status IS NOT NULL;

-- One-time backfill: propagate any existing lesson-level status down to its
-- pages so authors don't lose visual state when this migration ships. Only
-- touches pages whose workflow_status is still NULL.
UPDATE public.pages p
SET workflow_status = l.workflow_status
FROM public.lessons l
WHERE p.lesson_id = l.id
  AND l.workflow_status IS NOT NULL
  AND p.workflow_status IS NULL;

COMMENT ON COLUMN public.lessons.workflow_status IS
  'DEPRECATED in favor of pages.workflow_status (see migration 0033). Retained as a future manual override hook; the studio sidebar now derives lesson tint from its pages.';
