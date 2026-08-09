-- Invoice inbox: enforce one journal entry per inbox item.
--
-- The book-direct route does a check-then-write (409 guard on
-- created_journal_entry_id, then createJournalEntry, then update).
-- Without a UNIQUE constraint, two concurrent calls for the same
-- inbox item can both pass the guard, both insert a journal entry,
-- and the second update overwrites the FK — orphaning the first
-- entry in an immutable ledger with no inbox reference.
--
-- PostgreSQL treats NULLs as distinct in UNIQUE constraints by
-- default, so unbooked items (NULL) remain unconstrained.

ALTER TABLE public.invoice_inbox_items
  ADD CONSTRAINT invoice_inbox_items_journal_entry_unique
  UNIQUE (created_journal_entry_id);

NOTIFY pgrst, 'reload schema';
