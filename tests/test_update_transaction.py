import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("update", ROOT / "pi/image/update_transaction.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("app", "state", "units", "udev", "stage/app/pi", "stage/app/editor", "stage/units", "stage/udev"):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        (self.root / "app/VERSION").write_text("1.0.0\n")
        (self.root / "app/user-marker").write_text("old app")
        (self.root / "units/bridge.service").write_text("old unit")
        (self.root / "udev/device.rules").write_text("old rules")
        (self.root / "stage/VERSION").write_text("1.1.0\n")
        (self.root / "stage/app/pi/looper_bridge.py").write_text("pass\n")
        (self.root / "stage/app/editor/index.html").write_text("new editor")
        (self.root / "stage/units/bridge.service").write_text("new unit")
        (self.root / "stage/units/new.timer").write_text("new timer")
        (self.root / "stage/udev/device.rules").write_text("new rules")
        self.health = [True]
        self.versions_at_restart = []
        def restart():
            self.versions_at_restart.append((self.root / "app/VERSION").read_text().strip())
        self.tx = update.Transaction(*(self.root / p for p in ("app", "state", "units", "udev")),
                                     restart, lambda: self.health.pop(0))

    def test_success_commits_version_only_after_health(self):
        self.tx.apply(self.root / "stage")
        self.assertEqual(self.versions_at_restart, ["1.0.0"])
        self.assertEqual((self.root / "app/VERSION").read_text().strip(), "1.1.0")
        self.assertEqual(json.loads(self.tx.progress.read_text())["phase"], "complete")

    def test_health_failure_restores_app_units_rules_and_removes_new_timer(self):
        self.health = [False, True]
        with self.assertRaisesRegex(RuntimeError, "candidate"):
            self.tx.apply(self.root / "stage")
        self.assertEqual((self.root / "app/user-marker").read_text(), "old app")
        self.assertEqual((self.root / "units/bridge.service").read_text(), "old unit")
        self.assertEqual((self.root / "udev/device.rules").read_text(), "old rules")
        self.assertFalse((self.root / "units/new.timer").exists())
        self.assertEqual(self.versions_at_restart, ["1.0.0", "1.0.0"])

    def test_bad_python_never_mutates_installation(self):
        (self.root / "stage/app/pi/looper_bridge.py").write_text("def !!!")
        with self.assertRaises(SyntaxError):
            self.tx.apply(self.root / "stage")
        self.assertEqual(self.versions_at_restart, [])
        self.assertEqual((self.root / "app/user-marker").read_text(), "old app")

    def test_explicit_rollback_after_success(self):
        self.health = [True, True]
        self.tx.apply(self.root / "stage")
        self.tx.rollback()
        self.assertEqual((self.root / "app/VERSION").read_text().strip(), "1.0.0")

    def test_archives_reject_traversal_links_and_duplicates_before_writing(self):
        for unsafe in ("../escape", "/escape", "duplicate", "link"):
            with self.subTest(unsafe=unsafe):
                archive = self.root / "bundle.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    good = tarfile.TarInfo("good"); good.size = 2
                    tar.addfile(good, io.BytesIO(b"ok"))
                    bad = tarfile.TarInfo("good" if unsafe == "duplicate" else unsafe)
                    if unsafe == "link":
                        bad.type = tarfile.SYMTYPE; bad.linkname = "/tmp"
                    tar.addfile(bad)
                dest = self.root / "out"
                with self.assertRaises(ValueError):
                    update.unpack(archive, dest)
                self.assertFalse(dest.exists())


if __name__ == "__main__":
    unittest.main()
