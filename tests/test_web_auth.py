import asyncio
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "pi/looper_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AuthTest(unittest.TestCase):
    def test_missing_credentials_does_not_disable_auth(self):
        with patch.object(bridge, "conf_value", return_value="1"), patch.object(bridge.WebAuth, "creds", return_value=None):
            self.assertTrue(bridge.WebAuth().enabled())

    def test_remote_missing_credentials_rejected_including_websocket(self):
        server = bridge.Server(None, "", "", None, None)
        replies = []
        async def respond(*args, **kwargs):
            replies.append(args)
        server._json = respond
        server._respond = respond
        with patch.object(server.auth, "creds", return_value=None), patch.object(server.auth, "enabled", return_value=True):
            for path in ("/", "/setup", "/api/status", "/ws", "/midi", "/api/admin/set-password"):
                asyncio.run(server.route(None, None, "GET", path, {}, b"", "192.0.2.1:123"))
                self.assertIn(replies[-1][-1], ("409 Conflict", ["Location: /claim"]))

    def test_local_health_is_available_without_credentials(self):
        server = bridge.Server(None, "", "", None, None)
        replies = []
        async def respond(*args, **kwargs):
            replies.append(args)
        server._json = respond
        asyncio.run(server.route(None, None, "GET", "/api/health", {}, b"", "127.0.0.1:123"))
        self.assertEqual(replies[-1][1], {"ok": True})


if __name__ == "__main__":
    unittest.main()
