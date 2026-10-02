"""Credential-bearing broker. Never runs model code or exposes arbitrary URLs.

Generated commands cannot mount its protected Unix socket; peer credentials also
restrict this service to the controller uid. No TCP listener exists.
The controller uses a bounded allowlist, and website publication has an independent
server-side governance/budget check. Secrets never appear in replies/errors/logs.
"""
import http.server
import json
import os
import pwd
import re
import socket
import socketserver
import stat
import struct
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from privacy import redact, require_public
from publisher import Publisher, NoRedirect, authority_of, trusted_grant

MAX_BODY = 1_000_000
ROUTES = {
    "GET": [r"/budget", r"/capabilities", r"/inbox(?:\?cursor=[A-Za-z0-9_%:.-]+)?", r"/inbox\?cursor=[0-9]{1,12}&wait=(?:[1-9]|1[0-9]|2[0-5])", r"/proposals\?status=approved"],
    "POST": [r"/heartbeat", r"/status-log", r"/replies", r"/proposals/[A-Za-z0-9_-]+/status",
             r"/proposals/suggest", r"/context", r"/message-status", r"/svc/research", r"/svc/deliveries", r"/svc/voice", r"/svc/treasury/(?:execute|check)", r"/svc/dex/(?:pay|check|prepare|handoff)", r"/svc/ai/v1/chat/completions", r"/svc/farcaster/(?:cast|profile|reply)"],
}


def route_allowed(method, path, workbench_enabled=True):
    if not workbench_enabled and method in ("GET", "POST") and path == "/svc/website":
        return True  # Preserve the existing agent when the new feature is disabled.
    return any(re.fullmatch(p, path) for p in ROUTES.get(method, []))


def controller_request(headers, method):
    # The desktop also runs a browser. Reject browser-originated requests, including
    # simple cross-origin POSTs, so a visited page cannot spend through the broker.
    unique = all(len(headers.get_all(name, [])) <= 1 for name in ("Host", "Content-Length", "Content-Type", "Idempotency-Key")) if hasattr(headers, "get_all") else True
    return (unique and headers.get("Host") == "gateway-controller"
            and not headers.get("Origin") and not any(k.lower().startswith("sec-fetch-") for k in headers)
            and (method == "GET" or headers.get("Content-Type", "").split(";")[0] == "application/json"))


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON fields refused")
            result[key] = value
        return result
    def invalid(value):
        raise ValueError("non-finite JSON values refused")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


class UnixBrokerServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """No TCP listener. Only the trusted controller uid can open this socket."""
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, path, handler, uid, gid):
        if not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("Linux peer credential authentication is required")
        self.controller_uid = uid
        self.slots = threading.BoundedSemaphore(8)
        # No unlink/rebind fallback: replacing an active broker would confuse
        # authority, and stale sockets require deliberate service cleanup.
        super().__init__(str(path), handler)
        os.chown(path, uid, gid)
        os.chmod(path, 0o600)

    def verify_request(self, request, address):
        try:
            _, uid, _ = struct.unpack("3i", request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            return uid == self.controller_uid
        except (OSError, struct.error):
            return False

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


def safe_response(value, preserve_proposal_hash=False, depth=0, path=(), trusted_hashes=None):
    if depth > 32:
        raise ValueError("response nesting limit exceeded")
    if isinstance(value, str):
        if trusted_hashes and trusted_hashes.get(path) == value:
            return value
        return redact(value)
    if isinstance(value, list):
        return [safe_response(v, preserve_proposal_hash, depth + 1, path + (index,), trusted_hashes) for index, v in enumerate(value)]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if preserve_proposal_hash and len(path) == 2 and path[0] == "proposals" and isinstance(path[1], int) and key == "payloadHash" and isinstance(item, str) and re.fullmatch(r"(?:0x)?[a-f0-9]{64}", item):
                result[key] = item
            else:
                result[redact(key)] = safe_response(item, preserve_proposal_hash, depth + 1, path + (key,), trusted_hashes)
        return result
    return value


def dex_approval_request(method, path, body):
    if method != "POST" or path not in ("/svc/dex/prepare", "/svc/dex/handoff", "/svc/dex/pay", "/svc/treasury/execute", "/svc/treasury/check"):
        return None
    if (not isinstance(body, dict) or set(body) != {"proposalId", "approvedPayloadHash"}
            or not isinstance(body["proposalId"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", body["proposalId"])
            or not isinstance(body["approvedPayloadHash"], str)
            or not re.fullmatch(r"(?:0x)?[a-f0-9]{64}", body["approvedPayloadHash"])):
        raise ValueError("exact approved proposal reference required")
    return body


def dex_response_hashes(path, code, out, approval):
    # Only a successful, inert response bound to this exact request gets typed
    # digest preservation. A hash-shaped string in content remains private data.
    if code != 200 or not approval or not isinstance(out, dict):
        return {}
    item = out.get("preparation") if path == "/svc/dex/prepare" else out if path == "/svc/dex/handoff" else None
    field = "payloadHash" if path == "/svc/dex/prepare" else "approvedPayloadHash"
    if (not isinstance(item, dict) or item.get("provider") != "padre"
            or item.get("automaticPayment") is not False or item.get("actionable") is not False
            or item.get("proposalId") != approval["proposalId"]
            or item.get(field) != approval["approvedPayloadHash"]):
        return {}
    if path == "/svc/dex/handoff" and item.get("schemaVersion") != 1:
        return {}
    key = ("preparation", field) if path == "/svc/dex/prepare" else (field,)
    return {key: approval["approvedPayloadHash"]}


def handler_for(upstream, publisher, enabled):
    """Importable isolated handler factory; does not load runtime credentials."""
    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 10
        def dispatch(self):
            try:
                if len(self.path) > 2048 or not controller_request(self.headers, self.command):
                    raise ValueError("browser or non-controller request refused")
                length = self.headers.get("Content-Length") or "0"
                if not re.fullmatch(r"[0-9]{1,7}", length):
                    raise ValueError("invalid request size")
                n = int(length)
                if n > MAX_BODY or self.headers.get("Transfer-Encoding") or self.headers.get("Expect") or (self.command == "GET" and n):
                    raise ValueError("invalid request size")
                raw_body = self.rfile.read(n)
                if len(raw_body) != n:
                    raise ValueError("incomplete request")
                body = strict_json(raw_body) if n else None
                if n and not isinstance(body, dict):
                    raise ValueError("JSON object required")
                idem = self.headers.get("Idempotency-Key")
                if idem is not None and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", idem):
                    raise ValueError("invalid operation identifier")
                approval = dex_approval_request(self.command, self.path, body)
                if body is not None:
                    checked = dict(body)
                    if approval or (re.fullmatch(r"/proposals/[A-Za-z0-9_-]+/status", self.path) and "approvedPayloadHash" in checked):
                        digest = checked.pop("approvedPayloadHash")
                        if not isinstance(digest, str) or not re.fullmatch(r"(?:0x)?[a-f0-9]{64}", digest):
                            raise ValueError("invalid approval digest")
                    require_public(json.dumps(checked, ensure_ascii=False))
                if enabled and self.command == "POST" and self.path == "/workbench/authorize":
                    authority = authority_of(body)
                    code, out = upstream("POST", "/svc/workbench/authorize", authority)
                    if code == 200:
                        out = trusted_grant(out, authority)
                elif enabled and self.command == "POST" and self.path == "/workbench/publish":
                    out, code = publisher.publish(body or {}), 200
                elif route_allowed(self.command, self.path, enabled):
                    code, out = upstream(self.command, self.path, body, idem)
                else:
                    code, out = 403, {"error": "route not available to the agent"}
                out = safe_response(out, self.command == "GET" and self.path == "/proposals?status=approved",
                                    trusted_hashes=dex_response_hashes(self.path, code, out, approval))
                raw = json.dumps(out, allow_nan=False).encode()
                if len(raw) > MAX_BODY:
                    raise ValueError("response size limit exceeded")
            except (ValueError, RecursionError):
                code, raw = 400, b'{"error":"invalid or unauthorized local request"}'
            except Exception:
                code, raw = 503, b'{"error":"local service unavailable; no publication claimed"}'
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(raw)
        do_GET = do_POST = dispatch
        def log_message(self, *args):
            pass
    return Handler


def main():
    cfg = json.loads(Path("/etc/gateway/config.json").read_text())
    session = json.loads(Path("/etc/gateway/session.json").read_text())["session"]
    gateway = cfg["gateway"].rstrip("/")
    parsed = urllib.parse.urlsplit(gateway)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Gateway must use HTTPS")
    if not re.fullmatch(r"(?:0x[a-fA-F0-9]{40}|[A-Za-z0-9_-]{1,128})", cfg["token"]):
        raise ValueError("invalid token path")
    base = gateway + "/api/site/agent/" + cfg["token"]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def upstream(method, path, body=None, idem=None):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
            method=method, headers={"Authorization": "Bearer " + session, "Content-Type": "application/json",
            "Accept": "application/json", "User-Agent": "GatewayAgent/1.0 (+" + gateway + ")", "Idempotency-Key": idem or ""})
        try:
            with opener.open(req, timeout=8 if path == "/heartbeat" else 180) as r:
                raw = r.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    return 502, {"error": "upstream response too large"}
                return r.status, strict_json(raw)
        except urllib.error.HTTPError as e:
            # Do not relay provider error dumps, URLs, headers or credentials.
            code = e.code
            e.close()
            return code, {"error": "Gateway rejected the request (%d)" % code}
        except Exception:
            return 502, {"error": "Gateway temporarily unavailable"}

    publisher = Publisher("/home/agent/work", "/var/lib/gateway-sites", cfg["token"], upstream)
    enabled = cfg.get("workbench", {}).get("enabled") is True
    socket_dir = Path("/run/gateway")
    socket_dir.mkdir(mode=0o755, exist_ok=True)
    info = socket_dir.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
        raise RuntimeError("controller socket directory is not protected")
    account = pwd.getpwnam("agent")
    socket_path = socket_dir / "controller.sock"
    server = UnixBrokerServer(socket_path, handler_for(upstream, publisher, enabled), account.pw_uid, account.pw_gid)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        socket_path.unlink(missing_ok=True)
        publisher.close()


if __name__ == "__main__":
    main()
