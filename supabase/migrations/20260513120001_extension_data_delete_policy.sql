-- The 2026-03-30 multi-tenant refactor (20260330130000) dropped all policies on
-- extension_data and recreated only SELECT / INSERT / UPDATE — leaving DELETE
-- without a policy. Combined with `value jsonb NOT NULL`, this silently broke
-- every extension that tried to clear stored state via upsert with value=null
-- (cloud-backup disconnect, skatteverket OAuth/AGI cleanup, arcim-migration
-- consent reset). The fix is to expose a real DELETE on the row and have
-- ExtensionSettings.clear() use it.

DROP POLICY IF EXISTS "extension_data_delete" ON public.extension_data;
CREATE POLICY "extension_data_delete" ON public.extension_data
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

NOTIFY pgrst, 'reload schema';
