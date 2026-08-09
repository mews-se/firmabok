-- Bank file import support
-- Adds import_source and reference to transactions,
-- and a bank_file_imports tracking table

-- Track import origin on transactions
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS import_source text;
CREATE INDEX IF NOT EXISTS idx_transactions_import_source ON public.transactions(import_source);

-- Store OCR/Bankgiro reference for Swedish payment matching
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS reference text;
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON public.transactions(reference);

-- Bank file import tracking (prevents duplicate file uploads, provides history)
CREATE TABLE public.bank_file_imports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  filename text NOT NULL,
  file_hash text NOT NULL,
  file_format text NOT NULL,
  transaction_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  date_from date,
  date_to date,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, file_hash)
);

ALTER TABLE public.bank_file_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bank_file_imports_select" ON public.bank_file_imports
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "bank_file_imports_insert" ON public.bank_file_imports
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "bank_file_imports_update" ON public.bank_file_imports
  FOR UPDATE USING (auth.uid() = user_id);

CREATE TRIGGER bank_file_imports_updated_at
  BEFORE UPDATE ON public.bank_file_imports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
