-- Migration 13: Document Archive
-- WORM-style document storage with hash integrity and version chain

-- =============================================================================
-- 1. document_attachments table
-- =============================================================================
CREATE TABLE public.document_attachments (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,

  -- Storage
  storage_path          text NOT NULL,
  file_name             text NOT NULL,
  file_size_bytes       bigint,
  mime_type             text,

  -- Integrity
  sha256_hash           text NOT NULL,

  -- Version chain (WORM: Write Once, Read Many)
  version               integer NOT NULL DEFAULT 1,
  original_id           uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  superseded_by_id      uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  is_current_version    boolean NOT NULL DEFAULT true,

  -- Digitization metadata
  uploaded_by           uuid REFERENCES auth.users ON DELETE SET NULL,
  upload_source         text CHECK (upload_source IN (
    'camera', 'file_upload', 'email', 'e_invoice', 'scan', 'api', 'system'
  )),
  digitization_date     timestamptz DEFAULT now(),

  -- Linkage to journal entries (ON DELETE RESTRICT prevents deletion of linked entries)
  journal_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  journal_entry_line_id uuid REFERENCES public.journal_entry_lines(id) ON DELETE RESTRICT,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.document_attachments ENABLE ROW LEVEL SECURITY;

-- RLS: select, insert, update for owner. NO DELETE policy (handled by trigger).
CREATE POLICY "document_attachments_select" ON public.document_attachments
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "document_attachments_insert" ON public.document_attachments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "document_attachments_update" ON public.document_attachments
  FOR UPDATE USING (auth.uid() = user_id);

-- Intentionally NO DELETE policy -- deletion is blocked by trigger

CREATE INDEX idx_document_attachments_user_id ON public.document_attachments (user_id);
CREATE INDEX idx_document_attachments_journal_entry_id ON public.document_attachments (journal_entry_id);
CREATE INDEX idx_document_attachments_journal_entry_line_id ON public.document_attachments (journal_entry_line_id);
CREATE INDEX idx_document_attachments_sha256_hash ON public.document_attachments (sha256_hash);
CREATE INDEX idx_document_attachments_original_id ON public.document_attachments (original_id);

CREATE TRIGGER document_attachments_updated_at
  BEFORE UPDATE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
