#!/usr/bin/env python3
"""CLI for managing Deus warden quality gates."""

from __future__ import annotations

import argparse
import curses
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / ".claude" / "wardens" / "config.json"
EXAMPLE_PATH = REPO_ROOT / ".claude" / "wardens" / "config.json.example"

WARDEN_DESCRIPTIONS: dict[str, str] = {
    "plan-reviewer": "Reviews plans against Deus-specific rules before source edits",
    "code-reviewer": "Reviews code changes for quality and security before commits",
    "threat-modeler": "STRIDE/OWASP threat review for auth, data, and trust boundaries",
    "architecture-snapshot": "Generates architecture overview with Mermaid diagrams",
    "session-retrospective": "Cross-session pattern analysis and retrospective reports",
    "data-quality": "Reviews auto-memory files for retrieval quality",
}

BLOCKING_WARDENS = {"plan-reviewer", "code-reviewer"}


def _use_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    if not _use_color():
        return text
    return f"\033[{code}m{text}\033[0m"


def _bold(text: str) -> str:
    return _c("1", text)


def _green(text: str) -> str:
    return _c("32", text)


def _red(text: str) -> str:
    return _c("31", text)


def _dim(text: str) -> str:
    return _c("2", text)


def _yellow(text: str) -> str:
    return _c("33", text)


# The gate hooks read only config.json, and a missing file (or key) means their
# own defaults. So this CLI never seeds config.json from the example — the
# example's `backends` would add a codex gate nothing here can pass — and every
# change writes just the one key it changes.


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        print(_red(f"Error reading {path.name}: {exc}"))
        sys.exit(1)
    return data if isinstance(data, dict) else {}


def _read_live() -> dict[str, Any]:
    """config.json as it is on disk; {} when there is none."""
    return _read_json(CONFIG_PATH) or {}


def _write_live(data: dict[str, Any]) -> None:
    if CONFIG_PATH.exists():
        stamp = time.strftime("%Y%m%d%H%M%S")
        shutil.copy2(CONFIG_PATH, CONFIG_PATH.with_name(f"{CONFIG_PATH.name}.bak-{stamp}"))
    CONFIG_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _load_config() -> dict[str, Any]:
    """What to show: every warden in the example or config.json, config.json's
    values over the example's. The example's `backends` are left out — the
    hooks never read them. Nothing is written."""
    example = _read_json(EXAMPLE_PATH) or {} if EXAMPLE_PATH.exists() else {}
    live = _read_live()
    view: dict[str, Any] = {}
    for name in [*example, *[n for n in live if n not in example]]:
        base = dict(example.get(name) or {}) if isinstance(example.get(name), dict) else {}
        base.pop("backends", None)
        entry = live.get(name)
        if entry is not None and not isinstance(entry, dict):
            print(_yellow(f"Ignoring config.json entry for {name}: not an object"))
            entry = None
        view[name] = {**base, **(entry or {})}
    return view


def _write_field(config: dict[str, Any], name: str, key: str, value: Any) -> None:
    """Set one key of one warden in config.json (read fresh) and in the view."""
    live = _read_live()
    entry = live.get(name)
    if not isinstance(entry, dict):
        entry = {}
    entry[key] = value
    live[name] = entry
    _write_live(live)
    config[name][key] = value


def _validate_name(config: dict[str, Any], name: str) -> None:
    if name not in config:
        available = ", ".join(config.keys())
        print(_red(f"Unknown warden: {name}"))
        print(f"Available: {available}")
        sys.exit(1)


def _triggers_label(warden: dict[str, Any], name: str) -> str:
    if name == "session-retrospective":
        threshold = warden.get("auto_threshold", 20)
        return f"auto (threshold: {threshold} sessions), manual"
    tools = warden.get("tools")
    if not tools:
        return "manual"
    return ", ".join(tools)


def cmd_show(config: dict[str, Any]) -> None:
    print()
    print(_bold("Wardens"))
    print()
    for name, warden in config.items():
        enabled = warden.get("enabled", True)
        tag = _green("[ON]") if enabled else _red("[OFF]")
        desc = WARDEN_DESCRIPTIONS.get(name, "")
        custom = warden.get("custom_instructions")
        if custom:
            desc += f" {_dim('(custom instructions set)')}"
        triggers = _triggers_label(warden, name)
        print(f"  {name:<24} {tag}  {desc}")
        print(f"  {'':<24}       {_dim(f'Triggers: {triggers}')}")
    print()


def cmd_enable(config: dict[str, Any], name: str) -> None:
    _validate_name(config, name)
    _write_field(config, name, "enabled", True)
    print(f"{name}: {_green('enabled')}")


def cmd_disable(config: dict[str, Any], name: str) -> None:
    _validate_name(config, name)
    if name in BLOCKING_WARDENS:
        print(
            _yellow(
                f"Warning: Disabling {name} removes a safety gate. "
                "Source edits/commits will proceed without warden review until re-enabled."
            )
        )
    _write_field(config, name, "enabled", False)
    print(f"{name}: {_red('disabled')}")


def cmd_triggers(
    config: dict[str, Any], name: str, action: str | None, value: str | None,
) -> None:
    _validate_name(config, name)
    warden = config[name]

    if action is None:
        print(f"{name} triggers: {_triggers_label(warden, name)}")
        return

    if name == "session-retrospective" and action == "threshold":
        if value is None:
            print(f"auto_threshold: {warden.get('auto_threshold', 20)}")
            return
        try:
            n = int(value)
            if n <= 0:
                raise ValueError
        except ValueError:
            print(_red("Threshold must be a positive integer"))
            sys.exit(1)
        _write_field(config, name, "auto_threshold", n)
        print(f"{name} auto_threshold: {n}")
        return

    live_entry = _read_live().get(name)
    live_tools = live_entry.get("tools") if isinstance(live_entry, dict) else None
    if isinstance(live_tools, list):
        tools = list(live_tools)
    elif name == "plan-reviewer":
        # the hook's own default, so a first `add` keeps ExitPlanMode gated
        from codex_warden_hooks import PLAN_REVIEWER_DEFAULT_TOOLS
        tools = list(PLAN_REVIEWER_DEFAULT_TOOLS)
    elif isinstance(warden.get("tools"), list):
        tools = list(warden["tools"])
    else:
        print(_red(f"{name} uses manual/auto triggers, not tool-based triggers."))
        sys.exit(1)

    if value is None:
        print(_red(f"Usage: wardens triggers {name} {action} <tool>"))
        sys.exit(1)

    if action == "add":
        if value not in tools:
            tools.append(value)
            _write_field(config, name, "tools", tools)
        print(f"{name} triggers: {', '.join(tools)}")
    elif action == "remove":
        if value not in tools:
            print(_red(f"{value} not in triggers for {name}"))
            sys.exit(1)
        tools.remove(value)
        _write_field(config, name, "tools", tools)
        print(f"{name} triggers: {', '.join(tools)}")
    else:
        print(_red(f"Unknown trigger action: {action} (use add/remove)"))
        sys.exit(1)


def cmd_reset(config: dict[str, Any], name: str) -> None:
    """Back to the hooks' own defaults: drop this warden's entry from config.json
    (its enabled, tools, backends and custom instructions)."""
    _validate_name(config, name)
    live = _read_live()
    if name not in live:
        print(f"{name} is already at defaults.")
        return
    live.pop(name)
    _write_live(live)
    print(f"Reset {name} to defaults (its settings and custom instructions were removed).")


def cmd_customize(config: dict[str, Any], name: str) -> None:
    _validate_name(config, name)
    if not shutil.which("claude"):
        print(_red("Error: 'claude' CLI not found on PATH."))
        print("Install Claude Code: https://claude.ai/claude-code")
        sys.exit(1)

    current = config[name].get("custom_instructions")
    current_note = f"Current instructions: {current}" if current else "No custom instructions set."

    prompt = (
        f"I want to set custom instructions for the {name} warden. "
        f"{current_note} "
        f"Help me write effective custom instructions for {name}, then save them to "
        f"{CONFIG_PATH} under the key [\"{name}\"][\"custom_instructions\"] "
        "(create the file if it is absent; change only that key and keep every other warden). "
        "Ask me what behavior I want to customize."
    )
    subprocess.run(["claude", "-p", prompt], check=False)


WARDEN_TYPES: dict[str, str] = {
    "plan-reviewer": "Validator (blocking)",
    "code-reviewer": "Validator (blocking)",
    "threat-modeler": "Validator (warning)",
    "architecture-snapshot": "Generator",
    "session-retrospective": "Generator",
    "data-quality": "Validator (manual)",
}


def _tui(stdscr: curses.window) -> None:
    curses.curs_set(0)
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_GREEN, -1)
    curses.init_pair(2, curses.COLOR_RED, -1)
    curses.init_pair(3, curses.COLOR_YELLOW, -1)
    curses.init_pair(4, curses.COLOR_CYAN, -1)

    config = _load_config()
    names = list(config.keys())
    cursor = 0

    while True:
        stdscr.clear()
        h, w = stdscr.getmaxyx()

        title = " Wardens "
        stdscr.addstr(0, 0, title, curses.A_BOLD | curses.A_REVERSE)
        stdscr.addstr(0, len(title), " " * max(0, w - len(title)), curses.A_REVERSE)

        row = 2
        for i, name in enumerate(names):
            warden = config[name]
            enabled = warden.get("enabled", True)
            selected = i == cursor

            if enabled:
                indicator = " ● "
                color = curses.color_pair(1)
            else:
                indicator = " ○ "
                color = curses.color_pair(2)

            attr = curses.A_REVERSE if selected else 0
            line = f"{indicator}{name:<26}"
            desc = WARDEN_DESCRIPTIONS.get(name, "")
            full = f"{line}{desc}"
            if len(full) > w:
                full = full[: w - 1]

            stdscr.addstr(row, 0, full[:3], color | attr)
            stdscr.addstr(row, 3, full[3:], attr)
            row += 1

        row += 1
        if row < h - 4:
            sel_name = names[cursor]
            sel = config[sel_name]
            stdscr.addstr(row, 0, "─" * min(60, w - 1), curses.A_DIM)
            row += 1
            wtype = WARDEN_TYPES.get(sel_name, "")
            stdscr.addstr(row, 2, f"Type: ", curses.A_DIM)
            stdscr.addstr(row, 8, wtype, curses.color_pair(4))
            row += 1
            stdscr.addstr(row, 2, f"Triggers: ", curses.A_DIM)
            stdscr.addstr(row, 12, _triggers_label(sel, sel_name))
            row += 1
            ci = sel.get("custom_instructions")
            if ci:
                label = ci if len(ci) <= w - 20 else ci[: w - 23] + "..."
                stdscr.addstr(row, 2, f"Instructions: ", curses.A_DIM)
                stdscr.addstr(row, 16, label)
                row += 1

        footer_row = h - 1
        footer = " ↑↓ navigate  ⎵ toggle  q quit "
        try:
            stdscr.addstr(footer_row, 0, " " * (w - 1), curses.A_REVERSE)
            stdscr.addstr(footer_row, 0, footer[: w - 1], curses.A_REVERSE)
        except curses.error:
            pass

        stdscr.refresh()
        key = stdscr.getch()

        if key in (ord("q"), ord("Q"), 27):
            break
        elif key == curses.KEY_UP and cursor > 0:
            cursor -= 1
        elif key == curses.KEY_DOWN and cursor < len(names) - 1:
            cursor += 1
        elif key in (ord(" "), ord("\n"), curses.KEY_ENTER, 10, 13):
            name = names[cursor]
            _write_field(config, name, "enabled", not config[name].get("enabled", True))


def cmd_interactive() -> None:
    curses.wrapper(_tui)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Manage Deus warden quality gates",
        prog="wardens",
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("show", help="Show all wardens with status")
    p_enable = sub.add_parser("enable", help="Enable a warden")
    p_enable.add_argument("name")
    p_disable = sub.add_parser("disable", help="Disable a warden")
    p_disable.add_argument("name")

    p_triggers = sub.add_parser("triggers", help="View/modify warden triggers")
    p_triggers.add_argument("name")
    p_triggers.add_argument("action", nargs="?", help="add, remove, or threshold")
    p_triggers.add_argument("value", nargs="?", help="tool name or threshold value")

    p_reset = sub.add_parser("reset", help="Reset a warden to defaults")
    p_reset.add_argument("name")

    p_customize = sub.add_parser("customize", help="Launch Claude to set custom instructions")
    p_customize.add_argument("name")

    args = parser.parse_args(argv)
    config = _load_config()

    if args.command is None and sys.stdin.isatty() and sys.stdout.isatty():
        cmd_interactive()
        return 0
    elif args.command is None or args.command == "show":
        cmd_show(config)
    elif args.command == "enable":
        cmd_enable(config, args.name)
    elif args.command == "disable":
        cmd_disable(config, args.name)
    elif args.command == "triggers":
        cmd_triggers(config, args.name, args.action, args.value)
    elif args.command == "reset":
        cmd_reset(config, args.name)
    elif args.command == "customize":
        cmd_customize(config, args.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
