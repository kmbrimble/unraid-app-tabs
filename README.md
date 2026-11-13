# App Tabs

An Unraid plugin that turns a list of web apps into top-bar tabs of the Unraid GUI. Each tab embeds the app in an
iframe (or opens it in a new browser tab), so Backrest, a dashboard or any other LAN web app sits next to Dashboard,
Main and Docker.

> **How this was built.** Most of this code was written by an AI (Claude, through Claude Code). The idea, the
> requirements and the design decisions are human: a person conceived the plugin, directed every step, and reviewed
> and live-tested the result on a real Unraid server before each release. Read the code with that in mind.

## Install

Plugins, Install Plugin, paste:

```
https://raw.githubusercontent.com/kmbrimble/unraid-app-tabs/main/app.tabs.plg
```

Not distributed through Community Applications. Requires Unraid 7.0 or later.

## Use

Open **Settings, Utilities, App Tabs**. For each tab:

| Field | Meaning |
|---|---|
| Label | The name on the top bar. Letters, digits, spaces and `. _ + -`, up to 24, starting and ending with a letter or digit. It is also the tab's file name (`AppTab-<Label>.page`, address `/AppTab-<Label>`). |
| URL | `http://` or `https://` only. `[HOST]` stands for the hostname you opened Unraid with, so `http://[HOST]:9898/` follows whatever address you use (IP, name, IPv6). |
| Open in | A tab inside Unraid (iframe), or a new browser tab. |
| Enabled | A disabled tab keeps its settings but has no top-bar entry. |

Add, edit, delete (with confirmation), reorder with Up/Down buttons (no drag), enable/disable. Tabs appear after NetMan
in the order of the list. A change shows in the top bar the next time an Unraid page loads (the app offers a reload button).

Things to know:

- **https GUI, http app.** Browsers refuse to show an http page inside an https one (mixed content). The editor warns
  when it sees that combination, and the tab shows a message instead of a blank frame; "Open full page" still works.
- **Apps that forbid embedding** (`X-Frame-Options`, CSP `frame-ancestors`) stay blank: a page cannot detect that.
  Use "Open full page", or change the app's embedding policy.
- **"New browser tab" mode** shows a small landing page with an Open button, because a browser blocks a script from
  opening a tab on its own after a navigation.
- **Same-origin apps are trusted code.** An iframe has no sandbox (apps need scripts and cookies). An app served from the
  same host and port as the Unraid GUI (for example through a reverse proxy path) can reach the GUI page around it. Only
  add apps you trust; a different port counts as a different origin.
- A tab whose file name matches an existing page that App Tabs did not generate is refused rather than overwritten.
- At most 12 tabs.

## Where things live

- Config: `/boot/config/plugins/app.tabs/tabs.json` (flash, written atomically, validated on load; the last good copy is
  `tabs.json.bak`). A file that does not validate is shown as an error on the settings page and generates **no** tabs;
  nothing is overwritten until you fix or remove it by hand.
- Generated pages: `/usr/local/emhttp/plugins/app.tabs/AppTab-*.page`, rebuilt from the config on every save, install
  and boot. Do not edit them.
- Uninstalling removes the plugin and its generated pages but keeps `tabs.json`; delete
  `/boot/config/plugins/app.tabs/` to wipe it.

## Security notes

Labels and URLs are treated as untrusted. A URL is never written into a generated page: the page carries only a
whitelisted slug, and the tab is looked up in `tabs.json` and escaped when it is rendered. Labels are held to a strict
character set because the stock top bar prints them unescaped. The settings endpoint accepts POST only (urlencoded,
Unraid's CSRF token), validates at the server, and writes only `tabs.json` (and its `.bak`) in the flash config
directory and `AppTab-*.page` in the plugin directory.

## Development

See `CLAUDE.md`. In short: `php tests/run.php` (PHP suite, includes the package build and reproducibility checks),
`node tests/js.test.js` and `node tests/globals.test.js`, and in `ui/`: `npm test`, `npm run check:contrast`,
`npm run build`. Releases are cut on the primary forge and published to GitHub by a workflow; see CLAUDE.md.

MIT licensed.
