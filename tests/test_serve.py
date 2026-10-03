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

    def test_read_image_metadata_is_served_without_a_catalog_db(self) -> None:
        # Edited exports re-attach the source's EXIF through this command; it
        # must work in the resident process (packaged builds have no python3
        # with the sidecar source on its path) and must not open the catalog.
        from PIL import Image

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "相册" / "IMG_0001.jpg"
            source.parent.mkdir()
            exif = Image.Exif()
            exif[0x010F] = "TestMake"
            exif[0x0110] = "TestCam X1"
            Image.new("RGB", (8, 6), "gray").save(source, exif=exif)

            catalog = Path(temp_dir) / "demo.afcatalog"
            env = {**os.environ, "PYTHONPATH": str(SIDECAR_SRC)}
            proc = subprocess.Popen(
                ["python3", "-m", "media_workspace", "--catalog", str(catalog), "serve"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                env=env,
            )
            try:
                self.assertTrue(json.loads(proc.stdout.readline())["ready"])
                proc.stdin.write(json.dumps({"id": 1, "argv": ["read-image-metadata", "--path", str(source)]}) + "\n")
                proc.stdin.flush()
                resp = json.loads(proc.stdout.readline())
                self.assertEqual(resp["code"], 0, resp["error"])
                meta = json.loads(resp["stdout"])
                self.assertEqual(meta["camera_make"], "TestMake")
                self.assertEqual(meta["camera_model"], "TestCam X1")
                self.assertIn("gps_latitude", meta)
                self.assertFalse(catalog.exists())
            finally:
                proc.stdin.close()
                self.assertEqual(proc.wait(timeout=10), 0)
                proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
