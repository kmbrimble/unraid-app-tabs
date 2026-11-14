# Changelog

The plugin's own `<CHANGES>` block in `app.tabs.plg` is the release-notes source; this file mirrors it.

## 0.2.0

Docker console tabs: a top-bar tab that shows `docker exec -it <container> tmux attach -t <session>` (or sh/bash) in an
iframe through the host's own ttyd on a root-only unix socket, behind the webGUI login (nginx `auth_request`); no credential
anywhere. New `console.php` (lifecycle: one ttyd per tab, started on page load only, replaced on edit, stopped on delete),
`scripts/console-attach.sh` (ends the container-side process when a connection closes, which `docker exec -it` does not do),
editor kind selector, shared identifier rules in `app-tabs-core.js`. `tabs.json` stays version 1 for URL-only lists (byte for
byte as 0.1.x wrote it) and becomes version 2 only while a console tab exists.

## 0.1.1

Delivery moved from GitHub to Gitea: `pluginURL`, the `.txz` URL and `support` point at git.kiztigs.com; a v* tag publishes a Gitea
release through `.gitea/workflows/release.yml` and `scripts/gitea-release.sh`. No functional change.

## 0.1.0

First release. Settings, Utilities, App Tabs manages a list of web apps shown as top-bar tabs after NetMan: label, URL
(`[HOST]` placeholder, http/https only), open in a tab iframe or a new browser tab, enabled, order. Config on flash,
tab pages generated on save, install and boot.
