# MONETRA v4.3 — Google-only sign-in, fresh local start and persistent session

This update replaces the User ID/password login screen with **Continue with Google**, using the Supabase Google provider already enabled for this project.

## Local-data safety

- Existing local finance storage keys (`apna_kharcha_*`) are not deleted or rewritten by the sign-in change.
- On the first Google sign-in, if older `apna_kharcha_*` data exists in this browser, the app asks for confirmation before deleting it. This is the requested fresh-start step.
- Only after confirmation are old local Apna Kharcha/MONETRA keys removed from this browser. Your separate JSON backup file is not touched.
- A new, stable local namespace is created for the Google account. Use Backup & Restore → Restore backup to import your saved JSON.
- The Supabase Google session is persisted in browser storage; reload should return directly to the dashboard after session restoration.
- Signing out does not delete finance records. Google authentication is not cloud backup or cross-device sync.

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


## v4.3 changes

- Removed the old local-account picker; each Google identity maps to one stable local data namespace.
- Added an explicit confirmation before clearing older local `apna_kharcha_*` records on the first Google sign-in.
- Fixed reload behavior by waiting for Supabase `INITIAL_SESSION` before showing either the login screen or dashboard.
- Uses Supabase's persisted browser session and restores the dashboard on reload.
- The JSON backup must be imported after the fresh start using the in-app Backup & Restore screen.
