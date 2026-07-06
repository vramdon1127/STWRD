-- ============================================================================
-- I-3: tasks.project guard — trigger enforcing project names against projects
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   Adds a BEFORE INSERT OR UPDATE trigger on `tasks` that validates
--   NEW.project against the owning user's rows in `projects`. Any project
--   value not found there is rewritten to 'Personal'. This makes free-text
--   project writes impossible at the database level, regardless of what the
--   Claude categorization call returns or which client performs the write.
--
--   Context: task rows are inserted directly from the browser via Supabase
--   REST (index.html saveTask → /rest/v1/tasks), so there is no server hop
--   where validation could live. The client validates too (processTask), but
--   this trigger is the airtight guard.
--
-- WHEN IT RUNS
--   Reviewable code, NOT yet applied. Vijay executes manually in Supabase
--   Studio (SQL editor) for project fnnegalrrdzcgoelljmi. Claude Code does
--   not run this. After running, confirm the post-migration checks below.
--
-- HOW TO ROLL BACK
--   See ROLLBACK section at the bottom.
--
-- KEY DESIGN DECISIONS
--   • NULL project is left untouched — the guard only rewrites non-NULL
--     values that don't match a real project.
--   • On UPDATE the guard only runs when project actually changed
--     (IS DISTINCT FROM), so unrelated PATCHes (status, priority, due_date)
--     never re-validate or rewrite an existing project value.
--   • Fallback is the literal 'Personal', matching the client-side fallback
--     and api/brief/promote.js. If a user has no project named 'Personal',
--     the stored value is still 'Personal' (rendered as an orphan project in
--     the UI, same as tasks from deleted projects today).
--   • SECURITY DEFINER with a pinned search_path so the projects lookup is
--     not subject to the caller's RLS visibility — the check is against
--     NEW.user_id's projects, which may differ from the authenticated user
--     under partnership RLS (i1).
--   • DROP ... IF EXISTS guards make this re-runnable.
--
-- TABLES AFFECTED
--   tasks (1 trigger added), projects (read-only lookup)
--
-- ============================================================================


-- ============================================================================
-- 1. Guard function
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_task_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL project is allowed through untouched.
  IF NEW.project IS NULL THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only validate when the project value actually changed.
  IF TG_OP = 'UPDATE' AND NEW.project IS NOT DISTINCT FROM OLD.project THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.user_id = NEW.user_id
      AND p.name = NEW.project
  ) THEN
    NEW.project := 'Personal';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_task_project() IS
  'Rewrites tasks.project to ''Personal'' when the value does not match any '
  'projects.name row for tasks.user_id. Backstop for free-text project values '
  'from the Claude categorization call (tasks are inserted directly from the '
  'browser, so this is the only non-bypassable guard).';


-- ============================================================================
-- 2. Trigger
-- ============================================================================

DROP TRIGGER IF EXISTS tasks_project_guard ON public.tasks;

CREATE TRIGGER tasks_project_guard
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_task_project();


-- ============================================================================
-- POST-MIGRATION CHECKS (run in Studio after applying)
-- ============================================================================
--
-- 1. Trigger exists:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.tasks'::regclass AND tgname = 'tasks_project_guard';
--
-- 2. Invalid project is rewritten (replace <uid> with your user id):
--    INSERT INTO public.tasks (user_id, content, project, status)
--    VALUES ('<uid>', 'guard smoke test', 'NotARealProject', 'todo')
--    RETURNING project;  -- expect 'Personal'
--    Then delete the smoke-test row.
--
-- 3. Valid project passes through unchanged:
--    same INSERT with project = 'ServeAnts' → expect 'ServeAnts'.
--
-- ============================================================================
-- ROLLBACK (uncomment and run to fully undo)
-- ============================================================================
--
-- DROP TRIGGER IF EXISTS tasks_project_guard ON public.tasks;
-- DROP FUNCTION IF EXISTS public.enforce_task_project();
