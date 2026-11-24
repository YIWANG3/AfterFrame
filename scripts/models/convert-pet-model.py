#!/usr/bin/env python3
"""Build AfterFrame's pet identity model: DINOv2 as a Core ML package.

The People Worker (`--pet-model`) pads each cat or dog to a square, scales
it to 224x224 and feeds it to this package as an RGB image; `embedding` is
the [CLS] token of DINOv2's last layer. See docs/pet-recognition-design.md.

What the conversion bakes in:
- ImageNet normalisation, because a Core ML image input can only scale all
  channels alike;
- DINOv2's position table resized to the 16x16 patch grid of a 224 input.
  The model resizes its 37x37 table with a bicubic interpolation on every
  call; the input never changes size here, so the result is a constant.

Output is an fp16 ML Program for macOS 14. Run it in a throwaway venv:

    python3.11 -m venv /tmp/convert && /tmp/convert/bin/pip install \
        torch==2.7.0 transformers==4.53.3 coremltools==9.0 pillow
    /tmp/convert/bin/python scripts/models/convert-pet-model.py \
        --out apps/desktop/native/PetEmbedding.mlpackage

The weights are Meta's (Apache-2.0), fetched from Hugging Face at a pinned
revision unless --weights points at a local copy of the same files.
Converting twice gives the same numbers but not the same bytes (Core ML
writes fresh ids into the package), so the build pins the published
archive's hash, not this script's output.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import coremltools as ct
import numpy as np
import torch
from transformers import Dinov2Model

SIZE = 224
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]
REPOS = {"small": "facebook/dinov2-small", "base": "facebook/dinov2-base"}
# Revisions current on 2026-11-22 (last changed 2023-09-06).
REVISIONS = {"small": "ed25f3a31f01632728cabb09d1542f84ab7b0056"}


class Embedder(torch.nn.Module):
    def __init__(self, model: Dinov2Model):
        super().__init__()
        self.model = model.eval()
        embeddings = self.model.embeddings
        with torch.no_grad():
            dummy = torch.zeros(1, 1 + (SIZE // 14) ** 2, embeddings.position_embeddings.shape[-1])
            fixed = embeddings.interpolate_pos_encoding(dummy, SIZE, SIZE).clone()
        embeddings.interpolate_pos_encoding = lambda *_: fixed
        self.register_buffer("mean", torch.tensor(MEAN).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(STD).view(1, 3, 1, 1))

    def forward(self, image: torch.Tensor) -> torch.Tensor:  # image in [0, 1]
        hidden = self.model(pixel_values=(image - self.mean) / self.std).last_hidden_state
        return hidden[:, 0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", choices=sorted(REPOS), default="small")
    parser.add_argument("--weights", type=Path, help="a local directory with config.json and model.safetensors")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    source = str(args.weights) if args.weights else REPOS[args.size]
    revision = None if args.weights else REVISIONS.get(args.size)
    model = Dinov2Model.from_pretrained(source, revision=revision, attn_implementation="eager")
    module = Embedder(model).eval()
    example = torch.rand(1, 3, SIZE, SIZE)
    with torch.no_grad():
        traced = torch.jit.trace(module, example)

    mlmodel = ct.convert(
        traced,
        inputs=[ct.ImageType(name="image", shape=(1, 3, SIZE, SIZE), scale=1 / 255.0, color_layout=ct.colorlayout.RGB)],
        outputs=[ct.TensorType(name="embedding")],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS14,
    )
    mlmodel.short_description = f"Pet identity embedding: DINOv2 {args.size} [CLS], 224x224 RGB in"
    mlmodel.license = "Apache-2.0 (DINOv2 weights by Meta)"
    mlmodel.input_description["image"] = "A cat or dog, padded to a square with mid grey"
    mlmodel.output_description["embedding"] = "DINOv2 [CLS] token; L2-normalise before comparing"
    mlmodel.user_defined_metadata["source"] = f"{REPOS[args.size]}@{revision or 'local'}"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    mlmodel.save(str(args.out))

    # The same input through Core ML on the CPU and through PyTorch: the
    # conversion is right when these agree (fp16 keeps cosine above 0.999).
    from PIL import Image

    pixels = (np.random.default_rng(0).random((SIZE, SIZE, 3)) * 255).round().astype(np.uint8)
    loaded = ct.models.MLModel(str(args.out), compute_units=ct.ComputeUnit.CPU_ONLY)
    got = np.asarray(loaded.predict({"image": Image.fromarray(pixels)})["embedding"], dtype=np.float64).reshape(-1)
    with torch.no_grad():
        want = module(torch.from_numpy(pixels).permute(2, 0, 1)[None].float() / 255).numpy().reshape(-1)
    cosine = float(got @ want / (np.linalg.norm(got) * np.linalg.norm(want)))
    print(f"saved {args.out}: {got.size} dimensions, cosine(Core ML, PyTorch) = {cosine:.5f}")
    if cosine < 0.999:
        raise SystemExit("conversion check failed: Core ML and PyTorch disagree")


if __name__ == "__main__":
    main()
