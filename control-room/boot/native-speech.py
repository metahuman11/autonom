"""Play only an already-paid, cached reply on the rented desktop's audio sink.

No model/provider request, wallet, credentials, shell, URL from chat, or paid retry.
The root-owned bootstrap configuration is the sole source of gateway and token.
"""
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request


TOKEN_RE = r"0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}"   # an EVM address or a base58 Solana mint


def canonical_token(token):
    """An EVM address is case-insensitive and stored lowercase; a Solana mint keeps its case."""
    t = str(token)
    return t.lower() if t.lower().startswith("0x") else t

MAX_AUDIO = 6_000_000
MAX_SECONDS = 60
PCM_BYTES = MAX_SECONDS * 48_000 * 2 * 2
# Written by the boot self-test (root) or by this player (agent) when the capture sink's monitor
# is being fed back into the sink: one spoken reply would echo on the stream for minutes.
FEEDBACK_MARKERS = ("/etc/gateway/audio-feedback", "/home/agent/.audio-feedback")
TAIL_SECONDS = 2.5
TAIL_LIMIT_DB = -55.0


def feedback_marked():
    return any(os.path.exists(path) for path in FEEDBACK_MARKERS)


def tail_energy_db(env):
    """RMS level (dBFS) of the capture sink's monitor during the last second of a short
    recording taken right after playback. None when it cannot be measured."""
    try:
        rec = subprocess.run(["/usr/bin/timeout", str(TAIL_SECONDS + 3), "/usr/bin/parec", "--raw", "--format=s16le",
                              "--rate=48000", "--channels=2", "--device=gateway_audio.monitor"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=TAIL_SECONDS + 6, check=False)
    except Exception:
        return None
    pcm = rec.stdout[:int(TAIL_SECONDS * 48_000) * 4]
    if len(pcm) < 48_000 * 4 * 2:
        return None
    last = pcm[-48_000 * 4:]
    total, n = 0, len(last) // 2
    for i in range(0, len(last), 2):
        v = int.from_bytes(last[i:i + 2], "little", signed=True); total += v * v
    r = (total / n) ** 0.5 / 32768.0
    return 20 * __import__("math").log10(r) if r > 1e-6 else -120.0


def mark_feedback():
    try:
        with open(FEEDBACK_MARKERS[1], "w") as f:
            f.write("audio feedback detected after playback\n")
    except OSError:
        pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def clip_url(config, reply_id):
    origin = config.get("gateway", "")
    url = urllib.parse.urlsplit(origin)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.port not in (None, 443) or url.query or url.fragment
            or url.path not in ("", "/") or not re.fullmatch(r"[a-zA-Z0-9.-]+", url.hostname)):
        raise ValueError("Invalid trusted gateway origin")
    token = config.get("token", "")
    if not isinstance(token, str) or not re.fullmatch(TOKEN_RE, token):
        raise ValueError("Invalid project identity")
    if not isinstance(reply_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", reply_id):
        raise ValueError("Invalid saved reply")
    return origin.rstrip("/") + "/api/site/token/" + canonical_token(token) + "/voice/" + reply_id


def fetch_clip(config, reply_id):
    target = clip_url(config, reply_id)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(target, headers={"Accept": "audio/mpeg,audio/wav,audio/ogg"})
    started = time.monotonic()
    with opener.open(request, timeout=5) as response:
        if response.status != 200 or response.geturl() != target:
            raise ValueError("Cached speech unavailable")
        kind = response.headers.get_content_type()
        formats = {"audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg"}
        if kind not in formats or response.headers.get("Content-Encoding", "identity") != "identity":
            raise ValueError("Unsupported cached audio")
        length = response.headers.get("Content-Length")
        if length is not None and (not length.isdigit() or int(length) > MAX_AUDIO):
            raise ValueError("Invalid audio size")
        chunks, size = [], 0
        while True:
            if time.monotonic() - started > 15:
                raise TimeoutError("Cached audio deadline")
            chunk = response.read1(min(65536, MAX_AUDIO + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_AUDIO:
                raise ValueError("Audio too large")
            chunks.append(chunk)
        data = b"".join(chunks)
        if not data or (length is not None and len(data) != int(length)):
            raise ValueError("Incomplete cached audio")
        return data, formats[kind]


def play_cached_reply(config, reply_id, still_allowed):
    """Once-only best effort. Failure must NEVER regenerate a paid clip."""
    child = None
    try:
        if feedback_marked() or still_allowed() is not True:
            return False
        data, audio_format = fetch_clip(config, reply_id)
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
               "PULSE_SERVER": "unix:/run/user/%d/pulse/native" % os.getuid()}
        # Force a demuxer and pipe-only input: no playlists, network or local-file
        # references from media bytes. Decode has bounded duration and deadline.
        decoded = subprocess.run(["/usr/bin/ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-protocol_whitelist", "pipe", "-f", audio_format, "-i", "pipe:0",
            "-t", str(MAX_SECONDS), "-vn", "-ac", "2", "-ar", "48000",
            "-f", "s16le", "pipe:1"], input=data, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=15, env=env, check=False)
        pcm = decoded.stdout
        if decoded.returncode or not pcm or len(pcm) > PCM_BYTES or len(pcm) % 4 or still_allowed() is not True:
            return False
        # Anonymous temporary file, no predictable path or symlink, no persistent
        # audio history. This is the very sink captured into the RTMP audio track.
        with tempfile.TemporaryFile() as clip:
            clip.write(pcm); clip.seek(0)
            child = subprocess.Popen(["/usr/bin/paplay", "--raw", "--format=s16le",
                "--rate=48000", "--channels=2", "--device=gateway_audio"],
                stdin=clip, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
            deadline = time.monotonic() + MAX_SECONDS + 5
            while child.poll() is None:
                if time.monotonic() >= deadline or still_allowed() is not True:
                    return False
                time.sleep(0.5)
            if child.returncode != 0:
                return False
            # The sink must fall silent once the clip ends. If it does not, the monitor is being
            # fed back into the sink: no further reply is played on this machine.
            tail = tail_energy_db(env)
            if tail is not None and tail > TAIL_LIMIT_DB:
                mark_feedback()
                return False
            return True
    except Exception:
        # Nothing from an HTTP body, process stderr, path or config enters chat.
        return False
    finally:
        if child is not None and child.poll() is None:
            try:
                child.kill()
                child.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
