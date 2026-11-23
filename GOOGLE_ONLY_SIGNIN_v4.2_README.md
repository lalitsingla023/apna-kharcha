# MONETRA v4.2 — Google-only sign-in

This update replaces the User ID/password login screen with **Continue with Google**, using the Supabase Google provider already enabled for this project.

## Local-data safety

- Existing local finance storage keys (`apna_kharcha_*`) are not deleted or rewritten by the sign-in change.
- If this browser profile has exactly one existing MONETRA local account, Google sign-in continues into that account automatically.
- If multiple local accounts exist, the app asks which local account's records to open.
- If no local account exists in this browser profile, a new empty local namespace is created for the Google identity. Existing records on another device/browser are not automatically transferred.
- Google authentication is not cloud backup or cross-device sync. Keep your JSON backup and do not clear browser/app storage.
- The old local password login is no longer available from the UI. Existing local account metadata is retained as a data-preservation measure.

## Publish

Upload the **contents** of `pwa_source/` to the root of the existing `apna-kharcha` GitHub Pages repository/branch. Keep `.well-known/assetlinks.json`. Do not upload `personal-data/` or this project archive to the public repository.

## Supabase / Google settings

The supplied Supabase project URL and publishable key are already configured in `supabase-config.js`. The key is a public browser publishable key; never put a service-role/secret key in these files.

Confirm:
- Google provider is enabled in Supabase Authentication → Sign In / Providers.
- Google OAuth Web client has JavaScript origin `https://lalitsingla023.github.io`.
- Google OAuth Authorized redirect URI is the exact callback URL displayed by Supabase for this project.
- Supabase Authentication → URL Configuration allows `https://lalitsingla023.github.io/apna-kharcha/`.

Supabase's browser `signInWithOAuth({ provider: 'google' })` flow redirects to Google and returns to the app; the redirect must be on the Supabase allowed redirect URL list. See Supabase docs: https://supabase.com/docs/reference/javascript/auth-signinwithoauth and https://supabase.com/docs/guides/auth/redirect-urls.

## Safe test sequence

1. Keep your current live site and JSON backup unchanged until this test passes.
2. Upload the files to GitHub and wait for the Pages deployment to finish.
3. On the device/browser that currently contains your existing MONETRA local records, open the website and tap **Continue with Google**.
4. Complete Google sign-in. If prompted, choose the local account that contains your records.
5. Verify transaction totals, loans, card purchases, and a few older records before relying on the update.
6. Test a second device separately. A new device will not inherit local records unless you explicitly restore/import your JSON backup or implement cloud sync later.

If Google sign-in fails, use the browser's reload and check the Supabase redirect allow list. Do not clear site data to troubleshoot.
