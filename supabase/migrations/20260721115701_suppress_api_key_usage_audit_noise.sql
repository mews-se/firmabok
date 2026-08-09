-- Keep API-key security and configuration changes in behandlingshistorik, but
-- do not create a full audit row for every authenticated API or MCP request.
-- validate_and_increment_api_key updates only these four telemetry columns.

DROP TRIGGER IF EXISTS audit_api_keys_update ON public.api_keys;
DROP TRIGGER IF EXISTS audit_api_keys ON public.api_keys;

-- Preserve the historical trigger name for account-deletion routines that
-- temporarily disable audit_api_keys while removing a user.
CREATE TRIGGER audit_api_keys
  AFTER INSERT OR DELETE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_api_keys_update
  AFTER UPDATE ON public.api_keys
  FOR EACH ROW
  WHEN (
    (to_jsonb(OLD) - ARRAY[
      'request_count',
      'rate_limit_window_start',
      'last_used_at',
      'updated_at'
    ]::text[])
    IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY[
      'request_count',
      'rate_limit_window_start',
      'last_used_at',
      'updated_at'
    ]::text[])
  )
  EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
