"""The optional GPT second opinion for review wardens (#78): the OpenAI key is bound to
api.openai.com, nothing credential-shaped is sent, every call is logged and capped, and the
settings load only for this backend. The network seam is mocked; no real HTTP."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import codex_warden as cw
import codex_warden_hooks as h
import cogate
from _exit_codes import SUCCESS
from warden_review.backends import openai_compat as oac
from warden_review.backends.base import ReviewRequest
from warden_review.backends.glm import GLMBackend
from warden_review.secret_scan import PATTERNS, find_secret

_REPO = Path(_SCRIPTS_DIR).parent
_OPENAI = "https://api.openai.com/v1"
_KEY = "sk-" + "a" * 40  # shaped like a key, but only ever passed as the key itself


def _body(verdict="SHIP", finish="stop", usage=None):
    content = json.dumps({"verdict": verdict, "summary": "ok", "results": []})
    b = {"choices": [{"message": {"content": content}, "finish_reason": finish}]}
    if usage:
        b["usage"] = usage
    return b


def _req(content="diff --git a/x b/x\n+ok = 1\n", **kw):
    kw.setdefault("rules_path", "/nonexistent-rules.md")
    return ReviewRequest(role="code-reviewer", content=content, cwd="/r", **kw)


@pytest.fixture
def openai_env(monkeypatch):
    monkeypatch.setenv("WARDEN_OPENAI_COMPAT_BASE_URL", _OPENAI)
    monkeypatch.setenv("WARDEN_OPENAI_COMPAT_MODEL", "gpt-4.1-nano")
    monkeypatch.delenv("WARDEN_OPENAI_COMPAT_API_KEY", raising=False)
    monkeypatch.delenv("WARDEN_OPENAI_COMPAT_MAX_TOKENS", raising=False)
    monkeypatch.delenv("WARDEN_OPENAI_COMPAT_MAX_CALLS_PER_DAY", raising=False)


class _Spy:
    def __init__(self, body=None, status=200):
        self.calls: list[tuple] = []
        self.body = body or _body()
        self.status = status

    def __call__(self, endpoint, payload, headers, timeout):
        self.calls.append((endpoint, payload, headers))
        return self.status, self.body


def _log_lines():
    p = Path(os.environ["DEUS_WARDEN_CALL_LOG"])
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


# ── secret scan ──────────────────────────────────────────────────────────────────────

_SAMPLES = {
    "OpenAI-style key": "sk-proj-" + "A1b2" * 8,
    "Stripe key": "sk_live_" + "a1B2" * 6,
    "GitHub token": "ghp_" + "a1B2" * 9,
    "GitHub fine-grained token": "github_pat_" + "a1B2_" * 10,
    "GitLab token": "glpat-" + "a1B2" * 6,
    "Slack token": "xoxb-1234567890-abcdefghij",
    "Google API key": "AIza" + "a" * 35,
    "Google OAuth access token": "ya29." + "a1B2" * 6,
    "Google OAuth client secret": "GOCSPX-" + "a1B2" * 6,
    "AWS access key": "AKIA" + "ABCDEFGHIJKLMNOP",
    "JWT": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "Google refresh token": "1//" + "a1B2" * 9,
    "Telegram bot token": "123456789:" + "a" * 35,
    "Discord bot token": "M" + "a" * 23 + ".abcdef." + "b" * 27,
    "password in a URL": "https://user:hunter2hunter2@example.com/x",
    "private key": "-----BEGIN RSA PRIVATE KEY-----",
    "key/token/secret/password assignment": "API_KEY = 'abcdefghijklmnop1234'",
}


def test_every_pattern_has_a_sample_that_hits():
    assert set(_SAMPLES) == {name for name, _ in PATTERNS}
    for name, sample in _SAMPLES.items():
        assert find_secret(f"+ x = {sample}\n") == name, name


def test_ordinary_words_do_not_trip_it():
    clean = ("## task-granularity\nrisk-level: disk-usage\nurl = 'v1//path'\nsk-1\n"
             "desk-" + "a" * 26 + " mask-" + "b" * 26 + "\ntoken = short\n")
    assert find_secret(clean) is None


@pytest.mark.parametrize("rules", ["code-review-rules.md", "ai-engineering-rules.md"])
def test_the_two_roles_rules_text_is_clean(rules):
    from codex_review import build_rules_digest
    assert find_secret(build_rules_digest(_REPO / ".claude" / "wardens" / rules)) is None


# ── key bound to api.openai.com ─────────────────────────────────────────────────────

@pytest.mark.parametrize("url,ok", [
    ("https://api.openai.com/v1", True),
    ("https://api.openai.com:443/v1", True),
    ("http://api.openai.com/v1", False),
    ("https://api.openai.com.evil.tld/v1", False),
    ("https://u:p@api.openai.com/v1", False),
    ("https://api.openai.com:8443/v1", False),
    ("https://openrouter.ai/api/v1", False),
])
def test_is_openai_api(url, ok):
    assert oac._is_openai_api(url) is ok


def test_key_is_sent_to_openai_and_the_request_is_shaped(monkeypatch, openai_env):
    spy = _Spy(_body(usage={"prompt_tokens": 30000, "completion_tokens": 1000}))
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    v = oac.OpenAICompatBackend().review(_req(api_key=_KEY))
    assert v.verdict == "SHIP"
    endpoint, payload, headers = spy.calls[0]
    assert endpoint == f"{_OPENAI}/chat/completions"
    assert headers["Authorization"] == f"Bearer {_KEY}"
    assert payload["max_tokens"] == 4000 and payload["model"] == "gpt-4.1-nano"
    (line,) = _log_lines()
    assert line["sent"] is True and line["outcome"] == "SHIP"
    assert line["tokens"] == {"in": 30000, "out": 1000}
    assert line["cost_usd"] == pytest.approx(0.0034)
    assert _KEY not in json.dumps(line)
    assert oct(Path(os.environ["DEUS_WARDEN_CALL_LOG"]).stat().st_mode & 0o777) == "0o600"


@pytest.mark.parametrize("url", ["http://api.openai.com/v1", "https://api.openai.com.evil.tld/v1",
                                 "https://u:p@api.openai.com/v1", "http://127.0.0.1:8080/v1"])
def test_handed_over_key_never_goes_elsewhere(monkeypatch, openai_env, url):
    monkeypatch.setenv("WARDEN_OPENAI_COMPAT_BASE_URL", url)
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    oac.OpenAICompatBackend().review(_req(api_key=_KEY))
    for _, _, headers in spy.calls:
        assert "Authorization" not in headers


def test_openai_without_a_key_does_not_call(monkeypatch, openai_env):
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    v = oac.OpenAICompatBackend().review(_req())
    assert v.could_not_run and not spy.calls
    assert _log_lines()[0]["skipped"] == "no key"


def test_glm_never_uses_the_openai_key(monkeypatch):
    monkeypatch.setenv("WARDEN_GLM_BASE_URL", _OPENAI)  # even pointed at OpenAI
    monkeypatch.delenv("WARDEN_GLM_API_KEY", raising=False)
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    v = GLMBackend().review(_req(api_key=_KEY))
    assert v.could_not_run and not spy.calls


def test_key_is_not_in_the_request_repr():
    assert "sk-" not in repr(_req(api_key=_KEY))


# ── nothing credential-shaped leaves ────────────────────────────────────────────────

def test_a_key_in_the_diff_is_not_sent(monkeypatch, openai_env):
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    secret = _SAMPLES["GitHub token"]
    v = oac.OpenAICompatBackend().review(_req(content=f"+token = '{secret}'\n", api_key=_KEY))
    assert v.could_not_run and not spy.calls
    assert "GitHub token" in v.error and secret not in v.error
    assert secret not in json.dumps(_log_lines())


def test_a_key_in_the_rules_text_is_not_sent(monkeypatch, openai_env, tmp_path):
    rules = tmp_path / "rules.md"
    rules.write_text("# rules\n\nExample: " + _SAMPLES["GitHub token"] + "\n")
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    v = oac.OpenAICompatBackend().review(_req(rules_path=str(rules), api_key=_KEY))
    assert v.could_not_run and not spy.calls


def test_a_key_in_the_cross_context_is_not_sent(monkeypatch, openai_env):
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    v = oac.OpenAICompatBackend().review(
        _req(cross_context="earlier: " + _SAMPLES["AWS access key"], api_key=_KEY))
    assert v.could_not_run and not spy.calls


def test_a_broken_scan_does_not_send(monkeypatch, openai_env):
    def boom(*a):
        raise RuntimeError("regex engine exploded")
    monkeypatch.setattr(oac, "find_secret", boom)
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    v = oac.OpenAICompatBackend().review(_req(api_key=_KEY))
    assert v.could_not_run and not spy.calls


def test_real_rules_and_a_clean_diff_are_sent(monkeypatch, openai_env):
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    rules = str(_REPO / ".claude" / "wardens" / "code-review-rules.md")
    v = oac.OpenAICompatBackend().review(_req(rules_path=rules, api_key=_KEY))
    assert v.verdict == "SHIP" and len(spy.calls) == 1


# ── cap, truncation ─────────────────────────────────────────────────────────────────

def test_daily_cap(monkeypatch, openai_env):
    monkeypatch.setenv("WARDEN_OPENAI_COMPAT_MAX_CALLS_PER_DAY", "2")
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    b = oac.OpenAICompatBackend()
    assert [b.review(_req(api_key=_KEY)).verdict for _ in range(3)] == \
        ["SHIP", "SHIP", "COULD_NOT_RUN"]
    assert len(spy.calls) == 2
    assert _log_lines()[-1]["skipped"] == "daily cap"


def test_a_truncated_reply_is_never_a_verdict(monkeypatch, openai_env):
    # Even when the cut-off JSON happens to parse.
    monkeypatch.setattr(oac, "_post_chat_completion", _Spy(_body("SHIP", finish="length")))
    v = oac.OpenAICompatBackend().review(_req(api_key=_KEY))
    assert v.could_not_run
    assert _log_lines()[0]["outcome"] == "truncated"


def test_the_cap_counts_only_today_and_this_backend(monkeypatch, openai_env):
    monkeypatch.setenv("WARDEN_OPENAI_COMPAT_MAX_CALLS_PER_DAY", "1")
    log = Path(os.environ["DEUS_WARDEN_CALL_LOG"])
    log.write_text(
        json.dumps({"day": "2000-01-01", "backend": "openai_compat", "sent": True}) + "\n"
        + json.dumps({"day": oac.time.strftime("%Y-%m-%d", oac.time.gmtime()),
                      "backend": "glm", "sent": True}) + "\n")
    spy = _Spy()
    monkeypatch.setattr(oac, "_post_chat_completion", spy)
    assert oac.OpenAICompatBackend().review(_req(api_key=_KEY)).verdict == "SHIP"
    assert oac.OpenAICompatBackend().review(_req(api_key=_KEY)).could_not_run
    assert len(spy.calls) == 1


def test_an_unexpected_send_error_is_logged_and_not_raised(monkeypatch, openai_env):
    def boom(*a):
        raise RuntimeError("socket gone")
    monkeypatch.setattr(oac, "_post_chat_completion", boom)
    v = oac.OpenAICompatBackend().review(_req(api_key=_KEY))
    assert v.could_not_run
    line = _log_lines()[0]
    assert line["sent"] is True and line["outcome"] == "connection error"


def test_a_provider_error_never_echoes_a_key(monkeypatch, openai_env):
    body = {"error": {"message": "Incorrect API key provided: sk-proj-****abcd. Also "
                                 + _SAMPLES["GitHub token"]}}
    monkeypatch.setattr(oac, "_post_chat_completion", _Spy(body, status=401))
    v = oac.OpenAICompatBackend().review(_req(api_key=_KEY))
    assert v.could_not_run and "abcd" not in v.error
    assert _SAMPLES["GitHub token"] not in v.error


def test_loader_reads_export_lines(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text(f"export OPENAI_API_KEY={_KEY}\nexport WARDEN_OPENAI_COMPAT_MODEL=m\n")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("WARDEN_OPENAI_COMPAT_MODEL", raising=False)
    assert cw._load_openai_compat_env(env) == _KEY
    assert os.environ["WARDEN_OPENAI_COMPAT_MODEL"] == "m"


# ── settings load only for this backend; the key is never exported ──────────────────

def test_loader_loads_only_its_settings_and_does_not_export_the_key(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text(f"OPENAI_API_KEY={_KEY}\nWARDEN_OPENAI_COMPAT_BASE_URL={_OPENAI}\n"
                   "WARDEN_OPENAI_COMPAT_MODEL=gpt-4.1-nano\nANTHROPIC_API_KEY=x\n"
                   "OPENAI_BASE_URL=https://elsewhere\n")
    for k in ("OPENAI_API_KEY", "WARDEN_OPENAI_COMPAT_BASE_URL", "WARDEN_OPENAI_COMPAT_MODEL",
              "ANTHROPIC_API_KEY", "OPENAI_BASE_URL"):
        monkeypatch.delenv(k, raising=False)
    assert cw._load_openai_compat_env(env) == _KEY
    assert os.environ["WARDEN_OPENAI_COMPAT_BASE_URL"] == _OPENAI
    assert "OPENAI_API_KEY" not in os.environ
    assert "ANTHROPIC_API_KEY" not in os.environ and "OPENAI_BASE_URL" not in os.environ


def test_loader_keeps_exported_values(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("WARDEN_OPENAI_COMPAT_MODEL=from-file\nOPENAI_API_KEY=from-file\n")
    monkeypatch.setenv("WARDEN_OPENAI_COMPAT_MODEL", "exported")
    monkeypatch.setenv("OPENAI_API_KEY", "exported-key")
    assert cw._load_openai_compat_env(env) == "exported-key"
    assert os.environ["WARDEN_OPENAI_COMPAT_MODEL"] == "exported"


def test_run_review_loads_it_only_for_openai_compat(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(cw, "_load_openai_compat_env", lambda *a: seen.append(1) or _KEY)
    captured = {}

    class _B:
        def review(self, req):
            captured["key"] = req.api_key
            return oac.Verdict("SHIP")

    monkeypatch.setattr(cw.registry, "get_backend", lambda b: _B())
    monkeypatch.setattr(cw.registry, "is_registered", lambda b: True)
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "f.txt").write_text("x\n")
    diff = tmp_path / "d.diff"
    diff.write_text("diff --git a/f.txt b/f.txt\n+x\n")
    for backend, expect_key in (("glm", None), ("openai_compat", _KEY)):
        seen.clear()
        captured.clear()
        cw.run_review("code-reviewer", backend, worktree_root=str(tmp_path),
                      diff_file=str(diff), use_cross_context=False)
        assert captured["key"] == expect_key
        assert bool(seen) is (backend == "openai_compat")


# ── cogate --backend, gate keeps Claude ─────────────────────────────────────────────

def test_cogate_backend_openai_compat_marks_under_that_backend(monkeypatch, tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    monkeypatch.delenv("CLAUDE_JOB_DIR", raising=False)
    monkeypatch.setattr(cogate.cr.cfr, "repo_root", lambda: str(tmp_path))
    calls = []

    def fake(argv):
        calls.append(argv)
        wt = Path(argv[argv.index("--worktree-root") + 1])
        backend = argv[argv.index("--backend") + 1]
        with cogate.whooks.worktree_override(wt):
            mr = cogate.whooks.primary_repo_root(wt)
            cogate.whooks.record_script_verdict(
                mr, cogate.store_key("code-reviewer", backend), "SHIP", "fake")
        return SUCCESS

    monkeypatch.setattr(cogate.codex_warden, "main", fake)
    rc = cogate.main(["--role", "code-reviewer", "--claude-verdict", "SHIP",
                      "--claude-reason", "ok", "--backend", "openai_compat",
                      "--worktree-root", str(tmp_path)])
    assert rc == SUCCESS
    assert calls[0][calls[0].index("--backend") + 1] == "openai_compat"


def test_default_backend_is_still_gpt(monkeypatch, tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    monkeypatch.delenv("CLAUDE_JOB_DIR", raising=False)
    calls = []
    monkeypatch.setattr(cogate.codex_warden, "main", lambda argv: calls.append(argv) or 1)
    cogate.main(["--role", "code-reviewer", "--claude-verdict", "SHIP", "--claude-reason", "ok",
                 "--worktree-root", str(tmp_path)])
    assert calls[0][calls[0].index("--backend") + 1] == "gpt"


@pytest.mark.parametrize("role", ["code-reviewer", "plan-reviewer", "ai-eng-warden"])
def test_gate_always_keeps_claude(role):
    assert h._role_backends({role: {"backends": ["openai_compat"]}}, role) == \
        ["claude", "openai_compat"]
    assert h._role_backends({role: {"backends": ["claude", "openai_compat"]}}, role) == \
        ["claude", "openai_compat"]
    assert h._role_backends({}, role) == ["claude"]
