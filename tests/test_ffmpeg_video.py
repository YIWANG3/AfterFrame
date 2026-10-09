"""Video through FFmpeg answers as the macOS video-tool does
(media_workspace.ffmpeg_video): ffprobe's JSON read the way AVFoundation
reports a clip, the same sample times, and, where an FFmpeg is installed,
real posters, frames and playback proxies."""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from PIL import Image

from media_workspace import cli, ffmpeg_video, video

TOOLS = ffmpeg_video.find_tools()


def _iphone_portrait() -> dict:
    # What ffprobe says about an iPhone clip held upright.
    return {
        "streams": [
            {
                "codec_type": "video", "codec_name": "hevc", "codec_tag_string": "hvc1",
                "width": 3840, "height": 2160, "avg_frame_rate": "30000/1001", "r_frame_rate": "30/1",
                "color_transfer": "arib-std-b67",
                "side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}],
                "disposition": {"attached_pic": 0},
            },
            {"codec_type": "audio", "codec_name": "aac", "codec_tag_string": "mp4a"},
        ],
        "format": {
            "duration": "12.345000",
            "tags": {"creation_time": "2026-05-01T02:20:31.000000Z", "com.apple.quicktime.creationdate": "2026-05-01T10:20:30+0800"},
        },
    }


class DescribeTest(unittest.TestCase):
    def test_an_upright_phone_clip_is_taller_than_wide_and_dated_in_utc(self) -> None:
        self.assertEqual(ffmpeg_video.describe(_iphone_portrait()), {
            "duration": 12.345,
            "width": 2160,
            "height": 3840,
            "fps": 30000 / 1001,
            "codec": "hvc1",
            "hasAudio": True,
            # Apple's key, local time with its offset, wins over the container's.
            "creationDate": "2026-05-01T02:20:30Z",
        })

    def test_a_clip_without_a_four_character_code_or_apple_date(self) -> None:
        info = {
            "streams": [{"codec_type": "video", "codec_name": "h264", "codec_tag_string": "[0][0][0][0]",
                         "width": 1920, "height": 1080, "avg_frame_rate": "0/0", "r_frame_rate": "25/1",
                         "tags": {"rotate": "180"}}],
            "format": {"duration": "3.0", "tags": {"creation_time": "2024-03-02T10:00:00.000000Z"}},
        }
        self.assertEqual(ffmpeg_video.describe(info), {
            "duration": 3.0, "width": 1920, "height": 1080, "fps": 25.0, "codec": "h264",
            "hasAudio": False, "creationDate": "2024-03-02T10:00:00Z",
        })

    def test_cover_art_is_not_the_video_and_non_square_pixels_are_shown_wider(self) -> None:
        info = {
            "streams": [
                {"codec_type": "video", "codec_name": "mjpeg", "width": 600, "height": 600, "disposition": {"attached_pic": 1}},
                {"codec_type": "video", "codec_name": "dvvideo", "codec_tag_string": "dvc ", "width": 720, "height": 480,
                 "sample_aspect_ratio": "8:9", "avg_frame_rate": "30000/1001"},
            ],
            "format": {"duration": "1.5", "tags": {"creation_time": "1970-01-01T00:00:00.000000Z"}},
        }
        clip = ffmpeg_video.describe(info)
        self.assertEqual((clip["width"], clip["height"], clip["codec"]), (640, 480, "dvc"))
        self.assertIsNone(clip["creationDate"])  # a zero time is no date

    def test_a_file_with_no_picture_has_no_answer(self) -> None:
        with self.assertRaises(ffmpeg_video.VideoToolError):
            ffmpeg_video.describe({"streams": [{"codec_type": "audio"}], "format": {"duration": "1"}})


def _times(duration: float, **kwargs: Any) -> list[float]:
    return [round(t, 6) for t in ffmpeg_video.sample_times(duration, **kwargs)]


class SampleTimesTest(unittest.TestCase):
    # The values video-tool's sampleTimes gives for the same arguments.
    def test_three_by_default_inset_from_the_end(self) -> None:
        self.assertEqual(_times(10.0), [0.0, 5.0, 9.9])

    def test_an_interval_adds_the_first_middle_and_last_and_drops_near_duplicates(self) -> None:
        self.assertEqual(_times(3.0, interval=1.0), [0.0, 1.0, 1.5, 2.0, 2.94])

    def test_at_most_max_frames_keeping_the_first_and_last(self) -> None:
        times = _times(100.0, interval=1.0, max_frames=20)
        self.assertEqual(len(times), 20)
        self.assertEqual((times[0], times[-1]), (0.0, 99.9))

    def test_count_spreads_evenly(self) -> None:
        self.assertEqual(_times(2.0, count=5), [0.0, 0.5, 1.0, 1.5, 1.96])


class WithoutFFmpegTest(unittest.TestCase):
    def test_video_degrades_as_with_no_video_tool(self) -> None:
        with mock.patch.dict("os.environ", {"VIDEO_TOOL_PATH": ""}), \
                mock.patch.object(ffmpeg_video, "find_tools", return_value=None):
            self.assertIsNone(video.probe(Path("clip.mp4")))
            self.assertFalse(video.poster(Path("clip.mp4"), Path("poster.jpg")))
            self.assertEqual(video.frames(Path("clip.mp4"), Path("frames")), [])


@unittest.skipUnless(TOOLS, "no FFmpeg here")
class WithFFmpegTest(unittest.TestCase):
    """Against a clip FFmpeg makes itself: 2 s of a 640×360 test pattern and a
    tone, in MPEG-4 Part 2, which every FFmpeg can write."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.temp.name)
        cls.clip = cls.dir / "pattern.mp4"
        assert TOOLS is not None
        subprocess.run(
            [TOOLS[0], "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi",
             "-i", "sine=frequency=440", "-t", "2", "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac", str(cls.clip)],
            check=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def test_probe(self) -> None:
        clip = ffmpeg_video.probe(self.clip)
        self.assertEqual((clip["width"], clip["height"], clip["codec"], clip["hasAudio"]), (640, 360, "mp4v", True))
        self.assertAlmostEqual(clip["duration"], 2.0, delta=0.1)
        self.assertAlmostEqual(clip["fps"], 25.0)

    def test_a_poster_is_never_enlarged_but_is_made_smaller(self) -> None:
        poster = self.dir / "poster.jpg"
        ffmpeg_video.poster(self.clip, poster)
        with Image.open(poster) as image:
            self.assertEqual((image.format, image.size), ("JPEG", (640, 360)))
        ffmpeg_video.poster(self.clip, poster, max_edge=320)
        with Image.open(poster) as image:
            self.assertEqual(image.size, (320, 180))

    def test_frames_and_their_manifest(self) -> None:
        out = self.dir / "frames"
        manifest = ffmpeg_video.frames(self.clip, out, count=4, max_edge=160)
        self.assertEqual([f["filename"] for f in manifest["frames"]], ["frame_0.jpg", "frame_1.jpg", "frame_2.jpg", "frame_3.jpg"])
        self.assertEqual(json.loads((out / "manifest.json").read_text(encoding="utf-8")), manifest)
        with Image.open(out / "frame_3.jpg") as image:
            self.assertEqual(image.size, (160, 90))

    def test_an_hdr_clip_is_tone_mapped(self) -> None:
        filters = subprocess.run([TOOLS[0], "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        if " zscale " not in filters:
            self.skipTest("this FFmpeg has no zscale")
        hlg = self.dir / "hlg.mov"
        subprocess.run(
            [TOOLS[0], "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "1",
             # Tagged on the frames: the encoder's colour options alone don't reach the file.
             "-vf", "setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc",
             "-c:v", "prores_ks", "-pix_fmt", "yuv422p10le", str(hlg)],
            check=True,
        )
        self.assertEqual(ffmpeg_video._video_stream(ffmpeg_video._probe_json(TOOLS[1], hlg))["color_transfer"], "arib-std-b67")
        poster = self.dir / "hlg.jpg"
        ffmpeg_video.poster(hlg, poster)
        with Image.open(poster) as image:
            self.assertEqual(image.size, (320, 180))

    def test_transcode_makes_an_h264_proxy_with_sound(self) -> None:
        if not ffmpeg_video._h264_encoders(TOOLS[0]):
            self.skipTest("this FFmpeg has no H.264 encoder")
        proxy = self.dir / "proxy.mp4"
        ffmpeg_video.transcode(self.clip, proxy)
        clip = ffmpeg_video.probe(proxy)
        self.assertEqual((clip["codec"], clip["width"], clip["height"], clip["hasAudio"]), ("avc1", 640, 360, True))
        self.assertEqual([p.name for p in self.dir.glob("*.partial*")], [])

    def test_the_cli_answers_in_json(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(["video-tool", "probe", str(self.clip)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["width"], 640)


if __name__ == "__main__":
    unittest.main()
