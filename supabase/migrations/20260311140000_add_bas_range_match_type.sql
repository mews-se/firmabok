-- Add 'bas_range' to the match_type CHECK constraint on sie_account_mappings.
-- The account-mapper.ts creates mappings with matchType 'bas_range', but the
-- original CHECK (migration 007) only allowed ('exact', 'name', 'class', 'manual').

alter table sie_account_mappings
  drop constraint if exists sie_account_mappings_match_type_check;

alter table sie_account_mappings
  add constraint sie_account_mappings_match_type_check
    check (match_type in ('exact', 'name', 'class', 'manual', 'bas_range'));
