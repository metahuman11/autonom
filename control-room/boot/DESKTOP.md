# Kurt desktop — 4K-ready broadcast home

> REJECTED WEB DRAFT — superseded on 2026-09-15 by [the native desktop setup](NATIVE-DESKTOP.md).
> The owner meant the rented VPS's real Linux desktop, not a browser recreation.
> The descriptions below are historical, not the current bootstrap. The public
> `/desktop/:token` route and its asset routes have been removed from the server.
> Draft source and the separate local preview remain recoverable, not a VPS preview.

Owner requested a beautiful, uncluttered VPS home screen with only necessary apps.
The approved white/blue-grey direction and permanent Kurt/Dennis identity remain.

## What opens on the VPS

`bootstrap.sh` opens Chrome full-screen at `/desktop/<token>` instead of the old
half-screen terminal + half-screen token page. The AI controller still runs as
the same unprivileged `agent` user with a clean environment and existing broker,
permission and spending rules. Its stdout/stderr go to a root-readable log at
`/var/log/gateway/agent.log`, not onto the public video. No new app privileges,
packages, paid services, remote desktop endpoints or terminal tools are added.

The four visible app shortcuts are deliberately limited to:

1. **Kurt** — the real interactive 3D companion, latest reply and upcoming task.
2. **Community** — read-only real public conversation, plus a link to participate
   on the holder's own device. No wallet connection on the broadcast desktop.
3. **Work** — public community tasks and downloadable saved outputs. This is not
   a file explorer and cannot read `/home`, credentials or private machine files.
4. **Browser** — fixed links to this token's public channel and published website.
   No arbitrary URL bar, iframe, command console or operator panel is provided.

Switching these apps only changes the viewer's local page. It does not remotely
control a VPS. The same SSE stream as the community page provides data. Every
reply/task uses `textContent`, artifact IDs are validated, and all destinations
are same-token platform routes. The page uses a same-origin CSP and no frames,
forms, microphone, signing requests, paid speech or inline/external scripts.

## Display and performance

- Desktop and Xvfb retain configurable capture geometry, default **3840×2160**.
  Chrome uses a 2× device scale for readable text at native 4K capture.
- The 3D view allows up to 2× pixel density on the desktop with a four-megapixel
  fill-rate ceiling. Hidden apps/tabs suspend rendering; reduced motion works.
- Light native XFCE fallback wallpaper matches the app. Native panel auto-hides;
  no terminal or filesystem icons are placed on the broadcast home screen.
- Chrome no longer explicitly disables GPU rendering. WebGL availability still
  requires checking on a real Linux/Xvfb machine. No unsafe software-WebGL or
  remote-debugging override was added. Existing browser sandbox flag is unchanged.
- This is a **4K-ready interface**, not a claim the live stream is already 4K.
  Existing NVENC probe and early-failure handling are preserved; software fallback
  still encodes 1080p. Only actual ingest readiness establishes a live broadcast.
- Dennis remains selected but public speech is disabled pending the owner's
  billing decision and a capped, authorized payment/settlement test.

## Files and preview

`public/desktop.{html,css,js}` are the home screen. `src/server.mjs` contains the
exact desktop route/assets and CSP. `public/kurt/wolf-scene.mjs` handles bounded
native rendering and hidden-app suspension. The existing Wolf rig and licenses
are reused unchanged.

Read-only local review, using actual public community data:
`http://127.0.0.1:57329/desktop/0xd088030dbafF5ac7ac6Eb41042FEBBd78c3AD4f7`

Run only the standalone `tools/kurt-preview.mjs` to preview without loading app
credentials. Main tests must run from a source-only staging checkout without
`.env`, production state, or private keys. Current before-copy and test staging
are under `/tmp/gateway-desktop-Ow16go`.

## Rollout boundary

Not deployed. No production process, token VPS, treasury or voice provider was
started or changed. The previous request for public deployment approval remains
unanswered. Do not deploy the entire local backend: the preceding holder-budget
work has separate compatibility gates. Publish only a reviewed guarded diff once
authorized. Deploying bootstrap source affects future boots; it does NOT update
an already running VPS. Do not destroy/rent/restart a token machine just to apply
this layout without explicit authority and a compatible billing/controller check.

No actual Linux desktop/WebGL/4K encoder acceptance or browser visual QA was run.
