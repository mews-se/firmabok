-- customers.personal_number holds ciphertext, so stop checking it for the
-- personnummer format.
--
-- 20260522130000 added the column as plaintext and constrained it to the
-- canonical personnummer formats. Since 2026-07-15 the write path encrypts the
-- value (encryptCustomerPersonalNumber -> encryptPersonnummer, AES-256-GCM),
-- so what actually reaches the column is a hex string of iv + ciphertext +
-- auth tag: 76 to 82 characters for the four accepted input formats. That can
-- never match a personnummer regex, so customers_personal_number_check
-- rejected every single write. Production confirms it: 4957 customers, 1355 of
-- them individuals, and 0 rows have ever held a non-null personal_number.
--
-- The format guarantee was destroyed by the encryption change, not by this
-- migration. A CHECK cannot validate a personnummer it can no longer read.
-- Plaintext format validation stays where it can still run: the application
-- layer validates it (CreateCustomerSchema / UpdateCustomerSchema) before
-- handing the value to the cipher.
--
-- What the database can still enforce is the opposite, and more valuable,
-- guarantee: this column must never hold a bare personnummer. The constraint
-- is therefore re-pointed at the ciphertext shape. Lowercase hex only (what
-- Buffer.toString('hex') emits), 76 to 255 characters: 24 for the iv + 32 for
-- the auth tag + at least 20 for the shortest accepted plaintext, real values
-- landing on 76/78/80/82. The upper bound is 255 because that is the highest
-- repetition count a Postgres POSIX regex accepts. Every plaintext
-- personnummer form is far too short and/or carries a '-'/'+' separator, so a
-- write path that forgets to encrypt now fails loudly instead of quietly
-- persisting PII.
--
-- This matches the two encrypted personnummer columns that already work in
-- production, employees.personnummer and
-- invoices.deduction_personnummer_encrypted, neither of which carries a format
-- CHECK.
--
-- Added NOT VALID, validated in 20260726110001. On hosted there is nothing to
-- re-validate (0 rows have ever held a non-null personal_number), but a
-- self-hosted or forked database may still carry a legacy plaintext row from
-- the pre-encryption era. A validating ADD CONSTRAINT would abort THIS
-- migration on such a row (23514) and stall every migration queued behind it;
-- NOT VALID enforces the ciphertext shape for all new writes immediately and
-- moves the existing-row scan to its own migration, where a failure is
-- isolated and names exactly what has to be cleaned up. Same NOT
-- VALID/VALIDATE split as 20260727090000/20260727090001.

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_personal_number_check;

ALTER TABLE public.customers
  ADD CONSTRAINT customers_personal_number_check
  CHECK (personal_number IS NULL OR personal_number ~ '^[0-9a-f]{76,255}$')
  NOT VALID;

COMMENT ON COLUMN public.customers.personal_number IS
  'Personnummer for individual customers, AES-256-GCM ciphertext (hex iv + ciphertext + auth tag). Never plaintext; read paths decrypt and mask via lib/customers/protect-personal-number.ts.';

NOTIFY pgrst, 'reload schema';
