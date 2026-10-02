# Build only from this directory, never from the app/repository root.
FROM nvidia/cuda:12.8.1-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

# curl must be available before the shared installer starts parallel downloads.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates
COPY runtime-setup.sh /opt/gateway-runtime/runtime-setup.sh
RUN bash -c 'set -e; source /opt/gateway-runtime/runtime-setup.sh; gateway_prepare_runtime; gateway_runtime_ready' \
    && printf '2026-09-15.3\n' > /opt/gateway-runtime/version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Keep the runtime reusable: config, session, agent code and personality are fetched
# from Gateway at boot, never baked into a distributable image.
WORKDIR /opt/gateway-runtime
ENTRYPOINT []
CMD ["bash"]
