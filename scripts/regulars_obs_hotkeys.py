"""OBS Studio frontend hotkeys for a paired local Regulars browser dock.

Load through OBS Tools > Scripts. Python must be configured in OBS's Python
Settings first. This is an OBS script, not a command-line background service.
Official API: https://docs.obsproject.com/scripting
"""

import json
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import obspython as obs

_endpoint = ""
_token = ""
_commands = queue.Queue(maxsize=8)
_stop = threading.Event()
_worker_thread = None
_error = ""
_hotkeys = []
_held = {}
_HOLD_SECONDS = 0.6


def script_description():
    return ("<b>Regulars dock hotkeys</b><br>"
            "1. Open Regulars Settings → OBS hotkeys and copy the endpoint and pairing token here.<br>"
            "2. Keep Regulars open as an OBS Custom Browser Dock.<br>"
            "3. Tap F7 / F8 to move between subjects or people; hold either for 0.6 seconds "
            "to switch Chat / Community. F9 dismisses the current message or private reminder.<br>"
            "Bindings can be changed under OBS Settings → Hotkeys. Avoid game/OBS key conflicts; "
            "OBS must allow hotkeys while another app is focused.<br>"
            "Python must first be configured in Tools → Scripts → Python Settings. "
            "Pairing survives Regulars restarts; reopen the dock after a server restart. "
            "No Twitch messages are deleted by these shortcuts.")


def script_defaults(settings):
    obs.obs_data_set_default_string(settings, "endpoint", "http://127.0.0.1:3000/api/dock/hotkey")


def script_properties():
    props = obs.obs_properties_create()
    obs.obs_properties_add_text(props, "endpoint", "Local endpoint", obs.OBS_TEXT_DEFAULT)
    obs.obs_properties_add_text(props, "token", "Pairing token", obs.OBS_TEXT_PASSWORD)
    return props


def _valid_endpoint(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        return (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
                and parsed.port is not None and 1 <= parsed.port <= 65535
                and parsed.path == "/api/dock/hotkey" and not parsed.query
                and not parsed.fragment and not parsed.username and not parsed.password)
    except ValueError:
        return False


def script_update(settings):
    global _endpoint, _token
    value = obs.obs_data_get_string(settings, "endpoint").strip()
    token = obs.obs_data_get_string(settings, "token").strip()
    _endpoint = value if _valid_endpoint(value) else ""
    _token = token if re.fullmatch(r"[a-f0-9]{64}", token) else ""


def _enqueue(command, pressed):
    global _error
    if not pressed:
        return
    if not _endpoint or not _token:
        _error = "Regulars: enter the endpoint and pairing token from the dock's Settings."
        return
    try:
        # Do not retry or retain old F9 presses after a connection failure.
        _commands.put_nowait((time.monotonic(), command, _endpoint, _token))
    except queue.Full:
        _error = "Regulars: hotkey queue is full; wait for the local dock to respond."


def _navigation(command, pressed):
    if pressed:
        # OBS may repeat key-down callbacks; retain the original press time.
        if command not in _held:
            _held[command] = [time.monotonic(), False]
        return
    state = _held.pop(command, None)
    if state is not None and not state[1]:
        # A release can arrive between timer ticks at the hold boundary.
        _enqueue("toggle_section" if time.monotonic() - state[0] >= _HOLD_SECONDS else command, True)


def _poll_holds():
    now = time.monotonic()
    for state in _held.values():
        if not state[1] and now - state[0] >= _HOLD_SECONDS:
            state[1] = True
            _enqueue("toggle_section", True)


def _previous(pressed):
    _navigation("prev_subject", pressed)


def _next(pressed):
    _navigation("next_subject", pressed)


def _dismiss(pressed):
    _enqueue("dismiss_message", pressed)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _worker():
    global _error
    # Ignore proxy settings: the credential only ever travels to loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    while not _stop.is_set():
        try:
            created, command, endpoint, token = _commands.get(timeout=0.1)
        except queue.Empty:
            continue
        if _stop.is_set() or time.monotonic() - created > 1:
            continue
        request = urllib.request.Request(endpoint,
            data=json.dumps({"command": command}).encode("utf-8"),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST")
        try:
            with opener.open(request, timeout=0.8) as response:
                response.read(512)
        except (OSError, urllib.error.URLError, ValueError):
            # Never log the request URL, headers, or token.
            _error = "Regulars: hotkey was not confirmed. Check the server, dock, and pairing settings."


def _report_error():
    global _error
    if _error:
        error, _error = _error, ""
        obs.script_log(obs.LOG_WARNING, error)


def _load_binding(settings, name, key, callback):
    hotkey = obs.obs_hotkey_register_frontend(name, "Regulars: " + {
        "prev_subject": "previous item / hold to switch section", "next_subject": "next item / hold to switch section",
        "dismiss_message": "answer / skip item"}[name.rsplit(".", 1)[-1]], callback)
    if obs.obs_data_has_user_value(settings, name):
        bindings = obs.obs_data_get_array(settings, name)
    else:
        default = obs.obs_data_create_from_json(json.dumps({"bindings": [{"key": key}]}))
        bindings = obs.obs_data_get_array(default, "bindings")
        obs.obs_data_release(default)
    if bindings is not None:
        obs.obs_hotkey_load(hotkey, bindings)
        obs.obs_data_array_release(bindings)
    _hotkeys.append((name, hotkey, callback))


def script_load(settings):
    global _worker_thread
    script_update(settings)
    _stop.clear()
    _load_binding(settings, "regulars.prev_subject", "OBS_KEY_F7", _previous)
    _load_binding(settings, "regulars.next_subject", "OBS_KEY_F8", _next)
    _load_binding(settings, "regulars.dismiss_message", "OBS_KEY_F9", _dismiss)
    _worker_thread = threading.Thread(target=_worker, name="RegularsHotkeys", daemon=True)
    _worker_thread.start()
    obs.timer_add(_report_error, 1000)
    obs.timer_add(_poll_holds, 25)


def script_save(settings):
    for name, hotkey, _ in _hotkeys:
        bindings = obs.obs_hotkey_save(hotkey)
        if bindings is not None:
            obs.obs_data_set_array(settings, name, bindings)
            obs.obs_data_array_release(bindings)


def script_unload():
    _held.clear()
    obs.timer_remove(_poll_holds)
    _stop.set()
    if _worker_thread is not None:
        _worker_thread.join(timeout=1.2)
    obs.timer_remove(_report_error)
    for _, _, callback in _hotkeys:
        obs.obs_hotkey_unregister(callback)
    _hotkeys.clear()
