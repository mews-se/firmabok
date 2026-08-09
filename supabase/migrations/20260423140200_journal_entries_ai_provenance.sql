-- AI provenance on journal entries.
--
-- Adds two columns to journal_entries so that entries posted via the AI
-- agent flow carry a BFL-defensible audit trail: who created this entry,
-- and which AI proposal did the user approve to produce it?
--
-- `created_via` is informational — it describes the *method* of creation,
-- not the business event. The existing `source_type` column still describes
-- the business event (bank_transaction, invoice_created, supplier_invoice_
-- registered, etc.). An AI-proposed booking for a bank transaction will
-- have source_type='bank_transaction' AND created_via='ai_proposed'.
--
-- The existing immutability trigger (migration 017) prevents changes to
-- posted entries. These new columns are set while the entry is still in
-- draft status and frozen at commit — consistent with how the trigger
-- already treats other fields.

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'manual';

ALTER TABLE public.journal_entries
  ALTER COLUMN created_via SET DEFAULT 'manual';

-- Re-apply NOT NULL for environments where the column was added out-of-band
UPDATE public.journal_entries SET created_via = 'manual' WHERE created_via IS NULL;

ALTER TABLE public.journal_entries
  ALTER COLUMN created_via SET NOT NULL;

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_created_via_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_created_via_check
  CHECK (created_via IN ('manual', 'ai_proposed', 'imported', 'system'));

-- Nullable FK — only AI-proposed entries link back to a proposal
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS source_proposal_id uuid
  REFERENCES public.ai_proposals(id) ON DELETE SET NULL;

-- Audit lookup: "show me all AI-proposed entries from last month"
CREATE INDEX IF NOT EXISTS idx_journal_entries_created_via_ai
  ON public.journal_entries (company_id, created_at DESC)
  WHERE created_via = 'ai_proposed';

NOTIFY pgrst, 'reload schema';
