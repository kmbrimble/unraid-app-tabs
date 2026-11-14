# App Tabs

An Unraid plugin that turns a list of web apps into top-bar tabs of the Unraid GUI. Each tab embeds the app in an
iframe (or opens it in a new browser tab), so Backrest, a dashboard or any other LAN web app sits next to Dashboard,
Main and Docker. A tab can also be a **Docker console**: a live terminal into a container (a shell, or a tmux session)
embedded in the page, instead of the Docker tab's Console popup.

> **How this was built.** Most of this code was written by an AI (Claude, through Claude Code). The idea, the
> requirements and the design decisions are human: a person conceived the plugin, directed every step, and reviewed
> and live-tested the result on a real Unraid server before each release. Read the code with that in mind.

## Install

Plugins, Install Plugin, paste:

```
https://git.kiztigs.com/kmbrimble/unraid-app-tabs/raw/branch/main/app.tabs.plg
```

Not distributed through Community Applications. Requires Unraid 7.0 or later.

## Use

Open **Settings, Utilities, App Tabs**. For each tab:

| Field | Meaning |
|---|---|
| Label | The name on the top bar. Letters, digits, spaces and `. _ + -`, up to 24, starting and ending with a letter or digit. It is also the tab's file name (`AppTab-<Label>.page`, address `/AppTab-<Label>`). |
| Kind | **A web app (URL)** or **A Docker console**. |
| URL | (web app) `http://` or `https://` only. `[HOST]` stands for the hostname you opened Unraid with, so `http://[HOST]:9898/` follows whatever address you use (IP, name, IPv6). |
| Open in | (web app) A tab inside Unraid (iframe), or a new browser tab. |
| Container | (console) The Docker container's name, as on the Docker tab. Letters, digits and `. _ -`, starting with a letter or digit, up to 128. |
| tmux session | (console, optional) Attach to this tmux session in the container, by exact name. Same character rules. |
| Shell | (console, only when there is no tmux session) `sh` or `bash`. |
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
- At most 12 tabs (of either kind).

## Docker console tabs

A console tab shows `docker exec -it <container> tmux attach -t <session>` (or `sh`/`bash`) in an iframe, through the
**host's own ttyd**: the same terminal server Unraid's Docker tab Console and webGUI terminal use, on a root-only unix
socket under `/var/tmp` (`_apptabs-<tab>.sock`), reached through nginx's `/logterminal/` proxy, which sits behind the Unraid
login (`auth_request`). No terminal server runs inside the container, and no password, token or port exists anywhere: an
unauthenticated request for the terminal is redirected to the login page.

- **When it starts.** Only when the tab's page is loaded by a signed-in browser, never at install or boot. The page first
  checks that the container exists and is running (and that the tmux session exists), and says plainly if not, rather
  than showing a blank frame. One ttyd per tab then stays up and serves every connection (reloads, reconnects, a second
  window), so revisiting the tab never piles up processes. It is replaced if you edit the tab's container or session and
  stopped when you delete or disable the tab or remove the plugin. A reboot clears it; the next page load starts it again.
- **Closing the tab does not strand a client.** `docker exec -it` leaves its process running in the container when the
  browser goes away (this is also true of Unraid's own Console), which for `tmux attach` would leave a ghost client behind
  on every closed tab, and tmux sizes a window to its smallest client. Each connection therefore runs through
  `scripts/console-attach.sh`, which tags the connection and has the container end exactly the processes carrying that tag
  when the connection closes.
- **Reconnect** reloads the terminal; **Open full page** opens it on its own. Several windows can attach to the same tmux
  session at once (that is tmux's normal behaviour: they mirror each other, and the window is as small as the smallest).
- **Security, plainly.** A console tab is a **writable terminal inside the container**. For `claude-code` that is a
  container with the Docker socket and git credentials. It is exactly as privileged as Unraid's own webGUI terminal and the
  Docker tab's Console, is protected by the same login and nothing else, and anyone signed in to the GUI can use it. The
  terminal is same-origin with the GUI (the iframe runs with the GUI's origin); that is acceptable only because it is the
  host's own ttyd. Container, session and shell are validated against fixed rules (the same identifier rule Unraid's
  launcher uses), re-validated where the command is built, and passed as separate arguments: nothing is ever interpolated
  into a shell string, and the generated page contains only the label and slug.

## Where things live

- Config: `/boot/config/plugins/app.tabs/tabs.json` (flash, written atomically, validated on load; the last good copy is
  `tabs.json.bak`). A list of web-app tabs only is written exactly as 0.1.x wrote it (`version` 1). The first console tab
  switches the file to `version` 2 (every tab gets an explicit `kind`); 0.1.x refuses a version 2 file instead of misreading
  it, and removing the last console tab goes back to a byte-identical version 1 file. A file that does not validate is shown as an error on the settings page and generates **no** tabs;
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
`npm run build`. Releases are cut on the primary forge and published as a Gitea release by a workflow; see CLAUDE.md.

MIT licensed.
