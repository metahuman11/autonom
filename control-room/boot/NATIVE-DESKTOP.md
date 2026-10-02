# Rented VPS native desktop

Status: bootstrap/helper deployed to Gateway on 2026-09-15 for future authorized
boots. Configuration tests passed locally and on Linux. Not visually accepted on
a rented desktop; no machine rented, restarted or billed by this rollout.
This replaces the rejected full-screen web desktop described in `DESKTOP.md`.

## Actual Linux session

`bootstrap.sh` starts the real XFCE desktop on the existing Xvfb display. The
default capture is 3840×2160. A light blue-white native wallpaper, Greybird theme,
Papirus icons, scaled text, a top task list/UTC clock and a centered bottom panel
are configured before the session starts. There is no full-screen browser overlay.

The native panel contains four launchers:

- Kurt: a normal, closable Chrome application window showing the same token's
  existing Kurt companion (`/t/:token?screen=1#kurt`). It autostarts; video recursion
  is disabled by the existing screen mode. This one app is web-based, not the OS.
- Chrome: a normal browser window with a separate profile and a blank initial tab.
- Work Files: the real Thunar file manager, opening `/home/agent/work`.
- Text Editor: the real Mousepad editor.

No terminal, administration, power or remote-access button is added to the panel.
Installed development utilities are not removed; app visibility is not a security
boundary. Thunar's initial directory is not a filesystem jail: it can browse files
readable by the unprivileged user. Do not open private data on a broadcast desktop.

## Implementation and boundaries

`native-desktop.py` generates Xfconf XML, native `.desktop` launchers, autostart and
GTK panel styles. `server.mjs` embeds it in bootstrap alongside the runtime helper.
No additional public executable/configuration endpoint is needed. Output names are
fixed; gateway/token inputs are checked; Exec entries contain no shell wrappers.
The writer refuses symlinked homes, parents and output targets.

Runtime `.3` adds Thunar, Mousepad, Greybird and Papirus. The reusable image is still
unbuilt/unpublished. Existing bare-image installation remains available. Themes
fall back to Adwaita if unavailable; required app commands are checked for readiness.

The AI controller still runs unprivileged in the background, with a clean environment
and a root-readable log. Credentials remain behind the existing broker. No new
holder remote-control endpoint, VNC, Jupyter, browser debug port, tool permission,
wallet action or payment path is added. Existing Chrome sandbox flags are unchanged;
this layout change is not a claim of a complete desktop security audit.

Kurt remains the wolf's name and Dennis the configured voice. Public paid speech
is still disabled pending a billing decision. Native apps do not enable execution
tools or change holder authorization/governance/budget rules.

## Verification and rollout

Run `npm run test:desktop` only in a source-only staging copy, not this project root:
the main application's environment loader otherwise reads `.env`. Include only
src/test/boot/public/package.json and the sibling public agent prompt, link existing
node_modules, set `GATEWAY_OFFLINE=1`, `VAST_ALLOW_RENT=0`, `VAST_API_KEY=` and
`NODE_ENV=test`. The rental test mocks the provider; it never rents a machine.

Tests cover XML/desktop parsing, real launcher targets, independent Chrome profiles,
input rejection, write boundaries, DPI/panel scaling, full embedded shell syntax,
retired public web-desktop routes, the registration/stream contract and Kurt assets.
They do not prove an actual XFCE render or working WebGL/NVENC on rented hardware.
This Mac has no Docker or Xvfb available for that acceptance step.

4K is the configured desktop capture, not a guaranteed live playback resolution.
The unchanged NVENC probe/early-exit logic can fall back to 1080p software encoding.
Only verified stream ingest marks a channel live. Public channel status was paused
or stopped when checked; that is not an inventory of the provider's billed rentals.

Current before-copy and staging: `/tmp/gateway-native-desktop-bBSRbL`.
Review/back up a bounded production diff before rollout; do not copy the whole local
backend because other undeployed budget/controller changes are present. Publishing
bootstrap changes future boots only. Applying it to an existing rented machine or
starting a paid test needs a confirmed target and authorized lifecycle/billing step.
Do not replace its registration credentials by replaying the entire bootstrap.

Configuration references: [XFCE's default panel](https://github.com/xfce-mirror/xfce4-panel/blob/master/migrate/default.xml.in)
and [Desktop Entry Exec rules](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html).
