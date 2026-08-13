-- Add bundled and company-uploaded invoice fonts. Custom font files live on
-- the filesystem storage backend (lib/storage/local.ts). The server embeds
-- each font into the generated PDF, so font files never need public URLs.

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

NOTIFY pgrst, 'reload schema';
