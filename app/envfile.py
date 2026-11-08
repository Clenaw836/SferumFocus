"""ENV-01: `.env` is read with EXACTLY the semantics of systemd `EnvironmentFile=` (v252).

Why: the service runs under systemd with `EnvironmentFile=/opt/SferumFocus/.env`, and the application also
reads the same file itself. Until v2.0.1 the two readers disagreed on duplicates — systemd keeps the LAST
assignment of a key, the old in-app loader kept the FIRST. A template line such as `SFERUM_PUBLIC_ORIGIN=`
left below a correct value made the service start with an empty origin while every manual check
(`python -c 'import app.config'`) showed the correct one (incident ENV-01, /ready →
explicit_same_https_origin_and_cors_required).

This module is a line-by-line port of systemd v252 `parse_env_file_internal()` (src/basic/env-file.c) with
`load_env_file_push()` (a later assignment replaces an earlier one) and `strv_env_clean()` (assignments
whose name is not a valid environment name are ignored: `export KEY=…`, a UTF-8 BOM glued to the first key).
Parity with the real libsystemd-shared parser is checked by tests/test_env_precedence_v3.py and, against the
UNMODIFIED Debian 12 sources (252.39-1~deb12u2 and bookworm-backports 254.26-1~bpo12+1), by
tests/test_env_independent_v202.py (v2.0.2 independent verification).

v2.0.2 (independent re-verification of v2.0.1) — whole-file refusals and a version nuance:
• a NUL byte anywhere → systemd read_full_stream() returns EBADMSG → the WHOLE file is refused (ENV-03);
• noncharacters U+FDD0..U+FDEF, U+xxFFFE/U+xxFFFF → utf8_is_valid() fails → EINVAL, whole file refused (ENV-02);
• a comment line ending with a backslash swallows the NEXT line in systemd 252/253 (Debian 12 stable), but not in
  254+ (bookworm-backports): such lines are reported as `comment_continuations` and keys whose value depends on
  the systemd version as `version_dependent_keys` (ENV-04). The app itself follows 252 (Debian 12 stable).

Precedence is unchanged: a variable already present in the process environment (systemd, Docker, shell)
wins over the file. The report lists duplicates, conflicts, ignored lines, BOM and shadowed keys —
key names and line numbers only, never values.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import MutableMapping

_WHITESPACE = " \t\n\r"
_NEWLINE = "\n\r"
_COMMENTS = "#;"
_SHELL_NEED_ESCAPE = "\"\\`$"
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")      # systemd env_name_is_valid(): bash name, not starting with a digit


@dataclass
class EnvFileReport:
    path: str
    exists: bool = False
    error: str | None = None                                      # "unreadable" | "not_utf8" | "nul_byte": systemd refuses the file
    values: dict[str, str] = field(default_factory=dict)          # effective values, last assignment wins
    lines: dict[str, list[int]] = field(default_factory=dict)     # every line that assigns the key
    conflicts: list[str] = field(default_factory=list)            # assigned ≥ 2 times with different values
    invalid_lines: list[int] = field(default_factory=list)        # ignored: invalid variable name
    bom: bool = False
    applied: list[str] = field(default_factory=list)              # set into the environment from this file
    shadowed: list[str] = field(default_factory=list)             # process environment has a different value
    comment_continuations: list[int] = field(default_factory=list)  # lines swallowed by a preceding `#…\\` (systemd ≤253)
    version_dependent_keys: list[str] = field(default_factory=list) # effective value differs between systemd 252 and 254+

    @property
    def duplicates(self) -> list[str]:
        return sorted(k for k, n in self.lines.items() if len(n) > 1)

    def last_line(self, key: str) -> int | None:
        n = self.lines.get(key)
        return n[-1] if n else None

    def summary(self) -> dict:
        """Safe to log or return: names and line numbers only."""
        return {"path": self.path, "exists": self.exists, "error": self.error, "bom": self.bom,
                "duplicates": {k: self.lines[k] for k in self.duplicates}, "conflicts": sorted(self.conflicts),
                "invalid_lines": self.invalid_lines, "shadowed": sorted(self.shadowed),
                "comment_continuations": self.comment_continuations,
                "version_dependent_keys": self.version_dependent_keys}


def parse_assignments(text: str, systemd: int = 252, swallowed: list[int] | None = None) -> list[tuple[int, str, str]]:
    """(line where the assignment starts, key, value) in file order — systemd parse_env_file_internal().

    systemd=252 (also 253, Debian 12 stable): a comment line ending with `\\` continues onto the next line, which is
    therefore ignored. systemd>=254 ends the comment at the newline (the only parsing difference 252→254).
    `swallowed` collects (252 mode) the numbers of non-blank lines eaten by such a comment continuation.
    A NUL byte makes systemd refuse the whole file before parsing (see parse_env_text); here the text is cut at
    the first NUL, like the C string the parser works on."""
    PRE_KEY, KEY, PRE_VALUE, VALUE, VALUE_ESCAPE, SQ, DQ, DQ_ESCAPE, COMMENT, COMMENT_ESCAPE = range(10)
    text = text.split("\0", 1)[0]
    out: list[tuple[int, str, str]] = []
    continued = False                             # inside a line swallowed by a comment continuation (252 mode)
    state = PRE_KEY
    key: list[str] = []
    value: list[str] = []
    last_key_ws: int | None = None                # systemd: last_key_whitespace (SIZE_MAX ≙ None)
    last_value_ws: int | None = None
    line, key_line = 1, 1

    def push(chomp_value: bool) -> None:
        k = key[:last_key_ws] if last_key_ws is not None else key
        v = value[:last_value_ws] if chomp_value and last_value_ws is not None else value
        out.append((key_line, "".join(k), "".join(v)))

    for c in text:
        if state == PRE_KEY:
            if c in _COMMENTS:
                state = COMMENT
            elif c not in _WHITESPACE:
                state = KEY; last_key_ws = None; key = [c]; value = []; key_line = line
        elif state == KEY:
            if c in _NEWLINE:
                state = PRE_KEY; key = []
            elif c == "=":
                state = PRE_VALUE; last_value_ws = None
            else:
                if c not in _WHITESPACE:
                    last_key_ws = None
                elif last_key_ws is None:
                    last_key_ws = len(key)
                key.append(c)
        elif state == PRE_VALUE:
            if c in _NEWLINE:
                state = PRE_KEY; push(False); key = []; value = []
            elif c == "'":
                state = SQ
            elif c == '"':
                state = DQ
            elif c == "\\":
                state = VALUE_ESCAPE
            elif c not in _WHITESPACE:
                state = VALUE; value.append(c)
        elif state == VALUE:
            if c in _NEWLINE:
                state = PRE_KEY; push(True); key = []; value = []
            elif c == "\\":
                state = VALUE_ESCAPE; last_value_ws = None
            else:
                if c not in _WHITESPACE:
                    last_value_ws = None
                elif last_value_ws is None:
                    last_value_ws = len(value)
                value.append(c)
        elif state == VALUE_ESCAPE:
            state = VALUE
            if c not in _NEWLINE:                 # escaped newlines are eaten entirely
                value.append(c)
        elif state == SQ:
            if c == "'":
                state = PRE_VALUE
            else:
                value.append(c)
        elif state == DQ:
            if c == '"':
                state = PRE_VALUE
            elif c == "\\":
                state = DQ_ESCAPE
            else:
                value.append(c)
        elif state == DQ_ESCAPE:
            state = DQ
            if c in _SHELL_NEED_ESCAPE:
                value.append(c)
            elif c != "\n":
                value.extend(("\\", c))
        elif state == COMMENT:
            if c == "\\":
                state = COMMENT_ESCAPE
            elif c in _NEWLINE:
                state = PRE_KEY; continued = False
            elif continued and c not in _WHITESPACE:
                continued = False                 # first visible character of the swallowed line
                if c not in _COMMENTS and swallowed is not None:
                    swallowed.append(line)        # would be parsed as a line of its own by systemd 254+
        elif state == COMMENT_ESCAPE:
            if systemd >= 254 and c in _NEWLINE:  # v254: "…is now treated as a non comment line since v254"
                state = PRE_KEY
            else:
                state = COMMENT
                if c in _NEWLINE:                 # v252/253: the next line (LF, or CR-only endings) is still comment
                    continued = True
        if c == "\n":
            line += 1
    if state in (PRE_VALUE, VALUE, VALUE_ESCAPE, SQ, DQ, DQ_ESCAPE):
        push(state == VALUE)
    return out


def _utf8(s: str) -> bool:
    """systemd utf8_is_valid() (src/basic/utf8.c, v252–v254): strict UTF-8 AND no noncharacters —
    unichar_is_valid() rejects U+FDD0..U+FDEF and every U+xxFFFE/U+xxFFFF. Such a value makes
    load_env_file() fail with EINVAL, i.e. systemd refuses the WHOLE EnvironmentFile."""
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:                    # surrogateescape'd invalid bytes
        return False
    return not any(0xFDD0 <= ord(c) <= 0xFDEF or (ord(c) & 0xFFFE) == 0xFFFE for c in s)


def _effective(assignments: list[tuple[int, str, str]]) -> dict[str, str] | None:
    """load_env_file_push() + strv_env_clean(): last assignment wins, invalid names dropped; None ≙ EINVAL."""
    out: dict[str, str] = {}
    for _line, key, value in assignments:
        if not (_utf8(key) and _utf8(value)):
            return None
        if _NAME.match(key):
            out[key] = value
    return out


def parse_env_text(text: str, path: str = "<text>") -> EnvFileReport:
    if "\0" in text:                              # systemd read_full_stream(): EBADMSG → the whole file is refused
        return EnvFileReport(path=path, exists=True, error="nul_byte", bom=text.startswith("\ufeff"))
    rep = EnvFileReport(path=path, exists=True, bom=text.startswith("\ufeff"))
    seen: dict[str, set[str]] = {}
    swallowed: list[int] = []
    assignments = parse_assignments(text, 252, swallowed)
    for line, key, value in assignments:
        if not (_utf8(key) and _utf8(value)):     # systemd refuses the whole file (the unit does not start)
            return EnvFileReport(path=path, exists=True, error="not_utf8", bom=rep.bom)
        if not _NAME.match(key):
            rep.invalid_lines.append(line)
            continue
        rep.values.pop(key, None)
        rep.values[key] = value
        rep.lines.setdefault(key, []).append(line)
        seen.setdefault(key, set()).add(value)
    rep.conflicts = sorted(k for k, v in seen.items() if len(v) > 1)
    rep.comment_continuations = swallowed
    if swallowed:                                 # only then can systemd 254+ read the file differently
        v254 = _effective(parse_assignments(text, 254))
        if v254 is None:
            rep.version_dependent_keys = sorted(rep.values)       # 254+ would refuse the whole file
        else:
            rep.version_dependent_keys = sorted(k for k in set(rep.values) | set(v254) if rep.values.get(k) != v254.get(k))
    return rep


def parse_env_file(path: str | os.PathLike) -> EnvFileReport:
    p = Path(path)
    if not p.exists():
        return EnvFileReport(path=str(p))
    try:
        raw = p.read_bytes()
    except OSError:
        return EnvFileReport(path=str(p), exists=True, error="unreadable")
    return parse_env_text(raw.decode("utf-8", "surrogateescape"), str(p))


def load_env_file(path: str | os.PathLike, environ: MutableMapping[str, str] | None = None) -> EnvFileReport:
    """Apply the file to the environment: only variables that are NOT already set (process env wins)."""
    env = os.environ if environ is None else environ
    rep = parse_env_file(path)
    for k, v in rep.values.items():
        if k in env:
            if env[k] != v:
                rep.shadowed.append(k)
        else:
            env[k] = v
            rep.applied.append(k)
    return rep
