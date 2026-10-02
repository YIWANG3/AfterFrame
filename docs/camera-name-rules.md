# 相机命名规则

app 里相机叫什么名字（界面上的品牌名、机型名，以及边框上印的机型文字）按下面的顺序决定，前面的优先：

1. **用户改的名字**：设置 › 水印 › 相机 logo 里点机型名改，存在 `watermarkProfile.cameraNames`。
2. **手工表** `apps/desktop/camera-names/manual.json`：随 app 发布，发现显示成代码的新机型就加一行。
3. **规则**：只有三条，在 `apps/desktop/shared/cameraNameRules.mjs`。
   - 佳能：`EOS R6m2` 显示为 `EOS R6 Mark II`。
   - 尼康：`NIKON Z5_2` 显示为 `Nikon Z5II`。
   - 索尼：`ILCE-7CM2` 显示为 `Sony α7C II`，`ILCE-7CR` 显示为 `Sony α7CR`。
4. **生成表** `apps/desktop/camera-names/generated.json`：从 Wikidata 和 Wikimedia Commons（都是 CC0）生成，见 `camera-names/README.md`。只收白名单里的厂商：这些年还在出相机的厂商，加上小米（Redmi、POCO）、OPPO、一加、realme、vivo（iQOO）这几家国产手机；只翻译看不懂的型号代码，规则能命名的不收。子品牌手机按子品牌叫（Redmi Note 13 Pro+、iQOO 9 SE）。华为、荣耀不收：抽查发现约六分之一配成了别的市场或兄弟机型的名字，这两家的照片显示 EXIF 原文，常用机型以后手工加进手工表。
5. **EXIF 原文**。

代码在 `frameLogos.cameraNamer`，读表在 `render/cameraNames.js`。编辑器、设置页和 agent 的 apply_frame 都走同一个 namer。

## 表的格式

两张表格式相同，键是 EXIF 的 Make / Model 去掉多余空格、转小写：

```json
{
  "brands": { "make:yingling innovations pte. ltd.": "Antigravity" },
  "names": { "dji": { "fc9113": "DJI Air 3S" } }
}
```

- `names` 按 EXIF 厂商分组，显示名带品牌前缀（`DJI Air 3S`、`Sony α7 IV`），边框上直接印这个名字。
- `brands` 只在手工表里，给没有内置 logo 的厂商起名。键是 `make:` 加厂商原文。
- 同一品牌下不同厂商写法（`FUJIFILM` 和 `Fuji Photo Film Co., Ltd.`）共用一个品牌，表里任一写法的条目对整个品牌生效。

## 同名即同一台

同一品牌下显示名相同的机型算同一台相机，共用机型 logo。大疆一架飞机的几个镜头写不同代码（Air 3S 是 FC9113 和 FC9184），表里都叫「DJI Air 3S」，给其中一个设的机型 logo 另一个也用。

- 选择只存在设置它的那个机型上，其他同名机型读的时候借用。在任一个上选「默认」会把整台的选择清掉。
- 用户把两个机型改成同一个名字，效果一样。
- 机型 logo 按 EXIF 原文存键（`dji#fc9113`），改表或改名不会让已设好的 logo 失效。

## 品牌归属

EXIF 厂商里包含 `frame-logos/logos.json` 的 `match` 字样就归到那个内置品牌，不区分大小写。几条特别的：

| EXIF 厂商 | 品牌 | 说明 |
|---|---|---|
| Osmo | 大疆 | Osmo 360 的厂商写的是「Osmo」 |
| Hasselblad | 哈苏 | 大疆飞机上的哈苏主摄也写 Hasselblad，归哈苏品牌、显示哈苏 logo |
| Yingling Innovations Pte. Ltd. | 没有内置品牌 | 手工表起名 Antigravity |

大疆飞机上的哈苏相机，显示名按飞机来：L1D-20c 是 DJI Mavic 2 Pro，L2D-20c 是 DJI Mavic 3（Mavic 3 各款共用），L3D-100c 是 DJI Mavic 4 Pro。它们和同一架飞机的其他镜头不在同一个品牌下，所以机型 logo 要分开设。

大疆各型号代码的出处见 [dji-camera-models.md](dji-camera-models.md)。

## 什么时候加表

- 显示成代码、看不出是什么相机：加手工表。
- 生成表里的名字不对或没用：写进 `apps/desktop/scripts/camera-names/corrections.mjs`（改名或删掉，附原因），重新生成。不要直接改 generated.json，重新生成会冲掉。
- 只是大小写或前缀不统一（`LEICA M11-P`）：不管，按 EXIF 原文。
