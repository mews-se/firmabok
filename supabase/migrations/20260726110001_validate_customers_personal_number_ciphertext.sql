-- Validate the ciphertext CHECK added NOT VALID in 20260726110000.
-- Separate transaction, mirroring 20260727090000/20260727090001: the scan of
-- existing rows runs without the preceding migration's stronger table lock,
-- and a self-hosted or forked database that still holds a legacy plaintext
-- personal_number row fails HERE, in a migration whose name says what to
-- clean up, instead of aborting the constraint swap itself. New writes are
-- already held to the ciphertext shape either way.

ALTER TABLE public.customers
  VALIDATE CONSTRAINT customers_personal_number_check;
