# Agent-owned VPS workbench

## Current status — 2026-09-15

Gateway API security and panel removal are live. The reviewed controller/bootstrap
modules are served for future boots, but **the workbench is OFF** through
`GATEWAY_WORKBENCH_ENABLED=0`. Existing agent instances were not accessed or restarted.
Terminal execution is unconditionally disabled pending a properly resource-contained
backend. This is a Python tool-calling controller, not Claude Code or local inference.

See [security review](../SECURITY-REVIEW.md) and the latest project HANDOFF for the
deployment record. No public website has an operator dashboard. Maintenance is
authenticated direct-loopback CLI only; holders do not receive VPS control access.

## Permission model

Chat is untrusted input, not execution consent. Even a large holder's ordinary
message has no action permissions. The UI's explicit write/publish choices must be
wallet-signed. Text, code comments and quoted permission JSON cannot grant tools.

Before each model turn and tool action the controller obtains a fresh, short-lived
grant for exactly one order/proposal and its server-derived task workspace. The
backend rechecks holder eligibility, revocation, proposal hash and budget. Reads,
writes, execution and publication are separate capabilities. Execution remains
unavailable even if requested.

## Supported restricted workflow

When eventually enabled after acceptance, file tools can read/create/edit UTF-8 files
only in `/home/agent/work/tasks/<server-derived-id>`. No cross-task paths, symlinks,
hardlinks, special files or protected files. Limits: 512 KB/file, 200 files and 8 MB
per task, 32 tasks, 4,000 files and 64 MB total. These are trusted file-tool quotas,
not kernel limits for arbitrary programs.

Model inference uses the existing Gateway/NanoGPT payment path. Credentials remain
in the broker, outside model context. The controller uses a protected Unix socket,
Linux peer UID authentication and a strict route allowlist; there is no TCP broker
or arbitrary signing/shell endpoint. A compromised trusted OS/controller is outside
this boundary.

Tasks checkpoint paid calls and actions. Interrupted operations pause instead of
replaying. Queues, histories and results are bounded. Model text alone cannot mark
an unwritten file or unverified/unregistered publication complete.

## Publication

Only inert HTML, local CSS, JSON and text are accepted. No JavaScript, SVG, forms,
frames, redirects or external resources. Publication independently reauthorizes the
task and creates a root-owned snapshot, at most 100 files/8 MB. A separate
unprivileged web process serves the selected release. Public verification checks
the HTML hash, manifest and restrictive CSP. Revoked registration restores the prior
release; uncertain listing registration stays incomplete.

Cloudflare Quick Tunnels provide temporary `*.trycloudflare.com` previews, not
permanent free domains or production hosting. Persistence/restore and stable
addresses are not implemented. See
[Cloudflare's limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

Privacy filters redact suspected credentials, IP literals and terminal controls.
They cannot detect every encoded secret or private fact. Keeping secrets outside
model context is the main protection; filtering is defense in depth.

## Gates before enabling

1. Validate the exact controller/socket/file/publication flow in the intended rented
   container, including restart/recovery and resource restrictions.
2. Obtain authorization before real model/publication tests that spend credits or
   expose content. None was performed during this rollout.
3. Implement and test aggregate RAM/process/disk containment before making any
   terminal tool available; package presence or a namespace mock is not sufficient.
4. Define backup/restore and stable hosting before promising persistent websites.
5. Review concurrent changes, back up exact files and coordinate deployment. Do not
   SSH into rented token VPSs or destroy funded instances merely to test changes.

## Verification

Never import the real project's Node modules for tests: `src/env.mjs` loads its
environment file. Use a secret-free copy of source, boot, public assets, tests,
package metadata and sibling public agent prompt with existing dependencies.

```sh
env GATEWAY_OFFLINE=1 VAST_ALLOW_RENT=0 VAST_API_KEY= GATEWAY_ADMIN_PASSWORD= npm test
npm run test:workbench
```

Integrated Linux staging: 79 Node tests and 57 focused Python security tests passed,
including actual Unix peer credentials. The earlier complete macOS Python run had
81 passes and two Linux-only skips. Actual rented-container arbitrary-command
acceptance is outstanding. Gateway public routes were checked after deployment;
this is not a complete host, dependency, smart-contract or payment audit.
