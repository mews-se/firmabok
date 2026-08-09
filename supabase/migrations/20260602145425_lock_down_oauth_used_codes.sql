-- OAuth authorization-code replay tracking is internal-only. The token
-- endpoint uses a service-role client, so browser-facing API roles must not
-- access this table.
ALTER TABLE public.oauth_used_codes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.oauth_used_codes FROM anon, authenticated;

-- Privilege change: tell PostgREST to reload its schema/role cache.
NOTIFY pgrst, 'reload schema';
