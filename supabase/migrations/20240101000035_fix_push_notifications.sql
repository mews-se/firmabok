-- Migration 035: Fix push notifications
-- 1. Expand notification_log notification_type CHECK constraint to include new event types
-- 2. Add per-event enabled columns to notification_settings

-- Drop and recreate the CHECK constraint with new types
alter table public.notification_log
  drop constraint if exists notification_log_notification_type_check;

alter table public.notification_log
  add constraint notification_log_notification_type_check
  check (notification_type in (
    'tax_deadline',
    'invoice_due',
    'invoice_overdue',
    'period_locked',
    'period_year_closed',
    'invoice_sent',
    'receipt_extracted',
    'receipt_matched'
  ));

-- Add new per-event enabled columns to notification_settings
alter table public.notification_settings
  add column if not exists period_locked_enabled boolean default true,
  add column if not exists period_year_closed_enabled boolean default true,
  add column if not exists invoice_sent_enabled boolean default false,
  add column if not exists receipt_extracted_enabled boolean default true,
  add column if not exists receipt_matched_enabled boolean default true;
