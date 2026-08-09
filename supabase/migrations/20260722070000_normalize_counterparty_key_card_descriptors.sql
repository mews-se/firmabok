-- Card-descriptor awareness for normalize_counterparty_key().
--
-- Card-network descriptors embed '*' between merchant identity and a
-- per-charge tail (product, order ref, city): "ANTHROPIC* CLAUDE SUB SAN
-- FRANCISCO" is the merchant "ANTHROPIC", not five words. The tail varies
-- between charges, so keeping it splinters every recurring foreign SaaS
-- subscription into a new counterparty key each month; counterparty matching
-- and ledger usage stats then report no signal for merchants with a dozen
-- prior bookings. Processor descriptors ("PAYPAL *SPOTIFY", "SQ *BLUE
-- BOTTLE") put the real merchant AFTER the star instead, keyed off a fixed
-- processor prefix list.
--
-- This is the SQL mirror of extractCardDescriptorCore() inside
-- normalizeCounterpartyName() (lib/bookkeeping/counterparty-templates.ts).
-- Keep the two in sync: categorization_templates.counterparty_name is written
-- through the TS side, and lib/agent-context/ledger-context.ts joins RPC rows
-- to templates on this key. Parity is asserted by
-- tests/pg/ledger-usage-stats-rpc.pg.test.ts.
--
-- CREATE OR REPLACE, no signature change: get_ledger_usage_stats() and the
-- deep-context RPCs pick the new body up unchanged.

CREATE OR REPLACE FUNCTION public.normalize_counterparty_key(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  cleaned text;
  tokens text[];
  last_tok text;
  star_pos int;
  head text;
  tail text;
  head_key text;
  months constant text[] := ARRAY[
    'jan','feb','mar','apr','maj','may','jun','jul','aug','sep','sept',
    'okt','oct','nov','dec',
    'januari','februari','mars','april','juni','juli','augusti',
    'september','oktober','november','december'
  ];
  -- Mirror of PROCESSOR_STAR_PREFIXES (counterparty-templates.ts).
  processors constant text[] := ARRAY[
    'paypal','klarna','izettle','zettle','iz','sq','sp','sumup',
    'google','stripe','payu','mollie'
  ];
BEGIN
  IF raw IS NULL THEN
    RETURN '';
  END IF;

  -- stripBankNoise(): payment-rail prefixes, dates, invoice refs,
  -- trailing digit runs.
  cleaned := regexp_replace(raw, '^(BANKGIRO|SWISH|KORTKÖP|KORT[[:space:]]*KÖP|PG|BG|AUTOGIRO|PLUSGIRO)[[:space:]]*', '', 'i');
  cleaned := regexp_replace(cleaned, '\y\d{2,4}[-/]?\d{2}[-/]?\d{2}\y', '', 'g');
  cleaned := regexp_replace(cleaned, '\y[F#]?\d{4,}\S*', '', 'gi');
  cleaned := regexp_replace(cleaned, '\yINV-?\d+', '', 'gi');
  cleaned := regexp_replace(cleaned, '[[:space:]]+\d{4,}[[:space:]]*$', '', 'g');
  cleaned := btrim(cleaned);

  -- extractCardDescriptorCore(): keep the merchant segment of a card
  -- descriptor. Head unless the head is a processor prefix; then tail.
  star_pos := position('*' in cleaned);
  IF star_pos > 0 THEN
    head := btrim(substr(cleaned, 1, star_pos - 1));
    tail := btrim(substr(cleaned, star_pos + 1));
    head_key := regexp_replace(lower(head), '[^a-z0-9åäöé]', '', 'g');
    IF head_key = ANY(processors) AND tail <> '' THEN
      cleaned := tail;
    ELSIF length(head_key) >= 3 THEN
      cleaned := head;
    ELSIF tail <> '' THEN
      cleaned := tail;
    ELSE
      cleaned := head;
    END IF;
  END IF;

  -- stripTrailingNoiseTokens(): pop trailing month names and 1-2 letter
  -- all-caps initials (checked against ORIGINAL casing, before lowering);
  -- always keep at least one token.
  tokens := regexp_split_to_array(cleaned, '[[:space:]]+');
  WHILE coalesce(array_length(tokens, 1), 0) > 1 LOOP
    last_tok := tokens[array_length(tokens, 1)];
    IF lower(last_tok) = ANY(months) OR last_tok ~ '^[A-ZÅÄÖ]{1,2}$' THEN
      tokens := tokens[1:array_length(tokens, 1) - 1];
    ELSE
      EXIT;
    END IF;
  END LOOP;
  cleaned := array_to_string(tokens, ' ');

  -- normalizeMerchantName(): lowercase, strip special chars (keep Swedish
  -- letters), drop legal-form suffixes, collapse whitespace.
  cleaned := lower(cleaned);
  cleaned := regexp_replace(cleaned, '[^a-z0-9_[:space:]åäöé]', '', 'g');
  cleaned := regexp_replace(cleaned, '\y(ab|hb|kb|ek|för|stiftelse)\y', '', 'g');
  cleaned := regexp_replace(cleaned, '[[:space:]]+', ' ', 'g');
  RETURN btrim(cleaned);
END;
$$;
