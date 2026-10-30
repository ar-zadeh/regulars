"""Run with: python -m unittest discover -s test -p obs_hotkeys_test.py

Tests the OBS script through a fake native API; no OBS installation is required.
"""
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch


class FakeOBS(types.ModuleType):
    OBS_TEXT_DEFAULT = 0
    OBS_TEXT_PASSWORD = 1
    LOG_WARNING = 2

    def __init__(self):
        super().__init__("obspython")
        self.callbacks = []
        self.loaded = []
        self.unregistered = []
        self.timers = {}

    def obs_data_get_string(self, settings, key):
        return settings.get(key, "")

    def obs_data_has_user_value(self, settings, key):
        return key in settings

    def obs_hotkey_register_frontend(self, name, label, callback):
        self.callbacks.append(callback)
        return len(self.callbacks)

    def obs_data_create_from_json(self, value):
        return json.loads(value)

    def obs_data_get_array(self, settings, name):
        return settings.get(name)

    def obs_data_release(self, value):
        pass

    def obs_data_array_release(self, value):
        pass

    def obs_hotkey_load(self, hotkey, bindings):
        self.loaded.append((hotkey, bindings))

    def timer_add(self, callback, interval):
        self.timers[callback] = interval

    def timer_remove(self, callback):
        self.timers.pop(callback, None)

    def obs_hotkey_unregister(self, callback):
        self.unregistered.append(callback)


class OBSHotkeyTests(unittest.TestCase):
    def setUp(self):
        self.obs = FakeOBS()
        spec = importlib.util.spec_from_file_location("regulars_obs_test", Path(__file__).parents[1] / "scripts/regulars_obs_hotkeys.py")
        self.script = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"obspython": self.obs}):
            spec.loader.exec_module(self.script)
        self.settings = {"endpoint": "http://127.0.0.1:3000/api/dock/hotkey", "token": "a" * 64}

    def tearDown(self):
        self.script.script_unload()

    def test_endpoint_never_sends_pairing_token_to_other_destinations(self):
        self.assertTrue(self.script._valid_endpoint(self.settings["endpoint"]))
        for value in ["https://127.0.0.1:3000/api/dock/hotkey", "http://example.com:3000/api/dock/hotkey",
                      "http://127.0.0.1:3000/other", "http://user@127.0.0.1:3000/api/dock/hotkey",
                      "http://127.0.0.1:3000/api/dock/hotkey?token=secret", "http://127.0.0.1/api/dock/hotkey"]:
            self.assertFalse(self.script._valid_endpoint(value), value)
        self.assertIsNone(self.script._NoRedirect().redirect_request(None, None, 302, "", {}, "http://example.com"))

    def test_registered_hotkeys_send_taps_on_release_without_blocking_obs(self):
        requests = []
        done = threading.Event()

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b"{}"

        class Opener:
            def open(inner, request, timeout):
                requests.append(request)
                if len(requests) == 3: done.set()
                return Response()

        with patch.object(self.script.urllib.request, "build_opener", return_value=Opener()):
            self.script.script_load(self.settings)
            self.assertEqual([bindings[0]["key"] for _, bindings in self.obs.loaded], ["OBS_KEY_F7", "OBS_KEY_F8", "OBS_KEY_F9"])
            for callback in self.obs.callbacks:
                callback(False)
                callback(True)
                callback(False)
            self.assertTrue(done.wait(2))
        self.assertEqual([json.loads(request.data)["command"] for request in requests], ["prev_subject", "next_subject", "dismiss_message"])
        self.assertTrue(all(request.full_url == self.settings["endpoint"] for request in requests))
        self.script.script_unload()
        self.assertEqual(self.obs.unregistered, self.obs.callbacks)

    def test_navigation_taps_hold_repeat_and_release(self):
        self.script.script_update(self.settings)
        for callback, command in [(self.script._previous, "prev_subject"),
                                  (self.script._next, "next_subject")]:
            with self.subTest(command=command), patch.object(self.script.time, "monotonic") as now:
                now.return_value = 10
                callback(False)  # A stray release is harmless.
                callback(True)
                callback(True)
                self.assertTrue(self.script._commands.empty())
                now.return_value = 10.2
                callback(False)
                self.assertEqual(self.script._commands.get_nowait()[1], command)
                callback(False)
                self.assertTrue(self.script._commands.empty())
                now.return_value = 20
                callback(True)
                now.return_value = 20.4
                callback(True)
                self.script._poll_holds()
                self.assertTrue(self.script._commands.empty())
                now.return_value = 20.61
                self.script._poll_holds()
                self.assertEqual(self.script._commands.get_nowait()[1], "toggle_section")
                callback(True)
                now.return_value = 21
                self.script._poll_holds()
                callback(False)
                self.assertTrue(self.script._commands.empty())

    def test_release_after_threshold_and_unload_cancel_pending_hold(self):
        self.script.script_update(self.settings)
        with patch.object(self.script.time, "monotonic") as now:
            now.return_value = 10
            self.script._previous(True)
            now.return_value = 10.61
            self.script._previous(False)
            self.assertEqual(self.script._commands.get_nowait()[1], "toggle_section")
            self.script._next(True)
            self.script.script_unload()
            now.return_value = 12
            self.script._poll_holds()
            self.script._next(False)
            self.assertTrue(self.script._commands.empty())
            self.assertNotIn(self.script._poll_holds, self.obs.timers)

    def test_explicitly_unbound_keys_stay_unbound_and_old_commands_are_not_sent(self):
        settings = {**self.settings, "regulars.prev_subject": []}
        self.script._load_binding(settings, "regulars.prev_subject", "OBS_KEY_F7", self.script._previous)
        self.assertEqual(self.obs.loaded[0][1], [])
        self.script._commands.put((time.monotonic() - 2, "dismiss_message", self.settings["endpoint"], self.settings["token"]))
        calls = []
        class Opener:
            def open(inner, request, timeout): calls.append(request)
        with patch.object(self.script.urllib.request, "build_opener", return_value=Opener()):
            thread = threading.Thread(target=self.script._worker)
            thread.start()
            time.sleep(0.15)
            self.script._stop.set()
            thread.join(1)
        self.assertEqual(calls, [])

    def test_hotkey_queue_is_bounded_and_never_contains_credentials_without_pairing(self):
        self.script._dismiss(True)
        self.assertTrue(self.script._commands.empty())
        self.script.script_update(self.settings)
        for _ in range(20): self.script._dismiss(True)
        self.assertEqual(self.script._commands.qsize(), 8)
        self.assertNotIn(self.settings["token"], self.script._error)


if __name__ == "__main__":
    unittest.main()
