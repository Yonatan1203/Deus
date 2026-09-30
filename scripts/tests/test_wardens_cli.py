"""scripts/wardens.py never seeds config.json from the example and writes only
the key it changes (#79). The gate hooks read only config.json, so a copied
example would add its codex `gpt` backend to every commit's gate."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = str(Path(__file__).resolve().parent.parent)
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

import wardens as w  # noqa: E402
from codex_warden_hooks import PLAN_REVIEWER_DEFAULT_TOOLS  # noqa: E402

EXAMPLE = {
    "plan-reviewer": {"enabled": True, "tools": ["Edit", "Write"], "custom_instructions": None},
    "code-reviewer": {"enabled": True, "tools": ["Bash"], "backends": ["claude", "gpt"]},
    "session-retrospective": {"enabled": True, "auto_threshold": 20},
    "architecture-snapshot": {"enabled": True},
}


@pytest.fixture
def paths(tmp_path, monkeypatch):
    cfg = tmp_path / "config.json"
    ex = tmp_path / "config.json.example"
    ex.write_text(json.dumps(EXAMPLE))
    monkeypatch.setattr(w, "CONFIG_PATH", cfg)
    monkeypatch.setattr(w, "EXAMPLE_PATH", ex)
    return cfg


def live(cfg: Path):
    return json.loads(cfg.read_text())


def test_show_writes_nothing(paths, capsys):
    assert w.main(["show"]) == 0
    assert not paths.exists()
    out = capsys.readouterr().out
    assert "code-reviewer" in out and "plan-reviewer" in out


def test_view_never_has_the_example_backends(paths):
    assert "backends" not in w._load_config()["code-reviewer"]
    paths.write_text(json.dumps({"code-reviewer": {"backends": ["claude"]}}))
    assert w._load_config()["code-reviewer"]["backends"] == ["claude"]


def test_disable_writes_only_that_key(paths):
    w.main(["disable", "plan-reviewer"])
    assert live(paths) == {"plan-reviewer": {"enabled": False}}
    assert "gpt" not in paths.read_text()


def test_toggling_back_writes_the_start_value(paths):
    w.main(["disable", "plan-reviewer"])
    w.main(["enable", "plan-reviewer"])
    assert live(paths) == {"plan-reviewer": {"enabled": True}}


def test_other_roles_and_fields_are_kept(paths):
    paths.write_text(json.dumps({
        "code-reviewer": {"backends": ["claude"], "custom_instructions": "x"},
        "admin-merge-gate": {"standing_grant": True},
    }))
    w.main(["disable", "code-reviewer"])
    assert live(paths) == {
        "code-reviewer": {"backends": ["claude"], "custom_instructions": "x", "enabled": False},
        "admin-merge-gate": {"standing_grant": True},
    }
    assert list(paths.parent.glob("config.json.bak-*"))


def test_first_trigger_add_keeps_the_hook_default(paths):
    w.main(["triggers", "plan-reviewer", "add", "NotebookEdit"])
    tools = live(paths)["plan-reviewer"]["tools"]
    assert tools == [*PLAN_REVIEWER_DEFAULT_TOOLS, "NotebookEdit"]
    assert "ExitPlanMode" in tools
    w.main(["triggers", "plan-reviewer", "remove", "Write"])
    assert "Write" not in live(paths)["plan-reviewer"]["tools"]
    assert set(live(paths)) == {"plan-reviewer"}


def test_trigger_add_for_other_roles_starts_from_the_view(paths):
    w.main(["triggers", "code-reviewer", "add", "Edit"])
    assert live(paths) == {"code-reviewer": {"tools": ["Bash", "Edit"]}}


def test_threshold_writes_only_that_key(paths):
    w.main(["triggers", "session-retrospective", "threshold", "5"])
    assert live(paths) == {"session-retrospective": {"auto_threshold": 5}}


def test_manual_roles_still_refuse_tools(paths):
    with pytest.raises(SystemExit) as e:
        w.main(["triggers", "architecture-snapshot", "add", "Edit"])
    assert e.value.code == 1
    assert not paths.exists()


def test_reset_removes_the_entry_and_never_writes_backends(paths, capsys):
    paths.write_text(json.dumps({"code-reviewer": {"enabled": False}, "plan-reviewer": {"enabled": False}}))
    w.main(["reset", "code-reviewer"])
    assert live(paths) == {"plan-reviewer": {"enabled": False}}
    assert "backends" not in paths.read_text()


def test_reset_with_no_entry_writes_nothing(paths, capsys):
    w.main(["reset", "code-reviewer"])
    assert not paths.exists()
    assert "already at defaults" in capsys.readouterr().out


def test_reset_a_role_that_is_only_in_config(paths):
    paths.write_text(json.dumps({"admin-merge-gate": {"standing_grant": True}}))
    w.main(["reset", "admin-merge-gate"])
    assert live(paths) == {}


def test_a_non_object_entry_is_ignored_then_replaced(paths, capsys):
    paths.write_text(json.dumps({"plan-reviewer": "oops"}))
    assert w._load_config()["plan-reviewer"]["tools"] == ["Edit", "Write"]
    w.main(["disable", "plan-reviewer"])
    assert live(paths) == {"plan-reviewer": {"enabled": False}}


def test_malformed_config_exits(paths):
    paths.write_text("{nope")
    with pytest.raises(SystemExit) as e:
        w.main(["show"])
    assert e.value.code == 1


def test_unknown_warden_exits(paths):
    with pytest.raises(SystemExit) as e:
        w.main(["enable", "nobody"])
    assert e.value.code == 1
    assert not paths.exists()


def test_no_example_still_works(paths, tmp_path, monkeypatch):
    monkeypatch.setattr(w, "EXAMPLE_PATH", tmp_path / "missing.example")
    paths.write_text(json.dumps({"plan-reviewer": {"enabled": True}}))
    assert w.main(["show"]) == 0


def test_the_example_shows_the_hooks_real_plan_reviewer_tools():
    """The example is what every warden list shows; it must match what the gate
    actually uses when config.json names no tools (#81)."""
    example = Path(_SCRIPTS).parent / ".claude" / "wardens" / "config.json.example"
    assert json.loads(example.read_text())["plan-reviewer"]["tools"] == PLAN_REVIEWER_DEFAULT_TOOLS
