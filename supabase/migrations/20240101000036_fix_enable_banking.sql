-- Migration 036: Fix Enable Banking
-- Add authorization_id column to bank_connections for PSD2 authorization tracking

alter table public.bank_connections
  add column if not exists authorization_id text;
