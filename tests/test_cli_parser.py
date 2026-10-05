"""The resident sidecar answers every request through main(), with one
argument parser built for the process: a request must leave nothing in it
for the next one."""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog


class ResidentParserTest(unittest.TestCase):
    def test_the_parser_is_built_once(self) -> None:
        self.assertIs(cli._get_parser(), cli._get_parser())

    def test_a_request_keeps_none_of_the_last_ones_options(self) -> None:
        parser = cli._get_parser()
        first = parser.parse_args(["--catalog", "/c", "generate-previews", "--kind", "preview-hd", "--path", "/a.jpg", "--path", "/b.jpg"])
        second = parser.parse_args(["--catalog", "/c", "generate-previews", "--kind", "preview-hd", "--path", "/c.jpg"])
        third = parser.parse_args(["--catalog", "/c", "generate-previews", "--kind", "preview-hd"])
        self.assertEqual([str(p) for p in first.paths], ["/a.jpg", "/b.jpg"])
        self.assertEqual([str(p) for p in second.paths], ["/c.jpg"])
        self.assertIsNone(third.paths)

    def test_requests_in_a_row_answer_as_one_shots_do(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            catalog = ensure_catalog(Path(tmp) / "requests.afcatalog")

            def request(*argv: str) -> object:
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(cli.main(["--catalog", str(catalog.root), *argv]), 0)
                return json.loads(out.getvalue())

            summary = request("summary")
            self.assertEqual(request("list-active-jobs"), [])
            self.assertEqual(request("summary"), summary)
            self.assertEqual(request("browse-images", "--status", "all", "--limit", "5"), [])


if __name__ == "__main__":
    unittest.main()
