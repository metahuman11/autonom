# Gateway fast-boot runtime

Status: bootstrap/helper and video-capability code deployed to Gateway for future
boots on 2026-09-15. The prebuilt image has NOT been built, published or selected.
No new machine has been rented to benchmark this path. Workbench activation is off;
terminal execution is disabled regardless of installed runtime packages.

**Native desktop correction (deployed for future boots on 2026-09-15):** runtime version `.3` adds
Thunar, Mousepad, Greybird and Papirus for the actual rented XFCE desktop. The
rejected browser desktop is no longer the boot target. See `../NATIVE-DESKTOP.md`.
The prebuilt image is still unbuilt/unpublished; normal bare-image setup installs
these packages at an authorized boot. No existing token machine was restarted.

## What changes

The normal bare CUDA image remains the default. A versioned, prebuilt runtime can
be selected through the existing `VAST_IMAGE` setting. It contains Chrome, XFCE,
Xvfb, fonts, Python, Node.js, git, bubblewrap, resource-limit utilities, a pinned
cloudflared, the software FFmpeg fallback and a checksum-verified modern
NVENC-capable FFmpeg. A warm boot validates these components and skips all apt
operations and downloads. Bare/partial images install only missing components.

The gateway embeds the same runtime helper into its boot script, so no extra public
endpoint is needed. The agent, rules, session, stream key and token config are still
fetched fresh per instance. The Docker build context is restricted to two files;
never build from the project root or add application data to the image.

Fixed desktop startup sleeps are replaced with bounded readiness checks. A local,
eight-second-max NVENC preflight selects GPU encoding or the existing 1080p software
fallback, also used if the real GPU stream exits early despite a successful probe.
NVIDIA video driver mounts are requested in the rental configuration.
Only the MediaMTX ready event marks a stream live; encoder startup is not proof.

This changes no treasury thresholds, payments, quotas, AI models, wallet ownership,
or the no-SSH/no-Jupyter rental policy.

## Build on a Docker machine

Use Docker with buildx and build **linux/amd64**, including when using an Apple Silicon
Mac. From this directory, replace the example namespace with the owner's registry:

```sh
bash build.sh ghcr.io/YOUR_ORG/gateway-runtime:2026-09-15.3
```

The script builds and runs a network-disabled package check locally. It does **not**
publish, authenticate to a registry, rent hardware, or restart services. On an actual
NVIDIA host, test the image's encoder before activating it:

```sh
docker run --rm --gpus all --network none --entrypoint bash \
  ghcr.io/YOUR_ORG/gateway-runtime:2026-09-15.3 -lc \
  'source /opt/gateway-runtime/runtime-setup.sh; gateway_nvenc_ready /opt/ffmpeg/ffmpeg 3840 2160 24'
```

Then, with the owner's authorization, publish to the chosen registry. The image must
be pullable by Vast; the current client does not send private-registry credentials.
After verifying the published image, prefer an immutable `@sha256:...` reference for
`VAST_IMAGE`. Never bake registry credentials or runtime secrets into the image.

The FFmpeg artifact is pinned to a dated BtbN release and verified using its release
asset SHA-256. If upstream removes that build, deliberately update **both** URL and
digest and rebuild/test a new image version. Chrome updates similarly require a
new build. Do not promise a fixed startup SLA: first pulls, uncached layers, machine
availability, gateway availability and AI-pocket refills still affect readiness.

The workbench adds a separate activation gate and real-Linux isolation requirements.
See [VPS workbench](../WORKBENCH.md) before enabling it. Package presence does not
prove that a rented container permits unprivileged user/network/PID namespaces.

## Rollout and rollback

1. Review only the bootstrap/helper, its renderer, rental capability change and tests.
2. Back up those production files before deployment. Do not use a whole-app sync to
   overwrite concurrent work. The normal installer restarts Gateway; do not run it
   casually while another agent is deploying.
3. Publish and verify the image before changing `VAST_IMAGE`. Do not restart or destroy
   an existing GPU instance or MediaMTX just to apply a runtime to future instances.
4. Enable the versioned image for **future** rentals through the authorized config
   workflow. Editing environment/configuration requires separate owner coordination.
5. At the next authorized new launch record threshold → rent → registration → first
   paid AI completion → MediaMTX live; also record actual video resolution. Do not
   spend treasury money just to obtain a benchmark without confirmation.
6. Roll back to the previous image selection and backed-up renderer/bootstrap/helper
   together. Existing instances retain the files they downloaded at boot.

## Verification without reading production secrets

The existing `src/env.mjs` reads `.env` at import time. Run the test suite from a
temporary copy containing only `src`, `test`, `public`, `boot`, `package.json` and
the sibling public agent prompt. Link the existing `node_modules`; do not copy
`data`, `.env`, secret files or wallet backups. Set `GATEWAY_OFFLINE=1`,
`VAST_ALLOW_RENT=0`, `VAST_API_KEY=` and `GATEWAY_ADMIN_PASSWORD=` when testing. The
new rental test replaces `fetch` with a local stub before temporarily enabling its
fake rental permission. No real request is sent.

## Sources

- [Vast instance creation / args mode](https://docs.vast.ai/api-reference/creating-instances-with-api)
- [Vast base image caching guidance](https://github.com/vast-ai/base-image)
- [NVIDIA driver capabilities](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html)
- [Pinned FFmpeg release](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-14-13-17)
