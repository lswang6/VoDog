#!/usr/bin/env python3
"""Validate VoDog's Localizable.strings files and literal L10n.tr keys."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import final

LANGUAGES = ("zh-Hans", "en", "ja", "fr")
MAX_DETAILS_PER_CHECK = 30


class CheckError(Exception):
    pass


@dataclass(frozen=True)
class SwiftString:
    value: str
    literal: bool
    line: int


@dataclass(frozen=True)
class Token:
    kind: str
    value: str | SwiftString
    line: int


@final
class StringsParser:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.text = path.read_text(encoding="utf-8-sig")
        self.index = 0
        self.line = 1

    def error(self, message: str) -> CheckError:
        return CheckError(f"{self.path}:{self.line}: {message}")

    def advance(self, count: int = 1) -> None:
        segment = self.text[self.index : self.index + count]
        self.line += segment.count("\n")
        self.index += count

    def skip_trivia(self) -> None:
        while self.index < len(self.text):
            if self.text[self.index].isspace():
                self.advance()
            elif self.text.startswith("//", self.index):
                end = self.text.find("\n", self.index + 2)
                self.advance(len(self.text) - self.index if end < 0 else end - self.index)
            elif self.text.startswith("/*", self.index):
                end = self.text.find("*/", self.index + 2)
                if end < 0:
                    raise self.error("unterminated block comment")
                self.advance(end + 2 - self.index)
            else:
                return

    def parse_string(self) -> tuple[str, int]:
        if self.index >= len(self.text) or self.text[self.index] != '"':
            raise self.error("expected a quoted string")
        start_line = self.line
        self.advance()
        result: list[str] = []
        while self.index < len(self.text):
            char = self.text[self.index]
            if char == '"':
                self.advance()
                return "".join(result), start_line
            if char in "\r\n":
                raise self.error("newline in quoted string")
            if char != "\\":
                result.append(char)
                self.advance()
                continue

            self.advance()
            if self.index >= len(self.text):
                raise self.error("unterminated escape sequence")
            escape = self.text[self.index]
            simple = {
                '"': '"',
                "'": "'",
                "\\": "\\",
                "a": "\a",
                "b": "\b",
                "f": "\f",
                "n": "\n",
                "r": "\r",
                "t": "\t",
                "v": "\v",
            }
            if escape in simple:
                result.append(simple[escape])
                self.advance()
            elif escape in "01234567":
                match = re.match(r"[0-7]{1,3}", self.text[self.index :])
                assert match is not None
                result.append(chr(int(match.group(), 8)))
                self.advance(len(match.group()))
            elif escape in "uU":
                digits = 4 if escape == "u" else 8
                raw = self.text[self.index + 1 : self.index + 1 + digits]
                if len(raw) != digits or not re.fullmatch(r"[0-9A-Fa-f]+", raw):
                    raise self.error(f"invalid \\{escape} escape")
                result.append(chr(int(raw, 16)))
                self.advance(1 + digits)
            else:
                raise self.error(f"unsupported escape sequence \\{escape}")
        raise self.error("unterminated quoted string")

    def expect(self, value: str) -> None:
        self.skip_trivia()
        if not self.text.startswith(value, self.index):
            raise self.error(f"expected {value!r}")
        self.advance(len(value))

    def parse(self) -> dict[str, str]:
        entries: dict[str, str] = {}
        key_lines: dict[str, int] = {}
        while True:
            self.skip_trivia()
            if self.index >= len(self.text):
                return entries
            key, key_line = self.parse_string()
            self.expect("=")
            self.skip_trivia()
            value, _ = self.parse_string()
            self.expect(";")
            if key in entries:
                raise CheckError(
                    f"{self.path}:{key_line}: duplicate key {key!r}; "
                    + f"first declared on line {key_lines[key]}"
                )
            entries[key] = value
            key_lines[key] = key_line


@final
class SwiftLexer:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.text = path.read_text(encoding="utf-8")
        self.index = 0
        self.line = 1

    def advance(self, count: int = 1) -> None:
        segment = self.text[self.index : self.index + count]
        self.line += segment.count("\n")
        self.index += count

    def skip_trivia(self) -> None:
        while self.index < len(self.text):
            if self.text[self.index].isspace():
                self.advance()
            elif self.text.startswith("//", self.index):
                end = self.text.find("\n", self.index + 2)
                self.advance(len(self.text) - self.index if end < 0 else end - self.index)
            elif self.text.startswith("/*", self.index):
                depth = 1
                self.advance(2)
                while depth and self.index < len(self.text):
                    if self.text.startswith("/*", self.index):
                        depth += 1
                        self.advance(2)
                    elif self.text.startswith("*/", self.index):
                        depth -= 1
                        self.advance(2)
                    else:
                        self.advance()
            else:
                return

    def parse_string(self, hashes: int, multiline: bool, start_line: int) -> SwiftString:
        delimiter = ('"""' if multiline else '"') + ("#" * hashes)
        self.advance(3 if multiline else 1)
        result: list[str] = []
        is_literal = True
        while self.index < len(self.text):
            if self.text.startswith(delimiter, self.index):
                self.advance(len(delimiter))
                value = "".join(result)
                if multiline and value.startswith("\n"):
                    value = value[1:]
                return SwiftString(value, is_literal, start_line)

            escape_prefix = "\\" + ("#" * hashes)
            if self.text.startswith(escape_prefix + "(", self.index):
                is_literal = False
                result.append("<interpolation>")
                self.advance(len(escape_prefix) + 1)
                depth = 1
                while depth and self.index < len(self.text):
                    if self.text[self.index] == "(":
                        depth += 1
                    elif self.text[self.index] == ")":
                        depth -= 1
                    self.advance()
                continue

            if self.text.startswith(escape_prefix, self.index):
                self.advance(len(escape_prefix))
                if self.index >= len(self.text):
                    break
                escape = self.text[self.index]
                simple = {
                    "0": "\0",
                    "\\": "\\",
                    "t": "\t",
                    "n": "\n",
                    "r": "\r",
                    '"': '"',
                    "'": "'",
                }
                if escape in simple:
                    result.append(simple[escape])
                    self.advance()
                    continue
                if escape == "u" and self.text.startswith("u{", self.index):
                    end = self.text.find("}", self.index + 2)
                    if end >= 0:
                        raw = self.text[self.index + 2 : end]
                        if re.fullmatch(r"[0-9A-Fa-f]{1,8}", raw):
                            result.append(chr(int(raw, 16)))
                            self.advance(end + 1 - self.index)
                            continue
                is_literal = False
                result.append("\\" + escape)
                self.advance()
                continue

            char = self.text[self.index]
            if not multiline and char in "\r\n":
                return SwiftString("".join(result), False, start_line)
            result.append(char)
            self.advance()
        return SwiftString("".join(result), False, start_line)

    def tokens(self) -> list[Token]:
        tokens: list[Token] = []
        while self.index < len(self.text):
            self.skip_trivia()
            if self.index >= len(self.text):
                break
            start_line = self.line
            char = self.text[self.index]
            if char.isalpha() or char == "_":
                match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", self.text[self.index :])
                assert match is not None
                tokens.append(Token("identifier", match.group(), start_line))
                self.advance(len(match.group()))
                continue
            if char == "#":
                match = re.match(r"(#+)(\"\"\"|\")", self.text[self.index :])
                if match:
                    hashes = len(match.group(1))
                    multiline = match.group(2) == '"""'
                    self.advance(hashes)
                    tokens.append(
                        Token("string", self.parse_string(hashes, multiline, start_line), start_line)
                    )
                    continue
            if self.text.startswith('"""', self.index):
                tokens.append(Token("string", self.parse_string(0, True, start_line), start_line))
                continue
            if char == '"':
                tokens.append(Token("string", self.parse_string(0, False, start_line), start_line))
                continue
            tokens.append(Token("punctuation", char, start_line))
            self.advance()
        return tokens


def literal_l10n_keys(source_dir: Path) -> dict[str, list[str]]:
    usages: dict[str, list[str]] = {}
    for path in sorted(source_dir.rglob("*.swift")):
        tokens = SwiftLexer(path).tokens()
        for index in range(len(tokens) - 4):
            sequence = tokens[index : index + 5]
            if (
                sequence[0].kind == "identifier"
                and sequence[0].value == "L10n"
                and sequence[1].value == "."
                and sequence[2].kind == "identifier"
                and sequence[2].value == "tr"
                and sequence[3].value == "("
                and sequence[4].kind == "string"
            ):
                swift_string = sequence[4].value
                assert isinstance(swift_string, SwiftString)
                if swift_string.literal:
                    location = f"{path}:{swift_string.line}"
                    usages.setdefault(swift_string.value, []).append(location)
    return usages


FORMAT_RE = re.compile(
    r"%(?:(?P<position>[1-9][0-9]*)\$)?(?P<flags>[-+ #0']*)"
    + r"(?P<width>\*(?P<width_position>[1-9][0-9]*\$)?|[0-9]+)?"
    + r"(?:\.(?P<precision>\*(?P<precision_position>[1-9][0-9]*\$)?|[0-9]+))?"
    + r"(?P<length>hh|ll|[hlqLjzt])?(?P<conversion>[@diouxXfFeEgGaAcCsSpn])"
)


def format_signature(value: str) -> tuple[tuple[int, str], ...]:
    arguments: list[tuple[int, str]] = []
    next_position = 1
    index = 0
    while index < len(value):
        percent = value.find("%", index)
        if percent < 0:
            break
        if percent + 1 < len(value) and value[percent + 1] == "%":
            index = percent + 2
            continue
        match = FORMAT_RE.match(value, percent)
        if not match:
            index = percent + 1
            continue

        def consume_star(
            current_match: re.Match[str], group: str, position_group: str
        ) -> None:
            nonlocal next_position
            group_value = current_match.group(group)
            if group_value and group_value.startswith("*"):
                raw_position = current_match.group(position_group)
                position = int(raw_position[:-1]) if raw_position else next_position
                arguments.append((position, "int"))
                if not raw_position:
                    next_position += 1

        consume_star(match, "width", "width_position")
        consume_star(match, "precision", "precision_position")
        raw_position = match.group("position")
        position = int(raw_position) if raw_position else next_position
        conversion = match.group("conversion")
        length = match.group("length") or ""
        if conversion in "di":
            conversion = "d"
        elif conversion in "ouxX":
            conversion = "u" + conversion.lower()
        elif conversion in "fFeEgGaA":
            conversion = "f"
        arguments.append((position, length + conversion))
        if not raw_position:
            next_position += 1
        index = match.end()
    return tuple(sorted(arguments))


def print_details(title: str, details: list[str]) -> None:
    if not details:
        return
    print(f"{title} ({len(details)}):", file=sys.stderr)
    for detail in details[:MAX_DETAILS_PER_CHECK]:
        print(f"  - {detail}", file=sys.stderr)
    remaining = len(details) - MAX_DETAILS_PER_CHECK
    if remaining > 0:
        print(f"  ... and {remaining} more", file=sys.stderr)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    localization_root = root / "Resources" / "Localization"
    tables: dict[str, dict[str, str]] = {}

    try:
        for language in LANGUAGES:
            path = localization_root / f"{language}.lproj" / "Localizable.strings"
            tables[language] = StringsParser(path).parse()
    except (CheckError, OSError, UnicodeError) as error:
        print(f"Localization check failed: {error}", file=sys.stderr)
        return 1

    reference_language = LANGUAGES[0]
    reference_keys = set(tables[reference_language])
    key_set_errors: list[str] = []
    for language in LANGUAGES[1:]:
        keys = set(tables[language])
        for key in sorted(reference_keys - keys):
            key_set_errors.append(f"{language} is missing {key!r}")
        for key in sorted(keys - reference_keys):
            key_set_errors.append(f"{language} has extra key {key!r}")

    usages = literal_l10n_keys(root / "Sources" / "VoDog")
    missing_usage_errors: list[str] = []
    for key, locations in sorted(usages.items()):
        missing_languages = [language for language in LANGUAGES if key not in tables[language]]
        if missing_languages:
            missing_usage_errors.append(
                f"{key!r} used at {locations[0]} is missing from {', '.join(missing_languages)}"
            )

    format_errors: list[str] = []
    all_keys: set[str] = set()
    for table in tables.values():
        all_keys.update(table)
    for key in sorted(all_keys):
        expected = format_signature(key)
        for language in LANGUAGES:
            value = tables[language].get(key)
            if value is None:
                continue
            actual = format_signature(value)
            if actual != expected:
                format_errors.append(
                    f"{language} {key!r}: expected {expected}, found {actual} in {value!r}"
                )

    print_details("Localization key-set mismatches", key_set_errors)
    print_details("Literal L10n.tr keys missing translations", missing_usage_errors)
    print_details("Format-placeholder signature mismatches", format_errors)
    error_count = len(key_set_errors) + len(missing_usage_errors) + len(format_errors)
    if error_count:
        print(f"Localization check failed with {error_count} error(s).", file=sys.stderr)
        return 1

    summary = (
        f"Localization check passed: {len(reference_keys)} keys in {len(LANGUAGES)} languages; "
        + f"{len(usages)} literal L10n.tr keys verified."
    )
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
