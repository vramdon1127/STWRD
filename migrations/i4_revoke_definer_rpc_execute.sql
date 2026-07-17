-- i4: revoke public EXECUTE on SECURITY DEFINER RPCs (STWRD + LIFE)
-- Project: hrwgmqjqtoabttqvurkq
-- Applied to prod 2026-07-17 via Supabase MCP (migration:
-- revoke_public_execute_on_security_definer_rpcs). This file is repo parity.
--
-- Why: public.trigger_edge_function(text, text) is SECURITY DEFINER, takes a
-- caller-supplied URL, performs no validation, and was EXECUTE-able by anon via
-- /rest/v1/rpc/. The anon key ships in the client, so this was a server-side
-- request forgery primitive: any caller could make the database POST to an
-- arbitrary URL with an arbitrary bearer token. rls_auto_enable() had the same
-- anon exposure. Same class as the enforce_task_project fix in i3.
--
-- Safe because pg_cron executes as postgres (owner), which retains EXECUTE.
-- Verified: job 7 tick at 13:50:00 post-revoke succeeded; gmail_messages
-- synced_at advanced to 13:50:03. No client callers (grep of index.html,
-- api/, scripts/ returned nothing).
--
-- Rollback:
--   GRANT EXECUTE ON FUNCTION public.trigger_edge_function(text, text) TO anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.trigger_edge_function(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
