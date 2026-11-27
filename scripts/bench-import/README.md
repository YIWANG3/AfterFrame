# 导入性能测量

测导入任务和人脸任务的耗时，结果写在 [docs/import-pipeline-redesign.md](../../docs/import-pipeline-redesign.md)。不改仓库代码：`measure.py` 在进程里给 sidecar 的函数套上计时器，再走 CLI 的真实入口。只用临时图库，别指向真实图库。

```bash
B=$TMPDIR/bench-import
```

```bash
python3 scripts/bench-import/make_dataset.py apps/desktop/sample-photos $B/photos 400 100
```

用内置样片生成 400 张 2400 万像素 JPEG 和 100 张 1200 万像素 HEIC（约 3.6 GB，HEIC 编码慢，M3 Pro 上要 12 分钟）。

加 `--sips` 用系统的硬件编码器出 HEIC，一两分钟就好，风扇也安静得多；加 `--workers 4` 限制进程数。两种 HEIC 不能混着比，前后对比用同一批。

```bash
python3 scripts/bench-import/measure.py import $B/cat.afcatalog $B/photos > $B/import.json
```

```bash
python3 scripts/bench-import/measure.py people $B/cat.afcatalog > $B/people.json
```

- 同一个图库再跑一次 `import` 就是「重新导入已导入的文件夹」。
- `BENCH_WORKERS=12` 改出图线程数（默认是核数的一半）。
- `BENCH_SIDECAR_SRC=<目录>` 换一份 sidecar 源码来测，用来比较改动前后（见下）。
- `micro.py <photos> <out>`：单张、无并发时各格式出图、取色的耗时。
- `imageio_thumb.swift`：系统 ImageIO 出 512 缩略图的耗时，用 Xcode 的工具链编译：

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -O scripts/bench-import/imageio_thumb.swift -o $B/imageio_thumb
```

比较改动前后：先导出改动前那个提交的 sidecar 源码，再让 `BENCH_SIDECAR_SRC` 指过去，测量脚本本身用当前的。每次都用新的图库目录。

```bash
mkdir -p $B/before && git archive <改动前的提交> services/sidecar/src | tar -x -C $B/before
```

```bash
BENCH_SIDECAR_SRC=$B/before/services/sidecar/src python3 scripts/bench-import/measure.py import $B/cat-before.afcatalog $B/photos > $B/before.json
```

`results-2026-11-26/` 是原始输出：不带前缀的是第一次测量，`step1-*`、`step2-*` 是重新设计第 1、2 步前后的对比（见重新设计 §1.6、§1.7）。输出里 `main |` 是索引和写库的主线程，`thread |` 是出图线程（各线程时间相加）；带 `(incl.)` 的包含它里面的子步骤。
