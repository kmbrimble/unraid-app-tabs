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

A general plugin: a list of tabs becomes Unraid top-bar tabs. A tab is either a **web app** (label, URL, open-in, enabled: an
iframe or a landing page) or, since 0.2.0, a **Docker console** (label, container, optional tmux session, shell, enabled: a
live terminal in an iframe). Settings UI: Settings, Utilities, App Tabs.

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
- **Config:** `/boot/config/plugins/app.tabs/tabs.json` `{version:1,tabs:[{label,url,open,enabled}]}` (see "Console tabs" for
  version 2), atomic temp+rename,
  previous good copy kept as `tabs.json.bak`, validated on every load. A corrupt file is an error everywhere (settings page banner,
  tab page text, install log) and `save` refuses to overwrite it.
- **Regeneration** happens on save, and from the install `<INLINE>` block (`php include/generate.php`), which is also the boot hook.
  The remove block keeps `tabs.json`.
- **Endpoint:** `include/api.php`, POST urlencoded only, actions `get` and `save` (whole list), no plugin-side CSRF check (see the
  webgui skill). Env overrides for tests: `APPTABS_CONFIG_DIR`, `APPTABS_PAGES_DIR`, `APPTABS_VAR_INI`, `APPTABS_DYNAMIX_CFG`,
  `APPTABS_UI_DIST`.

## Console tabs (0.2.0)

Decisions, with the evidence they rest on (Unraid 7.3.4, ttyd 7.0.1):

- **No terminal server in the container, no credential anywhere.** A console tab runs the HOST's ttyd (through Unraid's
  `/usr/local/sbin/ttyd-exec`, which sources `/etc/default/ttyd`) on a root-only unix socket `/var/tmp/_apptabs-<slug>.sock`.
  nginx's `location ~ /logterminal/(.*)/(.*)$` proxies `/logterminal/<name>/` to `unix:/var/tmp/<name>.sock`, and the http-level
  `auth_request /auth-request.php` makes that need the webGUI session (proved live: unauthenticated `/`, `/token` and the `ws`
  upgrade get a 302 to `/login`, a bogus cookie too, while the same requests with a session get 200 / 101). `servers.conf`'s
  `frame-ancestors 'self'` allows the same-origin iframe. The reason for all this is claude-code-unraid issue #19 / CHANGELOG 0.29
  (a ttyd inside the container could only take its password on argv).
- **Socket name `_apptabs-<slug>`.** Every other socket there is named after a Docker container, a disk or a log, and all of those
  start with `[A-Za-z0-9]` (OpenTerminal.php), so a leading underscore cannot collide with or reach one of them. The slug is the
  whitelisted tab slug, re-validated by `apptabs_console_sockname()`.
- **Lifecycle differs from Unraid's launcher on purpose.** Unraid uses `-om1` (one client, exit on disconnect), which makes every
  reload race a dying process. Here ttyd runs WITHOUT `-o`/`-m`: one per tab, serving every connection, found by exact match
  (`/proc/<pid>/cmdline`: executable name `ttyd` and `-i <socket>` as an exact argv pair, never `pgrep -f`, which matches the agent's
  own command line), replaced only when its command no longer equals the tab's, started only by `apptabs_console_prepare()` from a
  page load, serialised by a per-socket flock, readiness = a real connect (a killed ttyd leaves its socket file behind). Stopped by
  `apptabs_console_reap()` after a save (tab removed, disabled or edited) and by `include/console-stop.php` from the .plg remove block.
- **`docker exec -it` orphans its process in the container** when the client goes away: killing the docker CLI with HUP, INT, TERM or
  KILL all leave the `tmux attach` client running (measured), and tmux sizes a window to its smallest client, so every closed
  browser tab would leave a ghost that can shrink Kieren's real session. `scripts/console-attach.sh` is therefore what ttyd runs:
  it tags the connection (`docker exec -e APPTABS_CONN=<uuid>`) and on SIGHUP (ttyd is started with `-s1`, not `-s9`, so the wrapper
  can run) asks the container to HUP every process whose environment carries that id. Measured live: 5 reloads leave 1 tmux client.
  Unraid's own Console has the same orphaning for the shells it opens; that is not ours to change.
- **No shell, ever.** Every command is an argv array (`proc_open` with an array never involves `/bin/sh`); the wrapper gets container,
  session and shell as separate arguments, re-validates them with the same rule and passes them on separately. A test fails if
  `console.php` contains `exec(`/`system(`/backticks or a `proc_open` that is not the argv one. `tmux attach-session -t =<name>`:
  the `=` is an exact match, not a prefix.
- **Pre-checks give messages, not blank frames:** `docker ps -a` compared by exact name (`--filter name=` is a substring match),
  then `docker exec <c> tmux has-session -t =<s>`; stopped, missing, no tmux, no session, Docker down (a hung docker is cut off at
  6 s), no `ttyd-exec`, ttyd not listening in 3 s each have their own text, all HTML-escaped.
- **Config version (deliberate).** URL-only lists are written exactly as 0.1.x wrote them (version 1, four keys, no `kind`): installing
  0.2.0 changes nothing on flash and a downgrade keeps working. The first console tab switches the file to version 2 with an explicit
  `kind` on every tab; going back to URL-only rewrites the exact version 1 file (tested byte for byte). The 0.1.1 loader drops unknown
  keys but requires `url` and `open`, so it would have turned a version 1 console entry into an error or, worse, a URL tab on its next
  save; it instead refuses a version 2 file ("not a version 1 App Tabs file", no tabs generated, nothing overwritten). A version 1 file
  containing a console tab is rejected by this loader too. `tests/fixtures/tabs-0.1.1.php` is a byte copy of the 0.1.1 `tabs.php`
  (CI checks out shallow, so `git show` is not available) and the tests run the real old loader against new files in a subprocess.
- **The generated page is unchanged** for a console tab: the same fixed line with only the slug; the kind is looked up at render time.
- **Security statement (keep it in README):** a console tab is a writable terminal in the container (for claude-code: the Docker socket
  and git credentials), exactly as privileged as Unraid's webGUI terminal and the Docker tab's Console, protected by the same login
  only, and same-origin with the GUI.
- Testing seams: `APPTABS_DOCKER`, `APPTABS_TTYD_EXEC`, `APPTABS_BASH`, `APPTABS_SOCK_DIR`; stand-ins in `tests/stubs/` (a docker that
  orphans its "container process" like the real one, a ttyd-exec, a fake ttyd that listens on the socket). Never run the console tests
  or `live-check.js console-*` against the real `claude` session: functional tests use a throwaway tmux session `apptabs-test`.

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
Live checks: `NODE_PATH=/tmp/pwcheck/node_modules node scripts/live-check.js shots|exercise|pages|console-setup|console-test|console-clean|console-real` (headless Chromium against the host,
reusing an active root session; never prints it).

## Deploy and verify

Release flow is the `forge-release` skill: version-bump PR (with `&md5;` from CI), merge, tag `v<version>` on Gitea,
the tag runs `.gitea/workflows/release.yml` and publishes the Gitea release. Then `scripts/install-on-host.sh` from the claude-code container
(it waits for the raw `.plg` to converge and verifies the host), and three-way md5: release asset == `.plg &md5;` == the package
file on the host's flash.
