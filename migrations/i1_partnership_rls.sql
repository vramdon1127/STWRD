-- ============================================================================
-- I-1: Partnership-aware Row Level Security
-- ============================================================================
--
-- WHAT THIS MIGRATION DOES
--   Replaces own-data-only RLS on tasks, projects, life_categories, knowledge,
--   and corrections with partnership-aware policies. After running, two users
--   linked via a row in `partnerships` (status='active') can SELECT, UPDATE,
--   and DELETE each other's rows. INSERT remains strict — you can only create
--   rows owned by yourself.
--
--   Implements decision Q5 from Loop I-0 (full-collab partner view) for the
--   five user-scoped tables. partnerships and profiles are intentionally NOT
--   touched in this migration — they have their own concerns and policies.
--
-- WHEN IT RUNS
--   This file is reviewable code, NOT yet applied to any database. Execute
--   manually in Supabase Studio (SQL editor) after:
--     1. Reviewing the pre-flight policy enumeration below
--     2. Confirming the dynamic DROP block is acceptable for the five tables
--     3. Taking a backup or working in a non-prod project first
--
-- HOW TO ROLL BACK
--   Uncomment the rollback section at the bottom of this file and run it.
--   The rollback drops the partner_* policies, drops the helper function,
--   and re-creates own-only policies with predictable names. If your prior
--   policies had specific names you want to restore, adjust the rollback
--   section before running.
--
-- KEY DESIGN DECISIONS (for reviewer)
--   • Helper function `is_partner_or_self(uuid)` centralizes the JOIN logic.
--     Marked SECURITY DEFINER + STABLE so it (a) bypasses the caller's
--     partnerships RLS to read the link, and (b) is planner-cacheable for
--     row-level evaluation. search_path is pinned for security.
--   • INSERT is STRICT: WITH CHECK (user_id = auth.uid()). Partner cannot
--     create rows on the other's behalf. Easier to relax later than to
--     tighten. Revisit this if capture-from-partner-view becomes a feature.
--   • SELECT/UPDATE/DELETE all gate via is_partner_or_self(user_id).
--   • UPDATE has both USING and WITH CHECK set to the same predicate so the
--     post-update row stays inside the partnership's view (prevents updating
--     user_id to a value outside the partnership).
--   • Existing policies on each target table are dropped wholesale via a
--     dynamic DO block. This is intentional — every prior own-only policy
--     is being replaced. If you have policies on these tables you want to
--     KEEP (e.g. service-role bypass), enumerate them first via the pre-flight
--     query and adjust the DROP block to skip them.
--
-- TABLES AFFECTED
--   tasks, projects, life_categories, knowledge, corrections
--
-- TABLES NOT TOUCHED
--   partnerships, profiles, auth.users, anything else
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PRE-FLIGHT (run this first, manually, to see what's about to be dropped)
-- ----------------------------------------------------------------------------
-- SELECT schemaname, tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('tasks', 'projects', 'life_categories', 'knowledge', 'corrections')
-- ORDER BY tablename, policyname;
--
-- Review the output. The dynamic DROP block below will remove ALL of those.
-- If any policy in that list should be preserved, edit this migration before
-- running.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 1. Helper function — central JOIN logic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_partner_or_self(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    auth.uid() = target_user_id
    OR EXISTS (
      SELECT 1
      FROM public.partnerships
      WHERE status = 'active'
        AND (
          (inviter_id = auth.uid() AND invitee_id = target_user_id)
          OR
          (invitee_id = auth.uid() AND inviter_id = target_user_id)
        )
    );
$$;

COMMENT ON FUNCTION public.is_partner_or_self(uuid) IS
  'Returns true if the calling user (auth.uid()) is the target user or has '
  'an active partnership with the target user. SECURITY DEFINER bypasses '
  'partnerships RLS to allow this lookup from inside row-level policies. '
  'Used by partnership-aware policies on tasks, projects, life_categories, '
  'knowledge, and corrections.';

-- Allow the policies (run as 'authenticated') to call the function.
GRANT EXECUTE ON FUNCTION public.is_partner_or_self(uuid) TO authenticated;


-- ============================================================================
-- 2. tasks
-- ============================================================================

-- Drop all existing policies on tasks. Wholesale replacement.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tasks'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.tasks', r.policyname);
  END LOOP;
END$$;

-- Ensure RLS is enabled.
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tasks_partner_select ON public.tasks
  FOR SELECT TO authenticated
  USING (public.is_partner_or_self(user_id));

CREATE POLICY tasks_partner_insert ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());  -- STRICT: only insert your own rows.

CREATE POLICY tasks_partner_update ON public.tasks
  FOR UPDATE TO authenticated
  USING (public.is_partner_or_self(user_id))
  WITH CHECK (public.is_partner_or_self(user_id));

CREATE POLICY tasks_partner_delete ON public.tasks
  FOR DELETE TO authenticated
  USING (public.is_partner_or_self(user_id));


-- ============================================================================
-- 3. projects
-- ============================================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.projects', r.policyname);
  END LOOP;
END$$;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_partner_select ON public.projects
  FOR SELECT TO authenticated
  USING (public.is_partner_or_self(user_id));

CREATE POLICY projects_partner_insert ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY projects_partner_update ON public.projects
  FOR UPDATE TO authenticated
  USING (public.is_partner_or_self(user_id))
  WITH CHECK (public.is_partner_or_self(user_id));

CREATE POLICY projects_partner_delete ON public.projects
  FOR DELETE TO authenticated
  USING (public.is_partner_or_self(user_id));


-- ============================================================================
-- 4. life_categories
-- ============================================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'life_categories'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.life_categories', r.policyname);
  END LOOP;
END$$;

ALTER TABLE public.life_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY life_categories_partner_select ON public.life_categories
  FOR SELECT TO authenticated
  USING (public.is_partner_or_self(user_id));

CREATE POLICY life_categories_partner_insert ON public.life_categories
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY life_categories_partner_update ON public.life_categories
  FOR UPDATE TO authenticated
  USING (public.is_partner_or_self(user_id))
  WITH CHECK (public.is_partner_or_self(user_id));

CREATE POLICY life_categories_partner_delete ON public.life_categories
  FOR DELETE TO authenticated
  USING (public.is_partner_or_self(user_id));


-- ============================================================================
-- 5. knowledge
-- ============================================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.knowledge', r.policyname);
  END LOOP;
END$$;

ALTER TABLE public.knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_partner_select ON public.knowledge
  FOR SELECT TO authenticated
  USING (public.is_partner_or_self(user_id));

CREATE POLICY knowledge_partner_insert ON public.knowledge
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY knowledge_partner_update ON public.knowledge
  FOR UPDATE TO authenticated
  USING (public.is_partner_or_self(user_id))
  WITH CHECK (public.is_partner_or_self(user_id));

CREATE POLICY knowledge_partner_delete ON public.knowledge
  FOR DELETE TO authenticated
  USING (public.is_partner_or_self(user_id));


-- ============================================================================
-- 6. corrections
-- ============================================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'corrections'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.corrections', r.policyname);
  END LOOP;
END$$;

ALTER TABLE public.corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY corrections_partner_select ON public.corrections
  FOR SELECT TO authenticated
  USING (public.is_partner_or_self(user_id));

CREATE POLICY corrections_partner_insert ON public.corrections
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY corrections_partner_update ON public.corrections
  FOR UPDATE TO authenticated
  USING (public.is_partner_or_self(user_id))
  WITH CHECK (public.is_partner_or_self(user_id));

CREATE POLICY corrections_partner_delete ON public.corrections
  FOR DELETE TO authenticated
  USING (public.is_partner_or_self(user_id));


-- ============================================================================
-- POST-MIGRATION VERIFICATION (run manually after applying)
-- ============================================================================
-- SELECT tablename, policyname, cmd
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('tasks', 'projects', 'life_categories', 'knowledge', 'corrections')
-- ORDER BY tablename, cmd, policyname;
--
-- Expect 4 rows per table (SELECT, INSERT, UPDATE, DELETE) all named
-- '<table>_partner_<cmd>'. Total 20 policies across the 5 tables.
-- ============================================================================


-- ============================================================================
-- ROLLBACK (commented out — uncomment all lines below and run to revert)
-- ============================================================================
-- DO $$
-- DECLARE r record;
-- BEGIN
--   FOR r IN
--     SELECT tablename, policyname FROM pg_policies
--     WHERE schemaname = 'public'
--       AND tablename IN ('tasks', 'projects', 'life_categories', 'knowledge', 'corrections')
--       AND policyname LIKE '%_partner_%'
--   LOOP
--     EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
--   END LOOP;
-- END$$;
--
-- DROP FUNCTION IF EXISTS public.is_partner_or_self(uuid);
--
-- -- Re-create own-only policies with predictable names. Adjust if your
-- -- prior installation used different names.
-- DO $$
-- DECLARE t text;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY['tasks', 'projects', 'life_categories', 'knowledge', 'corrections']
--   LOOP
--     EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (user_id = auth.uid())', t || '_self_select', t);
--     EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())', t || '_self_insert', t);
--     EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())', t || '_self_update', t);
--     EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (user_id = auth.uid())', t || '_self_delete', t);
--   END LOOP;
-- END$$;
-- ============================================================================
