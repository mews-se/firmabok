-- Register the behandlingshistorik event emitted when a user dismisses the
-- booking-time duplicate guard (force=true) and books a transaction anyway.
--
-- Per BFNAR 2013:2 kap 8, the decision to book over a DETECTED possible
-- double-booking is a legally significant act and must leave a durable,
-- queryable record — not just an ephemeral application-log warn. The book /
-- categorize routes write it via appendProcessingHistory with aggregate_type
-- 'BankTransaction' (already permitted by the aggregate_type CHECK, so no
-- constraint change is needed — only the event-type catalog row).
--
-- processing_history.event_type has an FK to processing_event_types; an
-- unregistered type would fail the insert (and, since the append is best-effort,
-- be silently swallowed), so the event MUST be registered here.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('BankTransactionDuplicateDismissed')
ON CONFLICT (event_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
