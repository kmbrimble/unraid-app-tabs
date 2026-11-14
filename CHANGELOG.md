# Changelog

The plugin's own `<CHANGES>` block in `app.tabs.plg` is the release-notes source; this file mirrors it.

## 0.1.1

Delivery moved from GitHub to Gitea: `pluginURL`, the `.txz` URL and `support` point at git.kiztigs.com; a v* tag publishes a Gitea
release through `.gitea/workflows/release.yml` and `scripts/gitea-release.sh`. No functional change.

## 0.1.0

First release. Settings, Utilities, App Tabs manages a list of web apps shown as top-bar tabs after NetMan: label, URL
(`[HOST]` placeholder, http/https only), open in a tab iframe or a new browser tab, enabled, order. Config on flash,
tab pages generated on save, install and boot.
