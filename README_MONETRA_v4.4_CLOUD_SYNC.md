# MONETRA v4.4 — Google sign-in and Supabase cloud sync

This version keeps browser local storage as an offline cache and synchronizes the signed-in Google account's finance records with Supabase. It supports transactions, credit card purchases (including payment arrays), and loans (including repayment arrays).

## Important before deployment

1. Keep the existing JSON backup file. Do not clear browser data or uninstall the Android app.
2. In the MONETRA Supabase project, open **SQL Editor** and run the contents of `MONETRA_CLOUD_SYNC_SETUP.sql` once. This creates the composite unique indexes used by the app's safe upserts. It does not delete existing records.
3. Confirm RLS is enabled and that authenticated users have policies permitting SELECT, INSERT, UPDATE and DELETE only for rows where `user_id = auth.uid()` on `transactions`, `credit_purchases`, and `loans`. Do not disable RLS.

## Publish to GitHub Pages

Upload/replace the app files in the root of the existing `apna-kharcha` repository with these files from this archive:

- `index.html`
- `style.css`
- `app.js`
- `sw.js`
- `supabase-config.js`
- `manifest.json`
- `icon-192.png`
- `icon-512.png`
- `.well-known/assetlinks.json` (keep this file and its path)

Do not upload the ZIP itself or the SQL/README files as website assets. Do not replace your GitHub repository or change its Pages settings.

## First sync procedure — do this on the device that already displays the restored data

1. After GitHub Pages finishes deploying, open the MONETRA website on the mobile device that currently shows the restored JSON data.
2. Reload the site while connected to the internet. If the old version remains, fully close and reopen the browser/TWA, then reload once more.
3. Sign in with the same Google account. The app reads the current device's local MONETRA data and uploads the records to that authenticated account in Supabase.
4. The app should report that it uploaded the transactions. Check Supabase Table Editor: `transactions`, `credit_purchases`, and `loans` should contain the restored rows for that user's UUID.
5. Only after verifying the rows, open MONETRA on the laptop and sign in using the same Google account. The laptop should download those cloud records and display the same data.

## Sync behavior

- First sign-in on a device reads that account's rows from Supabase. If cloud rows exist, cloud-only records are copied into local storage; local-only records are preserved and then synchronized.
- If the cloud tables are empty but the current device already has local records (such as a previously imported JSON backup), those records are uploaded to Supabase.
- Creating, editing, deleting, or restoring records saves locally first and then synchronizes the account's full set of records.
- A failed cloud request does not delete the local copy. The app shows an error toast; retry by reloading after connectivity/schema issues have been fixed.
- All cloud operations use the current Supabase Google session and RLS. No service-role key is used in browser code.

## Database assumptions

The existing tables must have these columns:

- `transactions`, `credit_purchases`, `loans`: `id` (identity primary key), `user_id` (uuid), `record_id` (text), `data` (jsonb), `created_at`, `updated_at`.
- RLS must remain enabled, with authenticated-user policies that constrain each row to `auth.uid() = user_id` for reads, inserts, updates and deletes.

If Supabase reports an RLS or column error, stop and share the exact error. Do not disable RLS and never add a service-role/secret key to the app.
