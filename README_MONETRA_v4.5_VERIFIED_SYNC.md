# MONETRA v4.5 — verified cloud CRUD and cross-device deletion sync

This release fixes cloud deletion handling and makes every supported create, edit, delete, and backup-restore action wait for Supabase confirmation before showing a success message.

## Before publishing

1. Keep your existing JSON backup and do not clear browser/app storage.
2. Open Supabase Dashboard → SQL Editor → New query.
3. Run the complete contents of `MONETRA_CLOUD_SYNC_V45.sql` once. It is safe to re-run. It adds a nullable `deleted_at` marker, ensures the composite upsert indexes, and sets per-user RLS policies. It does not physically delete or rewrite existing finance records.
4. Keep RLS enabled. Never put a Supabase service-role/secret key in the website.

## Publish to the existing GitHub Pages repository

Replace the website files in the repository root with the files from this archive:

- `index.html`, `style.css`, `app.js`, `sw.js`
- `supabase-config.js`, `manifest.json`
- `icon-192.png`, `icon-512.png`
- `.well-known/assetlinks.json` at the same path

Do not upload this ZIP itself. Keep the existing GitHub Pages settings and Android application ID/package configuration unchanged.

## Update devices

1. Let GitHub Pages finish deploying.
2. On mobile, fully close and reopen MONETRA, then reload while online. On laptop, do the same.
3. Sign in with the same Google account on both devices.
4. Test with one disposable record: add it on mobile, confirm it appears on laptop, delete it on mobile, then confirm it disappears on laptop after reload.
5. Confirm a deletion only after MONETRA shows the cloud-confirmed deletion toast.

## How synchronization works

- New records and edits are upserted to the account's Supabase rows.
- Deletions are represented by `deleted_at` rather than physical row removal. This retained marker prevents an older/offline device from bringing a deleted record back during the next sign-in.
- Cloud reads load only rows where `deleted_at` is null.
- The app verifies the number of rows Supabase confirms for upserts and soft deletes. Missing RLS permissions or schema changes produce an explicit error instead of a false success message.
- This applies to transactions, credit purchases, loans, and linked loan/cardless payment/repayment ledger changes because those data collections are synchronized together.
- Backup restore is an explicit replacement operation and is permitted to restore records present in the selected backup.
- If a deletion/update fails in the cloud, the local copy is retained and the app displays an error. Do not assume another device is synchronized until the error is resolved.

## Supabase verification

To count active (not deleted) records for a specific auth UID, use:

```sql
select
  (select count(*) from public.transactions where user_id = 'YOUR_AUTH_UID' and deleted_at is null) as transactions,
  (select count(*) from public.credit_purchases where user_id = 'YOUR_AUTH_UID' and deleted_at is null) as credit_purchases,
  (select count(*) from public.loans where user_id = 'YOUR_AUTH_UID' and deleted_at is null) as loans;
```

Table Editor may still display rows with a non-null `deleted_at`; they are retained deletion markers, not active records.
