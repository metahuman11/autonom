#!/usr/bin/env bash
# Shared by the image build and injected into the per-instance bootstrap. No secrets,
# token state, sessions, or application code belong in the reusable runtime image.
GATEWAY_RUNTIME_VERSION=2026-09-19.3
GATEWAY_FFMPEG_DIR=${GATEWAY_FFMPEG_DIR:-/opt/ffmpeg}
GATEWAY_FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-14-13-17/ffmpeg-N-126549-ga51bb69b09-linux64-gpl.tar.xz
GATEWAY_FFMPEG_SHA256=5d6ccb948dd4f4422e1325706dc2828f8c8730198e5ac914c02366ea9334aa9e
GATEWAY_CLOUDFLARED_URL=https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/cloudflared-linux-amd64
GATEWAY_CLOUDFLARED_SHA256=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc

gateway_runtime_log() { printf '[runtime] %s\n' "$*"; }

gateway_core_ready() {
  local cmd
  for cmd in Xvfb startxfce4 xfce4-terminal xfwm4 xfce4-panel xfdesktop thunar mousepad wmctrl dbus-launch xdpyinfo python3 curl xz tar ffmpeg timeout bwrap prlimit node git pulseaudio pactl parec; do
    command -v "$cmd" >/dev/null 2>&1 || return 1
  done
  # Old prebuilt images must install Kurt's CPU renderer too. No display/GPU is
  # needed for this import probe; use the same system Python as the launcher.
  /usr/bin/python3 -c 'import gi, cairo; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk, Gdk, Gio, Pango, PangoCairo' >/dev/null 2>&1 || return 1
}

gateway_ffmpeg_ready() {
  [ -x "$GATEWAY_FFMPEG_DIR/ffmpeg" ] && [ -x "$GATEWAY_FFMPEG_DIR/ffprobe" ] || return 1
  # This checks the build, not the GPU driver. Actual NVENC is tested on the host.
  local encoders
  encoders=$("$GATEWAY_FFMPEG_DIR/ffmpeg" -hide_banner -encoders 2>/dev/null) || return 1
  [[ "$encoders" == *h264_nvenc* ]]
}

gateway_runtime_ready() {
  gateway_core_ready && command -v google-chrome >/dev/null 2>&1 && command -v cloudflared >/dev/null 2>&1 && gateway_ffmpeg_ready
}

gateway_download() {
  curl -4 -fsSL --connect-timeout 10 --max-time 120 --retry 1 --retry-delay 1 -o "$2" "$1"
}

# Only package/network work is retried; this helper never repeats registration,
# model requests or payments. Heartbeats report a fixed stage, never raw logs.
gateway_run_step() {
  local label="$1" limit="$2"; shift 2
  local child status=0 started=$SECONDS
  gateway_runtime_log "$label"
  declare -F beacon >/dev/null && beacon "$label" "starting bounded setup step"
  timeout --signal=TERM --kill-after=10 "$limit" "$@" & child=$!
  while kill -0 "$child" 2>/dev/null; do
    sleep 10
    kill -0 "$child" 2>/dev/null || break
    declare -F beacon >/dev/null && beacon "$label" "elapsed=$((SECONDS-started))s; deadline=${limit}s"
  done
  wait "$child" || status=$?
  if [ "$status" -ne 0 ]; then
    gateway_runtime_log "$label failed (exit=$status)"
    declare -F beacon >/dev/null && beacon "runtime setup FAILED" "$label; exit=$status"
  fi
  return "$status"
}

gateway_apt() {
  # IPv4 avoids long unreachable IPv6 routes on marketplace hosts. Each network
  # operation and the whole subprocess have deadlines, including apt locks.
  gateway_run_step "$1" "$2" env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::ForceIPv4=true -o Acquire::Retries=1 \
    -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 \
    -o DPkg::Lock::Timeout=30 "${@:3}"
}

gateway_prepare_optional_runtime() {
  local optional_tmp
  optional_tmp=$(mktemp -d /tmp/gateway-optional.XXXXXX) || return 1
  if ! command -v google-chrome >/dev/null 2>&1; then
    if gateway_download https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb "$optional_tmp/chrome.deb"; then
      gateway_apt "installing browser" 180 install -y -qq --no-install-recommends "$optional_tmp/chrome.deb" \
        || gateway_runtime_log "Browser unavailable; desktop and broadcast stay running"
    fi
  fi
  if ! command -v cloudflared >/dev/null 2>&1; then
    if gateway_download "$GATEWAY_CLOUDFLARED_URL" "$optional_tmp/cloudflared" \
      && printf '%s  %s\n' "$GATEWAY_CLOUDFLARED_SHA256" "$optional_tmp/cloudflared" | sha256sum -c - >/dev/null 2>&1; then
      install -m 755 "$optional_tmp/cloudflared" /usr/local/bin/cloudflared
    else gateway_runtime_log "Preview tunnel unavailable; no publication capability enabled"; fi
  fi
  rm -f "$optional_tmp/chrome.deb" "$optional_tmp/cloudflared"
  rmdir "$optional_tmp" 2>/dev/null || true
}

gateway_prepare_runtime() {
  if gateway_runtime_ready; then
    gateway_runtime_log "preinstalled runtime ready — no downloads or apt"
    return 0
  fi

  local tmp ffmpeg_pid='' need_core=0 need_ffmpeg=0
  gateway_core_ready || need_core=1
  gateway_ffmpeg_ready || need_ffmpeg=1
  tmp=$(mktemp -d /tmp/gateway-runtime.XXXXXX) || return 1
  mkdir -p "$GATEWAY_FFMPEG_DIR"

  # Preserve the bare-CUDA-image fallback. Downloads overlap apt, and already
  # installed components are never downloaded again.
  if [ "$need_ffmpeg" = 1 ]; then
    gateway_download "$GATEWAY_FFMPEG_URL" "$tmp/ffmpeg.tar.xz" & ffmpeg_pid=$!
  fi
  if [ "$need_core" = 1 ]; then
    gateway_runtime_log "installing missing runtime packages (cold image)"
    gateway_apt "refreshing package index" 120 update -qq || return 1
  fi
  if [ "$need_core" = 1 ]; then
    gateway_apt "installing desktop and audio" 360 install -y -qq --no-install-recommends \
      xvfb xfce4-terminal xfce4-panel xfdesktop4 xfwm4 xfce4-session xfce4-settings thunar mousepad greybird-gtk-theme papirus-icon-theme dbus-x11 x11-utils \
      xfonts-base fonts-dejavu-core fonts-noto-color-emoji ffmpeg python3 python3-gi python3-gi-cairo gir1.2-gtk-3.0 curl ca-certificates procps psmisc wmctrl xz-utils bubblewrap util-linux nodejs git pulseaudio pulseaudio-utils \
      || return 1
  fi
  if [ -n "$ffmpeg_pid" ]; then
    if wait "$ffmpeg_pid" && printf '%s  %s\n' "$GATEWAY_FFMPEG_SHA256" "$tmp/ffmpeg.tar.xz" | sha256sum -c - >/dev/null 2>&1; then
      tar -xJf "$tmp/ffmpeg.tar.xz" -C "$GATEWAY_FFMPEG_DIR" --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe' \
        || gateway_runtime_log "static FFmpeg unpack failed; retaining software fallback"
    else
      gateway_runtime_log "FFmpeg download/checksum failed; retaining software fallback"
    fi
  fi
  rm -f "$tmp/ffmpeg.tar.xz"
  rmdir "$tmp" 2>/dev/null || true
  gateway_core_ready || return 1
  # Image builds still install everything. Live cold boots do optional tools
  # only after the desktop and stream are started, never on the critical path.
  if [ "${GATEWAY_RUNTIME_DEFER_OPTIONAL:-0}" != 1 ]; then gateway_prepare_optional_runtime; fi
  return 0
}

# Wait for readiness instead of sleeping for a fixed delay on every startup.
gateway_wait_until() {
  local deadline=$((SECONDS + $1)); shift
  until "$@"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.2
  done
}

gateway_nvenc_ready() {
  local binary=$1 width=$2 height=$3 fps=$4
  local diagnostic status=0 reason=initialization_failed
  # No network or credentials enter this probe. Only allowlisted failure classes
  # reach logs; never print arbitrary stderr, environment, or provider data.
  diagnostic=$(timeout 8 "$binary" -hide_banner -loglevel error -f lavfi \
    -i "color=c=black:s=${width}x${height}:r=${fps}" -frames:v 1 \
    -c:v h264_nvenc -preset p4 -tune ll -pix_fmt yuv420p -f null - 2>&1 >/dev/null) || status=$?
  [ "$status" -eq 0 ] && return 0
  case "$diagnostic" in
    *libnvidia-encode*) reason=encoder_driver_unavailable ;;
    *libcuda*) reason=cuda_driver_unavailable ;;
    *"required nvenc API"*|*"minimum required Nvidia driver"*) reason=driver_api_incompatible ;;
    *"No capable devices"*) reason=no_encoder_device ;;
    *GLIBC_*) reason=binary_runtime_incompatible ;;
  esac
  [ "$status" -eq 124 ] && reason=probe_timeout
  gateway_runtime_log "NVENC probe: $reason (exit=$status)" >&2
  return "$status"
}

gateway_select_nvenc() {
  local preferred=$1 width=$2 height=$3 fps=$4 system_binary
  if gateway_nvenc_ready "$preferred" "$width" "$height" "$fps"; then
    printf '%s\n' "$preferred"; return 0
  fi
  # A newer bundled encoder can require a newer driver API than the host has.
  # Test the distro's compatible encoder before falling back to CPU rendering.
  system_binary=$(command -v ffmpeg) || return 1
  if [ "$preferred" != "$system_binary" ] && [ "$preferred" != ffmpeg ] \
      && gateway_nvenc_ready "$system_binary" "$width" "$height" "$fps"; then
    printf '%s\n' "$system_binary"; return 0
  fi
  return 1
}
