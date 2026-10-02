"""VPS-local tools. No credentials, host shell fallback, host network or host /proc.

The controller is trusted/read-only. Model-generated commands are disabled until
aggregate resource containment is provisioned and tested. Bubblewrap construction
below is an inactive future backend building block, not permission to run code.
Publication uses a different trusted service and never exposes this tool server.
"""
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time

from privacy import redact, require_public

MAX_FILE = 512_000
MAX_OUTPUT = 32_000
MAX_TASK_BYTES = 8_000_000
MAX_TASK_FILES = 200
MAX_TASKS = 32
MAX_TOTAL_BYTES = 64_000_000
MAX_TOTAL_FILES = 4_000
MAX_DEPTH = 8
PERMISSION = {"list_files": "read", "read_file": "read", "write_file": "write", "run_command": "execute", "publish_site": "publish"}
WORKSPACE_ID = re.compile(r"task-[a-f0-9]{32}\Z")
# prlimit only limits each process/file, not a hostile job's aggregate RAM/disk.
# Until a tested cgroup + hard filesystem quota backend exists, executing ANY
# model-provided shell code is forbidden. Never replace this with an env toggle.
EXECUTION_UNAVAILABLE = "command execution disabled: verified aggregate memory, process and disk containment is not provisioned"
BLOCKED = {"secrets", "node_modules", ".git", ".ssh", ".aws", ".config", ".cloudflared"}


def parts_of(value, allow_root=False):
    if not isinstance(value, str) or len(value) > 240 or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("use a short relative workspace path")
    if allow_root and value in ("", "."):
        return ()
    raw_parts = value.split("/")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or len(raw_parts) > MAX_DEPTH or any(p in ("", ".", "..") or p.startswith(".") or p.lower() in BLOCKED or p.lower().endswith((".key", ".pem", ".env")) for p in raw_parts):
        raise ValueError("protected path or path outside the workspace")
    return path.parts


@contextlib.contextmanager
def directory_at(root, parts=(), create=False):
    # Directory descriptors + O_NOFOLLOW also protect the publisher from rename /
    # symlink races. Never resolve an untrusted path and reopen it as root.
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def directory_at_fd(parentfd, parts=(), create=False):
    fd = os.dup(parentfd)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        yield fd
    finally:
        os.close(fd)


def bounded_names(fd, limit):
    names = []
    with os.scandir(fd) as entries:
        for entry in entries:
            names.append(entry.name)
            if len(names) > limit:
                raise ValueError("workspace directory entry limit exceeded")
    return sorted(names)


def read_regular(fd, name, limit=MAX_FILE):
    f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(f)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError("only bounded regular files without hard links are allowed")
        chunks, size = [], 0
        while True:
            chunk = os.read(f, min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise ValueError("file exceeds the size limit")
        return b"".join(chunks)
    finally:
        os.close(f)


def sandbox_command(root, command, cwd="."):
    # Low-level construction helper ONLY: Workbench never invokes it until a
    # separate aggregate-resource backend is implemented and tested on Linux.
    if sys.platform != "linux" or not shutil.which("bwrap"):
        raise RuntimeError("isolated command execution unavailable; Linux bubblewrap is required")
    if os.geteuid() == 0:
        raise RuntimeError("the workbench must not run as root")
    parts = parts_of(cwd, allow_root=True)
    with directory_at(root, parts):
        pass
    args = [shutil.which("bwrap"), "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"]
    # Do not mount /etc, /home, /run, /var, /opt, X11 sockets, or any host procfs.
    for path in ("/usr", "/bin", "/lib", "/lib64"):
        if Path(path).exists():
            args += ["--ro-bind", path, path]
    args += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/work",
             "--bind", str(root), "/work", "--chdir", "/work" + ("/" + "/".join(parts) if parts else ""),
             "--setenv", "HOME", "/work", "--setenv", "PATH", "/usr/bin:/bin",
             "--setenv", "LANG", "C.UTF-8", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
             "--", "/usr/bin/prlimit", "--as=2147483648", "--cpu=30", "--nproc=64", "--nofile=128",
             "--fsize=16777216", "--core=0", "--", "/bin/bash", "--noprofile", "--norc", "-c", command]
    return args


def run_bounded(args, timeout=30):
    # The process sees an allowlist, never the controller's environment. stdin and
    # inherited descriptors are closed; output is bounded and not streamed raw.
    p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, close_fds=True, start_new_session=True)
    output = bytearray()
    timed_out = truncated = False
    deadline = time.monotonic() + timeout
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ)
    try:
        while sel.get_map():
            if time.monotonic() >= deadline:
                timed_out = True
                break
            for key, _ in sel.select(min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    sel.unregister(key.fileobj)
                    continue
                output.extend(chunk[:MAX_OUTPUT + 1 - len(output)])
                if len(output) > MAX_OUTPUT:
                    truncated = True
                    break
            if truncated:
                break
        if not timed_out and not truncated:
            try:
                p.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
    finally:
        # Kill the entire isolated job, including background children. A command
        # is not a public server; the publisher owns the persistent web server.
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait(timeout=5)
        sel.close()
        p.stdout.close()
    return {"exitCode": p.returncode, "output": redact(output[:MAX_OUTPUT].decode("utf-8", "replace")),
            "timedOut": timed_out, "truncated": truncated}


def function(name, description, properties, required):
    return {"type": "function", "function": {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}}


TOOLS = [
    function("list_files", "List files in your VPS workspace; paths are relative.", {"path": {"type": "string"}}, ["path"]),
    function("read_file", "Read a UTF-8 workspace file; never secrets.", {"path": {"type": "string"}}, ["path"]),
    function("write_file", "Create or replace a UTF-8 workspace file. Put a static site's files under site/ with index.html.", {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
    function("run_command", "Unavailable: shell execution is disabled until verified aggregate memory, process and disk containment exists. Do not request this tool or claim builds/tests ran.", {"command": {"type": "string"}, "cwd": {"type": "string"}}, ["command", "cwd"]),
    function("publish_site", "Publish a safe static HTML/CSS/JSON/text site from this task's workspace through the trusted publisher. No scripts, SVG, forms, external links or remote assets. A temporary HTTPS preview, not a permanent domain. Requires explicit publication authority. Never say live until verified=true.", {"directory": {"type": "string"}}, ["directory"]),
]


def validate_authority(authority, permission=None):
    """Validate a fresh trusted broker grant, never model-provided arguments.

    This validates shape/expiry, not a signature. Only the trusted controller may
    supply this object after a fresh /workbench/authorize request.
    """
    if not isinstance(authority, dict):
        raise PermissionError("a fresh server-authorized task grant is required")
    ids = [key for key in ("orderId", "proposalId") if authority.get(key)]
    if len(ids) != 1 or any(key in authority and key not in ids for key in ("orderId", "proposalId")):
        raise PermissionError("exactly one verified order or proposal is required")
    identity = authority[ids[0]]
    if not isinstance(identity, str) or not 1 <= len(identity) <= 160 or any(ord(c) < 33 or ord(c) > 126 for c in identity):
        raise PermissionError("invalid task identity")
    if not isinstance(authority.get("workspaceId"), str) or not WORKSPACE_ID.fullmatch(authority["workspaceId"]):
        raise PermissionError("invalid task workspace")
    permissions = authority.get("permissions")
    if not isinstance(permissions, dict) or set(permissions) != {"read", "write", "execute", "publish"} or any(type(v) is not bool for v in permissions.values()):
        raise PermissionError("explicit task capabilities are required")
    try:
        expires = datetime.datetime.fromisoformat(authority["expiresAt"].replace("Z", "+00:00"))
        now = datetime.datetime.now(datetime.timezone.utc)
        if expires.tzinfo is None or not 0 < (expires - now).total_seconds() <= 120:
            raise ValueError("stale or excessive grant lifetime")
    except (ValueError, TypeError, KeyError, AttributeError):
        raise PermissionError("a fresh short-lived task grant is required") from None
    if permission is not None and permissions.get(permission) is not True:
        raise PermissionError("this task does not authorize " + permission)
    return {ids[0]: identity, "workspaceId": authority["workspaceId"],
            "permissions": dict(permissions), "expiresAt": authority["expiresAt"]}


def tools_for_authority(authority):
    grant = validate_authority(authority)
    return [tool for tool in TOOLS if tool["function"]["name"] != "run_command" and
            grant["permissions"][PERMISSION[tool["function"]["name"]]]]


def usage_at(fd, depth=0, counters=None, entry_limit=MAX_TOTAL_FILES * 2):
    """Bounded no-follow inventory; forbidden types stop writes rather than skip.

    This protects trusted file-tool writes, NOT arbitrary concurrent shell jobs.
    Execution remains disabled until hard OS quotas are available.
    """
    counters = counters if counters is not None else [0, 0, 0]
    with os.scandir(fd) as entries:
        for entry in entries:
            counters[2] += 1
            if counters[2] > entry_limit or depth > MAX_DEPTH + 2:
                raise ValueError("workspace inventory limit exceeded")
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                counters[0] += 1
                counters[1] += info.st_size
            elif stat.S_ISDIR(info.st_mode):
                child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    usage_at(child, depth + 1, counters, entry_limit=entry_limit)
                finally:
                    os.close(child)
            else:
                raise ValueError("unsafe link or special file in task workspace")
            if counters[0] > MAX_TOTAL_FILES or counters[1] > MAX_TOTAL_BYTES:
                raise ValueError("workspace storage limit exceeded")
    return counters[0], counters[1]


class Workbench:
    def __init__(self, root, publish):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.root.is_symlink():
            raise ValueError("workspace cannot be a symlink")
        self.publish = publish

    @contextlib.contextmanager
    def task_workspace(self, grant, writing=False):
        # Serialize ALL file mutations under a no-follow lock. Unlike checking
        # size before an unrestricted shell, this bounds every supported writer.
        with directory_at(self.root) as rootfd:
            lockfd = os.open(".gateway-file-lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=rootfd)
            try:
                lockinfo = os.fstat(lockfd)
                if not stat.S_ISREG(lockinfo.st_mode) or lockinfo.st_nlink != 1:
                    raise ValueError("unsafe workspace lock")
                fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    os.mkdir("tasks", 0o700, dir_fd=rootfd)
                except FileExistsError:
                    pass
                tasksfd = os.open("tasks", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
                try:
                    names = bounded_names(tasksfd, MAX_TASKS)
                    if any(not WORKSPACE_ID.fullmatch(name) for name in names):
                        raise ValueError("invalid workspace storage layout")
                    if grant["workspaceId"] not in names:
                        if not writing:
                            raise FileNotFoundError("task workspace has no files yet")
                        if len(names) >= MAX_TASKS:
                            raise ValueError("task workspace count limit reached")
                        os.mkdir(grant["workspaceId"], 0o700, dir_fd=tasksfd)
                    taskfd = os.open(grant["workspaceId"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=tasksfd)
                    try:
                        yield taskfd, tasksfd
                    finally:
                        os.close(taskfd)
                finally:
                    os.close(tasksfd)
            finally:
                os.close(lockfd)

    def invoke(self, name, arguments, authority):
        if not isinstance(arguments, dict):
            raise ValueError("tool arguments must be an object")
        spec = next((t["function"] for t in TOOLS if t["function"]["name"] == name), None)
        if not spec or set(arguments) - set(spec["parameters"]["properties"]) or any(k not in arguments for k in spec["parameters"]["required"]):
            raise ValueError("unknown tool or invalid arguments")
        if any(not isinstance(value, str) for value in arguments.values()):
            raise ValueError("tool arguments must be strings")
        if any(len(value) > MAX_FILE for value in arguments.values()):
            raise ValueError("tool arguments exceed size limit")
        grant = validate_authority(authority, PERMISSION[name])
        require_public(json.dumps(arguments, ensure_ascii=False))
        if name == "publish_site":
            parts_of(arguments["directory"])
            # Never forward model-supplied permissions/workspace paths or even
            # stale trusted grants. The publisher independently obtains a grant.
            identity = {k: grant[k] for k in ("orderId", "proposalId") if k in grant}
            return self.publish({"directory": arguments["directory"], **identity})
        if name == "run_command":
            raise RuntimeError(EXECUTION_UNAVAILABLE)
        parts = parts_of(arguments["path"], allow_root=name == "list_files")
        if name == "list_files" and not parts:
            # A read-only capability must be useful before the first write, and
            # must not allocate a task directory/lock just to show an empty list.
            # Missing paths are empty; symlinks/permission errors still fail.
            try:
                with directory_at(self.root, ("tasks", grant["workspaceId"])):
                    pass
            except FileNotFoundError:
                return {"files": []}
        with self.task_workspace(grant, writing=name == "write_file") as (taskfd, tasksfd):
            if name == "list_files":
                with directory_at_fd(taskfd, parts) as fd:
                    entries = bounded_names(fd, MAX_TASK_FILES)
                    public = []
                    for n in entries:
                        try:
                            parts_of(n); require_public(n)
                            info = os.stat(n, dir_fd=fd, follow_symlinks=False)
                            if stat.S_ISDIR(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1):
                                public.append(n)
                        except ValueError:
                            continue
                    return {"files": public}
            if name == "write_file":
                # Reserve room for at most MAX_DEPTH new directories before any
                # mkdir. This also prevents failed-write directory exhaustion.
                taskfiles, taskbytes = usage_at(taskfd, entry_limit=MAX_TASK_FILES * 2 - MAX_DEPTH)
                totalfiles, totalbytes = usage_at(tasksfd, entry_limit=MAX_TOTAL_FILES * 2 - MAX_DEPTH)
            with directory_at_fd(taskfd, parts[:-1], create=name == "write_file") as fd:
                if name == "read_file":
                    text = read_regular(fd, parts[-1]).decode("utf-8")
                    require_public(text)
                    return {"content": redact(text)}
                text = arguments["content"]
                require_public(text)
                size = len(text.encode())
                if size > MAX_FILE:
                    raise ValueError("content exceeds the UTF-8 file size limit")
                oldsize = 0
                exists = False
                try:
                    info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise ValueError("refusing to replace a link or special file")
                    exists, oldsize = True, info.st_size
                except FileNotFoundError:
                    pass
                if (taskfiles + (not exists) > MAX_TASK_FILES or taskbytes - oldsize + size > MAX_TASK_BYTES or
                        totalfiles + (not exists) > MAX_TOTAL_FILES or totalbytes - oldsize + size > MAX_TOTAL_BYTES):
                    raise ValueError("task or aggregate workspace storage limit exceeded")
                # Atomic replacement never follows a final-component link.
                tmp = "gateway-write-" + os.urandom(12).hex()
                f = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                try:
                    with os.fdopen(f, "wb") as out:
                        out.write(text.encode()); out.flush(); os.fsync(out.fileno())
                    os.replace(tmp, parts[-1], src_dir_fd=fd, dst_dir_fd=fd)
                finally:
                    try:
                        os.unlink(tmp, dir_fd=fd)
                    except FileNotFoundError:
                        pass
                return {"written": arguments["path"], "bytes": size}
