-- MONETRA v4.5 cloud synchronization migration.
-- Run once in Supabase Dashboard -> SQL Editor.
-- Safe to re-run. Does not physically delete or rewrite existing financial data.

-- Composite keys required by the app's upserts.
create unique index if not exists transactions_user_record_id_uidx
  on public.transactions (user_id, record_id);
create unique index if not exists credit_purchases_user_record_id_uidx
  on public.credit_purchases (user_id, record_id);
create unique index if not exists loans_user_record_id_uidx
  on public.loans (user_id, record_id);

-- Soft-delete marker: retained rows communicate deletions to other devices.
alter table public.transactions add column if not exists deleted_at timestamptz;
alter table public.credit_purchases add column if not exists deleted_at timestamptz;
alter table public.loans add column if not exists deleted_at timestamptz;

-- Keep RLS enabled and ensure each authenticated user can perform only their own CRUD operations.
alter table public.transactions enable row level security;
alter table public.credit_purchases enable row level security;
alter table public.loans enable row level security;

-- Table privileges are still constrained by the per-user RLS policies below.
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.credit_purchases to authenticated;
grant select, insert, update, delete on public.loans to authenticated;

do $$
declare t text;
begin
  foreach t in array array['transactions','credit_purchases','loans'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = auth.uid())', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('create policy %I on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = auth.uid())', t || '_delete_own', t);
  end loop;
end $$;

-- Helpful indexes for per-account reads and active-record synchronization.
create index if not exists transactions_user_deleted_idx on public.transactions (user_id, deleted_at);
create index if not exists credit_purchases_user_deleted_idx on public.credit_purchases (user_id, deleted_at);
create index if not exists loans_user_deleted_idx on public.loans (user_id, deleted_at);
