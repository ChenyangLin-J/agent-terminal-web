#!/usr/bin/env python3

import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


def main():
    raw_event = sys.argv[-1] if len(sys.argv) > 1 else ""
    config = read_config()
    run_chained_notification(config.get("chain"), raw_event)

    try:
        event = json.loads(raw_event)
    except (TypeError, ValueError):
        return
    if event.get("type") != "agent-turn-complete":
        return

    url = str(config.get("url") or "").strip()
    token = str(config.get("token") or "").strip()
    if not allowed_url(url) or len(token) < 32:
        return

    request = urllib.request.Request(
        url,
        data=json.dumps(event, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "agent-web-remote-notify/1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8):
            pass
    except Exception:
        # Completion notifications must never interfere with the Codex turn.
        pass


def read_config():
    configured = os.environ.get("AGENT_REMOTE_NOTIFY_CONFIG", "")
    path = Path(configured).expanduser() if configured else Path.home() / ".config" / "agent-web" / "remote-notify.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def run_chained_notification(value, raw_event):
    if not raw_event or not isinstance(value, list):
        return
    command = [str(item) for item in value if str(item)]
    if not command:
        return
    executable = command[0] if Path(command[0]).is_absolute() else shutil.which(command[0])
    if not executable:
        return
    command[0] = executable
    try:
        subprocess.Popen(
            [*command, raw_event],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass


def allowed_url(value):
    return value.startswith("https://") or value.startswith("http://127.0.0.1:")


if __name__ == "__main__":
    main()
