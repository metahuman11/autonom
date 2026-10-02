#!/usr/bin/env python3
"""Bounded recovery for the fixed, unprivileged Gateway controller only.

This is not a task runner. It never accepts a model command, reads credentials,
clears state, rents a machine or retries a payment. The controller retains its
persisted reconciliation and budget checks on every restart.
"""
import os
import signal
import subprocess
import threading


AGENT_COMMAND = ("/usr/bin/python3", "/opt/gateway-agent/agent.py")
AGENT_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONIOENCODING": "utf-8"}
RESTART_DELAYS = (5, 10, 20, 40, 60)
INTENTIONAL_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT)
INTENTIONAL_EXITS = frozenset([0] + [-s for s in INTENTIONAL_SIGNALS]
                            + [128 + s for s in INTENTIONAL_SIGNALS])


class Shutdown:
    def __init__(self):
        self.event = threading.Event()
        self.signal = signal.SIGTERM

    def request(self, signum, _frame=None):
        self.signal = signum
        self.event.set()


def stop_child(child):
    """Reap only the process group created by this supervisor, with a deadline."""
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)


def supervise(shutdown, spawn=subprocess.Popen, log=print):
    restarts = 0
    while not shutdown.event.is_set():
        child = None
        try:
            child = spawn(AGENT_COMMAND, cwd="/home/agent", env=dict(AGENT_ENV),
                          stdin=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            # Do not expose raw operating-system errors, arguments or environment.
            result = 1
        else:
            try:
                while not shutdown.event.is_set():
                    try:
                        result = child.wait(timeout=1)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                else:
                    stop_child(child)
                    return 128 + shutdown.signal
            except Exception:
                # If child status itself is uncertain, never spawn a second one.
                stop_child(child)
                log("[controller] process status uncertain; recovery stopped", flush=True)
                return 1
        if shutdown.event.is_set():
            if child is not None:
                stop_child(child)
            return 128 + shutdown.signal
        if result in INTENTIONAL_EXITS:
            log("[controller] stopped intentionally; no restart", flush=True)
            return result if result >= 0 else 128 - result
        if restarts >= len(RESTART_DELAYS):
            log("[controller] recovery limit reached; operator review required", flush=True)
            return 1
        delay = RESTART_DELAYS[restarts]
        restarts += 1
        log("[controller] unexpected exit; bounded restart %d/%d in %ds"
            % (restarts, len(RESTART_DELAYS), delay), flush=True)
        # An operator/container shutdown interrupts backoff without spawning again.
        if shutdown.event.wait(delay):
            return 128 + shutdown.signal
    return 128 + shutdown.signal


def main():
    # Bootstrap already drops privileges. Refuse a miswired root launch instead
    # of accidentally turning controller work into root-owned execution.
    if os.geteuid() == 0:
        print("[controller] refusing privileged supervisor", flush=True)
        return 1
    shutdown = Shutdown()
    for sig in INTENTIONAL_SIGNALS:
        signal.signal(sig, shutdown.request)
    return supervise(shutdown)


if __name__ == "__main__":
    raise SystemExit(main())
