#!/usr/bin/env bash
# Builds locally only. This script never logs in, pushes, rents or restarts anything.
set -euo pipefail
IMAGE=${1:?Usage: bash build.sh REGISTRY/OWNER/gateway-runtime:VERSION}
if [[ "$IMAGE" == *:latest || "$IMAGE" != *:* || "$IMAGE" == -* || "$IMAGE" == *[[:space:]]* ]]; then
  echo 'Use an explicit versioned image reference, not :latest.' >&2; exit 2
fi
command -v docker >/dev/null || { echo 'Docker with buildx is required on the build machine.' >&2; exit 2; }
RUNTIME_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
docker buildx build --platform linux/amd64 --load --tag "$IMAGE" "$RUNTIME_DIR"
# No GPU required: verifies packages/encoder build and proves the warm path does
# not require the network. NVENC initialization still needs a separate GPU smoke test.
docker run --rm --network none --entrypoint bash "$IMAGE" -lc \
  'source /opt/gateway-runtime/runtime-setup.sh; gateway_runtime_ready && gateway_prepare_runtime'
printf 'Built and checked locally: %s\nNot pushed or deployed\n' "$IMAGE"
