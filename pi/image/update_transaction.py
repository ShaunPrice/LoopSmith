#!/usr/bin/env python3
"""Validated app/service update with a recoverable file transaction.

No third-party packages. Host tests inject temporary paths and service callbacks.
This restores application, service and udev files; it is not an OS-image rollback.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import time
import urllib.request
import urllib.error

MAX_BYTES = 256 * 1024 * 1024
MAX_MEMBERS = 12000


def unpack(archive, destination):
    """Validate ALL entries before writing any; reject links/devices/duplicates."""
    destination = Path(destination)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("extraction destination must be empty")
    with tarfile.open(archive, "r:gz") as src:
        members = src.getmembers()
        if len(members) > MAX_MEMBERS or sum(m.size for m in members) > MAX_BYTES:
            raise ValueError("update exceeds extraction limits")
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or not path.parts or not (member.isfile() or member.isdir())
                    or str(path) in seen):
                raise ValueError("unsafe or duplicate archive entry")
            seen.add(str(path))
        for member in members:
            dest = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with src.extractfile(member) as inp, dest.open("xb") as out:
                    shutil.copyfileobj(inp, out)
                dest.chmod(0o755 if member.mode & 0o111 else 0o644)


def atomic_json(path, obj):
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj) + "\n")
    os.replace(tmp, path)


class Transaction:
    def __init__(self, app, state, units, udev, restart, healthy, polkit=None):
        self.app, self.state, self.units, self.udev = map(Path, (app, state, units, udev))
        self.restart, self.healthy = restart, healthy
        self.polkit = Path(polkit) if polkit else self.udev
        self.backup = self.state / "update-backup"
        self.progress = self.state / "update-progress.json"

    def phase(self, phase, message):
        atomic_json(self.progress, {"phase": phase, "message": message, "at": int(time.time())})

    def restore_files(self):
        manifest = json.loads((self.backup / "manifest.json").read_text())
        restored = self.app.with_name(self.app.name + ".restore")
        if restored.exists():
            shutil.rmtree(restored)
        shutil.copytree(self.backup / "app", restored, symlinks=True)
        failed = self.app.with_name(self.app.name + ".failed")
        if failed.exists():
            shutil.rmtree(failed)
        if self.app.exists():
            os.replace(self.app, failed)
        os.replace(restored, self.app)
        for entry in manifest:
            root = {"units": self.units, "udev": self.udev, "polkit": self.polkit}[entry["kind"]]
            dest = root / entry["name"]
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            if entry["existed"]:
                shutil.copy2(self.backup / entry["kind"] / entry["name"], dest, follow_symlinks=False)

    def rollback(self):
        if not (self.backup / "manifest.json").exists():
            raise ValueError("no complete update backup")
        self.phase("rolling_back", "Restoring app and service files")
        self.restore_files()
        self.restart()
        if not self.healthy():
            self.phase("failed", "Files restored; bridge health check still failed")
            raise RuntimeError("rollback restored files but bridge is unavailable")
        self.phase("rolled_back", "Previous app and service files restored")

    def apply(self, stage):
        stage = Path(stage)
        version = (stage / "VERSION").read_text().strip()
        if not version or len(version) > 40 or any(c not in "0123456789.-abcdefghijklmnopqrstuvwxyz" for c in version):
            raise ValueError("invalid update version")
        for rel in ("app/pi/looper_bridge.py", "app/editor/index.html"):
            if not (stage / rel).is_file():
                raise ValueError("bundle is missing " + rel)
        # Syntax-check every Python file without executing bundle code.
        for path in (stage / "app").rglob("*.py"):
            compile(path.read_bytes(), str(path), "exec")
        manifest = []
        for kind, root, suffixes in (("units", self.units, (".service", ".timer")),
                                     ("udev", self.udev, (".rules",))):
            for path in sorted((stage / kind).glob("*")):
                if not path.is_file() or path.suffix not in suffixes:
                    raise ValueError("unsupported system file " + path.name)
                target_kind = "polkit" if kind == "udev" and path.name == "50-looper.rules" else kind
                target_root = self.polkit if target_kind == "polkit" else root
                manifest.append({"kind": target_kind, "source": kind, "name": path.name,
                                 "existed": (target_root / path.name).exists() or (target_root / path.name).is_symlink()})
        self.phase("preparing", "Backing up app and service files")
        pending = self.state / "update-backup.pending"
        if pending.exists():
            shutil.rmtree(pending)
        pending.mkdir()
        shutil.copytree(self.app, pending / "app", symlinks=True)
        for entry in manifest:
            if entry["existed"]:
                root = {"units": self.units, "udev": self.udev, "polkit": self.polkit}[entry["kind"]]
                dest = pending / entry["kind"] / entry["name"]
                dest.parent.mkdir(exist_ok=True)
                shutil.copy2(root / entry["name"], dest, follow_symlinks=False)
        atomic_json(pending / "manifest.json", manifest)
        candidate = self.app.with_name(self.app.name + ".candidate")
        if candidate.exists():
            shutil.rmtree(candidate)
        shutil.copytree(stage / "app", candidate)
        # Keep the installed version until the candidate actually passes health.
        old_version = (self.app / "VERSION").read_text()
        (candidate / "VERSION").write_text(old_version)
        if self.backup.exists():
            shutil.rmtree(self.backup)
        os.replace(pending, self.backup)
        self.phase("installing", "Installing candidate; version not yet confirmed")
        old = self.app.with_name(self.app.name + ".previous")
        if old.exists():
            shutil.rmtree(old)
        try:
            os.replace(self.app, old)
            os.replace(candidate, self.app)
            for entry in manifest:
                root = {"units": self.units, "udev": self.udev, "polkit": self.polkit}[entry["kind"]]
                root.mkdir(parents=True, exist_ok=True)
                dest = root / entry["name"]
                if dest.is_symlink():
                    dest.unlink()
                shutil.copy2(stage / entry["source"] / entry["name"], dest)
            self.phase("checking", "Waiting for the new bridge health check")
            self.restart()
            if not self.healthy():
                raise RuntimeError("candidate bridge health check failed")
            tmp = self.app / "VERSION.next"
            tmp.write_text(version + "\n")
            os.replace(tmp, self.app / "VERSION")
            self.phase("complete", "Updated to " + version)
        except Exception:
            self.rollback()
            raise
        finally:
            if candidate.exists():
                shutil.rmtree(candidate)


def restart():
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["udevadm", "control", "--reload"], check=True)
    subprocess.run(["systemctl", "restart", "looper-bridge"], check=True)


def healthy():
    for _ in range(20):
        try:
            with urllib.request.urlopen("http://127.0.0.1/api/health", timeout=2) as res:
                if json.load(res).get("ok") is True:
                    return True
        except urllib.error.HTTPError as exc:
            if exc.code == 404:  # rollback to an older bridge without /api/health
                try:
                    with urllib.request.urlopen("http://127.0.0.1/api/status", timeout=2) as res:
                        if isinstance(json.load(res), dict):
                            return True
                except urllib.error.HTTPError as old:
                    if old.code == 409:
                        try:
                            if json.load(old).get("claim") is True:
                                return True  # old public bridge awaiting local setup
                        except ValueError:
                            pass
                except (OSError, ValueError):
                    pass
        except (OSError, ValueError):
            pass
        time.sleep(1)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("unpack", "apply", "rollback"))
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()
    if args.action == "unpack":
        unpack(*args.paths)
        return
    state = Path("/var/lib/looper")
    state.mkdir(exist_ok=True)
    with (state / "update.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        tx = Transaction("/opt/looper", state, "/etc/systemd/system", "/etc/udev/rules.d", restart, healthy, "/etc/polkit-1/rules.d")
        if args.action == "apply":
            tx.apply(args.paths[0])
        else:
            tx.rollback()


if __name__ == "__main__":
    main()
