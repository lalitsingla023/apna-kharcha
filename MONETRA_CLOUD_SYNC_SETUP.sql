-- MONETRA v4.4 cloud-sync prerequisites
-- Run once in Supabase Dashboard -> SQL Editor.
-- This creates the composite unique keys required for safe upsert by user and record.
-- It does not delete or modify any existing finance records.

create unique index if not exists transactions_user_record_id_uidx
  on public.transactions (user_id, record_id);

create unique index if not exists credit_purchases_user_record_id_uidx
  on public.credit_purchases (user_id, record_id);

create unique index if not exists loans_user_record_id_uidx
  on public.loans (user_id, record_id);
