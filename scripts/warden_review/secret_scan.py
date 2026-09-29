"""Credential-shaped text in anything a model backend is about to send off the host.

Pure (no I/O). ``find_secret(*texts)`` returns the NAME of the first matching pattern, or
None. Callers must never print the matched text. Every pattern is anchored so it cannot start
inside a word (``task-granularity`` is not an ``sk-`` key) and length-bounded to real key
sizes, so ordinary code and prose do not trip it. It overlaps control-ui's ``redactSecrets``
(TypeScript) on purpose; this set is the stricter one because it guards egress.
"""
from __future__ import annotations

import re

_B = r"(?<![A-Za-z0-9])"  # not preceded by a letter or digit

PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(rx, flags))
    for name, rx, flags in (
        ("OpenAI-style key", _B + r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}", 0),
        ("Stripe key", _B + r"[sr]k_(?:live|test)_[A-Za-z0-9]{16,}", 0),
        ("GitHub token", _B + r"gh[posur]_[A-Za-z0-9]{30,}", 0),
        ("GitHub fine-grained token", _B + r"github_pat_[A-Za-z0-9_]{40,}", 0),
        ("GitLab token", _B + r"glpat-[A-Za-z0-9_-]{20,}", 0),
        ("Slack token", _B + r"xox[baprs]-[A-Za-z0-9-]{10,}", 0),
        ("Google API key", _B + r"AIza[0-9A-Za-z_-]{35}", 0),
        ("Google OAuth access token", _B + r"ya29\.[0-9A-Za-z_-]{20,}", 0),
        ("Google OAuth client secret", _B + r"GOCSPX-[A-Za-z0-9_-]{20,}", 0),
        ("AWS access key", _B + r"AKIA[0-9A-Z]{16}", 0),
        ("JWT", _B + r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", 0),
        ("Google refresh token", _B + r"1//[0-9A-Za-z_-]{30,}", 0),
        ("Telegram bot token", _B + r"\d{8,10}:[A-Za-z0-9_-]{35}", 0),
        ("Discord bot token", _B + r"[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}", 0),
        ("password in a URL", _B + r"https?://[^/\s:@]+:[^/\s@]{8,}@", 0),
        ("private key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", 0),
        ("key/token/secret/password assignment",
         _B + r"(?:api_?key|token|secret|password)\s*[:=]\s*[\"']?[A-Za-z0-9_\-/+=]{16,}",
         re.IGNORECASE),
    )
)


def find_secret(*texts: str) -> str | None:
    """Name of the first credential-shaped pattern found in any of ``texts``, else None."""
    for text in texts:
        if not text:
            continue
        for name, rx in PATTERNS:
            if rx.search(text):
                return name
    return None
