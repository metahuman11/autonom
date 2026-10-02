"""Trusted static-site publisher on the agent VPS, not on the Gateway server.

Only the Unix-socket broker calls Publisher. Untrusted code cannot reach its API.
Quick Tunnels expose a fixed static origin, never the broker or a workspace server.
No Cloudflare account/token is needed; these links are temporary development previews.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
import json
import mimetypes
import os
from pathlib import Path
import pwd
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import threading
import tempfile
import time
import urllib.parse
import urllib.request

from privacy import require_public
from workbench import directory_at, parts_of, read_regular

SUFFIXES = {".html", ".css", ".json", ".txt"}
PREVIEW_URL = re.compile(r"https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b")
MAX_TOTAL = 8_000_000
CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"


def authority_of(body, publication=False):
    expected = {"orderId", "proposalId"} | ({"directory"} if publication else set())
    if not isinstance(body, dict) or set(body) - expected:
        raise ValueError("unexpected authority fields")
    authority = {k: body[k] for k in ("orderId", "proposalId") if k in body}
    if len(authority) != 1 or not all(isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", v) for v in authority.values()):
        raise ValueError("exactly one valid task authority is required")
    if publication and ("directory" not in body or not isinstance(body["directory"], str)):
        raise ValueError("relative site directory is required")
    return authority


def trusted_grant(value, authority):
    """Accept only fresh, explicitly typed capability metadata from Gateway."""
    if not isinstance(value, dict) or any(value.get(k) != v for k, v in authority.items()):
        raise ValueError("workbench authority mismatch")
    if set(k for k in ("orderId", "proposalId") if k in value) != set(authority):
        raise ValueError("workbench authority mismatch")
    workspace = value.get("workspaceId")
    if not isinstance(workspace, str) or not re.fullmatch(r"task-[a-f0-9]{32}", workspace):
        raise ValueError("invalid task workspace")
    permissions = value.get("permissions")
    if not isinstance(permissions, dict) or set(permissions) != {"read", "write", "execute", "publish"} or not all(type(v) is bool for v in permissions.values()) or permissions["read"] is not True:
        raise ValueError("invalid task capabilities")
    try:
        expires = datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00"))
        lifetime = (expires - datetime.now(timezone.utc)).total_seconds()
    except (KeyError, AttributeError, TypeError, ValueError):
        raise ValueError("invalid capability expiration") from None
    if not 0 < lifetime <= 120:
        raise ValueError("expired or excessive capability lifetime")
    return {**authority, "workspaceId": workspace, "permissions": permissions.copy(), "expiresAt": value["expiresAt"]}


def local_reference(value):
    # No remote links, script/data URLs, network paths, escaped protocols or backslashes.
    decoded = urllib.parse.unquote(value)
    parsed = urllib.parse.urlsplit(decoded)
    if parsed.scheme or parsed.netloc or decoded.startswith(("/", "\\")) or "\\" in decoded or any(ord(c) < 32 for c in decoded):
        raise ValueError("published links must stay inside the static site")
    if parsed.path:
        parts_of(parsed.path)


class StaticHTML(HTMLParser):
    TAGS = set("html head title body main header footer section article aside nav div span p a h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col strong em b i u s small sub sup blockquote pre code br hr figure figcaption details summary style link meta".split())
    ATTRS = set("id class title lang dir role style aria-label aria-hidden aria-labelledby aria-describedby colspan rowspan scope open".split())

    def handle_starttag(self, tag, attrs):
        if tag not in self.TAGS:
            raise ValueError("active or unsupported HTML element refused")
        names = [k for k, _ in attrs]
        if len(names) != len(set(names)):
            raise ValueError("duplicate HTML attributes refused")
        values = dict(attrs)
        extra = {"href"} if tag == "a" else {"href", "rel", "media"} if tag == "link" else {"charset", "name", "content"} if tag == "meta" else set()
        if set(values) - self.ATTRS - extra:
            raise ValueError("active or unsupported HTML attribute refused")
        if "href" in values:
            local_reference(values["href"] or "")
        if tag == "link" and values.get("rel") != "stylesheet":
            raise ValueError("only local stylesheets may be linked")
        if tag == "meta" and values.get("name") not in (None, "viewport", "description"):
            raise ValueError("unsupported page metadata")

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag):
        if tag not in self.TAGS:
            raise ValueError("active or unsupported HTML element refused")


def validate_static(name, text):
    if Path(name).suffix.lower() == ".html":
        parser = StaticHTML(convert_charrefs=True)
        parser.feed(text)
        parser.close()
    # CSP blocks all external CSS resources even when CSS uses escape sequences.
    # No JavaScript/SVG/HTML forms are published, and CSP sandbox blocks navigation
    # of parent windows/popups. This is not a semantic scanner for private prose.


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16
    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def snapshot_site(workspace, directory):
    files, total, entries = {}, 0, 0
    def walk(fd, prefix="", depth=0):
        nonlocal total, entries
        if depth > 8:
            raise ValueError("site nesting limit exceeded")
        names = []
        # Count directory entries too, before materializing/sorting a huge list.
        # Empty directories must not bypass the 100-file publication bound.
        with os.scandir(fd) as listing:
            for entry in listing:
                entries += 1
                if entries > 256:
                    raise ValueError("site directory entry limit exceeded")
                names.append(entry.name)
        for name in sorted(names):
            parts_of(name)
            if not prefix and name == "gateway-release.json":
                raise ValueError("publication manifest is reserved for the trusted publisher")
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            key = prefix + name
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    walk(child, key + "/", depth + 1)
                finally:
                    os.close(child)
            else:
                if not stat.S_ISREG(info.st_mode) or Path(name).suffix.lower() not in SUFFIXES:
                    raise ValueError("publish only static HTML/CSS/JSON/text, without scripts, SVG or executables")
                data = read_regular(fd, name)
                text = data.decode("utf-8")
                require_public(text)
                validate_static(name, text)
                total += len(data)
                if total > MAX_TOTAL or len(files) >= 100:
                    raise ValueError("site exceeds the publication size limit")
                files[key] = data
    with directory_at(workspace, parts_of(directory)) as fd:
        walk(fd)
    if "index.html" not in files:
        raise ValueError("site must contain index.html")
    digest = hashlib.sha256()
    for path, data in sorted(files.items()):
        digest.update(path.encode() + b"\0" + str(len(data)).encode() + b"\0" + data)
    return files, digest.hexdigest(), hashlib.sha256(files["index.html"]).hexdigest()


def clean_environment():
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/var/empty/gateway-web", "LANG": "C.UTF-8"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect refused")


def check_preview(url, digest, index_digest=None):
    if not PREVIEW_URL.fullmatch(url):
        raise ValueError("unexpected preview hostname")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url + "/gateway-release.json", timeout=10) as r:
        data = r.read(2049)
        if len(data) > 2048 or r.status != 200 or json.loads(data).get("release") != digest:
            return False
    if index_digest is not None:
        with opener.open(url + "/index.html", timeout=10) as r:
            data = r.read(520_001)
            return (r.status == 200 and len(data) <= 520_000
                    and r.headers.get("Content-Security-Policy") == CSP
                    and hashlib.sha256(data).hexdigest() == index_digest)
    return True


class Publisher:
    def __init__(self, workspace, root, token, upstream, port=8787):
        self.workspace, self.root = Path(workspace), Path(root)
        self.token, self.upstream, self.port = token, upstream, port
        self.lock = threading.Lock()
        self.server = self.tunnel = None
        self.url = None
        self.root.mkdir(parents=True, exist_ok=True, mode=0o755)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022 or (os.geteuid() == 0 and info.st_uid != 0):
            raise ValueError("publication storage must be a protected directory")
        self.receipt = self.root / "receipt.json"

    def process_options(self):
        if os.geteuid() != 0:
            raise RuntimeError("publisher broker must run under the protected service account")
        account = pwd.getpwnam("gateway-web")
        return {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": [],
                "env": clean_environment(), "stdin": subprocess.DEVNULL, "close_fds": True, "start_new_session": True}

    def ensure_origin(self):
        if self.server is None or self.server.poll() is not None:
            self.server = subprocess.Popen(["/usr/bin/python3", str(Path(__file__).resolve()), "serve",
                "--root", str(self.root), "--port", str(self.port)], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, **self.process_options())

    def ensure_tunnel(self):
        self.ensure_origin()
        if self.tunnel is not None and self.tunnel.poll() is None and self.url:
            return self.url
        self.url = None
        self.tunnel = subprocess.Popen(["/usr/local/bin/cloudflared", "--no-autoupdate", "tunnel",
            "--url", "http://127.0.0.1:%d" % self.port, "--protocol", "http2"], stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, **self.process_options())
        deadline, tail = time.monotonic() + 45, b""
        while time.monotonic() < deadline and self.tunnel.poll() is None:
            ready, _, _ = select.select([self.tunnel.stderr], [], [], 0.2)
            if not ready:
                continue
            chunk = os.read(self.tunnel.stderr.fileno(), 4096)
            if not chunk:
                break
            tail = (tail + chunk)[-8192:]
            match = PREVIEW_URL.search(tail.decode("utf-8", "replace"))
            if match:
                self.url = match.group()
                # Drain to prevent log backpressure, but never expose raw logs.
                threading.Thread(target=self._drain, args=(self.tunnel.stderr,), daemon=True).start()
                return self.url
        self._stop(self.tunnel)
        raise RuntimeError("free preview tunnel did not become available; no public URL claimed")

    @staticmethod
    def _drain(pipe):
        try:
            while pipe.read(4096):
                pass
        finally:
            pipe.close()

    @staticmethod
    def _stop(process):
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)

    def close(self):
        self._stop(self.tunnel)
        self._stop(self.server)

    def publish(self, body):
        authority = authority_of(body, publication=True)
        if not self.lock.acquire(blocking=False):
            raise ValueError("another publication is already in progress")
        try:
            code, raw_grant = self.upstream("POST", "/svc/workbench/authorize", authority)
            if code != 200:
                raise ValueError("workbench publication is not authorized by Gateway")
            capability = trusted_grant(raw_grant, authority)
            if capability["permissions"]["publish"] is not True:
                raise ValueError("publication permission is not granted")
            # directory_at refuses a substituted task-directory symlink. Only the
            # backend chooses workspaceId; it is never accepted from model input.
            files, digest, index_hash = snapshot_site(self.workspace, "tasks/" + capability["workspaceId"] + "/" + body["directory"])
            approval = {**authority, "releaseHash": digest, "indexHash": index_hash}
            code, grant = self.upstream("POST", "/svc/website/authorize", approval)
            if code != 200 or not grant.get("authorized"):
                raise ValueError("website publication is not authorized by Gateway")
            # Identical releases use the same directory and operation receipt.
            dest = self.root / ("release-" + digest)
            disclosure = ('<footer>Built by an AI agent · Token ' + html.escape(self.token) + '</footer>').encode()
            published_index_hash = hashlib.sha256(files["index.html"] + disclosure).hexdigest()
            if not dest.exists():
                if len(list(self.root.glob("release-*"))) >= 20:
                    raise ValueError("release retention limit reached; maintenance is required")
                stage = Path(tempfile.mkdtemp(prefix="staging-", dir=self.root))
                try:
                    for name, data in files.items():
                        target = stage / name
                        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                        target.write_bytes(data + disclosure if name == "index.html" else data)
                        target.chmod(0o644)
                    (stage / "gateway-release.json").write_text(json.dumps({"release": digest, "token": self.token}))
                    (stage / "gateway-release.json").chmod(0o644)
                    stage.chmod(0o755)
                    os.replace(stage, dest)
                finally:
                    # Only this operation's generated staging directory, never a
                    # user workspace or a previously published release.
                    if stage.exists(): shutil.rmtree(stage)
            current = self.root / "current.json"
            previous = current.read_bytes() if current.exists() else None
            self._atomic(current, json.dumps({"directory": dest.name}).encode(), 0o644)
            try:
                url = self.ensure_tunnel()
                verified = False
                for _ in range(4):
                    try:
                        verified = check_preview(url, digest, published_index_hash)
                    except Exception:
                        verified = False
                    if verified:
                        break
                    time.sleep(1)
                if not verified:
                    raise RuntimeError("HTTPS preview health check failed")
                # Send metadata only. Source files and site serving remain on this VPS.
                receipt = {**approval, "url": url, "verified": True, "temporary": True, "hosting": "agent-vps"}
                code, result = self.upstream("POST", "/svc/website/register", receipt)
                if code != 200 and code < 500:
                    # A definite rejection (revoked permission, mismatched hash,
                    # stale authority) is not a transient listing failure.
                    raise ValueError("Gateway refused the final publication receipt")
                self._atomic(self.receipt, json.dumps(receipt).encode(), 0o600)
                if code != 200:
                    # Publication happened; retain receipt for idempotent retry.
                    return {**receipt, "registered": False, "warning": "preview live; Gateway listing update pending"}
                return {**receipt, "registered": True, "version": result.get("version")}
            except Exception:
                if previous is not None:
                    self._atomic(current, previous, 0o644)
                else:
                    self._atomic(current, b"{}", 0o644)
                raise
        finally:
            self.lock.release()

    @staticmethod
    def _atomic(path, data, mode):
        tmp = path.with_name(path.name + ".new")
        with open(tmp, "wb") as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        tmp.chmod(mode)
        os.replace(tmp, path)


def site_handler(root):
    root = Path(root)
    class Site(BaseHTTPRequestHandler):
        timeout = 10
        def do_GET(self):
            try:
                path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lstrip("/") or "index.html"
                if path.endswith("/"):
                    path += "index.html"
                parts = parts_of(path)
                current = json.loads((root / "current.json").read_text()).get("directory", "")
                if not re.fullmatch(r"release-[a-f0-9]{64}", current):
                    raise ValueError("no published release")
                with directory_at(root, (current,) + parts[:-1]) as fd:
                    data = read_regular(fd, parts[-1], 520_000)
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "text/plain")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Security-Policy", CSP)
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.send_header("Cross-Origin-Opener-Policy", "same-origin")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except (OSError, ValueError):
                self.send_error(404, "not found")
        def log_message(self, *args):
            pass
    return Site


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["serve"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    BoundedHTTPServer(("127.0.0.1", args.port), site_handler(args.root)).serve_forever()
