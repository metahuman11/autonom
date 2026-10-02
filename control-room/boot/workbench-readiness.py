"""Root-broker readiness for bounded files and inert static previews only.

No credential/configuration file is opened, no public tunnel is created, and no
model command is run. This is deployment evidence, never vote or spend authority.
The broker must supply project/registration and overwrite controller heartbeat
capabilities with this result. Never accept a readiness report from a request.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time

TTL = 60
EXECUTION_REASON = "verified_aggregate_execution_containment_unavailable"
CAPABILITIES_OFF = {"version": 1, "files": False, "preview": False, "execution": False}
CODE_FILES = ("workbench.py", "publisher.py", "privacy.py", "relay.py", "agent.py", "workbench-readiness.py")


@dataclass(frozen=True)
class Layout:
    workspace: Path = Path("/home/agent/work")
    publication: Path = Path("/var/lib/gateway-sites")
    code: Path = Path("/opt/gateway-agent")
    broker: Path = Path("/run/gateway/controller.sock")
    python: Path = Path("/usr/bin/python3")
    tunnel: Path = Path("/usr/local/bin/cloudflared")


def protected_node(path, uid, kind, mode=None):
    """Inspect metadata only. Do not read protected application/config files."""
    info = Path(path).lstat()
    matches = {"directory": stat.S_ISDIR, "file": stat.S_ISREG, "socket": stat.S_ISSOCK}[kind]
    if (not matches(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022
            or (kind == "file" and (info.st_nlink != 1 or info.st_mode & 0o6000))
            or (mode is not None and stat.S_IMODE(info.st_mode) != mode)):
        raise RuntimeError("protected deployment path unavailable")
    identity = (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)
    return identity + ((info.st_size, info.st_mtime_ns) if kind == "file" else ())


def protected_parents(path, agent_home=None, agent_uid=None):
    evidence = []
    for parent in reversed(Path(path).parents):
        owner = agent_uid if agent_home is not None and parent == agent_home else 0
        evidence.append(protected_node(parent, owner, "directory"))
    return evidence


def broker_peer(path):
    """Authenticate the listening root broker using Linux kernel credentials."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(1)
        peer.connect(str(path))
        _, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != 0:
            raise RuntimeError("protected broker unavailable")


def file_probe(root):
    """Fixed disposable fixture; called as agent, never with an actual vote."""
    from workbench import Workbench
    from publisher import snapshot_site
    authority = {"proposalId": "readiness-fixture", "workspaceId": "task-" + "a" * 32,
                 "permissions": {"read": True, "write": True, "execute": False, "publish": False},
                 "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()}
    bench = Workbench(root, lambda _: (_ for _ in ()).throw(RuntimeError("probe cannot publish")))
    if bench.invoke("list_files", {"path": "."}, authority) != {"files": []}:
        raise RuntimeError("fixture was not empty")
    content = "<!doctype html><html><head><title>Readiness</title></head><body><h1>Ready</h1></body></html>"
    bench.invoke("write_file", {"path": "site/index.html", "content": content}, authority)
    if bench.invoke("read_file", {"path": "site/index.html"}, authority) != {"content": content}:
        raise RuntimeError("file round trip failed")
    for path in ("../outside.txt", "/outside.txt", "site/../index.html"):
        try:
            bench.invoke("read_file", {"path": path}, authority)
        except (ValueError, OSError):
            pass
        else:
            raise RuntimeError("path boundary failed")
    other = {**authority, "workspaceId": "task-" + "b" * 32}
    if bench.invoke("list_files", {"path": "."}, other) != {"files": []}:
        raise RuntimeError("task boundary failed")
    files, _, digest = snapshot_site(root, "tasks/" + authority["workspaceId"] + "/site")
    if set(files) != {"index.html"} or digest != hashlib.sha256(content.encode()).hexdigest():
        raise RuntimeError("static snapshot failed")
    try:
        bench.invoke("run_command", {"command": "exit 0", "cwd": "."},
                     {**authority, "permissions": {**authority["permissions"], "execute": True}})
    except RuntimeError:
        pass
    else:
        raise RuntimeError("execution boundary failed")
    return {"ok": True, "execution": False}


def workspace_probe(workspace):
    # Create and clean up fixtures ONLY after dropping to the agent UID. The
    # workspace has agent-owned ancestors: privileged pathname chown/removal here
    # would race an agent's rename/symlink and could affect a host-owned target.
    protected_node(workspace, os.getuid(), "directory", 0o700)
    with tempfile.TemporaryDirectory(prefix=".gateway-readiness-", dir=workspace) as directory:
        return file_probe(directory)


def origin_probe(root):
    """Run the real static HTTP handler as gateway-web, loopback only."""
    import http.client
    from publisher import BoundedHTTPServer, CSP, site_handler
    server = BoundedHTTPServer(("127.0.0.1", 0), site_handler(root))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for path, expected in (("/index.html", 200), ("/gateway-release.json", 200), ("/missing.txt", 404)):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            try:
                connection.request("GET", path)
                response = connection.getresponse()
                body = response.read(2049)
                if response.status != expected or len(body) > 2048:
                    raise RuntimeError("static origin response failed")
                if expected == 200 and response.getheader("Content-Security-Policy") != CSP:
                    raise RuntimeError("static origin policy failed")
                if path == "/index.html" and body != b"<h1>Readiness</h1>":
                    raise RuntimeError("static origin content failed")
            finally:
                connection.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return {"ok": True, "execution": False}


class Readiness:
    """Instantiate inside the trusted root Unix broker, not in model tools.

    Caller configuration is only an opt-in. Fresh OS checks plus successful fixed
    probes are mandatory. A valid report does not bypass /workbench/authorize or
    /website/authorize/register. Publication still verifies its public HTTPS URL.
    """
    def __init__(self, project, registration, layout=None):
        if (not isinstance(project, str) or not re.fullmatch(r"(?:0x[a-fA-F0-9]{40}|[A-Za-z0-9_-]{1,128})", project)
                or not isinstance(registration, str) or not 1 <= len(registration) <= 128
                or any(ord(c) < 33 or ord(c) > 126 for c in registration)):
            raise ValueError("trusted project registration required")
        self.project, self.registration = project, registration
        self.layout = layout or Layout()
        self.lock = threading.Lock()
        self.cached = None

    def _deployment(self):
        if sys.platform != "linux" or os.geteuid() != 0 or not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("protected Linux broker required")
        agent, web = pwd.getpwnam("agent"), pwd.getpwnam("gateway-web")
        if (agent.pw_uid <= 0 or web.pw_uid <= 0 or agent.pw_uid == web.pw_uid
                or agent.pw_gid <= 0 or web.pw_gid <= 0 or agent.pw_gid == web.pw_gid
                or set(os.getgrouplist(agent.pw_name, agent.pw_gid)) != {agent.pw_gid}
                or set(os.getgrouplist(web.pw_name, web.pw_gid)) != {web.pw_gid}):
            raise RuntimeError("separate restricted service accounts required")
        p = self.layout
        fingerprint = protected_parents(p.workspace, p.workspace.parent, agent.pw_uid)
        fingerprint.append(protected_node(p.workspace, agent.pw_uid, "directory", 0o700))
        for directory in (p.code, p.publication, p.broker.parent):
            fingerprint.extend(protected_parents(directory))
            fingerprint.append(protected_node(directory, 0, "directory", 0o755))
        for filename in CODE_FILES:
            fingerprint.append(protected_node(p.code / filename, 0, "file", 0o644))
        fingerprint.append(protected_node(p.broker, agent.pw_uid, "socket", 0o600))
        # Resolve only trusted interpreter symlinks; no user-supplied executable.
        python = p.python.resolve(strict=True)
        fingerprint.extend(protected_parents(python))
        fingerprint.append(protected_node(python, 0, "file"))
        if not os.access(python, os.X_OK):
            raise RuntimeError("protected interpreter unavailable")
        broker_peer(p.broker)
        preview = False
        try:
            fingerprint.extend(protected_parents(p.tunnel))
            fingerprint.append(protected_node(p.tunnel, 0, "file"))
            preview = os.access(p.tunnel, os.X_OK)
        except (OSError, RuntimeError):
            pass
        return tuple(fingerprint), agent, web, python, preview

    def _run_probe(self, mode, directory, account, python):
        completed = subprocess.run([str(python), "-I", "-B", str(self.layout.code / "workbench-readiness.py"),
                                    mode, str(directory)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                   close_fds=True, user=account.pw_uid, group=account.pw_gid, extra_groups=[], timeout=8)
        if completed.returncode != 0 or completed.stdout != b'{"ok":true,"execution":false}\n':
            raise RuntimeError("bounded workbench probe failed")

    def _probe_files(self, account, python):
        self._run_probe("workspace", self.layout.workspace, account, python)

    def _probe_tunnel(self, account):
        # A root os.access check does not establish gateway-web executability.
        # --version is fixed, offline, and does not start a tunnel or contact an API.
        completed = subprocess.run([str(self.layout.tunnel), "--version"], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, close_fds=True,
                                   user=account.pw_uid, group=account.pw_gid, extra_groups=[], timeout=3)
        if completed.returncode != 0 or not completed.stdout.startswith(b"cloudflared version "):
            raise RuntimeError("static preview executable unavailable to its service user")

    def _probe_preview(self, account, python):
        with tempfile.TemporaryDirectory(prefix="readiness-", dir=self.layout.publication) as directory:
            root = Path(directory)
            root.chmod(0o755)
            release = root / ("release-" + "a" * 64)
            release.mkdir(mode=0o755)
            for path, content in ((release / "index.html", "<h1>Readiness</h1>"),
                                  (release / "gateway-release.json", '{"release":"readiness"}'),
                                  (root / "current.json", json.dumps({"directory": release.name}))):
                path.write_text(content)
                path.chmod(0o644)
            self._run_probe("origin", directory, account, python)

    def inspect(self, enabled=False):
        now = datetime.now(timezone.utc)
        result = {"version": 1, "project": self.project, "registration": self.registration,
                  "checkedAt": now.isoformat(), "expiresAt": (now + timedelta(seconds=TTL)).isoformat(),
                  "capabilities": dict(CAPABILITIES_OFF), "status": "disabled",
                  "executionReason": EXECUTION_REASON, "publicPreviewVerified": False}
        if enabled is not True:
            self.cached = None
            return result
        if not self.lock.acquire(blocking=False):
            return {**result, "status": "probe_busy"}
        try:
            fingerprint, agent, web, python, preview = self._deployment()
            cached = self.cached
            if not cached or cached[0] != fingerprint or not 0 <= time.monotonic() - cached[1] < TTL:
                self._probe_files(agent, python)
                if preview:
                    try:
                        self._probe_preview(web, python)
                        self._probe_tunnel(web)
                    except (OSError, RuntimeError, subprocess.SubprocessError):
                        preview = False
                after = self._deployment()
                if after[0] != fingerprint:
                    raise RuntimeError("protected deployment changed during probe")
                self.cached = (fingerprint, time.monotonic(), preview)
            else:
                preview = cached[2]
            result["capabilities"] = {"version": 1, "files": True, "preview": preview, "execution": False}
            result["status"] = "static_publisher_ready" if preview else "files_ready_preview_unavailable"
            return result
        except (OSError, KeyError, RuntimeError, subprocess.SubprocessError):
            self.cached = None
            return {**result, "status": "protected_runtime_unavailable"}
        finally:
            self.lock.release()


if __name__ == "__main__":
    # -I omits the script directory; only this root-owned deployment path is added.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    if len(sys.argv) != 3 or sys.argv[1] not in ("files", "workspace", "origin"):
        raise SystemExit(2)
    try:
        output = {"files": file_probe, "workspace": workspace_probe, "origin": origin_probe}[sys.argv[1]](sys.argv[2])
        print(json.dumps(output, separators=(",", ":")))
    except Exception:
        raise SystemExit(1) from None
