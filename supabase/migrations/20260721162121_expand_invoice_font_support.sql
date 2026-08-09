-- Add bundled and company-uploaded invoice fonts. Custom font files live in a
-- dedicated private bucket. The server embeds each font into the generated PDF,
-- so customer font files never need public URLs.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_custom_font_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS invoice_custom_font_name TEXT NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_invoice_font_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_invoice_font_check
  CHECK (
    invoice_font_family IN (
      'Helvetica',
      'Times-Roman',
      'Courier',
      'Source Sans 3',
      'Source Serif 4',
      'Custom'
    )
  );

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoice-fonts',
  'invoice-fonts',
  false,
  5242880,
  ARRAY['font/ttf', 'font/woff']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

NOTIFY pgrst, 'reload schema';
