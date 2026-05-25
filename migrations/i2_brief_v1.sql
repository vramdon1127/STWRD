-- ============================================================================
-- I-2: Brief View v1 — daily_briefs snapshot + task source tracking
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   Adds a `daily_briefs` table (one row per user per day, JSONB payload of
--   structured actionables) and three new columns on `tasks` for tracking the
--   origin of a task when it was promoted from a brief item. The new unique
--   index on tasks(user_id, source_dedup_key) prevents the same brief item
--   from being promoted twice.
--
--   This is Phase 1 schema only. Application code lands in subsequent loops.
--
-- WHEN IT RUNS
--   Reviewable code, NOT yet applied. Vijay executes manually in Supabase
--   Studio (SQL editor) for project fnnegalrrdzcgoelljmi. Claude Code does
--   not run this. After running, confirm the post-migration checks below.
--
-- HOW TO ROLL BACK
--   See ROLLBACK section at the bottom. The new table and columns are
--   harmless if unused, so rollback is only needed if you want to fully
--   undo. Uncomment and run.
--
-- KEY DESIGN DECISIONS
--   • daily_briefs.payload is JSONB so the actionables shape can evolve
--     without further migrations.
--   • UNIQUE(user_id, brief_date) lets the digest re-run idempotently via
--     upsert (Prefer: resolution=merge-duplicates).
--   • RLS on daily_briefs allows users to SELECT/UPDATE their own rows.
--     INSERT happens via service role from api/digest.js, which bypasses RLS.
--   • tasks.source_type / source_id record where a promoted task came from
--     (e.g. 'gmail' + thread_id, 'imessage' + thread_id).
--   • tasks.source_dedup_key is the unique-per-brief identifier the client
--     submitted; the partial unique index enforces "promote once". Stale
--     tasks (already STWRD tasks) leave it NULL, so they're not constrained.
--   • IF NOT EXISTS guards make this re-runnable.
--
-- TABLES AFFECTED
--   daily_briefs (new), tasks (3 columns added + 1 index)
--
-- ============================================================================


-- ============================================================================
-- 1. daily_briefs
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.daily_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  brief_date date NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, brief_date)
);

CREATE INDEX IF NOT EXISTS daily_briefs_user_date
  ON public.daily_briefs(user_id, brief_date DESC);

ALTER TABLE public.daily_briefs ENABLE ROW LEVEL SECURITY;

-- SELECT: users read their own brief rows.
DROP POLICY IF EXISTS "users read own briefs" ON public.daily_briefs;
CREATE POLICY "users read own briefs" ON public.daily_briefs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- UPDATE: users update their own brief rows (used by the client to mark
-- items promoted via /api/brief/promote, which runs as the user).
DROP POLICY IF EXISTS "users update own briefs" ON public.daily_briefs;
CREATE POLICY "users update own briefs" ON public.daily_briefs
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No INSERT policy: service role (digest.js) bypasses RLS to write rows.


-- ============================================================================
-- 2. tasks — source tracking columns
-- ============================================================================
--
-- user_id is the existing owner column on tasks (confirmed via i1 migration's
-- RLS policies using `user_id = auth.uid()`).

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS source_dedup_key text;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_dedup
  ON public.tasks(user_id, source_dedup_key)
  WHERE source_dedup_key IS NOT NULL;


-- ============================================================================
-- POST-MIGRATION VERIFICATION (run manually after applying)
-- ============================================================================
-- -- a) daily_briefs exists with expected columns
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'daily_briefs'
-- ORDER BY ordinal_position;
--
-- -- b) RLS is enabled on daily_briefs
-- SELECT relname, relrowsecurity
-- FROM pg_class
-- WHERE relname = 'daily_briefs';
--
-- -- c) tasks has 3 new columns
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'tasks'
--   AND column_name IN ('source_type', 'source_id', 'source_dedup_key')
-- ORDER BY column_name;
--
-- -- d) unique index exists
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE schemaname = 'public' AND indexname = 'tasks_source_dedup';
-- ============================================================================


-- ============================================================================
-- ROLLBACK (commented out — uncomment and run to revert)
-- ============================================================================
-- DROP INDEX IF EXISTS public.tasks_source_dedup;
-- ALTER TABLE public.tasks
--   DROP COLUMN IF EXISTS source_dedup_key,
--   DROP COLUMN IF EXISTS source_id,
--   DROP COLUMN IF EXISTS source_type;
--
-- DROP POLICY IF EXISTS "users update own briefs" ON public.daily_briefs;
-- DROP POLICY IF EXISTS "users read own briefs" ON public.daily_briefs;
-- DROP INDEX IF EXISTS public.daily_briefs_user_date;
-- DROP TABLE IF EXISTS public.daily_briefs;
-- ============================================================================
