#!/usr/bin/env bash
# Autonom VPS bootstrap. Served by the gateway at /boot/<token>/<code> with the
# placeholders below filled in. Runs as the container's command on a bare CUDA image:
# installs a virtual desktop, registers with the gateway (one-time code → session),
# runs the controller in the background and streams the real XFCE desktop.
# No SSH, no operator login. Nothing secret arrives before registration, and the
# session/stream key are written to a root-only directory the agent user cannot read.
set -u
export DEBIAN_FRONTEND=noninteractive
export LANG=C.UTF-8 LC_ALL=C.UTF-8 LANGUAGE=en_US:en
GATEWAY="__GATEWAY__"
INGEST="__INGEST__"
TOKEN="__TOKEN__"
CODE="__CODE__"
LOCK=/run/gateway-boot.lock
mkdir -p /run /etc/gateway /var/log/gateway
if [ -e "$LOCK" ]; then echo "[boot] already started"; sleep infinity; fi
echo $$ > "$LOCK"
log() { echo "[boot $(date -u +%H:%M:%S)] $*" | tee -a /var/log/gateway/boot.log; }
# Progress beacon: before registration the boot code proves who we are, afterwards the
# session does. Best effort — the panel shows each step so a stuck boot is visible.
beacon() {
  local step="$1" detail="${2:-}"
  # python3 is not on the bare image before apt runs: fall back to a plain-shell JSON.
  local body; body=$(python3 -c 'import json,sys; print(json.dumps({"token":sys.argv[1],"code":sys.argv[2],"step":sys.argv[3],"detail":sys.argv[4][:1500]}))' "$TOKEN" "$CODE" "$step" "$detail" 2>/dev/null) \
    || body=$(printf '{"token":"%s","code":"%s","step":"%s","detail":"%s"}' "$TOKEN" "$CODE" "$(printf '%s' "$step" | tr -d '"\\' | head -c 80)" "$(printf '%s' "$detail" | tr -d '"\\\n' | head -c 300)")
  local auth=""; [ -r /etc/gateway/session.json ] && auth="Bearer $(python3 -c 'import json;print(json.load(open("/etc/gateway/session.json"))["session"])' 2>/dev/null)"
  curl -fsS -m 15 -X POST "$GATEWAY/api/vps/progress" -H "Content-Type: application/json" ${auth:+-H "Authorization: $auth"} -d "$body" >/dev/null 2>&1 || true
}
BOOT_STARTED=$SECONDS
beacon "boot script started" "$(uname -a; nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1)"

# Injected by the gateway from boot/runtime/runtime-setup.sh. The same functions
# build the reusable image; the rendered bootstrap remains a single script.
__GATEWAY_RUNTIME_SETUP__
GATEWAY_RUNTIME_DEFER_OPTIONAL=1
beacon "preparing runtime"
if ! gateway_prepare_runtime; then
  beacon "runtime setup FAILED" "required desktop packages are unavailable"
  exit 1
fi
beacon "runtime ready" "elapsed=$((SECONDS - BOOT_STARTED))s preinstalled components are reused"

log "registering with the gateway"
HOST_INFO=$(python3 - <<'PY'
import json, os, platform, subprocess
gpu = ""
try: gpu = subprocess.run(["nvidia-smi","--query-gpu=name","--format=csv,noheader"], capture_output=True, text=True, timeout=10).stdout.strip().split("\n")[0]
except Exception: pass
print(json.dumps({"hostname": platform.node(), "gpu": gpu, "cpus": os.cpu_count(), "kernel": platform.release()}))
PY
)
REG=$(curl -fsS -X POST "$GATEWAY/api/vps/register" -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"code\":\"$CODE\",\"host\":$HOST_INFO}") || { log "registration refused — stopping"; beacon "registration refused"; sleep infinity; }
python3 - "$REG" <<'PY'
import json, sys, os
r = json.loads(sys.argv[1])
os.makedirs("/etc/gateway", exist_ok=True)
with open("/etc/gateway/session.json", "w") as f: json.dump({"session": r["session"], "streamKey": r["streamKey"]}, f)
os.chmod("/etc/gateway/session.json", 0o600)
with open("/etc/gateway/config.json", "w") as f: json.dump(r["config"], f, indent=1)
os.chmod("/etc/gateway/config.json", 0o644)
with open("/etc/gateway/prompt.md", "w") as f: f.write(r.get("prompt", ""))
PY
log "registered; token $TOKEN"

# The agent runs as its own user with no access to /etc/gateway/session.json.
id -u agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
chmod 700 /etc/gateway; chmod 644 /etc/gateway/config.json /etc/gateway/prompt.md 2>/dev/null; chmod 711 /etc/gateway
mkdir -p /opt/gateway-agent /home/agent/work /var/lib/gateway-sites
chown agent:agent /home/agent/work
chmod 700 /home/agent/work
chmod 755 /opt/gateway-agent /var/lib/gateway-sites
id -u gateway-web >/dev/null 2>&1 || useradd -r -M -d /var/empty/gateway-web -s /usr/sbin/nologin gateway-web
mkdir -p /var/empty/gateway-web
chown gateway-web:gateway-web /var/empty/gateway-web
chmod 700 /var/empty/gateway-web
# Executable controller/broker code is root-owned and outside the model workspace.
for MODULE in agent.py privacy.py workbench.py publisher.py relay.py supervisor.py desktop-kurt.py native-speech.py; do
  curl -fsSL --connect-timeout 15 --max-time 60 "$GATEWAY/boot/$MODULE" -o "/opt/gateway-agent/$MODULE" \
    || { beacon "agent module download FAILED"; exit 1; }
  chmod 644 "/opt/gateway-agent/$MODULE"
done

# Fixed, checksum-pinned animation of our existing wolf. Root-owned; no browser,
# external model download, WebGL flags, credentials or code from the public feed.
curl -fsSL --connect-timeout 15 --max-time 90 --retry 2 --max-filesize 8388608 \
  "$GATEWAY/kurt/assets/desktop-atlas.png" -o /opt/gateway-agent/desktop-atlas.png \
  || { beacon "Kurt assets FAILED" "animation download failed"; exit 1; }
if ! printf '%s  %s\n' '4fc470e9e9284ee12bdbd51d9012235d1f86249c7bf7412b78d062c7e11e0ff1' /opt/gateway-agent/desktop-atlas.png | sha256sum -c - >/dev/null 2>&1; then
  beacon "Kurt assets FAILED" "animation checksum mismatch"
  exit 1
fi
chmod 644 /opt/gateway-agent/desktop-atlas.png

# A protected Unix socket broker adds the session. No credential service listens
# on a TCP port, so the desktop browser cannot call it. No TCP fallback.
nohup env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 python3 /opt/gateway-agent/relay.py >/var/log/gateway/relay.log 2>&1 &
unset REG CODE
CODE=""

log "starting virtual desktop"
# Stream geometry comes from the gateway config (settings.stream*), 4K by default.
read -r W H FPS KBPS < <(python3 -c 'import json;c=json.load(open("/etc/gateway/config.json")).get("stream",{});print(c.get("width",3840),c.get("height",2160),c.get("fps",24),c.get("kbps",12000))')
export DISPLAY=:99
DPI=96; [ "$W" -ge 3000 ] && DPI=192
Xvfb :99 -screen 0 ${W}x${H}x24 -dpi "$DPI" -nolisten tcp >/var/log/gateway/xvfb.log 2>&1 &
if gateway_wait_until 10 xdpyinfo -display :99 >/dev/null 2>&1; then
  beacon "virtual desktop up" "${W}x${H}"
else
  beacon "virtual desktop FAILED" "X11 did not become ready within 10s"
  exit 1
fi

# Native fallback wallpaper at the configured capture resolution, 4K by default.
# The pinned Autonom artwork below replaces it only after successful validation.
# XFCE draws it behind actual application windows and the native launcher dock.
mkdir -p /usr/share/backgrounds
python3 - "$W" "$H" <<'PY'
import struct, zlib, sys
W, H = int(sys.argv[1]), int(sys.argv[2])
rows = []
for y in range(H):
    t = y / max(1, H - 1)
    r, g, b = int(250 - 16 * t), int(248 - 18 * t), int(243 - 18 * t)
    rows.append(b"\x00" + bytes([r, g, b]) * W)
raw = b"".join(rows)
def chunk(k, d): return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
open("/usr/share/backgrounds/gateway.png", "wb").write(png)
PY

# Fixed platform artwork; a failed optional download leaves the native fallback.
# Keep the existing XFCE path and install only verified bytes, never a partial PNG.
gateway_install_brand_wallpaper() {
  local expected='03aeb83c9e6f3da56afe994ee2a2e189ce2ef7c071b383b705ca3a4956c61686'
  local candidate
  candidate=$(mktemp /usr/share/backgrounds/.gateway-wallpaper.XXXXXX) || return 1
  if curl -fsS --proto '=https' --connect-timeout 4 --max-time 15 --max-filesize 8388608 \
      "$GATEWAY/brand/desktop-wallpaper.png" -o "$candidate" \
      && printf '%s  %s\n' "$expected" "$candidate" | sha256sum -c - >/dev/null 2>&1 \
      && chmod 644 "$candidate" \
      && mv -f "$candidate" /usr/share/backgrounds/gateway.png; then
    return 0
  fi
  rm -f "$candidate"
  return 1
}
gateway_install_brand_wallpaper || log "Autonom wallpaper unavailable; retaining native fallback"

# Configure actual XFCE panels, native .desktop launchers, fonts and theme.
# The desktop itself is NOT a browser page. Only Kurt uses its own normal window.
python3 - "$GATEWAY" "$TOKEN" "$W" "$H" <<'NATIVE_DESKTOP_PY'
__GATEWAY_NATIVE_DESKTOP__
NATIVE_DESKTOP_PY
if [ "$?" -ne 0 ]; then
  beacon "native desktop setup FAILED" "configuration was refused"
  exit 1
fi
chown -R agent:agent /home/agent/.config /home/agent/.local/share/applications
chown agent:agent /home/agent/.local /home/agent/.local/share

# No controller terminal is opened on the broadcast screen. State/replies remain
# available through the existing public API; process output is root-readable only.
touch /var/log/gateway/agent.log
chmod 600 /var/log/gateway/agent.log
# The fixed controller gets at most five crash restarts. Its saved pending
# requests, pauses and budget gates are never reset by process recovery.
nohup su agent -s /bin/bash -c 'cd /home/agent && exec env -i PATH=/usr/bin:/bin LANG=C.UTF-8 PYTHONIOENCODING=utf-8 python3 /opt/gateway-agent/supervisor.py' >>/var/log/gateway/agent.log 2>&1 &

# One user-owned local audio server with a FIXED module set: no hardware detection, no
# filters, no device switching, no restore modules. The null sink whose monitor enters RTMP is
# the only device, so nothing loadable can route that monitor back into the sink. It starts
# BEFORE the desktop session, and every client of this user (session, Chrome, the speech
# player) is pinned to it: autospawn off and the daemon binary pointed at /bin/true.
GATEWAY_AGENT_UID=$(id -u agent)
GATEWAY_AUDIO_RUNTIME="/run/user/$GATEWAY_AGENT_UID"
install -d -m 700 -o agent -g agent "$GATEWAY_AUDIO_RUNTIME"
GATEWAY_PULSE="unix:$GATEWAY_AUDIO_RUNTIME/pulse/native"
mkdir -p /home/agent/.config/pulse
printf 'default-server = %s\nautospawn = no\ndaemon-binary = /bin/true\n' "$GATEWAY_PULSE" > /home/agent/.config/pulse/client.conf
printf '%s\n' '.fail' 'load-module module-native-protocol-unix' \
  'load-module module-null-sink sink_name=gateway_audio rate=48000 channels=2 sink_properties=device.description=gateway_audio' \
  'set-default-sink gateway_audio' 'set-default-source gateway_audio.monitor' > /home/agent/.config/pulse/gateway.pa
chown -R agent:agent /home/agent/.config/pulse
rm -f /etc/gateway/audio-feedback
gateway_start_audio() {
  timeout 15 su agent -s /bin/bash -c "XDG_RUNTIME_DIR=$GATEWAY_AUDIO_RUNTIME pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr -n --file=/home/agent/.config/pulse/gateway.pa" || return 1
  gateway_wait_until 10 su agent -s /bin/bash -c "pactl --server=$GATEWAY_PULSE list short sinks 2>/dev/null | grep -q '^[0-9]*[[:space:]]gateway_audio[[:space:]]'"
}
if ! gateway_start_audio; then
  beacon "desktop audio FAILED" "local audio service or capture sink unavailable"; exit 1
fi
# Feedback self-test before anything is broadcast: a 0.3 s tone into the sink must be gone
# from its monitor two seconds later. Persisting energy means the monitor is being fed back
# into the sink (a loop that would turn one spoken reply into minutes of echo on the stream):
# the audio server is restarted clean and speech playback is disabled for this boot.
gateway_audio_selftest() {
  su agent -s /bin/bash -c "PULSE_SERVER=$GATEWAY_PULSE XDG_RUNTIME_DIR=$GATEWAY_AUDIO_RUNTIME python3 -" <<'AUDIO_SELFTEST_PY'
import json, math, os, struct, subprocess, time
env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PULSE_SERVER": os.environ["PULSE_SERVER"], "XDG_RUNTIME_DIR": os.environ["XDG_RUNTIME_DIR"]}
RATE, FRAME = 48000, 4
def db(pcm):
    n = len(pcm) // 2
    if n == 0: return -120.0
    total = 0
    for (v,) in struct.iter_unpack("<h", pcm): total += v * v
    r = math.sqrt(total / n) / 32768.0
    return round(20 * math.log10(r), 1) if r > 1e-6 else -120.0
def short(cmd):
    try: return subprocess.run(["/usr/bin/pactl", "list", "short", cmd], capture_output=True, text=True, timeout=5, env=env).stdout.replace("\t", " ").replace("\n", " | ").strip()[:400]
    except Exception: return "?"
out = {"feedback": None, "toneDb": None, "tailDb": None}
try:
    rec = subprocess.Popen(["/usr/bin/parec", "--raw", "--format=s16le", "--rate=48000", "--channels=2", "--device=gateway_audio.monitor"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    time.sleep(0.5)
    tone = b"".join(struct.pack("<hh", int(6000 * math.sin(2 * math.pi * 440 * i / RATE)), int(6000 * math.sin(2 * math.pi * 440 * i / RATE))) for i in range(RATE * 3 // 10))
    subprocess.run(["/usr/bin/paplay", "--raw", "--format=s16le", "--rate=48000", "--channels=2", "--device=gateway_audio"], input=tone, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, timeout=10)
    want, chunks, got, deadline = RATE * FRAME * 5, [], 0, time.monotonic() + 9
    while got < want and time.monotonic() < deadline:
        chunk = rec.stdout.read1(65536)
        if not chunk: break
        chunks.append(chunk); got += len(chunk)
    rec.kill()
    pcm = b"".join(chunks)[:want]
    sec = lambda a, b: pcm[int(a * RATE) * FRAME:int(b * RATE) * FRAME]
    out["toneDb"], out["tailDb"] = db(sec(0.0, 1.2)), db(sec(3.0, 5.0))
    out["feedback"] = len(pcm) >= RATE * FRAME * 4 and out["tailDb"] > -60.0 and out["tailDb"] > out["toneDb"] - 30.0
except Exception as e:
    out["error"] = type(e).__name__
out["modules"], out["clients"], out["sinkInputs"], out["sourceOutputs"] = short("modules"), short("clients"), short("sink-inputs"), short("source-outputs")
print(json.dumps(out))
AUDIO_SELFTEST_PY
}
GATEWAY_AUDIO_REPORT=$(gateway_audio_selftest 2>/dev/null | tail -n 1 | head -c 1400)
case "$GATEWAY_AUDIO_REPORT" in
  *'"feedback": true'*)
    touch /etc/gateway/audio-feedback; chmod 644 /etc/gateway/audio-feedback
    su agent -s /bin/bash -c "XDG_RUNTIME_DIR=$GATEWAY_AUDIO_RUNTIME pulseaudio -k" >/dev/null 2>&1 || true
    gateway_start_audio || { beacon "desktop audio FAILED" "audio service did not restart after the feedback test"; exit 1; }
    beacon "desktop audio FEEDBACK detected — speech playback disabled" "$GATEWAY_AUDIO_REPORT" ;;
  *) beacon "desktop audio ready" "local stereo capture; self-test $GATEWAY_AUDIO_REPORT" ;;
esac

if command -v startxfce4 >/dev/null 2>&1; then
  su agent -c "cd /home/agent && XDG_RUNTIME_DIR=$GATEWAY_AUDIO_RUNTIME DISPLAY=:99 TZ=UTC dbus-launch startxfce4 >/home/agent/xfce.log 2>&1 &"
  gateway_wait_until 15 su agent -c 'DISPLAY=:99 wmctrl -m >/dev/null 2>&1' || log "window manager is still starting"
else
  su agent -c "XDG_RUNTIME_DIR=$GATEWAY_AUDIO_RUNTIME DISPLAY=:99 fluxbox >/dev/null 2>&1 &"
  gateway_wait_until 10 su agent -c 'DISPLAY=:99 wmctrl -m >/dev/null 2>&1' || log "fallback window manager is still starting"
fi
# XFCE autostarts the native Kurt application from its .desktop entry.
# Chrome, Thunar and Mousepad are opened by real native panel launchers.
# No kiosk/fullscreen page, fake web dock, terminal window or remote-control port.
if ! gateway_wait_until 20 su agent -c 'DISPLAY=:99 wmctrl -lx | grep -q "kurt.GatewayKurt"'; then
  beacon "Kurt desktop FAILED" "native companion window did not become ready"
  exit 1
fi
beacon "desktop ready" "xfce=$(pgrep -x xfwm4 >/dev/null && echo yes || echo no) agent=$(pgrep -f agent.py >/dev/null && echo yes || echo no) kurt=native"

# Browser/tunnel installation no longer blocks launch. Optional setup cannot
# overwrite the public boot stage after the desktop is already ready.
( unset -f beacon; gateway_prepare_optional_runtime ) >/var/log/gateway/optional-runtime.log 2>&1 &

log "starting stream"
FFMPEG=$(/opt/ffmpeg/ffmpeg -version >/dev/null 2>&1 && echo /opt/ffmpeg/ffmpeg || echo ffmpeg)
beacon "starting stream" "${W}x${H}@${FPS} ${KBPS}k ffmpeg=$FFMPEG agent=$(pgrep -f agent.py >/dev/null && echo running || echo NOT running) chrome=$(pgrep -f google-chrome >/dev/null && echo running || echo no)"
STREAM_KEY=$(python3 -c 'import json;print(json.load(open("/etc/gateway/session.json"))["streamKey"])')
URL="rtmp://$INGEST:1935/live/$TOKEN?user=agent&pass=$STREAM_KEY"
GOP=$((FPS * 2))
NVENC_FAILED=0
NVENC_BINARY=$(gateway_select_nvenc "$FFMPEG" "$W" "$H" "$FPS") || NVENC_FAILED=1
while true; do
  ENC=x264
  if [ "$NVENC_FAILED" = 0 ]; then ENC=nvenc; fi
  ENCODER_STARTED=$SECONDS
  if [ "$ENC" = nvenc ]; then
    su agent -s /bin/bash -c "exec parec --server=$GATEWAY_PULSE --device=gateway_audio.monitor --raw --format=s16le --rate=48000 --channels=2" 2>/var/log/gateway/audio-capture.log | \
    "$NVENC_BINARY" -loglevel warning -thread_queue_size 512 -f x11grab -video_size ${W}x${H} -framerate $FPS -draw_mouse 0 -i :99 \
      -thread_queue_size 512 -f s16le -ar 48000 -ac 2 -i pipe:0 -map 0:v:0 -map 1:a:0 \
      -c:v h264_nvenc -profile:v main -preset p4 -tune ll -rc cbr -b:v ${KBPS}k -maxrate ${KBPS}k -bufsize $((KBPS * 2))k -g $GOP -bf 0 -pix_fmt yuv420p \
      -c:a aac -b:a 96k -af aresample=async=1:first_pts=0 -shortest \
      -f flv "$URL" >>/var/log/gateway/ffmpeg.log 2>&1 &
    FF=$!
  else
    beacon "nvenc unavailable, using software encoder" "${W}x${H}@12; reduced frame rate preserves desktop resolution"
    su agent -s /bin/bash -c "exec parec --server=$GATEWAY_PULSE --device=gateway_audio.monitor --raw --format=s16le --rate=48000 --channels=2" 2>/var/log/gateway/audio-capture.log | \
    ffmpeg -loglevel warning -thread_queue_size 512 -f x11grab -video_size ${W}x${H} -framerate 12 -draw_mouse 0 -i :99 \
      -thread_queue_size 512 -f s16le -ar 48000 -ac 2 -i pipe:0 -map 0:v:0 -map 1:a:0 \
      -c:v libx264 -profile:v main -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 24 -b:v 6000k -maxrate 6500k -bufsize 12000k \
      -c:a aac -b:a 96k -af aresample=async=1:first_pts=0 -shortest \
      -f flv "$URL" >>/var/log/gateway/ffmpeg.log 2>&1 &
    FF=$!
  fi
  # MediaMTX's authenticated ready callback, not a timer, marks the channel LIVE.
  beacon "encoder started ($ENC)" "boot elapsed=$((SECONDS - BOOT_STARTED))s; waiting for stream ingest"
  wait "$FF"
  # A local probe can succeed while the real capture/encode fails. Preserve the
  # software fallback for early failures, without sleeping 20s before detecting it.
  if [ "$ENC" = nvenc ] && [ $((SECONDS - ENCODER_STARTED)) -lt 20 ]; then
    NVENC_FAILED=1
    beacon "GPU stream exited early" "retrying with the software encoder"
    continue
  fi
  log "ffmpeg exited; restarting in 5s"; beacon "ffmpeg exited, restarting"; sleep 5
done
