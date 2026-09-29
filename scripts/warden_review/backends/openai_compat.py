"""OpenAI-compatible ``/v1/chat/completions`` model-reviewer backend.

Reviews a change against a role's rules via ANY OpenAI-compatible endpoint — a local
llama.cpp / Ollama server, OpenRouter, or OpenAI itself. Reuses the codex_review engine's
PURE prompt helpers (``build_rules_digest`` / ``build_prompt``) so the prompt, the
untrusted-diff sentinel boundary, and the findings shape stay identical to the ``gpt``
backend — only the transport differs (an HTTP POST here vs the ``codex`` CLI in codex.py).

Config is env-driven — NO hardcoded hosts, so a fresh clone configures it or abstains:
  WARDEN_OPENAI_COMPAT_BASE_URL  (required)  e.g. http://127.0.0.1:8080/v1, https://openrouter.ai/api/v1
  WARDEN_OPENAI_COMPAT_MODEL     (optional)  model id; ``ReviewRequest.model`` overrides it
  WARDEN_OPENAI_COMPAT_API_KEY   (optional)  sent as ``Authorization: Bearer`` only when set
                                             (a local llama.cpp / Ollama server needs none)

We send ``response_format={"type":"json_object"}`` — the portable common denominator across
all four targets (llama.cpp constrains output to a JSON grammar; Ollama maps it to
``format=json``; OpenRouter passes it through; OpenAI supports it). We deliberately do NOT
use ``json_schema``/strict mode: ``FINDINGS_SCHEMA``'s ``line`` field is a ``["integer",
"null"]`` type-union, which strict structured-outputs reject — so the required shape is
stated in the prompt instead, and the fail-closed verdict check below is the real guarantee.

Security: the diff is UNTRUSTED. It stays inside ``build_prompt``'s per-run 128-bit random
sentinel boundary; ``cross_context`` (trusted system input) is injected OUTSIDE it by
``build_prompt``. This is a read-only HTTP review — no writes, no auto-apply. The API key is
only ever placed in the ``Authorization`` header, never logged.

FAIL-CLOSED (mirrors codex.py): a missing base URL, a transport error, a non-200, an
unparseable body, or a verdict outside {SHIP,REVISE,BLOCK} all become COULD_NOT_RUN — the
gate fails OPEN on that (warn + allow, audit-logged distinctly), but a schema-conformant
response with no/invalid verdict NEVER silently becomes SHIP.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit

import codex_review as cr  # PURE prompt helpers (build_rules_digest / build_prompt); no codex CLI here
import httpx               # hard dep of the warden-review stack (codex_review requires it too)

from ..constants import (
    BACKEND_OPENAI_COMPAT,
    VERDICT_BLOCK,
    VERDICT_COULD_NOT_RUN,
    VERDICT_REVISE,
    VERDICT_SHIP,
)
from ..secret_scan import find_secret
from .base import ModelReviewerBackend, ReviewRequest, Verdict

# A real review outcome must be exactly one of these. Anything else (absent / null /
# unexpected) is COULD_NOT_RUN — NEVER silently SHIP (a valid-JSON response with no verdict
# key must not auto-approve a commit). Mirrors codex.py's contract.
_REVIEW_VERDICTS = (VERDICT_SHIP, VERDICT_REVISE, VERDICT_BLOCK)

# Env-var NAMES are class attributes on OpenAICompatBackend (see its docstring); module-level
# aliases for the old private names are defined after the class for back-compat.

# Single-call guard. Same VALUE as codex_review.WHOLE_DIFF_CHAR_LIMIT (200_000) but a
# different SCOPE: that bounds the DIFF slice alone (minus the rules digest); this bounds the
# WHOLE assembled prompt — i.e. strictly MORE conservative, so do not equate the two constants.
# Oversize -> COULD_NOT_RUN (fail open), NEVER a silent truncate-then-SHIP. Deliberately no
# per-file fan-out: the co-gate reviews working-tree-sized diffs, so the rare oversize case
# (fail-open + audit-logged) is an acceptable trade against the added quota cost and complexity
# of fanning a huge diff across many calls. Add fan-out only if real oversize diffs appear.
_MAX_PROMPT_CHARS = 200_000

# The one other env var whose value may be used as the key, and only for OpenAI itself
# (see _is_openai_api). Anything else never becomes a bearer token.
ALLOWED_FALLBACK_KEY_ENV = "OPENAI_API_KEY"
DEFAULT_MAX_TOKENS = 4000
DEFAULT_MAX_CALLS_PER_DAY = 100
# USD per 1M tokens (input, output), from OpenAI's pricing page 2026-09-29. Unknown model ->
# cost logged as null.
_PRICES = {"gpt-4.1-nano": (0.10, 0.40)}
# One JSON line per call attempt: no prompt, no reply, no key. The env override is for tests.
def _call_log() -> Path:
    return Path(os.environ.get("DEUS_WARDEN_CALL_LOG")
                or Path.home() / ".deus" / "warden-openai-calls.jsonl")


def _is_openai_api(base_url: str) -> bool:
    """True only for https://api.openai.com[:443]/... with no user info."""
    try:
        u = urlsplit(base_url)
        port = u.port
    except ValueError:
        return False
    return (u.scheme == "https" and u.hostname == "api.openai.com"
            and u.username is None and u.password is None and port in (None, 443))


def _int_env(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
    return v if v > 0 else default


def _calls_today(backend: str) -> int:
    """Requests this backend actually sent today (UTC), counted from the call log."""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    tag = f'"backend": "{backend}"'
    n = 0
    try:
        with _call_log().open(encoding="utf-8") as fh:
            for line in fh:
                if (line.startswith('{"day": "' + today + '"') and tag in line
                        and '"sent": true' in line):
                    n += 1
    except OSError:
        return 0
    return n


def _log_call(entry: dict) -> None:
    """Append one line to the call log (0600). Logging never fails a review."""
    path = _call_log()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        os.chmod(path, 0o600)
    except OSError:
        pass


def _shape_instruction() -> str:
    """The exact JSON object shape, appended to the prompt for ``json_object`` mode.

    ``response_format={"type":"json_object"}`` guarantees VALID JSON but not a SCHEMA, so the
    required shape (the same fields codex enforces out-of-band via ``--output-schema``) is
    stated here. Defensive parsing + the fail-closed verdict check are the real guarantee;
    this only steers the model to the right shape. Appended AFTER build_prompt's terminal
    instruction so the schema sits in the prompt's terminal position (where models attend best).
    """
    return (
        "\n\nReturn ONLY a single JSON object (no prose, no markdown fence) of EXACTLY this "
        "shape:\n"
        '{"verdict": "SHIP|REVISE|BLOCK", "summary": "<one sentence>", "results": '
        '[{"file": "<path>", "flagged": <bool>, "findings": [{"severity": '
        '"CRITICAL|MAJOR|MINOR", "line": <int|null>, "finding": "<text>", '
        '"confidence": "high|medium|low"}]}]}'
    )


def _post_chat_completion(
    endpoint: str, payload: dict, headers: dict, timeout: float
) -> tuple[int, dict | str]:
    """The ONE network seam (mocked wholesale in tests — zero real HTTP in CI).

    Returns ``(status_code, body)`` where body is the parsed JSON dict on success or the raw
    text when the response is not JSON (e.g. an HTML 502 from a proxy), so ``review`` handles
    status + shape uniformly. Transport failures propagate as ``httpx.HTTPError`` for the
    caller to map to COULD_NOT_RUN.
    """
    resp = httpx.post(endpoint, json=payload, headers=headers, timeout=timeout)
    try:
        return resp.status_code, resp.json()
    except (ValueError, json.JSONDecodeError):
        return resp.status_code, resp.text


def _parse_findings_json(raw: str) -> dict:
    """Parse the model's content into the findings dict, tolerating a markdown fence or
    leading/trailing prose some models wrap around the object (e.g. a trailing "Note: …").

    Tries the body first (after stripping a leading ```````/`````json`` fence); on
    failure, falls back to the OUTERMOST ``{...}`` span. A still-unparseable result or a
    non-object JSON value raises ValueError/TypeError — which ``review`` maps to COULD_NOT_RUN
    (fail-closed: prose, an array, or junk NEVER becomes a verdict)."""
    body = raw.strip()
    if body.startswith("```"):  # tolerate a fence the server didn't strip
        body = body.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(body)
    except (ValueError, json.JSONDecodeError):
        match = re.search(r"\{.*\}", raw, re.DOTALL)  # outermost object; surrounding prose tolerated
        if not match:
            raise
        data = json.loads(match.group(0))  # may still raise -> caller fails closed
    if not isinstance(data, dict):
        raise TypeError(f"expected a JSON object, got {type(data).__name__}")
    return data


class OpenAICompatBackend(ModelReviewerBackend):
    """Backend id ``openai_compat``: any OpenAI-compatible /v1/chat/completions endpoint.

    Subclass to add a provider: override the ``ENV_*`` / ``DEFAULT_*`` / ``REQUIRE_API_KEY``
    class attributes (and ``id()``) and reuse ``review()`` verbatim — see ``backends/glm.py``.
    """

    # Env-var NAMES this backend reads (no hardcoded host: a fresh clone sets these or abstains).
    ENV_BASE_URL = "WARDEN_OPENAI_COMPAT_BASE_URL"
    ENV_MODEL = "WARDEN_OPENAI_COMPAT_MODEL"
    ENV_API_KEY = "WARDEN_OPENAI_COMPAT_API_KEY"
    ENV_MAX_TOKENS = "WARDEN_OPENAI_COMPAT_MAX_TOKENS"
    ENV_MAX_CALLS_PER_DAY = "WARDEN_OPENAI_COMPAT_MAX_CALLS_PER_DAY"
    # The driver may hand over OPENAI_API_KEY on ReviewRequest.api_key; it is used only when
    # the endpoint is OpenAI itself. Subclasses for other providers set this to None.
    FALLBACK_KEY_ENV: str | None = ALLOWED_FALLBACK_KEY_ENV
    # Provider-specific defaults (empty = none; generic openai_compat must be env-configured).
    DEFAULT_BASE_URL = ""
    DEFAULT_MODEL = ""
    # Authenticated endpoints (e.g. Z.ai) set this so a keyless call abstains instead of being
    # sent; generic openai_compat allows keyless (a local llama.cpp / Ollama needs no key).
    REQUIRE_API_KEY = False

    def id(self) -> str:
        return BACKEND_OPENAI_COMPAT

    def review(self, request: ReviewRequest) -> Verdict:
        base_url = (os.environ.get(self.ENV_BASE_URL, "").strip()
                    or self.DEFAULT_BASE_URL).rstrip("/")
        if not base_url:
            # Fail open (never SHIP): the backend is registered but unconfigured here.
            return Verdict(
                VERDICT_COULD_NOT_RUN,
                error=f"{self.ENV_BASE_URL} is not set — no endpoint to review against. Set it "
                      "to an OpenAI-compatible /v1 base URL (e.g. http://127.0.0.1:8080/v1).",
                category="auth",
            )

        model = request.model or os.environ.get(self.ENV_MODEL, "").strip() or self.DEFAULT_MODEL
        log = {"day": time.strftime("%Y-%m-%d", time.gmtime()),
               "time": time.strftime("%H:%M:%SZ", time.gmtime()),
               "backend": self.id(), "role": request.role, "model": model or None,
               "host": urlsplit(base_url).hostname, "sent": False}

        api_key = os.environ.get(self.ENV_API_KEY, "").strip()
        to_openai = _is_openai_api(base_url)
        if (not api_key and to_openai and self.FALLBACK_KEY_ENV == ALLOWED_FALLBACK_KEY_ENV
                and request.api_key):
            api_key = request.api_key.strip()
        if to_openai and not api_key:
            _log_call({**log, "skipped": "no key"})
            return Verdict(
                VERDICT_COULD_NOT_RUN,
                error=f"no API key for api.openai.com (set {ALLOWED_FALLBACK_KEY_ENV} or "
                      f"{self.ENV_API_KEY}).",
                category="auth",
            )
        if self.REQUIRE_API_KEY and not api_key:
            # An authenticated endpoint with no key: abstain BEFORE building the prompt or
            # calling out (fail open, never SHIP) — guarantees a no-op when unconfigured.
            return Verdict(
                VERDICT_COULD_NOT_RUN,
                error=f"{self.ENV_API_KEY} is not set — this backend requires an API key.",
                category="auth",
            )

        rules_digest = cr.build_rules_digest(Path(request.rules_path))
        # Nothing credential-shaped leaves the host: the diff, the cross-review context and
        # the rules text are all checked. A hit, or any failure of the check, skips the call
        # (COULD_NOT_RUN: the gate stays on Claude's review alone). Only the pattern NAME is
        # ever reported.
        try:
            hit = find_secret(request.content, request.cross_context, rules_digest)
        except Exception:  # noqa: BLE001 — a broken scan must never mean "send anyway"
            hit = "secret scan failed"
        if hit:
            _log_call({**log, "skipped": f"secret: {hit}"})
            return Verdict(VERDICT_COULD_NOT_RUN,
                           error=f"not sent: the change looks like it holds a {hit}.")
        max_calls = _int_env(self.ENV_MAX_CALLS_PER_DAY, DEFAULT_MAX_CALLS_PER_DAY)
        if _calls_today(self.id()) >= max_calls:
            _log_call({**log, "skipped": "daily cap"})
            return Verdict(VERDICT_COULD_NOT_RUN,
                           error=f"daily cap of {max_calls} reviews reached "
                                 f"({self.ENV_MAX_CALLS_PER_DAY}).")
        sentinel = f"<<<UNTRUSTED-DIFF-{secrets.token_hex(16)}>>>"  # 128-bit, infeasible to forge
        prompt = (
            cr.build_prompt(request.content, rules_digest, sentinel, request.cross_context)
            + _shape_instruction()
        )
        log["prompt_chars"] = len(prompt)
        if len(prompt) > _MAX_PROMPT_CHARS:
            _log_call({**log, "skipped": "prompt too large"})
            return Verdict(
                VERDICT_COULD_NOT_RUN,
                error=f"assembled prompt is {len(prompt)} chars > {_MAX_PROMPT_CHARS} cap "
                      "(single-call backend; per-file fan-out is not implemented).",
            )

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"  # key never logged; header only
        payload: dict = {
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "stream": False,
            "response_format": {"type": "json_object"},
            "max_tokens": _int_env(self.ENV_MAX_TOKENS, DEFAULT_MAX_TOKENS),
        }
        if model:
            payload["model"] = model

        endpoint = f"{base_url}/chat/completions"
        log["sent"] = True
        try:
            status, body = _post_chat_completion(endpoint, payload, headers, request.timeout)
        except Exception as exc:  # noqa: BLE001 — review() must never raise into the gate
            _log_call({**log, "outcome": "connection error"})
            # Transport failure (offline / DNS / timeout) OR a malformed base URL (some httpx
            # versions raise ValueError for a schemeless URL) — honor the backend contract:
            # fail open (COULD_NOT_RUN), NEVER let review() raise out into the gate driver.
            return Verdict(VERDICT_COULD_NOT_RUN, error=f"connection error to {endpoint}: {exc}")

        usage = body.get("usage") if isinstance(body, dict) else None
        if isinstance(usage, dict):
            pin, pout = usage.get("prompt_tokens"), usage.get("completion_tokens")
            log["tokens"] = {"in": pin, "out": pout}
            price = _PRICES.get(str(model))
            if price and isinstance(pin, int) and isinstance(pout, int):
                log["cost_usd"] = round((pin * price[0] + pout * price[1]) / 1e6, 6)
        if status != 200:
            _log_call({**log, "outcome": f"HTTP {status}"})
            category = ("auth" if status in (401, 403)
                        else "rate_limit" if status == 429 else "")
            snippet = body if isinstance(body, str) else json.dumps(body)
            # Provider errors can echo a masked key ("sk-...abcd"); never pass it on.
            snippet = re.sub(r"sk-[A-Za-z0-9*._-]+", "sk-…", snippet)
            hit = find_secret(snippet)
            if hit:
                snippet = f"(body withheld: it looks like it holds a {hit})"
            return Verdict(
                VERDICT_COULD_NOT_RUN,
                error=f"HTTP {status} from {endpoint}: {snippet[:200]}",
                category=category,
            )

        # Parse the model's JSON content into a Verdict. ANY anomaly -> COULD_NOT_RUN.
        try:
            content = body["choices"][0]["message"]["content"]
            finish = body["choices"][0].get("finish_reason")
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            _log_call({**log, "outcome": "unexpected response shape"})
            return Verdict(VERDICT_COULD_NOT_RUN, error=f"unexpected response shape: {exc}")
        if finish == "length":
            # Cut off at max_tokens: whatever parses is not a whole review.
            _log_call({**log, "outcome": "truncated"})
            return Verdict(VERDICT_COULD_NOT_RUN,
                           error="the reply was cut off at the token limit; not a review.")
        raw = (content or "").strip()
        try:
            data = _parse_findings_json(raw)
            verdict = data["verdict"]
        except (ValueError, KeyError, TypeError) as exc:
            _log_call({**log, "outcome": "unparseable reply"})
            return Verdict(VERDICT_COULD_NOT_RUN, raw=raw,
                           error=f"model output was not schema-conforming JSON: {exc}")
        _log_call({**log, "outcome": str(verdict)})
        if verdict not in _REVIEW_VERDICTS:
            # Fail closed: a missing/invalid verdict is an anomaly, not an approval.
            return Verdict(VERDICT_COULD_NOT_RUN, raw=raw,
                           error=f"backend returned no/invalid verdict ({verdict!r})")

        findings: list[dict] = []
        results = data.get("results")
        if isinstance(results, list):
            for r in results:
                if not isinstance(r, dict):
                    continue
                file = r.get("file", "<unknown>")
                for f in r.get("findings") or []:
                    if isinstance(f, dict):
                        findings.append({"file": file, **f})
        return Verdict(verdict=verdict, findings=findings,
                       summary=data.get("summary", ""), raw=raw)


# Back-compat module-level aliases for the old private constant names (external importers).
_ENV_BASE_URL = OpenAICompatBackend.ENV_BASE_URL
_ENV_MODEL = OpenAICompatBackend.ENV_MODEL
_ENV_API_KEY = OpenAICompatBackend.ENV_API_KEY
