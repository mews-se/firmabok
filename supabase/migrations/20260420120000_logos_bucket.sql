-- Migration: Public `logos` storage bucket for company logos
--
-- Logos render on invoices, the invoice PDF, and the public invoice-action
-- page, so they need to be fetchable without signed URLs. The existing
-- `documents` bucket is private (WORM archive) and not appropriate for
-- this use case — `getPublicUrl()` on that bucket returns an unusable URL.
--
-- This bucket is world-readable; writes happen via the server route using
-- the service role, so we do not need user-scoped INSERT/UPDATE/DELETE
-- policies for authenticated clients.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'logos',
  'logos',
  true,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
