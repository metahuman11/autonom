"""Kurt on the rented XFCE desktop, not in a browser or a website.

Cairo plays frames of the existing wolf rig without OpenGL/WebGL. This is a
read-only presentation process: no AI loop, shell tools, credentials or payment.
Only the fixed public token feed is read. Model/user text is never interpreted.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
import unicodedata
import urllib.request


TOKEN_RE = r"0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}"   # an EVM address or a base58 Solana mint


def canonical_token(token):
    """An EVM address is case-insensitive and stored lowercase; a Solana mint keeps its case."""
    t = str(token)
    return t.lower() if t.lower().startswith("0x") else t

ATLAS_SHA256 = "4fc470e9e9284ee12bdbd51d9012235d1f86249c7bf7412b78d062c7e11e0ff1"
ATLAS_PATH = Path("/opt/gateway-agent/desktop-atlas.png")
CLIPS = {"idle": (0, 48), "thinking": (48, 32), "happy": (80, 32)}
TTL = 20
MAX_BODY = 1_000_000


def feed_url(gateway, token):
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?", gateway):
        raise ValueError("expected public HTTPS gateway")
    if not re.fullmatch(TOKEN_RE, token):
        raise ValueError("invalid project address")
    return gateway.rstrip("/") + "/api/site/token/" + canonical_token(token)


def plain_text(value, limit=420):
    # No markup, bidi/control characters or unbounded text in a broadcast window.
    if not isinstance(value, str):
        return ""
    return " ".join("".join(c for c in value[:4000]
                            if not unicodedata.category(c).startswith("C") or c in "\n\t").split())[:limit]


def obj(value):
    return value if isinstance(value, dict) else {}


def conversation(messages):
    rows = []
    for item in messages[-40:]:
        m = obj(item)
        if m.get("cancelledAt") or m.get("revokedAt"):
            continue
        if plain_text(m.get("text")):
            rows.append({"who": plain_text(m.get("username"), 28) or "Community member",
                         "text": plain_text(m["text"], 700), "kind": "holder"})
        reply = obj(m.get("reply"))
        if plain_text(reply.get("text")):
            rows.append({"who": "Kurt", "text": plain_text(reply["text"], 900), "kind": "kurt"})
        elif m.get("chatState") in ("working", "queued", "failed"):
            label = {"working": "Preparing a reply…", "queued": "Message received · waiting for a turn",
                     "failed": "No answer received · check the community page"}[m["chatState"]]
            rows.append({"who": "Status", "text": label, "kind": "status"})
    return rows[-60:]


def current_work(data, messages, online, label):
    if not online:
        return label, "Work resumes only when the agent is available"
    for item in messages:
        m = obj(item)
        if m.get("chatState") == "working" and not m.get("reply") and not (m.get("cancelledAt") or m.get("revokedAt")):
            return "Replying to your community", plain_text(m.get("text"), 180) or "Preparing a reply"
    proposals = data.get("proposals") if isinstance(data.get("proposals"), list) else []
    for item in proposals:
        p = obj(item)
        if (p.get("status") == "approved" and p.get("agentStatus") == "in_progress"
                and obj(data.get("agent")).get("state") == "working"
                and not (p.get("cancelledAt") or p.get("revokedAt"))):
            return "Working on an approved task", plain_text(p.get("title"), 180) or "Community-approved work"
    if obj(data.get("agent")).get("state") == "working":
        return "Agent is busy", "Waiting for a specific task update"
    return "Ready for your next idea", "Ask Kurt a question on your community page"


STAGE_URL_RE = r"https://[A-Za-z0-9.\-]+(?::[0-9]{1,5})?(?:/[^\s\"'<>]*)?"


def stage_of(data):
    """A page or video an order-role holder asked Kurt to show (gateway-validated public https URL)."""
    d = obj(data.get("desktop"))
    url = d.get("url")
    if not isinstance(url, str) or len(url) > 500 or not re.fullmatch(STAGE_URL_RE, url):
        return None
    return {"url": url, "key": url + "|" + str(d.get("at") or "")}


class Stage:
    """Shows the staged page in Chrome on this desktop and closes it when the stage clears."""
    PROFILE = "/home/agent/.config/gateway-browser"

    def __init__(self, runner=subprocess.Popen, which=shutil.which, now=time.monotonic):
        self.key, self.retry_at, self.runner, self.which, self.now = None, 0, runner, which, now

    def sync(self, stage):
        key = stage["key"] if stage else None
        if key == self.key:
            return None
        if stage is None:
            self.key = None
            self.close()
            return "closed"
        if self.now() < self.retry_at:
            return None
        chrome = self.which("google-chrome")
        if not chrome:
            self.retry_at = self.now() + 15   # the optional runtime may still be installing the browser
            return None
        self.close()
        try:
            self.runner([chrome, "--no-sandbox", "--no-first-run", "--disable-dev-shm-usage", "--disable-session-crashed-bubble",
                         "--user-data-dir=" + self.PROFILE, "--autoplay-policy=no-user-gesture-required",
                         "--new-window", "--start-maximized", stage["url"]],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            self.retry_at = self.now() + 15
            return None
        self.key = key
        return "opened"

    def close(self):
        try:
            subprocess.run(["pkill", "-f", "user-data-dir=" + self.PROFILE], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except Exception:
            pass


def presentation(data, token, now_ms):
    data = obj(data)
    if str(data.get("address", "")).lower() != token.lower():
        raise ValueError("wrong project")
    stamp = data.get("snapshotAtMs")
    if (isinstance(stamp, bool) or not isinstance(stamp, (int, float))
            or not math.isfinite(stamp) or not -5000 <= now_ms - stamp <= TTL * 1000):
        raise ValueError("stale or missing evidence")
    vps, runtime = obj(data.get("vps")), obj(data.get("runtime"))
    health = obj(vps.get("health"))
    paused = (obj(data.get("funding")).get("state") == "paused"
              or obj(data.get("lock")).get("state") == "paused"
              or obj(data.get("agent")).get("state") == "paused"
              or health.get("status") == "paused")
    locked = obj(data.get("lock")).get("state") == "locked"
    attention = (vps.get("reconciliationRequired") is True or health.get("status") == "attention_required"
                 or vps.get("phase") in ("stopping", "reconciliation_required"))
    acknowledged = health.get("agentOnline") if isinstance(health.get("agentOnline"), bool) else runtime.get("online")
    online = (not paused and not locked and not attention and vps.get("mode") == "real"
              and vps.get("state") == "running" and acknowledged is True)
    messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    working = online and (obj(data.get("agent")).get("state") == "working"
                          or any(obj(m).get("chatState") == "working" and not obj(m).get("reply")
                                 and not (obj(m).get("cancelledAt") or obj(m).get("revokedAt")) for m in messages))
    label = ("Paused" if paused else "Waiting for funding" if locked else "Needs an operator check" if attention
             else "Thinking with your community" if working else "Ready for your community" if online
             else "Connecting to the AI")
    reply, reply_id = "", ""
    for message in reversed(messages):
        r = obj(obj(message).get("reply"))
        if plain_text(r.get("text")):
            reply, reply_id = plain_text(r["text"]), plain_text(r.get("id") or obj(message).get("id"), 128)
            break
    work, detail = current_work(data, messages, online, label)
    return {"stamp": stamp, "online": online, "mode": "thinking" if working else "idle",
            "label": label, "reply": reply, "reply_id": reply_id,
            "work": work, "detail": detail, "stage": stage_of(data), "chat": conversation(messages)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("feed redirect refused")


def fetch_snapshot(url):
    # No inherited proxies/cookies/credentials and no redirects to other hosts.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "Gateway-Kurt-Desktop/1"})
    with opener.open(request, timeout=6) as response:
        if response.headers.get_content_type() != "application/json":
            raise ValueError("unexpected feed content")
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ValueError("feed too large")
        return json.loads(body)


def stream_snapshots(url, stop, opener=None):
    """Bounded SSE; one shared public connection for both native windows."""
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url + "/events", headers={"Accept": "text/event-stream", "User-Agent": "Gateway-Kurt-Desktop/1"})
    with opener.open(request, timeout=10) as response:
        if response.headers.get_content_type() != "text/event-stream":
            raise ValueError("unexpected live feed content")
        event, parts, size = "", [], 0
        # Reconnect periodically even if a peer sends comments but no evidence.
        deadline = time.monotonic() + 120
        while not stop.is_set() and time.monotonic() < deadline:
            line = response.readline(MAX_BODY + 1)
            if not line:
                return
            size += len(line)
            if size > MAX_BODY:
                raise ValueError("live frame too large")
            line = line.decode("utf-8").rstrip("\r\n")
            if not line:
                if event == "token" and parts:
                    yield json.loads("\n".join(parts))
                event, parts, size = "", [], 0
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                parts.append(line[5:].lstrip(" "))


def latest_only(inbox, result):
    # Drop the old pending frame, never the newest one, if the UI is busy.
    try:
        inbox.get_nowait()
    except queue.Empty:
        pass
    inbox.put_nowait(result)


class Feed:
    def __init__(self, token):
        self.token, self.last_good, self.stamp = token, None, -1
        self.state = {"online": False, "mode": "idle", "label": "Connecting to the AI", "reply": "", "reply_id": "",
                      "work": "Connecting to your community", "detail": "Waiting for a fresh update", "chat": [], "stage": None}

    def accept(self, data, now=None, now_ms=None):
        state = presentation(data, self.token, time.time() * 1000 if now_ms is None else now_ms)
        # Replaying one valid frame must not keep an old "online" badge alive.
        if state["stamp"] <= self.stamp:
            return False
        self.state, self.stamp = state, state["stamp"]
        self.last_good = time.monotonic() if now is None else now
        return True

    def current(self, now=None):
        now = time.monotonic() if now is None else now
        if self.last_good is None or now - self.last_good >= TTL:
            return {**self.state, "online": False, "mode": "idle", "label": "Reconnecting · waiting for an update",
                    "work": "Connection interrupted", "detail": "Showing saved messages · current work is unknown"}
        return self.state


def verify_atlas(path):
    if path.stat().st_size > 8_388_608:
        raise ValueError("oversized wolf atlas")
    if hashlib.sha256(path.read_bytes()).hexdigest() != ATLAS_SHA256:
        raise ValueError("wolf atlas checksum mismatch")


def run_gui(gateway, token, atlas_path=ATLAS_PATH, fetcher=fetch_snapshot):
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("PangoCairo", "1.0")
    from gi.repository import Gtk, Gdk, Gio, GLib, Pango, PangoCairo
    import cairo

    url = feed_url(gateway, token)
    verify_atlas(atlas_path)
    atlas = cairo.ImageSurface.create_from_png(str(atlas_path))
    if (atlas.get_width(), atlas.get_height()) != (4096, 7168):
        raise ValueError("wrong atlas geometry")
    feed, inbox, stop = Feed(token), queue.Queue(maxsize=1), threading.Event()
    stage = Stage()

    def poll():
        while not stop.is_set():
            try:
                latest_only(inbox, fetcher(url))
                if fetcher is fetch_snapshot:
                    for result in stream_snapshots(url, stop):
                        if stop.is_set():
                            break
                        latest_only(inbox, result)
            except Exception:
                # Never echo network errors, URLs or response bodies on the stream.
                pass
            stop.wait(2)

    app = Gtk.Application(application_id="app.gateway.Kurt.t" + token[2:].lower(), flags=Gio.ApplicationFlags.FLAGS_NONE)
    window = chat_window = None

    def activate(application):
        nonlocal window, chat_window
        if window is not None:
            window.present()
            chat_window.show_all()
            chat_window.present()
            return
        window = Gtk.ApplicationWindow(application=application, title="Kurt · Autonom")
        window.set_wmclass("kurt", "GatewayKurt")
        window.set_resizable(False)
        screen = window.get_screen()
        scale = 2 if screen.get_width() >= 3000 else 1
        window.set_default_size(440 * scale, 610 * scale)
        window.move(max(0, screen.get_width() - 480 * scale), 70 * scale)
        area = Gtk.DrawingArea()
        area.set_can_focus(True)
        area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.KEY_PRESS_MASK)
        area.set_tooltip_text("Click Kurt to cheer him up. Space pauses animation.")
        window.add(area)
        chat_window = Gtk.ApplicationWindow(application=application, title="Community · Autonom")
        chat_window.set_wmclass("kurt-chat", "GatewayKurtChat")
        chat_window.set_resizable(False)
        chat_window.set_default_size(660 * scale, 500 * scale)
        chat_window.move(35 * scale, max(40 * scale, screen.get_height() - 590 * scale))
        chat_area = Gtk.DrawingArea()
        chat_area.add_events(Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)
        chat_area.set_tooltip_text("Live public chat · Scroll for earlier messages · Send messages from the community page")
        chat_window.add(chat_area)
        scroll_back, last_chat = 0, None
        origin, happy_until, last_reply, motion = time.monotonic(), 0, None, True

        def text(cr, value, x, y, width, size, color=(.20, .30, .36), bold=False, lines=1):
            layout = PangoCairo.create_layout(cr)
            font = Pango.FontDescription("DejaVu Sans" + (" Bold" if bold else ""))
            font.set_absolute_size(size * Pango.SCALE)
            layout.set_font_description(font)
            layout.set_width(int(width * Pango.SCALE))
            layout.set_height(-lines)
            layout.set_wrap(Pango.WrapMode.WORD_CHAR)
            layout.set_ellipsize(Pango.EllipsizeMode.END)
            layout.set_text(value, -1)  # Never Pango markup from model/user content.
            cr.move_to(x, y); cr.set_source_rgb(*color); PangoCairo.show_layout(cr, layout)

        def draw_chat(widget, cr):
            cr.scale(scale, scale)
            cr.set_source_rgb(.985, .993, 1); cr.paint()
            state = feed.current()
            text(cr, "NOW WORKING ON", 26, 20, 480, 10, (.42, .52, .59), bold=True)
            text(cr, state["work"], 26, 42, 610, 22, bold=True)
            text(cr, state["detail"], 26, 76, 600, 12, lines=2)
            cr.set_source_rgb(.88, .92, .94); cr.rectangle(26, 121, 608, 1); cr.fill()
            text(cr, "Community chat", 26, 139, 440, 18, bold=True)
            text(cr, "LIVE" if state["online"] else "SAVED", 563, 143, 70, 10,
                 (.20, .55, .39) if state["online"] else (.53, .59, .63), bold=True)
            rows = state["chat"]
            end = max(0, len(rows) - scroll_back)
            visible = rows[max(0, end - 4):end]
            if not visible:
                text(cr, "Your conversation starts here", 26, 209, 600, 18, bold=True)
                text(cr, "Messages and Kurt’s answers will appear automatically", 26, 242, 600, 12)
            for index, row in enumerate(visible):
                y = 179 + index * 70
                cr.set_source_rgb(*((.93, .96, .98) if row["kind"] == "kurt" else (1, 1, 1)))
                cr.rectangle(18, y, 624, 64); cr.fill()
                text(cr, row["who"], 30, y + 7, 590, 11, (.24, .42, .48), bold=True)
                content = ("Last status · " if row["kind"] == "status" and not state["online"] else "") + row["text"]
                text(cr, content, 30, y + 24, 590, 12, lines=2)
            text(cr, "Earlier messages · Scroll down for latest" if scroll_back else "Send a message on your community page · Scroll for history",
                 26, 476, 610, 10, (.42, .52, .59))
            return False

        def scroll_chat(widget, event):
            nonlocal scroll_back
            direction = -1 if event.direction == Gdk.ScrollDirection.DOWN else 1
            if event.direction == Gdk.ScrollDirection.SMOOTH:
                valid, dx, dy = event.get_scroll_deltas()
                if not valid or not dy:
                    return False
                direction = -1 if dy > 0 else 1
            scroll_back = max(0, min(max(0, len(feed.current()["chat"]) - 4), scroll_back + direction))
            chat_area.queue_draw()
            return True

        def draw(widget, cr):
            cr.scale(scale, scale)
            bg = cairo.LinearGradient(0, 0, 440, 610)
            bg.add_color_stop_rgb(0, .985, .993, 1)
            bg.add_color_stop_rgb(1, .90, .94, .96)
            cr.set_source(bg); cr.paint()
            state = feed.current()
            text(cr, "Kurt", 28, 24, 300, 27, bold=True)
            text(cr, "META HUMAN · YOUR COMMUNITY COMPANION", 29, 64, 380, 10, (.42, .52, .59))
            cr.set_source_rgb(*((.20, .55, .39) if state["online"] else (.53, .59, .63)))
            cr.arc(34, 105, 4, 0, math.tau); cr.fill()
            text(cr, state["label"], 46, 96, 365, 12)
            now = time.monotonic()
            clip = "happy" if motion and now < happy_until else state["mode"]
            start, count = CLIPS[clip]
            elapsed = now - (happy_until - 3.2 if clip == "happy" else origin)
            frame = start + (int(max(0, elapsed) * 10) % count if motion else 0)
            # Software-only CPU compositing, no WebKit/Chrome or OpenGL context.
            cr.save(); cr.translate(-14, 60); cr.scale(468 / 512, 468 / 512)
            cr.rectangle(0, 0, 512, 512); cr.clip()
            cr.set_source_surface(atlas, -(frame % 8) * 512, -(frame // 8) * 512); cr.paint(); cr.restore()
            cr.set_source_rgba(1, 1, 1, .90); cr.rectangle(20, 466, 400, 118); cr.fill()
            text(cr, "LATEST REPLY" if state["reply"] else "A LITTLE WOLF · A SHARED FUTURE", 34, 479, 372, 10, (.42, .52, .59))
            text(cr, state["reply"] or "I live on this desktop. Join the conversation in your community chat.",
                 34, 500, 372, 12, lines=4)
            text(cr, "Animation paused" if not motion else "Click to cheer up · Space to pause", 30, 592, 380, 10, (.42, .52, .59))
            return False

        def tick():
            nonlocal happy_until, last_reply, last_chat, scroll_back
            if stop.is_set():
                return False
            try:
                feed.accept(inbox.get_nowait())
                current = feed.current()
                if last_reply is not None and current["reply_id"] and current["reply_id"] != last_reply and current["online"]:
                    happy_until = time.monotonic() + 3.2
                last_reply = current["reply_id"]
            except (queue.Empty, ValueError, TypeError):
                pass
            current = feed.current()
            try:
                stage.sync(current.get("stage"))
            except Exception:
                pass
            chat_key = (current["work"], current["detail"], current["online"], current["chat"])
            if chat_key != last_chat:
                scroll_back = min(scroll_back, max(0, len(current["chat"]) - 4))
                last_chat = chat_key
                chat_area.queue_draw()
            if window.get_visible() and not window.get_window().get_state() & Gdk.WindowState.ICONIFIED:
                area.queue_draw()
            return True

        def cheer(widget, event):
            nonlocal happy_until
            if event.button == 1 and motion:
                happy_until = time.monotonic() + 3.2
            widget.grab_focus()
            return True

        def key(widget, event):
            nonlocal motion
            if event.keyval == Gdk.KEY_space:
                motion = not motion
                return True
            return False

        area.connect("draw", draw); area.connect("button-press-event", cheer); area.connect("key-press-event", key)
        chat_area.connect("draw", draw_chat); chat_area.connect("scroll-event", scroll_chat)
        # Closing the companion closes its presentation only, never the AI.
        window.connect("destroy", lambda *_: (stop.set(), application.quit()))
        chat_window.connect("delete-event", lambda *_: (chat_window.hide(), True)[1])
        window.show_all()
        chat_window.show_all()
        GLib.timeout_add(100, tick)
        threading.Thread(target=poll, daemon=True, name="public-feed").start()

    app.connect("activate", activate)
    try:
        return app.run([])
    finally:
        stop.set()
        atlas.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Kurt native desktop companion")
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    feed_url(args.gateway, args.token)
    raise SystemExit(run_gui(args.gateway, canonical_token(args.token)))
