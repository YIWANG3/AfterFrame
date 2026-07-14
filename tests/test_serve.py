from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SIDECAR_SRC = Path(__file__).resolve().parents[1] / "services" / "sidecar" / "src"


class ServeProtocolTest(unittest.TestCase):
    """Line-delimited JSON protocol of the resident `serve` mode."""

    def test_roundtrip_and_error_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = Path(temp_dir) / "demo.afcatalog"
            env = {**os.environ, "PYTHONPATH": str(SIDECAR_SRC)}
            proc = subprocess.Popen(
                ["python3", "-m", "media_workspace", "--catalog", str(catalog), "serve"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                env=env,
            )
            try:
                ready = json.loads(proc.stdout.readline())
                self.assertTrue(ready["ready"])

                def call(request_id, argv):
                    proc.stdin.write(json.dumps({"id": request_id, "argv": argv}) + "\n")
                    proc.stdin.flush()
                    return json.loads(proc.stdout.readline())

                # Happy path: summary against the (empty) catalog
                resp = call(1, ["summary", "--json"])
                self.assertEqual(resp["id"], 1)
                self.assertEqual(resp["code"], 0)
                self.assertEqual(json.loads(resp["stdout"])["assets"], 0)

                # Second request on the same process (the whole point of serve)
                resp2 = call(2, ["list-active-jobs"])
                self.assertEqual(resp2["code"], 0)

                # Unknown command: non-zero code, error captured (not a crash)
                bad = call(3, ["bogus-command"])
                self.assertNotEqual(bad["code"], 0)
                self.assertTrue(bad["error"])

                # Malformed line is ignored; the loop keeps serving
                proc.stdin.write("not json\n")
                proc.stdin.flush()
                resp3 = call(4, ["summary", "--json"])
                self.assertEqual(resp3["id"], 4)
                self.assertEqual(resp3["code"], 0)
            finally:
                proc.stdin.close()
                self.assertEqual(proc.wait(timeout=10), 0)
                proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
