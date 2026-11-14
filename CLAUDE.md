# App Tabs — CLAUDE.md

Concise design record. Plugin id `app.tabs`, repo `kmbrimble/unraid-app-tabs`. Gitea is primary
(`https://git.kiztigs.com/kmbrimble/unraid-app-tabs`), GitHub (`kmbrimble/unraid-app-tabs`, public) is a read-only push
mirror. **Delivery is from Gitea (since 0.1.1, 14 Nov 2026; Kieren's decision: Gitea delivers all his Unraid plugins, GitHub is for HACS
add-ons only):** `pluginURL` is `https://git.kiztigs.com/kmbrimble/unraid-app-tabs/raw/branch/main/app.tabs.plg`, the `.txz`/`.md5` come from
the Gitea release, a `v*` tag runs `.gitea/workflows/release.yml` (shared `scripts/gitea-release.sh`, canonical copy in unraid-flightplan;
job token or Actions secret `RELEASE_TOKEN`), and the owner is public on Gitea (LAN-only), so no token is needed. Plugin updates therefore
depend on the homelab being up and on the host's `git.kiztigs.com` hosts entry. The GitHub copy has no release workflow any more (removed in the 15 Nov 2026 GitHub exit); Gitea is the only publisher. It was built by copying their
scaffolding; their CLAUDE.md files hold the history of the traps this repo already avoids.

## What it is

A general plugin: a list of web apps (label, URL, open-in, enabled, order) becomes Unraid top-bar tabs, each embedding the
app in an iframe. Settings UI: Settings, Utilities, App Tabs.

## Generic Unraid rules live in skills

Read `unraid-webgui-plugin-pages`, `unraid-plugin-packaging`, `unraid-live-host-testing` and `house-design-system` (and
`forge-release` to ship). Not repeated here. Repo-specific facts only:

## Design (verified against the host's webGui source, Unraid 7.3.4)

- **Pages are keyed by basename, globally** (`PageBuilder.php` `build_pages`: `$site[basename]`). A tab labelled "Docker" would
  shadow a stock page. So generated files are always `AppTab-<slug>.page` (no stock page starts with `AppTab-`), and the
  uppercase first letter is what routes `/AppTab-X` to `template.php` (nginx `location ~^/[A-Z].*`).
- **The top-bar label is the `Name` header**, printed by `Navigation/Main.php` as `_(_var($button,'Name',$pageName))` with NO
  HTML escaping. So the label is held to `[A-Za-z0-9 ._+-]`, 1-24 chars, alphanumeric at both ends (PHP `apptabs_validate_label`
  and JS `validateLabel`, same vectors in `tests/vectors.json`). The case the user typed is preserved in `Name`; the file name
  uses the slug (runs of non-alphanumerics become `-`, case kept). Slugs are unique case-insensitively.
- **Ordering:** `find_pages` keys pages `"$rank{name}"` and `ksort(SORT_NATURAL)`, so ranks above 99 sort numerically.
  Tasks used by stock/other plugins: 1,2,3,4,50,60,70,80,90 (Tools),91 (SecretsMan),92 (NetMan). Tabs take `93 + index` over the
  ENABLED tabs in list order. Max 12 tabs.
- **Header values are not evaluated for our fields** (`Menu` is only evaluated when it starts with `$` or `/`), and the header
  is read with `parse_ini_string`, which is why the label charset excludes quotes and `$`.
- **No user text in a generated page except the whitelisted label (header) and slug.** The page body is one fixed line that
  requires `include/tabpage.php` and calls `apptabs_render_tab('<slug>')`. The URL is looked up in `tabs.json` at render time
  and escaped (`data-url` attribute). `apptabs_page_text()` re-validates every interpolated value and throws, so a bypassed
  validator still cannot write a hostile page (tested directly).
- **Generated files are marked** (`app-tabs:generated` in the body); cleanup only ever deletes `AppTab-*.page` files carrying it.
  `AppTabs.page` (settings) is never touched. A config that does not load deletes ALL generated pages and reports why.
- **`[HOST]`:** only valid as the whole host (`http://[HOST]:9898/`). Brackets are IPv6-literal syntax, so neither `new URL` nor
  `parse_url` is used to validate: a regex does, with the placeholder allowed once as the host. Resolved client-side
  (`location.hostname`, already bracketed for IPv6) by `plugin/app-tabs-core.js`, which both the tab page and the settings app use.
- **Mixed content** is computed (`https:` GUI and a resolved `http:` URL) and replaces the iframe with a message. Blocked
  embedding by `X-Frame-Options`/CSP cannot be detected; documented, not handled.
- **Open in "new browser tab":** the tab page is a landing page with an Open link (no auto `window.open`, which a browser blocks,
  and no every-page injector).
- **Config:** `/boot/config/plugins/app.tabs/tabs.json` `{version:1,tabs:[{label,url,open,enabled}]}`, atomic temp+rename,
  previous good copy kept as `tabs.json.bak`, validated on every load. A corrupt file is an error everywhere (settings page banner,
  tab page text, install log) and `save` refuses to overwrite it.
- **Regeneration** happens on save, and from the install `<INLINE>` block (`php include/generate.php`), which is also the boot hook.
  The remove block keeps `tabs.json`.
- **Endpoint:** `include/api.php`, POST urlencoded only, actions `get` and `save` (whole list), no plugin-side CSRF check (see the
  webgui skill). Env overrides for tests: `APPTABS_CONFIG_DIR`, `APPTABS_PAGES_DIR`, `APPTABS_VAR_INI`, `APPTABS_DYNAMIX_CFG`,
  `APPTABS_UI_DIST`.

## Non-negotiable constraints

- UI follows DESIGN.md. No colour, spacing, radius or shadow values outside the vendored src/styles/tokens.css; changes go
  upstream to kmbrimble/design-system and are re-vendored. Vendored from `kmbrimble/design-system@b6c9faf`.
- Never write outside the plugin directory and `/boot/config/plugins/app.tabs/`. Never put a URL or free text into a generated page.
- Versions are compared with strcmp: single-digit components only (0.1.0, 0.1.1, ... 0.1.9, 0.2.0).
- A tag is immutable: fix forward with a new patch version, never retag.
- Reboots, array and Docker stops are the user's.

## Tests

No test is allowed to skip silently. `php tests/run.php` (builds the UI once and the package several times; prints skips),
`node tests/js.test.js` (shared vectors), `node tests/globals.test.js` (renders real tab pages through PHP and runs the page
script in a vm), and in `ui/`: `npm test` (vitest, jsdom), `npm run check:contrast`, `npm run build`.
CI (Gitea): jobs `php84` (everything) and `php81` (PHP suite), the two required checks on `main`.
Live checks: `NODE_PATH=/tmp/pwcheck/node_modules node scripts/live-check.js shots|exercise|pages` (headless Chromium against the host,
reusing an active root session; never prints it).

## Deploy and verify

Release flow is the `forge-release` skill: version-bump PR (with `&md5;` from CI), merge, tag `v<version>` on Gitea,
the tag runs `.gitea/workflows/release.yml` and publishes the Gitea release. Then `scripts/install-on-host.sh` from the claude-code container
(it waits for the raw `.plg` to converge and verifies the host), and three-way md5: release asset == `.plg &md5;` == the package
file on the host's flash.
