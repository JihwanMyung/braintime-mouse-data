# Braintime Mouse Data

Installable mouse-colony management for desktop, iPhone, iPad and Android. The static app can be hosted on GitHub Pages; shared records use a private Supabase database.

[Open Braintime Mouse Data](https://jihwanmyung.github.io/braintime-mouse-data/) · [Source repository](https://github.com/JihwanMyung/braintime-mouse-data)

Choose **Sign in**, enter your invited lab email, and open the sign-in link from that email. An empty browser opens the shared colony after authentication. If this browser already contains local records, use **Load shared colony** when ready to replace that local copy. The header identifies **Local only** or **Cloud connected**. Use Help for installation and daily workflows.

The public app configuration points to Supabase project `njhetwortngnniyrhcfk` at `https://njhetwortngnniyrhcfk.supabase.co`. Access to records requires an authenticated colony membership; the public project address and publishable key grant no anonymous record access.

## Open locally

From this directory, run `python3 -m http.server 51448 --bind 127.0.0.1 --directory web` and open http://127.0.0.1:51448/. Import the reconstructed `dataset_augmented.json` from the private outputs directory. Use the app's Help link for workflows. Browser edits persist on this device; export a backup before clearing browser data.

Features include animal, breeding, litter and cage records; pedigree views with ambiguous parent links; printable animal cards; room/rack/position views; dated light-protocol and husbandry history; searchable source evidence; immutable imported provenance; and role-controlled cloud edits with conflict detection. Phone/tablet installation requires HTTPS when hosted. Use the browser's Install command or, on iOS/iPadOS, Share → Add to Home Screen.

## Cloud setup

1. Create or select the lab's Supabase project. Apply `supabase/schema.sql`; create/invite lab users through Supabase Auth and establish the owner membership using `supabase/bootstrap.example.sql`.
2. Configure the app with the project URL, **publishable/anon key**, colony UUID, and your lab sign-in. Never use the service-role/secret key in the browser.
3. Import and inspect the reconstructed JSON locally, then use the explicit Upload to shared colony action. Existing different cloud records produce conflicts instead of silent replacement.
4. Publish only the reviewed app assets on GitHub Pages using **Deploy from a branch → `gh-pages` → `/ (root)`**. Run the app tests and `node scripts/prepare-pages.mjs`, then commit only the contents of `_site` to the deployment branch. The preparation script rejects unexpected tracked files, extra web assets and private credential formats. Source code remains on `main`; private records never enter either branch.
5. Set the production app URL as the Supabase Auth Site URL and an allowed redirect URL. The default email sign-in link and invitation link return to the app, which verifies the user and colony membership before saving a browser session. Email codes remain an optional alternative when the email template includes a code. Verify a second lab account and a second device before routine shared use.

See [backend setup](supabase/README.md) and [separate Animal Sheet synchronization](SHEET_SYNC.md). The optional Sheets integration requires an output-workbook service account and deployed function; creating the workbook or writing this code alone does not activate synchronization.

## Public repository boundary

`publication-files.txt` is the explicit source allowlist. For initial publication, stage exactly those paths with `git add --pathspec-from-file=publication-files.txt`, then review the staged files. Raw exports, imported datasets, browser backups, import reports and generated verification reports are excluded. Deployment settings in `web/config.js` may contain only the public project URL, publishable/anon key and colony UUID.

Run `node scripts/prepare-pages.mjs` to verify and create a fresh `_site` package, including `.nojekyll` for static branch hosting. Its output directory must be empty or absent. Publish those contents from a separate checkout of `gh-pages`; the preparation script does not commit or push. The service worker caches only the listed public shell files; private database and source-history responses are never placed in that cache.

`deploy/pages-workflow.example.yml` is an inactive Actions alternative retained for reference. There is no custom workflow under `.github/workflows`; branch deployment uses GitHub's built-in Pages publishing.

## Official lab mark

`web/icons/braintime-mark.png` is the unchanged [Braintime Lab header mark](https://braintime.tmu.edu.tw/assets/images/braintime-121x138.png), retrieved on 2026-10-14 (121 × 138 pixels). The website and printed cards preserve its aspect ratio. Install icons place the same artwork on a white square; the separate maskable icon keeps the complete mark within the central 80% safe circle. Larger icon files resize the supplied raster image and do not add detail.

The interface palette uses the mark’s blue (`#3374B6`), dark blue (`#1F4C7D`), and warm cream (`#F0ECD1`), with charcoal text. Theme tokens in `web/styles.css` also color the pedigree and card views; the manifest and browser theme use the same dark blue.

## Validation

Run `node --test tests/*.test.mjs`. The separate SQL suite runs with `npm ci --prefix supabase/tests` followed by `npm test --prefix supabase/tests`. The SQL suite uses an isolated local PostgreSQL-compatible runtime; it does not alter the shared scientific Python/R/Julia environments.

The public test suite generates synthetic scale data and should run before each release. Additional app round-trip and SQL validation tests use private local fixtures when present and explicitly skip when those files are absent; malformed or unreadable fixtures still fail.

No real colony records or login secrets are included in this source package. Deployment and data-import receipts are maintained separately from the public source repository.

## Managers and user accounts

Mouse and cage records show an editable manager, using the imported SoftMouse owner until an assignment is changed. Original owner fields are preserved. Printed animal and cage cards include managers in a compact two-column layout.

Signed-in members can set their app password and display name in Settings. The configured database owner can list users, invite new accounts, assign Read only or Read & write access, and deactivate access. See `supabase/functions/manage-colony-users/README.md` for the server setup and email-delivery requirements. Passwords and administrative keys are never included in the public app package.
