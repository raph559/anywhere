#!/usr/bin/env python3
"""Outbound-only Claude project launcher. Python 3.10+, pywinpty on Windows.

This process exposes no listener. It lists directories and starts the official
Claude CLI; it never handles Claude credentials or reads project file contents.
"""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = 6
CAPABILITIES = ["browse", "launch", "confirm", "stop", "self-update", "permission-mode"]
PERMISSION_MODES = ("default", "acceptEdits", "bypassPermissions")
# Only code signed with the matching private key (kept root-only on the hub server,
# never readable by the web service) is installed by the self-updater. Each install
# sets its own key with "updatePublicKey" in the agent configuration; without one,
# self-update is off. Generate it with: python3 deploy/publish-agent.py --init-key
UPDATE_PUBLIC_KEY = ""
UPDATE_RETRY_SECONDS = 3600
MAX_BODY = 2 * 1024 * 1024
ANSI = re.compile(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])")
OFFICIAL_URL = re.compile(r"https://claude\.ai/code(?:\?environment=env_[A-Za-z0-9]+|/session_[A-Za-z0-9]+)(?![A-Za-z0-9_])")
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")


# Ed25519 verification (RFC 8032, section 6), standard library only.
_EP = 2 ** 255 - 19
_EQ = 2 ** 252 + 27742317777372353535851937790883648493
_ED = -121665 * pow(121666, _EP - 2, _EP) % _EP
_ESQRT = pow(2, (_EP - 1) // 4, _EP)


def _ed_add(P, Q):
    A, B = (P[1] - P[0]) * (Q[1] - Q[0]) % _EP, (P[1] + P[0]) * (Q[1] + Q[0]) % _EP
    C, D = 2 * P[3] * Q[3] * _ED % _EP, 2 * P[2] * Q[2] % _EP
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _EP, G * H % _EP, F * G % _EP, E * H % _EP)


def _ed_mul(s, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            Q = _ed_add(Q, P)
        P = _ed_add(P, P)
        s >>= 1
    return Q


def _ed_x(y, sign):
    if y >= _EP:
        return None
    x2 = (y * y - 1) * pow(_ED * y * y + 1, _EP - 2, _EP) % _EP
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_EP + 3) // 8, _EP)
    if (x * x - x2) % _EP:
        x = x * _ESQRT % _EP
    if (x * x - x2) % _EP:
        return None
    return _EP - x if (x & 1) != sign else x


def _ed_point(data):
    y = int.from_bytes(data, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    x = _ed_x(y, sign)
    return None if x is None else (x, y, 1, x * y % _EP)


def ed25519_verify(public, message, signature):
    if len(public) != 32 or len(signature) != 64:
        return False
    A, R = _ed_point(public), _ed_point(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if A is None or R is None or s >= _EQ:
        return False
    gy = 4 * pow(5, _EP - 2, _EP) % _EP
    gx = _ed_x(gy, 0)
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % _EQ
    left, right = _ed_mul(s, (gx, gy, 1, gx * gy % _EP)), _ed_add(R, _ed_mul(h, A))
    return (left[0] * right[2] - right[0] * left[2]) % _EP == 0 and (left[1] * right[2] - right[1] * left[2]) % _EP == 0


class RestartForUpdate(Exception):
    pass


class AgentError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

    def public(self):
        return {"code": self.code, "message": str(self)}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def atomic_json(path: Path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default


class FileLock:
    """OS-released lock, including if an agent/broker is killed."""
    def __init__(self, path, wait=0):
        self.path = Path(path)
        self.file = None
        self.wait = wait

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.file = self.path.open("a+b")
        self.file.seek(0)
        self.file.write(b"\0")
        self.file.flush()
        self.file.seek(0)
        deadline = time.monotonic() + self.wait
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() < deadline:
                    time.sleep(0.5)
                    continue
                self.file.close()
                self.file = None
                raise AgentError("already_running", "A launcher for this configuration is already running.")

    def __exit__(self, *_):
        if self.file is not None:
            if os.name == "nt":
                import msvcrt
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            self.file.close()


def process_identity(pid):
    """Return an OS creation identity and executable; never trust PID alone."""
    try:
        pid = int(pid)
        if pid <= 0:
            return None
        if os.name != "nt":
            stat = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()
            if stat[0] == "Z":
                return None
            return {"pid": pid, "created": stat[19], "exe": os.readlink(f"/proc/{pid}/exe")}
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:
                return None
            created, exited, kern, user = [wintypes.FILETIME() for _ in range(4)]
            if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kern), ctypes.byref(user)):
                return None
            name, size = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
            if not kernel.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
                return None
            return {"pid": pid, "created": str((created.dwHighDateTime << 32) | created.dwLowDateTime), "exe": os.path.normcase(name.value)}
        finally:
            kernel.CloseHandle(handle)
    except (OSError, ValueError, IndexError):
        return None


def owned(identity):
    return bool(identity and process_identity(identity.get("pid")) == identity)


def process_workspace(pid):
    """Inspect an existing process without changing it or claiming ownership."""
    try:
        if os.name != "nt":
            cwd = os.readlink(f"/proc/{int(pid)}/cwd")
            argv = Path(f"/proc/{int(pid)}/cmdline").read_bytes().split(b"\0")
            return cwd, [arg.decode("utf-8", errors="replace") for arg in argv if arg]
        import psutil
        process = psutil.Process(int(pid))
        return process.cwd(), process.cmdline()
    except (ImportError, OSError, ValueError):
        return None
    except Exception:
        # psutil's access/process-disappeared exceptions also fail closed.
        return None


def verified_external_process(identity, path):
    if not owned(identity):
        return False
    workspace = process_workspace(identity["pid"])
    if not workspace:
        return False
    cwd, argv = workspace
    try:
        matches = os.path.normcase(str(Path(cwd).resolve(strict=True))) == os.path.normcase(str(path))
    except (OSError, RuntimeError, ValueError):
        return False
    return bool(matches and "remote-control" in argv[1:] and owned(identity))


class PathPolicy:
    def __init__(self, roots):
        if not isinstance(roots, list) or not roots:
            raise AgentError("configuration", "At least one allowed folder root is required.")
        self.roots = []
        for item in roots:
            value = item["path"] if isinstance(item, dict) else item
            candidate = Path(os.path.expanduser(value))
            if not candidate.is_absolute():
                raise AgentError("configuration", "Allowed roots must be absolute folders.")
            root = candidate.resolve(strict=True)
            if not root.is_dir():
                raise AgentError("configuration", "An allowed root is not a folder.")
            self.roots.append({"name": item.get("name", root.name or str(root)) if isinstance(item, dict) else root.name or str(root), "path": str(root)})

    def resolve(self, value):
        if not isinstance(value, str) or not value or len(value) > 32768 or "\0" in value:
            raise AgentError("invalid_path", "Choose an absolute folder path.")
        try:
            candidate = Path(value)
            if not candidate.is_absolute():
                raise AgentError("invalid_path", "Choose an absolute folder path.")
            canonical = candidate.resolve(strict=True)
            if not canonical.is_dir():
                raise AgentError("not_directory", "This path is not a folder.")
            if not any(canonical.is_relative_to(Path(root["path"])) for root in self.roots):
                raise AgentError("outside_roots", "This folder is outside this device's configured browsing roots.")
            return canonical
        except (OSError, RuntimeError, ValueError):
            raise AgentError("unavailable_path", "This folder is unavailable or cannot be accessed.")

    def browse(self, value=None):
        path = self.resolve(value or self.roots[0]["path"])
        entries = []
        skipped = 0
        try:
            with os.scandir(path) as children:
                for entry in children:
                    try:
                        if not entry.is_dir(follow_symlinks=True):
                            continue
                        canonical = self.resolve(entry.path)
                        entries.append({"name": entry.name, "path": str(canonical), "type": "directory", "isProject": any((canonical / marker).exists() for marker in (".git", "CLAUDE.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"))})
                    except (OSError, AgentError):
                        skipped += 1
        except OSError:
            raise AgentError("permission_denied", "This folder cannot be listed by the current device user.")
        entries.sort(key=lambda item: item["name"].casefold())
        parent = None
        if path.parent != path:
            with contextlib.suppress(AgentError):
                parent = str(self.resolve(str(path.parent)))
        return {"path": str(path), "parentPath": parent, "entries": entries[:2000], "roots": self.roots, "truncated": len(entries) > 2000, "skipped": skipped}


def check_approval(policy, args):
    path = policy.resolve(args.get("path"))
    approval = args.get("folderApproval")
    if not isinstance(approval, dict) or approval.get("approved") is not True:
        raise AgentError("approval_required", "Confirm the selected folder before starting Claude.")
    # The UI approves a canonical path from browse, never a mutable symlink alias.
    if approval.get("path") != str(path) or args.get("path") != str(path):
        raise AgentError("folder_changed", "The selected folder changed. Browse it again and confirm its current path.")
    return path


def command_digest(command):
    return hashlib.sha256(json.dumps(command, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def session_key(path):
    return hashlib.sha256(os.path.normcase(str(path)).encode()).hexdigest()


def claude_args(executable, label, path, supports_no_chrome=True, permission_mode="default"):
    if permission_mode not in PERMISSION_MODES:
        raise AgentError("invalid_mode", "Unsupported permission mode.")
    title = f"{label} · {path.name or str(path)}"
    title = "".join(c for c in title if c.isprintable())[:120]
    args = [str(executable), "remote-control", "--name", title, "--remote-control-session-name-prefix", label, "--spawn", "same-dir", "--capacity", "4", "--permission-mode", permission_mode]
    if supports_no_chrome:
        args.append("--no-chrome")
    return args


def find_urls(output):
    urls = list(dict.fromkeys(OFFICIAL_URL.findall(ANSI.sub("", output))))
    env = next((url for url in reversed(urls) if "?environment=" in url), None)
    session = next((url for url in reversed(urls) if "/session_" in url), None)
    return env, session


class ConsentGate:
    """Recognize prompts; only a later live browser approval can answer them."""
    def __init__(self, selected_path):
        self.path = Path(selected_path)
        self.trusted = False
        self.enabled = False

    def prompts(self, output):
        text = ANSI.sub("", output).replace("\r", "")
        prompts = []
        # Require the full printed path, question mark and default-deny choice.
        trust = re.search(r"(?:^|\n)\s*Trust (.+?)\?\s*\[y/N\]", text)
        if trust and not self.trusted:
            shown = trust.group(1).strip()
            if os.path.normcase(shown) != os.path.normcase(str(self.path)):
                raise AgentError("trust_path_mismatch", "Claude requested trust for a different folder. No approval was sent.")
            self.trusted = True
            prompts.append({"kind": "folder", "path": str(self.path), "message": "Claude asks you to trust this folder. Sessions can read, edit and execute files here, and its project settings, hooks, MCP servers and permission rules apply. Trust this exact folder and start Claude?"})
        if re.search(r"Enable Remote Control\?\s*\(y/n\)", text) and not self.enabled:
            self.enabled = True
            prompts.append({"kind": "remote-control", "path": str(self.path), "message": "Claude asks to enable Remote Control so sessions in this folder can be controlled from other devices signed into your Claude account. Enable Remote Control?"})
        return prompts


def local_host(host):
    """Plain http is only allowed to this machine or a private (LAN) address."""
    import ipaddress
    if not host:
        return False
    if host in ("localhost",) or host.endswith((".local", ".lan", ".home.arpa")):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private


def terminate_tree(identity, grace=5.0):
    """Stop a verified process and its descendants; never acts on a reused PID."""
    if not owned(identity):
        return
    pid = identity["pid"]
    if os.name == "nt":
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW}
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run(["taskkill", "/PID", str(pid), "/T"], capture_output=True, timeout=10, **flags)
        deadline = time.monotonic() + grace
        while owned(identity) and time.monotonic() < deadline:
            time.sleep(0.1)
        if owned(identity):
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10, **flags)
        return
    # Brokers start Claude as a session leader, so its group holds the
    # sessions it spawned. Only signal the group when it is really Claude's.
    try:
        group = os.getpgid(pid) == pid
    except OSError:
        return
    def send(sig):
        with contextlib.suppress(OSError):
            if group:
                os.killpg(pid, sig)
            else:
                os.kill(pid, sig)
    send(signal.SIGTERM)
    deadline = time.monotonic() + grace
    while owned(identity) and time.monotonic() < deadline:
        time.sleep(0.1)
    if owned(identity):
        send(signal.SIGKILL)


def detached_kwargs():
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP, "close_fds": True}
    return {"start_new_session": True, "close_fds": True}


class DeviceAgent:
    def __init__(self, config_path):
        self.config_path = Path(config_path).resolve(strict=True)
        self.config = read_json(self.config_path)
        self.device_id = self.config.get("deviceId", "")
        if not ID_RE.fullmatch(self.device_id):
            raise AgentError("configuration", "A valid deviceId is required.")
        self.secret = self.config.get("deviceSecret", "")
        if not isinstance(self.secret, str) or len(self.secret) < 32 or "\r" in self.secret or "\n" in self.secret:
            raise AgentError("configuration", "A device secret of at least 32 characters is required.")
        self.hub = self.config.get("hubUrl", "").rstrip("/")
        parsed = urllib.parse.urlsplit(self.hub)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise AgentError("configuration", "hubUrl must be the HTTPS origin without credentials or a path.")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and local_host(parsed.hostname) and self.config.get("allowLocalHttp") is True):
            raise AgentError("configuration", "The hub requires HTTPS. Local HTTP must be explicitly enabled for local tests.")
        self.policy = PathPolicy(self.config.get("roots"))
        self.label = self.config.get("label", self.device_id)
        if not isinstance(self.label, str) or not self.label.strip() or len(self.label) > 80 or not all(c.isprintable() for c in self.label):
            raise AgentError("configuration", "Use a short printable device label.")
        self.default = str(self.policy.resolve(self.config.get("defaultPath", self.policy.roots[0]["path"])))
        state_value = self.config.get("stateDir", "state")
        self.state = (self.config_path.parent / state_value).resolve()
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.commands_file = self.state / "commands.json"
        self.commands = read_json(self.commands_file, {})
        self.mappings_file = self.state / "sessions.json"
        self.mappings = read_json(self.mappings_file, {})
        self.broker_processes = {}
        self.exe = self.config.get("claudePath") or shutil.which("claude")
        if not self.exe or not Path(self.exe).is_absolute() or not Path(self.exe).is_file():
            raise AgentError("configuration", "claudePath must name an installed native Claude executable.")
        # .cmd/.bat would invoke an interpreter with platform-dependent quoting.
        if os.name == "nt" and Path(self.exe).suffix.lower() != ".exe":
            raise AgentError("configuration", "Use the native claude.exe installation on Windows.")
        self.external_connections = {}
        external_entries = self.config.get("externalConnections", [])
        if not isinstance(external_entries, list):
            raise AgentError("configuration", "externalConnections must be a list of verified connection records.")
        for entry in external_entries:
            if not isinstance(entry, dict):
                raise AgentError("configuration", "External connections must be explicit verified connection records.")
            path = self.policy.resolve(entry.get("path"))
            identity = entry.get("process")
            url = entry.get("url")
            if not isinstance(url, str) or not OFFICIAL_URL.fullmatch(url):
                raise AgentError("configuration", "An external connection requires an exact official Claude environment or session URL.")
            if (not isinstance(identity, dict) or not isinstance(identity.get("pid"), int)
                    or identity["pid"] <= 0 or not isinstance(identity.get("created"), str)
                    or not identity["created"] or not isinstance(identity.get("exe"), str)
                    or not Path(identity["exe"]).is_absolute()):
                raise AgentError("configuration", "An external connection needs its verified PID, creation identity and executable path.")
            self.external_connections[session_key(path)] = dict(entry, path=str(path))

    def descriptor(self):
        return {"label": self.label, "os": "windows" if os.name == "nt" else "linux", "roots": self.policy.roots, "defaultPath": self.default, "hostname": socket.gethostname(), "version": VERSION, "capabilities": CAPABILITIES}

    def record(self, key):
        record = read_json(self.state / "brokers" / key / "process.json", {})
        if record.get("status") in ("ready", "starting") and not owned(record.get("broker")):
            record = dict(record, status="offline", error={"code": "process_stopped", "message": "The session launcher has stopped on this device."})
        if record.get("status") == "ready" and not owned(record.get("child")):
            record = dict(record, status="offline", error={"code": "process_stopped", "message": "Claude has stopped on this device."})
        if record.get("status") not in ("ready", "starting"):
            external = self.external_record(key)
            if external:
                return external
            if key in self.external_connections and not record:
                return {"kind": "external", "path": self.external_connections[key]["path"], "status": "offline",
                        "error": {"code": "existing_connection_stopped", "message": "The existing Claude connection is no longer running in this folder. Start a new connection to continue."}}
        return record

    def external_record(self, key):
        entry = self.external_connections.get(key)
        if not entry or not verified_external_process(entry["process"], Path(entry["path"])):
            return None
        url = entry["url"]
        return {"kind": "external", "path": entry["path"], "status": "ready", "child": entry["process"],
                "environmentUrl": url if "?environment=" in url else None,
                "sessionUrl": url if "/session_" in url else None,
                "startedAt": entry.get("startedAt"), "trustPending": None}

    def public_record(self, record, hub_id=None):
        status = record.get("status", "starting")
        result = {"path": record.get("path"), "status": status, "url": record.get("environmentUrl") or record.get("sessionUrl"), "sessionUrl": record.get("sessionUrl"), "pid": (record.get("child") or {}).get("pid"), "startedAt": record.get("startedAt"), "permissionMode": record.get("permissionMode", "default")}
        if hub_id:
            result["id"] = hub_id
        if record.get("error"):
            result["error"] = record["error"]
        result["trustPending"] = record.get("trustPending") if status == "starting" else None
        if record.get("kind") == "external":
            result["external"] = True
        return result

    def sessions(self):
        return [self.public_record(self.record(value["key"]), sid) | {"path": value["path"]} for sid, value in self.mappings.items()]

    def launch(self, args):
        path = check_approval(self.policy, args)
        sid = args.get("sessionId")
        if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
            raise AgentError("invalid_session", "The launch request needs a valid session ID.")
        mode = args.get("permissionMode", "default")
        if mode not in PERMISSION_MODES:
            raise AgentError("invalid_mode", "Unsupported permission mode.")
        key = session_key(path)
        folder = self.state / "brokers" / key
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        record = self.record(key)
        if record.get("status") in ("ready", "starting") and record.get("permissionMode", "default") != mode:
            raise AgentError("mode_conflict", "Claude is already running in this folder with other permissions. Stop it first, then start again.")
        if record.get("status") not in ("ready", "starting"):
            if os.name == "nt":
                try:
                    import winpty  # noqa: F401
                except ImportError:
                    raise AgentError("setup_required", "Install the Windows terminal dependency pywinpty before starting new folders.")
            # Capture the directory identity; broker checks it again before launch.
            stat = path.stat()
            request = {"path": str(path), "folderApproval": args["folderApproval"], "deviceLabel": self.label, "executable": str(self.exe), "roots": self.policy.roots, "directoryIdentity": [stat.st_dev, stat.st_ino], "supportsNoChrome": self.config.get("supportsNoChrome", True), "permissionMode": mode, "approvedAt": now()}
            atomic_json(folder / "request.json", request)
            with contextlib.suppress(FileNotFoundError):
                (folder / "stop.json").unlink()
            # Agent itself has a global file lock. Each detached broker additionally
            # holds its own lock for its entire lifetime, closing crash/retry gaps.
            with (folder / "supervisor.log").open("ab", buffering=0) as log:
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "broker", "--request", str(folder / "request.json")], stdin=subprocess.DEVNULL, stdout=log, stderr=log, **detached_kwargs())
            self.broker_processes[child.pid] = child
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                record = self.record(key)
                if record.get("broker", {}).get("pid") == child.pid or record.get("status") in ("starting", "ready"):
                    break
                if child.poll() is not None:
                    break
                time.sleep(0.05)
            if not record or record.get("status") not in ("ready", "starting"):
                if record.get("error"):
                    raise AgentError(record["error"]["code"], record["error"]["message"])
                raise AgentError("launch_failed", "The device could not start its session launcher.")
        self.mappings[sid] = {"key": key, "path": str(path)}
        atomic_json(self.mappings_file, self.mappings)
        return self.public_record(record, sid)

    def confirm(self, args):
        sid = args.get("sessionId")
        mapping = self.mappings.get(sid)
        if not mapping or args.get("approved") is not True:
            raise AgentError("approval_required", "Confirm the displayed Claude prompt to continue.")
        record = self.record(mapping["key"])
        pending = record.get("trustPending")
        if not owned(record.get("broker")) or not pending or args.get("nonce") != pending.get("nonce") or args.get("path") != pending.get("path"):
            raise AgentError("confirmation_expired", "This confirmation is no longer current. Refresh the session and review its prompt.")
        path = self.policy.resolve(args["path"])
        if str(path) != pending["path"]:
            raise AgentError("folder_changed", "The selected folder changed. Select it again.")
        atomic_json(self.state / "brokers" / mapping["key"] / "consent.json", {"nonce": pending["nonce"], "path": pending["path"], "approved": True, "confirmedAt": now()})
        return self.public_record(record, sid)

    def stop(self, args):
        sid = args.get("sessionId")
        mapping = self.mappings.get(sid) if isinstance(sid, str) else None
        if not mapping:
            raise AgentError("unknown_session", "This device has no record of that session.")
        folder = self.state / "brokers" / mapping["key"]
        record = self.record(mapping["key"])
        if record.get("kind") == "external":
            raise AgentError("external_connection", "This connection was not started by Anywhere. Stop it on the device itself.")
        # Use the stored identities: a broker can die while its Claude lives on.
        stored = read_json(folder / "process.json", {})
        broker, child = stored.get("broker"), stored.get("child")
        if not owned(broker) and not owned(child):
            return self.public_record(dict(record, status="stopped", error=None, trustPending=None), sid)
        if owned(broker):
            # The broker owns the terminal; ask it to end Claude cleanly.
            atomic_json(folder / "stop.json", {"sessionId": sid, "requestedAt": now()})
            deadline = time.monotonic() + 10
            while owned(broker) and time.monotonic() < deadline:
                time.sleep(0.1)
        if owned(child):
            terminate_tree(child)
        record = read_json(folder / "process.json", {})
        if record.get("status") != "stopped" and not owned(record.get("child")) and not owned(record.get("broker")):
            record.update(status="stopped", trustPending=None)
            record.pop("error", None)
            atomic_json(folder / "process.json", record)
        if owned(child):
            raise AgentError("stop_failed", "Claude did not stop on this device. Check its launcher log.")
        # An older broker may still be exiting; Claude itself is gone.
        return self.public_record(dict(self.record(mapping["key"]), status="stopped", error=None, trustPending=None), sid)

    def execute(self, command):
        cid = command.get("id") if isinstance(command, dict) else None
        if not isinstance(cid, str) or not ID_RE.fullmatch(cid):
            return {"id": cid if isinstance(cid, str) and len(cid) < 200 else "invalid", "ok": False, "error": {"code": "invalid_command", "message": "Invalid command ID."}}
        digest = command_digest(command)
        if cid in self.commands:
            previous = self.commands[cid]
            if previous["digest"] != digest:
                return {"id": cid, "ok": False, "error": {"code": "replay_conflict", "message": "This command ID was already used for a different request."}}
            return previous["response"]
        try:
            args = command.get("args", {})
            if not isinstance(args, dict):
                raise AgentError("invalid_command", "Command arguments must be an object.")
            if command.get("type") == "browse":
                result = self.policy.browse(args.get("path"))
            elif command.get("type") == "launch":
                result = self.launch(args)
            elif command.get("type") == "confirm":
                result = self.confirm(args)
            elif command.get("type") == "stop":
                result = self.stop(args)
            elif command.get("type") == "status":
                result = {"sessions": self.sessions(), "device": self.descriptor()}
            else:
                raise AgentError("unsupported_command", "This device accepts only browse, launch, confirm, stop and status requests.")
            response = {"id": cid, "ok": True, "result": result}
        except AgentError as exc:
            response = {"id": cid, "ok": False, "error": exc.public()}
        except (OSError, ValueError, TypeError):
            response = {"id": cid, "ok": False, "error": {"code": "device_error", "message": "The device could not complete this request. Check its local launcher log."}}
        self.commands[cid] = {"digest": digest, "response": response, "completedAt": now()}
        atomic_json(self.commands_file, self.commands)
        return response

    def poll(self, results):
        # Reap brokers that finished without owning the lifetime of live ones.
        for pid, process in list(self.broker_processes.items()):
            if process.poll() is not None:
                del self.broker_processes[pid]
        body = json.dumps({"version": VERSION, "device": self.descriptor(), "sessions": self.sessions(), "results": results}).encode()
        request = urllib.request.Request(f"{self.hub}/api/agents/{urllib.parse.quote(self.device_id, safe='')}/poll", data=body, headers={"Authorization": f"Bearer {self.secret}", "Content-Type": "application/json", "User-Agent": "ClaudeDeviceLauncher/1"}, method="POST")
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=35) as response:
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise AgentError("hub_response", "The hub returned an oversized response.")
                data = json.loads(raw)
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise AgentError("authentication", "The hub rejected this device's credentials. Re-pair this device.")
            raise AgentError("hub_http", f"The hub returned HTTP {exc.code}.")
        except (urllib.error.URLError, TimeoutError, OSError):
            raise AgentError("hub_unavailable", "The hub is temporarily unavailable.")
        except (ValueError, TypeError):
            raise AgentError("hub_response", "The hub returned an invalid response.")
        if not isinstance(data, dict) or not isinstance(data.get("commands", []), list) or len(data.get("commands", [])) > 32:
            raise AgentError("hub_response", "The hub returned an invalid command batch.")
        return data

    def fetch(self, path, limit=MAX_BODY):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        request = urllib.request.Request(f"{self.hub}{path}", headers={"User-Agent": "ClaudeDeviceLauncher/1", "Cache-Control": "no-cache"})
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=35) as response:
                raw = response.read(limit + 1)
        except (urllib.error.URLError, TimeoutError, OSError):
            raise AgentError("update_unavailable", "The agent update could not be downloaded.")
        if len(raw) > limit:
            raise AgentError("update_invalid", "The agent update is too large.")
        return raw

    def self_update(self, advertised):
        """Install a newer agent only if its manifest is signed by the pinned key."""
        key = self.config.get("updatePublicKey") or UPDATE_PUBLIC_KEY
        if not key or not isinstance(advertised, int) or advertised <= VERSION or self.config.get("autoUpdate") is False:
            return False
        if time.monotonic() < getattr(self, "update_retry_at", 0):
            return False
        self.update_retry_at = time.monotonic() + UPDATE_RETRY_SECONDS
        try:
            manifest = json.loads(self.fetch("/install/agent-manifest.json", 64 * 1024))
            payload = manifest["payload"]
            import base64
            if not ed25519_verify(base64.b64decode(key), payload.encode("utf-8"), base64.b64decode(manifest["signature"])):
                raise AgentError("update_signature", "The agent update signature is invalid. Nothing was installed.")
            info = json.loads(payload)
            if info.get("name") != "anywhere-device-agent" or not isinstance(info.get("version"), int) or info["version"] <= VERSION:
                raise AgentError("update_invalid", "The signed agent update is not newer than this agent.")
            code = self.fetch("/install/device_agent.py")
            if hashlib.sha256(code).hexdigest() != info.get("sha256"):
                raise AgentError("update_invalid", "The downloaded agent does not match its signed checksum.")
            current = Path(__file__).resolve()
            candidate = current.with_name(current.name + ".new")
            candidate.write_bytes(code)
            kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            check = subprocess.run([sys.executable, str(candidate), "check", "--config", str(self.config_path)], capture_output=True, timeout=60, **kwargs)
            if check.returncode != 0:
                candidate.unlink(missing_ok=True)
                raise AgentError("update_check_failed", "The new agent failed its self-check on this device; the current agent keeps running.")
            shutil.copy2(current, current.with_name(current.name + ".previous"))
            os.replace(candidate, current)
            # Keep the verified signed manifest beside the agent so local
            # controls that pin the agent file can accept signed releases.
            atomic_json(current.with_name("agent-manifest.json"), manifest)
            print(json.dumps({"time": now(), "update": {"from": VERSION, "to": info["version"]}}), flush=True)
            return True
        except AgentError as exc:
            print(json.dumps({"time": now(), "error": exc.public()}), flush=True)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            print(json.dumps({"time": now(), "error": {"code": "update_failed", "message": "The agent update failed; the current agent keeps running."}}), flush=True)
        return False

    def adopt_update_key(self):
        """Agents installed before keys moved into the configuration learn their key once.

        The hub only proposes a key; it is kept only if it verifies the signed manifest of
        the code running right now, so a hub cannot substitute a key of its own.
        """
        if self.config.get("updatePublicKey") or UPDATE_PUBLIC_KEY or self.config.get("autoUpdate") is False:
            return
        current = Path(__file__).resolve()
        try:
            manifest = read_json(current.with_name("agent-manifest.json"), None)
            if not isinstance(manifest, dict):
                return
            info = json.loads(manifest["payload"])
            if info.get("sha256") != hashlib.sha256(current.read_bytes()).hexdigest():
                return
            key = json.loads(self.fetch("/api/agents/update-key", 4096)).get("key", "")
            import base64
            if not key or not ed25519_verify(base64.b64decode(key), manifest["payload"].encode("utf-8"), base64.b64decode(manifest["signature"])):
                return
            config = read_json(self.config_path, {})
            config["updatePublicKey"] = key
            atomic_json(self.config_path, config)
            self.config["updatePublicKey"] = key
            print(json.dumps({"time": now(), "update": {"adoptedKey": True}}), flush=True)
        except (AgentError, OSError, ValueError, KeyError, TypeError):
            pass

    def run(self):
        self.adopt_update_key()
        pending = []
        backoff = 2
        with FileLock(self.state / "agent.lock", wait=20):
            while True:
                try:
                    response = self.poll(pending)
                    acknowledged = response.get("acknowledged", [])
                    if not isinstance(acknowledged, list):
                        raise AgentError("hub_response", "The hub returned invalid acknowledgements.")
                    pending = [item for item in pending if item["id"] not in acknowledged]
                    for command in response.get("commands", []):
                        result = self.execute(command)
                        pending = [item for item in pending if item["id"] != result["id"]]
                        pending.append(result)
                    backoff = 2
                    if not pending and self.self_update(response.get("agentVersion")):
                        raise RestartForUpdate()
                    delay = response.get("pollAfterMs", 2000)
                    if not isinstance(delay, (int, float)):
                        delay = 2000
                    if not pending:
                        time.sleep(min(30, max(0.25, delay / 1000)))
                except AgentError as exc:
                    print(json.dumps({"time": now(), "error": exc.public()}), flush=True)
                    if exc.code == "authentication":
                        return 2
                    time.sleep(backoff)
                    backoff = min(60, backoff * 2)


def run_broker(request_path):
    request_path = Path(request_path).resolve(strict=True)
    folder = request_path.parent
    try:
        lock = FileLock(folder / "broker.lock")
        lock.__enter__()
    except AgentError:
        return 0
    record = {"broker": process_identity(os.getpid()), "path": None, "startedAt": now(), "status": "starting"}
    child = None
    master = None
    pty_process = None
    try:
        request = read_json(request_path)
        path = check_approval(PathPolicy(request["roots"]), request)
        record["path"] = str(path)
        stat = path.stat()
        if [stat.st_dev, stat.st_ino] != request["directoryIdentity"]:
            raise AgentError("folder_changed", "The selected folder changed before launch. Select it again.")
        with contextlib.suppress(FileNotFoundError):
            (folder / "stop.json").unlink()
        atomic_json(folder / "process.json", record)
        record["permissionMode"] = request.get("permissionMode", "default")
        args = claude_args(request["executable"], request["deviceLabel"], path, request.get("supportsNoChrome", True), record["permissionMode"])
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["NO_COLOR"] = "1"
        chunks = queue.Queue(maxsize=1024)
        if os.name == "nt":
            from winpty import PtyProcess
            pty_process = PtyProcess.spawn(args, cwd=str(path), env=env, dimensions=(40, 240), backend=1)
            child_pid = pty_process.pid
            write = pty_process.write
            read = lambda: pty_process.read(8192)
            alive = pty_process.isalive
        else:
            import pty
            import fcntl
            import termios
            import struct
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 240, 0, 0))
            child = subprocess.Popen(args, cwd=str(path), stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True, close_fds=True)
            os.close(slave)
            child_pid = child.pid
            write = lambda s: os.write(master, s.encode())
            read = lambda: os.read(master, 8192).decode("utf-8", errors="replace")
            alive = lambda: child.poll() is None
        identity_deadline = time.monotonic() + 1
        record["child"] = process_identity(child_pid)
        while record["child"] is None and time.monotonic() < identity_deadline and alive():
            time.sleep(0.025)
            record["child"] = process_identity(child_pid)
        if record["child"] is None:
            raise AgentError("process_identity", "The new Claude process could not be verified.")
        atomic_json(folder / "process.json", record)
        def read_loop():
            try:
                while True:
                    chunk = read()
                    if not chunk:
                        break
                    chunks.put(chunk)
            except (OSError, EOFError):
                pass
            finally:
                chunks.put(None)
        threading.Thread(target=read_loop, daemon=True).start()
        transcript = ""
        gate = ConsentGate(path)
        stopping = False
        def stop_requested():
            return (folder / "stop.json").exists()
        def stop_child():
            if pty_process is not None:
                with contextlib.suppress(Exception):
                    pty_process.terminate(force=False)
            terminate_tree(record["child"])
            if pty_process is not None and alive():
                with contextlib.suppress(Exception):
                    pty_process.terminate(force=True)
        deadline = time.monotonic() + 100
        def relay_live_consent():
            nonlocal deadline
            pending = record.get("trustPending")
            if not pending:
                return
            consent = read_json(folder / "consent.json", {})
            if consent.get("approved") is True and consent.get("nonce") == pending["nonce"] and consent.get("path") == pending["path"]:
                # The browser confirmation is a fresh command after the actual
                # CLI prompt became visible. No preapproval or delay bypass.
                write("y\r")
                record["trustPending"] = None
                deadline = time.monotonic() + 100
                atomic_json(folder / "process.json", record)
        with (folder / "claude.log").open("a", encoding="utf-8", buffering=1) as log:
            with contextlib.suppress(OSError):
                os.chmod(folder / "claude.log", 0o600)
            while True:
                if not stopping and stop_requested():
                    stopping = True
                    stop_child()
                relay_live_consent()
                try:
                    chunk = chunks.get(timeout=0.5)
                except queue.Empty:
                    if not alive():
                        break
                    if record["status"] == "starting" and time.monotonic() > deadline:
                        raise AgentError("setup_required", "Claude did not finish connecting. Sign in or review its local setup prompt on this device, then retry.")
                    continue
                if chunk is None:
                    break
                log.write(chunk)
                transcript = (transcript + chunk)[-100000:]
                if "That answer arrived too quickly after the question to count" in ANSI.sub("", transcript):
                    raise AgentError("confirmation_rejected", "Claude rejected the confirmation. Review its trust prompt locally before retrying this folder.")
                for prompt in gate.prompts(transcript):
                    record["trustPending"] = prompt | {"nonce": secrets.token_urlsafe(24)}
                    deadline = time.monotonic() + 600
                    atomic_json(folder / "process.json", record)
                environment_url, session_url = find_urls(transcript)
                if environment_url or session_url:
                    changed = record.get("environmentUrl") != environment_url or record.get("sessionUrl") != session_url or record["status"] != "ready"
                    record.update(status="ready", environmentUrl=environment_url, sessionUrl=session_url, trustPending=None)
                    if changed:
                        atomic_json(folder / "process.json", record)
                if record["status"] == "starting" and time.monotonic() > deadline:
                    raise AgentError("setup_required", "Claude is waiting for local setup. Review the device's launcher log and finish setup locally, then retry.")
        if stopping or stop_requested():
            record.update(status="stopped", trustPending=None)
            record.pop("error", None)
            return 0
        if record["status"] == "starting":
            text = ANSI.sub("", transcript).lower()
            if record.get("permissionMode") == "bypassPermissions" and ("root" in text or "sudo" in text) and ("dangerously" in text or "bypass" in text):
                raise AgentError("bypass_refused", "Claude refuses Full auto on this device (it runs as root). Use Ask or Accept edits here.")
            if "this folder is already served by a terminal" in text and "claude remote-control" in text:
                raise AgentError("already_running", "This folder already has a Claude Remote Control connection. Open its existing connection or add that verified connection to this launcher.")
            if "not trusted" in text or "trust" in text:
                raise AgentError("setup_required", "This Claude version needs the folder to be trusted locally first. Open Claude in that folder once, then retry.")
            if any(word in text for word in ("login", "logged in", "token", "authentication", "subscription")):
                raise AgentError("claude_authentication", "Sign in to Claude Code on this device, then retry.")
            raise AgentError("claude_exited", "Claude exited before connecting. Check its local launcher log.")
        record["status"] = "offline"
        record["error"] = {"code": "process_stopped", "message": "Claude has stopped on this device."}
    except AgentError as exc:
        record.update(status="error", error=exc.public())
        # This broker owns only the child it just launched. It never stops any
        # existing user's Claude process or legacy connection.
        if owned(record.get("child")):
            if pty_process is not None:
                with contextlib.suppress(Exception):
                    pty_process.terminate(force=True)
            elif child is not None:
                child.terminate()
    except Exception:
        record.update(status="error", error={"code": "broker_error", "message": "The device session launcher failed. Check its local setup and terminal dependency."})
        if child is not None and owned(record.get("child")):
            child.terminate()
        if pty_process is not None and owned(record.get("child")):
            with contextlib.suppress(Exception):
                pty_process.terminate(force=True)
    finally:
        atomic_json(folder / "process.json", record)
        if master is not None:
            with contextlib.suppress(OSError):
                os.close(master)
        lock.__exit__()
    return 0 if record["status"] in ("offline", "stopped") else 1


# Local control scripts that track the agent process (laptop: control.py,
# desktop: agent_control.py). They record the Popen child, which on Windows can
# be a venv launcher that is the parent of the interpreter running this code.
CONTROL_RECORDS = (("polling-agent-process.json", "identity", "control.lock"), ("agent-process.json", "process", "agent-control.lock"))


def hand_over_control(state, new_pid):
    """Point a local control script's process record at the restarted agent."""
    ours = [process_identity(os.getpid()), process_identity(os.getppid())]
    for name, field, lock in CONTROL_RECORDS:
        tracked = state / name
        if not tracked.exists():
            continue
        try:
            with FileLock(state / lock, wait=10):
                saved = read_json(tracked, None)
                if not isinstance(saved, dict) or not saved.get(field) or saved.get(field) not in ours:
                    continue
                deadline = time.monotonic() + 3
                identity = process_identity(new_pid)
                while not identity and time.monotonic() < deadline:
                    time.sleep(0.05)
                    identity = process_identity(new_pid)
                if not identity:
                    continue
                updated = dict(saved, startedAt=now())
                updated[field] = identity
                if "sourceSha256" in saved:
                    updated["sourceSha256"] = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()
                atomic_json(tracked, updated)
        except (AgentError, OSError, ValueError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("run", "check"):
        sub.add_parser(action).add_argument("--config", required=True)
    sub.add_parser("broker").add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        if args.action == "broker":
            return run_broker(args.request)
        agent = DeviceAgent(args.config)
        if args.action == "check":
            print(json.dumps({"deviceId": agent.device_id, "device": agent.descriptor(), "sessions": agent.sessions(), "claudePath": str(agent.exe)}, indent=2))
            return 0
        try:
            return agent.run()
        except RestartForUpdate:
            # The lock is released; start the new code with the same arguments.
            argv = [sys.executable, "-B", "-u", str(Path(__file__).resolve()), "run", "--config", args.config]
            sys.stdout.flush()
            if os.name != "nt":
                os.execv(sys.executable, argv)  # same PID: local controls keep tracking it
            child = subprocess.Popen(argv, cwd=str(agent.config_path.parent), stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr, **detached_kwargs())
            hand_over_control(agent.state, child.pid)
            return 0
    except AgentError as exc:
        print(json.dumps({"error": exc.public()}), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
