-- Schema sync: consolidates all changes applied to production after migration 97
-- (20260402120000_inbox_classification). This single migration reproduces the exact
-- production schema delta when applied on top of the first 97 base migrations.
--
-- Changes consolidated from 20 remote migrations (20260407091315 – 20260414191533).
-- Production database is the source of truth — no schema changes are introduced.


-- ============================================================================
-- 1. NEW TABLES
-- ============================================================================

-- 1a. bankid_identities
CREATE TABLE IF NOT EXISTS public.bankid_identities (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              uuid REFERENCES auth.users ON DELETE CASCADE UNIQUE NOT NULL,
  personal_number_hash text NOT NULL,
  personal_number_enc  bytea NOT NULL,
  given_name           text,
  surname              text,
  linked_at            timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bankid_identities ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bankid_identities_pnr_hash
  ON public.bankid_identities (personal_number_hash);
CREATE INDEX IF NOT EXISTS idx_bankid_identities_user_id
  ON public.bankid_identities (user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bankid_identities' AND policyname='bankid_identities_select') THEN
    CREATE POLICY bankid_identities_select ON public.bankid_identities FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bankid_identities' AND policyname='bankid_identities_insert') THEN
    CREATE POLICY bankid_identities_insert ON public.bankid_identities FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bankid_identities' AND policyname='bankid_identities_delete') THEN
    CREATE POLICY bankid_identities_delete ON public.bankid_identities FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE OR REPLACE TRIGGER bankid_identities_updated_at
  BEFORE UPDATE ON public.bankid_identities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- 1b. automation_webhooks
CREATE TABLE IF NOT EXISTS public.automation_webhooks (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  uuid NOT NULL REFERENCES public.companies ON DELETE CASCADE,
  event_type  text NOT NULL,
  webhook_url text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, event_type)
);
ALTER TABLE public.automation_webhooks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_automation_webhooks_company_event
  ON public.automation_webhooks (company_id, event_type) WHERE (active = true);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='automation_webhooks' AND policyname='Members can view company webhooks') THEN
    CREATE POLICY "Members can view company webhooks" ON public.automation_webhooks FOR SELECT
      USING (company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='automation_webhooks' AND policyname='Members can insert company webhooks') THEN
    CREATE POLICY "Members can insert company webhooks" ON public.automation_webhooks FOR INSERT
      WITH CHECK (company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='automation_webhooks' AND policyname='Members can update company webhooks') THEN
    CREATE POLICY "Members can update company webhooks" ON public.automation_webhooks FOR UPDATE
      USING (company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='automation_webhooks' AND policyname='Members can delete company webhooks') THEN
    CREATE POLICY "Members can delete company webhooks" ON public.automation_webhooks FOR DELETE
      USING (company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid()));
  END IF;
END $$;

CREATE OR REPLACE TRIGGER set_updated_at
  BEFORE UPDATE ON public.automation_webhooks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- 1c. booking_template_library
CREATE TABLE IF NOT EXISTS public.booking_template_library (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  uuid REFERENCES public.companies ON DELETE CASCADE,
  team_id     uuid REFERENCES public.teams ON DELETE CASCADE,
  created_by  uuid,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT 'other'
    CHECK (category IN ('eu_trade','tax_account','private_transfer','salary','representation','year_end','vat','financial','other')),
  entity_type text NOT NULL DEFAULT 'all'
    CHECK (entity_type IN ('all','enskild_firma','aktiebolag')),
  lines       jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_system   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_system OR (company_id IS NULL AND team_id IS NULL)),
  CHECK (team_id IS NULL OR company_id IS NULL),
  CHECK (company_id IS NOT NULL OR team_id IS NOT NULL OR is_system)
);
ALTER TABLE public.booking_template_library ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_btl_active   ON public.booking_template_library (is_active) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS idx_btl_category ON public.booking_template_library (category);
CREATE INDEX IF NOT EXISTS idx_btl_company  ON public.booking_template_library (company_id) WHERE (company_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_btl_system   ON public.booking_template_library (is_system) WHERE (is_system = true);
CREATE INDEX IF NOT EXISTS idx_btl_team     ON public.booking_template_library (team_id) WHERE (team_id IS NOT NULL);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='booking_template_library' AND policyname='btl_select') THEN
    CREATE POLICY btl_select ON public.booking_template_library FOR SELECT
      USING (is_system OR company_id IN (SELECT user_company_ids()) OR team_id IN (SELECT user_team_ids()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='booking_template_library' AND policyname='btl_insert') THEN
    CREATE POLICY btl_insert ON public.booking_template_library FOR INSERT
      WITH CHECK (NOT is_system AND (company_id IN (SELECT user_company_ids()) OR (company_id IS NULL AND team_id IN (SELECT user_team_ids()))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='booking_template_library' AND policyname='btl_update') THEN
    CREATE POLICY btl_update ON public.booking_template_library FOR UPDATE
      USING (NOT is_system AND (company_id IN (SELECT user_company_ids()) OR (company_id IS NULL AND team_id IN (SELECT user_team_ids()))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='booking_template_library' AND policyname='btl_delete') THEN
    CREATE POLICY btl_delete ON public.booking_template_library FOR DELETE
      USING (NOT is_system AND (company_id IN (SELECT user_company_ids()) OR (company_id IS NULL AND team_id IN (SELECT user_team_ids()))));
  END IF;
END $$;

CREATE OR REPLACE TRIGGER btl_updated_at
  BEFORE UPDATE ON public.booking_template_library
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 2. ALTER EXISTING TABLES — new columns
-- ============================================================================

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS archived_by uuid;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS delivery_date date;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.sie_imports ADD COLUMN IF NOT EXISTS replaced_at timestamptz;
ALTER TABLE public.document_attachments ADD COLUMN IF NOT EXISTS prev_version_hash text;


-- ============================================================================
-- 3. MODIFIED CHECK CONSTRAINTS
-- ============================================================================

-- sie_imports: add 'replaced' status
ALTER TABLE public.sie_imports DROP CONSTRAINT IF EXISTS sie_imports_status_check;
ALTER TABLE public.sie_imports ADD CONSTRAINT sie_imports_status_check
  CHECK (status = ANY (ARRAY['pending','mapped','completed','failed','replaced']));

-- audit_log: add integrity/security action types
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action = ANY (ARRAY[
    'INSERT','UPDATE','DELETE','COMMIT','REVERSE','CORRECT',
    'LOCK_PERIOD','CLOSE_PERIOD','DOCUMENT_DELETE_BLOCKED',
    'RETENTION_BLOCK','SECURITY_EVENT','INTEGRITY_FAILURE'
  ]));


-- ============================================================================
-- 4. FUNCTIONS — CREATE OR REPLACE
-- ============================================================================

-- 4a. user_company_ids — filters out archived companies
CREATE OR REPLACE FUNCTION public.user_company_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT cm.company_id
  FROM public.company_members cm
  JOIN public.companies c ON c.id = cm.company_id
  WHERE cm.user_id = auth.uid()
    AND c.archived_at IS NULL;
$function$;

-- 4b. ensure_user_team — get-or-create personal team
CREATE OR REPLACE FUNCTION public.ensure_user_team()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_team_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT team_id INTO v_team_id
  FROM public.team_members
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_team_id IS NOT NULL THEN
    RETURN v_team_id;
  END IF;

  INSERT INTO public.teams (name, created_by)
  VALUES ('Personal', v_user_id)
  RETURNING id INTO v_team_id;

  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (v_team_id, v_user_id, 'owner');

  RETURN v_team_id;
END;
$function$;

-- 4c. enforce_journal_entry_immutability — supports gnubok.allow_delete + cancelled
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'posted' THEN
    IF NEW.description = OLD.description
       AND NEW.entry_date = OLD.entry_date
       AND NEW.fiscal_period_id = OLD.fiscal_period_id
       AND NEW.voucher_number = OLD.voucher_number
       AND NEW.voucher_series = OLD.voucher_series
       AND NEW.source_type = OLD.source_type
       AND COALESCE(NEW.source_id::text, '') = COALESCE(OLD.source_id::text, '')
       AND NEW.user_id = OLD.user_id
       AND COALESCE(NEW.reversed_by_id::text, '') = COALESCE(OLD.reversed_by_id::text, '')
       AND COALESCE(NEW.reverses_id::text, '') = COALESCE(OLD.reverses_id::text, '')
       AND COALESCE(NEW.correction_of_id::text, '') = COALESCE(OLD.correction_of_id::text, '')
       AND NEW.committed_at IS NOT DISTINCT FROM OLD.committed_at
    THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END; $function$;

-- 4d. enforce_journal_entry_line_immutability — supports gnubok.allow_delete + cancelled
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_status text;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END; $function$;

-- 4e. enforce_retention_journal_entries — supports gnubok.allow_delete
CREATE OR REPLACE FUNCTION public.enforce_retention_journal_entries()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_retention_expires date;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT fp.retention_expires_at INTO v_retention_expires
  FROM public.fiscal_periods fp
  WHERE fp.id = OLD.fiscal_period_id;

  IF v_retention_expires IS NOT NULL AND v_retention_expires > CURRENT_DATE THEN
    INSERT INTO public.audit_log (user_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, 'RETENTION_BLOCK', 'journal_entries', OLD.id,
      'Attempted deletion within retention period (expires ' || v_retention_expires || ')');

    RAISE EXCEPTION 'Cannot delete journal entry within 7-year retention period (expires %)',
      v_retention_expires;
  END IF;

  RETURN OLD;
END; $function$;

-- 4f. enforce_document_metadata_immutability — new trigger function
CREATE OR REPLACE FUNCTION public.enforce_document_metadata_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_status text;
BEGIN
  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_entry_status
  FROM public.journal_entries
  WHERE id = OLD.journal_entry_id;

  IF v_entry_status IS NULL OR v_entry_status NOT IN ('posted', 'reversed') THEN
    RETURN NEW;
  END IF;

  IF NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.file_size_bytes IS DISTINCT FROM OLD.file_size_bytes
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.sha256_hash IS DISTINCT FROM OLD.sha256_hash
     OR NEW.upload_source IS DISTINCT FROM OLD.upload_source
     OR NEW.digitization_date IS DISTINCT FROM OLD.digitization_date
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.original_id IS DISTINCT FROM OLD.original_id
     OR NEW.is_current_version IS DISTINCT FROM OLD.is_current_version
  THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'SECURITY_EVENT', 'document_attachments', OLD.id,
      'Blocked metadata modification of document linked to ' || v_entry_status || ' entry ' || OLD.journal_entry_id);

    RAISE EXCEPTION 'Cannot modify metadata of document linked to a % journal entry (BFL 7 kap)', v_entry_status;
  END IF;

  RETURN NEW;
END;
$function$;

-- 4g. create_document_version — document versioning with hash chain
CREATE OR REPLACE FUNCTION public.create_document_version(
  p_user_id uuid,
  p_original_doc_id uuid,
  p_storage_path text,
  p_file_name text,
  p_file_size_bytes bigint,
  p_mime_type text,
  p_sha256_hash text
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current document_attachments%ROWTYPE;
  v_new_id uuid;
  v_root_id uuid;
  v_next_version integer;
BEGIN
  SELECT * INTO v_current
  FROM public.document_attachments
  WHERE id = p_original_doc_id
    AND is_current_version = true
  FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Document % not found or is not the current version', p_original_doc_id;
  END IF;

  v_root_id := COALESCE(v_current.original_id, v_current.id);
  v_next_version := v_current.version + 1;

  INSERT INTO public.document_attachments (
    user_id, company_id, storage_path, file_name, file_size_bytes,
    mime_type, sha256_hash, version, original_id, is_current_version,
    uploaded_by, upload_source, digitization_date,
    journal_entry_id, journal_entry_line_id, prev_version_hash
  ) VALUES (
    p_user_id, v_current.company_id, p_storage_path, p_file_name,
    p_file_size_bytes, p_mime_type, p_sha256_hash, v_next_version,
    v_root_id, true, p_user_id, v_current.upload_source, now(),
    v_current.journal_entry_id, v_current.journal_entry_line_id,
    v_current.sha256_hash
  )
  RETURNING id INTO v_new_id;

  UPDATE public.document_attachments
  SET is_current_version = false,
      superseded_by_id = v_new_id
  WHERE id = p_original_doc_id;

  RETURN v_new_id;
END;
$function$;

-- 4h. validate_version_chain — validates document version hash chain
CREATE OR REPLACE FUNCTION public.validate_version_chain(p_document_id uuid)
 RETURNS TABLE(version integer, document_id uuid, hash_valid boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_root_id uuid;
BEGIN
  SELECT COALESCE(da.original_id, da.id) INTO v_root_id
  FROM public.document_attachments da
  WHERE da.id = p_document_id;

  IF v_root_id IS NULL THEN
    RAISE EXCEPTION 'Document % not found', p_document_id;
  END IF;

  RETURN QUERY
  WITH chain AS (
    SELECT
      da.id AS doc_id,
      da.version AS ver,
      da.sha256_hash,
      da.prev_version_hash,
      LAG(da.sha256_hash) OVER (ORDER BY da.version) AS expected_prev_hash
    FROM public.document_attachments da
    WHERE da.id = v_root_id OR da.original_id = v_root_id
    ORDER BY da.version
  )
  SELECT
    chain.ver,
    chain.doc_id,
    CASE
      WHEN chain.ver = 1 THEN chain.prev_version_hash IS NULL
      ELSE chain.prev_version_hash IS NOT DISTINCT FROM chain.expected_prev_hash
    END AS hash_valid
  FROM chain
  ORDER BY chain.ver;
END;
$function$;

-- 4i. write_audit_log — comprehensive audit logging
CREATE OR REPLACE FUNCTION public.write_audit_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  v_user_id := COALESCE(v_user_id, auth.uid());

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description)
  VALUES (v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- 4j. delete_last_voucher — deletes only the last voucher in a series
CREATE OR REPLACE FUNCTION public.delete_last_voucher(p_company_id uuid, p_entry_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry            record;
  v_period           record;
  v_max_voucher      integer;
  v_ref_count        integer;
  v_caller_role      text;
  v_snapshot         jsonb;
  v_lines_snapshot   jsonb;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can delete vouchers';
  END IF;

  SELECT * INTO v_entry
  FROM journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status != 'posted' THEN
    RAISE EXCEPTION 'Only posted entries can be deleted (current status: %)', v_entry.status;
  END IF;

  SELECT * INTO v_period
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id
  FOR UPDATE;

  IF v_period.is_closed THEN
    RAISE EXCEPTION 'Cannot delete voucher in a closed fiscal period';
  END IF;

  IF v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot delete voucher in a locked fiscal period';
  END IF;

  PERFORM 1 FROM voucher_sequences
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
  FOR UPDATE;

  SELECT MAX(voucher_number) INTO v_max_voucher
  FROM journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
    AND status NOT IN ('cancelled', 'draft');

  IF v_entry.voucher_number != v_max_voucher THEN
    RAISE EXCEPTION 'Kan bara radera det sista verifikatet i serien. % har nummer % men senaste är %',
      v_entry.voucher_series, v_entry.voucher_number, v_max_voucher;
  END IF;

  SELECT COUNT(*) INTO v_ref_count
  FROM journal_entries
  WHERE company_id = p_company_id
    AND status != 'cancelled'
    AND (reverses_id = p_entry_id OR correction_of_id = p_entry_id);

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete: other entries reference this voucher (% references)',
      v_ref_count;
  END IF;

  SELECT jsonb_agg(to_jsonb(l)) INTO v_lines_snapshot
  FROM journal_entry_lines l
  WHERE l.journal_entry_id = p_entry_id;

  v_snapshot := to_jsonb(v_entry) || jsonb_build_object('lines', COALESCE(v_lines_snapshot, '[]'::jsonb));

  IF v_entry.reverses_id IS NOT NULL THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);
    UPDATE journal_entries
    SET status = 'posted', reversed_by_id = NULL
    WHERE id = v_entry.reverses_id
      AND company_id = p_company_id;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  UPDATE document_attachments
  SET journal_entry_id = NULL
  WHERE journal_entry_id = p_entry_id;

  DELETE FROM journal_entries WHERE id = p_entry_id;

  UPDATE voucher_sequences
  SET last_number = GREATEST(last_number - 1, 0)
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series;

  INSERT INTO audit_log (user_id, action, table_name, record_id, actor_id, old_state, description)
  VALUES (
    v_entry.user_id,
    'DELETE',
    'journal_entries',
    p_entry_id,
    auth.uid(),
    v_snapshot,
    'Deleted voucher ' || v_entry.voucher_series || v_entry.voucher_number ||
    ' (delete_last_voucher RPC, caller: ' || auth.uid() || ')'
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number
  );
END;
$function$;

-- 4k. replace_sie_import — cancels entries from a SIE import
CREATE OR REPLACE FUNCTION public.replace_sie_import(p_company_id uuid, p_import_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cancelled integer;
  v_fiscal_period_id uuid;
  v_opening_balance_entry_id uuid;
BEGIN
  SELECT fiscal_period_id, opening_balance_entry_id
    INTO v_fiscal_period_id, v_opening_balance_entry_id
    FROM public.sie_imports
   WHERE id = p_import_id AND company_id = p_company_id AND status = 'completed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found or not in completed status', p_import_id;
  END IF;

  UPDATE public.journal_entries
     SET status = 'cancelled'
   WHERE company_id = p_company_id
     AND status = 'posted'
     AND id IN (
       SELECT v_opening_balance_entry_id WHERE v_opening_balance_entry_id IS NOT NULL
       UNION ALL
       SELECT je.id FROM public.journal_entries je
        WHERE je.company_id = p_company_id
          AND je.fiscal_period_id = v_fiscal_period_id
          AND je.source_type = 'import'
          AND je.status = 'posted'
     );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE public.sie_imports
     SET status = 'replaced', replaced_at = now()
   WHERE id = p_import_id AND company_id = p_company_id;

  RETURN v_cancelled;
END;
$function$;

-- 4l. get_unlinked_1930_lines — bank reconciliation helper
CREATE OR REPLACE FUNCTION public.get_unlinked_1930_lines(
  p_company_id uuid,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
 RETURNS TABLE(
   line_id uuid, journal_entry_id uuid, debit_amount numeric,
   credit_amount numeric, line_description text, entry_date date,
   voucher_number integer, voucher_series text, entry_description text,
   source_type text
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_number = '1930'
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )
  ORDER BY je.entry_date, je.voucher_number;
$function$;

-- 4m. delete_user_account — full account deletion with cascade blockers
CREATE OR REPLACE FUNCTION public.delete_user_account(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
 SET lock_timeout TO '10s'
AS $function$
DECLARE
  v_company_ids uuid[];
BEGIN
  IF auth.uid() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'Can only delete your own account';
  END IF;

  SELECT array_agg(id) INTO v_company_ids
  FROM public.companies
  WHERE created_by = target_user_id;

  DELETE FROM public.user_preferences WHERE user_id = target_user_id;
  DELETE FROM public.extension_data WHERE user_id = target_user_id;

  ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete;
  ALTER TABLE payment_match_log DISABLE TRIGGER payment_match_log_no_delete;
  ALTER TABLE document_attachments DISABLE TRIGGER block_document_deletion;
  ALTER TABLE journal_entries DISABLE TRIGGER enforce_journal_entry_immutability;
  ALTER TABLE journal_entries DISABLE TRIGGER enforce_retention_journal_entries;
  ALTER TABLE journal_entry_lines DISABLE TRIGGER enforce_journal_entry_line_immutability;

  ALTER TABLE api_keys DISABLE TRIGGER audit_api_keys;
  ALTER TABLE chart_of_accounts DISABLE TRIGGER audit_chart_of_accounts;
  ALTER TABLE company_settings DISABLE TRIGGER audit_company_settings;
  ALTER TABLE document_attachments DISABLE TRIGGER audit_document_attachments;
  ALTER TABLE extension_data DISABLE TRIGGER audit_extension_data;
  ALTER TABLE fiscal_periods DISABLE TRIGGER audit_fiscal_periods;
  ALTER TABLE journal_entries DISABLE TRIGGER audit_journal_entries;
  ALTER TABLE supplier_invoices DISABLE TRIGGER audit_supplier_invoices;

  IF v_company_ids IS NOT NULL THEN
    DELETE FROM public.audit_log
    WHERE company_id = ANY(v_company_ids);

    UPDATE public.fiscal_periods
    SET previous_period_id = NULL,
        closing_entry_id = NULL,
        opening_balance_entry_id = NULL
    WHERE company_id = ANY(v_company_ids);
  END IF;

  DELETE FROM auth.users WHERE id = target_user_id;

  ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete;
  ALTER TABLE payment_match_log ENABLE TRIGGER payment_match_log_no_delete;
  ALTER TABLE document_attachments ENABLE TRIGGER block_document_deletion;
  ALTER TABLE journal_entries ENABLE TRIGGER enforce_journal_entry_immutability;
  ALTER TABLE journal_entries ENABLE TRIGGER enforce_retention_journal_entries;
  ALTER TABLE journal_entry_lines ENABLE TRIGGER enforce_journal_entry_line_immutability;
  ALTER TABLE api_keys ENABLE TRIGGER audit_api_keys;
  ALTER TABLE chart_of_accounts ENABLE TRIGGER audit_chart_of_accounts;
  ALTER TABLE company_settings ENABLE TRIGGER audit_company_settings;
  ALTER TABLE document_attachments ENABLE TRIGGER audit_document_attachments;
  ALTER TABLE extension_data ENABLE TRIGGER audit_extension_data;
  ALTER TABLE fiscal_periods ENABLE TRIGGER audit_fiscal_periods;
  ALTER TABLE journal_entries ENABLE TRIGGER audit_journal_entries;
  ALTER TABLE supplier_invoices ENABLE TRIGGER audit_supplier_invoices;
END;
$function$;


-- ============================================================================
-- 5. TRIGGERS on existing tables
-- ============================================================================

-- Document metadata immutability enforcement
DROP TRIGGER IF EXISTS enforce_document_metadata_immutability ON public.document_attachments;
CREATE TRIGGER enforce_document_metadata_immutability
  BEFORE UPDATE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_document_metadata_immutability();


-- ============================================================================
-- 6. MISSING DELETE POLICIES on existing tables
-- ============================================================================

DO $$
DECLARE
  r record;
BEGIN
  -- Tables with a direct company_id column
  FOR r IN
    SELECT unnest(ARRAY[
      'api_keys', 'bank_connections', 'bank_file_imports', 'calendar_feeds',
      'categorization_templates', 'chart_of_accounts', 'company_settings',
      'cost_centers', 'customers', 'deadlines', 'document_attachments',
      'extension_data', 'fiscal_periods',
      'invoice_inbox_items', 'invoice_payments',
      'invoice_reminders', 'invoices', 'journal_entries',
      'mapping_rules', 'projects',
      'receipts',
      'sie_account_mappings', 'sie_imports', 'skatteverket_tokens',
      'supplier_invoice_payments',
      'supplier_invoices', 'suppliers', 'transactions'
    ]) AS tbl
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = r.tbl AND cmd = 'DELETE'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE USING (company_id IN (SELECT user_company_ids()))',
        r.tbl || '_delete', r.tbl
      );
    END IF;
  END LOOP;

  -- Tables that join through a parent to reach company_id
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='invoice_items' AND cmd='DELETE') THEN
    CREATE POLICY invoice_items_delete ON public.invoice_items FOR DELETE
      USING (invoice_id IN (SELECT id FROM invoices WHERE company_id IN (SELECT user_company_ids())));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='journal_entry_lines' AND cmd='DELETE') THEN
    CREATE POLICY journal_entry_lines_delete ON public.journal_entry_lines FOR DELETE
      USING (journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id IN (SELECT user_company_ids())));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='receipt_line_items' AND cmd='DELETE') THEN
    CREATE POLICY receipt_line_items_delete ON public.receipt_line_items FOR DELETE
      USING (receipt_id IN (SELECT id FROM receipts WHERE company_id IN (SELECT user_company_ids())));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='supplier_invoice_items' AND cmd='DELETE') THEN
    CREATE POLICY supplier_invoice_items_delete ON public.supplier_invoice_items FOR DELETE
      USING (supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id IN (SELECT user_company_ids())));
  END IF;

  -- User-scoped tables (no company_id — use auth.uid())
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='extension_toggles' AND cmd='DELETE') THEN
    CREATE POLICY extension_toggles_delete ON public.extension_toggles FOR DELETE
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notification_settings' AND cmd='DELETE') THEN
    CREATE POLICY notification_settings_delete ON public.notification_settings FOR DELETE
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_subscriptions' AND cmd='DELETE') THEN
    CREATE POLICY push_subscriptions_delete ON public.push_subscriptions FOR DELETE
      USING (auth.uid() = user_id);
  END IF;

  -- Tables that use other policy patterns
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_sessions' AND cmd='DELETE') THEN
    CREATE POLICY chat_sessions_delete ON public.chat_sessions FOR DELETE
      USING (company_id IN (SELECT user_company_ids()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_messages' AND cmd='DELETE') THEN
    CREATE POLICY chat_messages_delete ON public.chat_messages FOR DELETE
      USING (company_id IN (SELECT user_company_ids()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='company_members' AND cmd='DELETE') THEN
    CREATE POLICY company_members_delete ON public.company_members FOR DELETE
      USING (company_id IN (SELECT user_company_ids()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='company_invitations' AND cmd='DELETE') THEN
    CREATE POLICY company_invitations_delete ON public.company_invitations FOR DELETE
      USING (company_id IN (SELECT user_company_ids()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='team_invitations' AND cmd='DELETE') THEN
    CREATE POLICY team_invitations_delete ON public.team_invitations FOR DELETE
      USING (team_id IN (SELECT user_team_ids()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='team_members' AND cmd='DELETE') THEN
    CREATE POLICY team_members_delete ON public.team_members FOR DELETE
      USING (team_id IN (SELECT user_team_ids()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='provider_consents' AND cmd='DELETE') THEN
    CREATE POLICY provider_consents_delete ON public.provider_consents FOR DELETE
      USING (company_id IN (SELECT user_company_ids()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='provider_consent_tokens' AND cmd='DELETE') THEN
    CREATE POLICY provider_consent_tokens_delete ON public.provider_consent_tokens FOR DELETE
      USING (consent_id IN (SELECT id FROM provider_consents WHERE company_id IN (SELECT user_company_ids())));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='provider_otc' AND cmd='DELETE') THEN
    CREATE POLICY provider_otc_delete ON public.provider_otc FOR DELETE
      USING (consent_id IN (SELECT id FROM provider_consents WHERE company_id IN (SELECT user_company_ids())));
  END IF;
END $$;


-- ============================================================================
-- 7. NOTIFY PostgREST to reload schema
-- ============================================================================

NOTIFY pgrst, 'reload schema';
