"""Every program the sidecar starts is started without a window on Windows:
there a background job's ExifTool, RAW decoder or video tool otherwise opens
a terminal window on the user's screen (media_workspace.processes). Nothing
shows it on macOS, so the sources are checked."""
from __future__ import annotations

import ast
import sys
import unittest
from collections.abc import Iterator
from pathlib import Path
from unittest import mock

import media_workspace
from media_workspace import processes

PACKAGE = Path(media_workspace.__file__).parent
STARTERS = {"Popen", "run", "call", "check_call", "check_output"}


def _starts(tree: ast.AST) -> Iterator[ast.Call]:
    """The subprocess calls in `tree` that start a program."""
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "subprocess"
            and node.func.attr in STARTERS
        ):
            yield node


def _without_window(call: ast.Call) -> bool:
    return any(
        keyword.arg is None
        and isinstance(keyword.value, ast.Call)
        and isinstance(keyword.value.func, ast.Name)
        and keyword.value.func.id == "no_window"
        for keyword in call.keywords
    )


class NoWindowTest(unittest.TestCase):
    def test_windows_gets_a_console_without_a_window(self) -> None:
        with mock.patch.object(sys, "platform", "win32"):
            self.assertEqual(processes.no_window(), {"creationflags": 0x08000000})

    def test_other_systems_get_nothing(self) -> None:
        for platform in ("darwin", "linux"):
            with mock.patch.object(sys, "platform", platform):
                self.assertEqual(processes.no_window(), {})

    def test_every_program_the_sidecar_starts_has_no_window(self) -> None:
        starts: list[str] = []
        missing: list[str] = []
        for source in sorted(PACKAGE.rglob("*.py")):
            tree = ast.parse(source.read_text(encoding="utf-8"))
            where = source.relative_to(PACKAGE)
            for node in ast.walk(tree):
                # Popen or run imported by name would hide from this check.
                if isinstance(node, ast.ImportFrom) and node.module == "subprocess":
                    missing.append(f"{where}:{node.lineno} imports from subprocess")
            for call in _starts(tree):
                starts.append(f"{where}:{call.lineno}")
                if not _without_window(call):
                    missing.append(f"{where}:{call.lineno}")
        self.assertIn("exiftool.py", " ".join(starts))  # it finds them
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
