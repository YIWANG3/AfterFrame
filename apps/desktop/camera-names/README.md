# camera-names

What a camera is called in the app (the model name in the UI and the text
printed on a frame), by its EXIF make and model. Two tables:

| File | What | Edit it? |
|---|---|---|
| `manual.json` | Hand-kept names (and brand names under `brands`). Wins over `generated.json`. | Yes: add a line when a camera shows a raw code or a wrong name. |
| `generated.json` | Built from CC0 sources by `scripts/camera-names/build.mjs`, with the reviewed fixes in `scripts/camera-names/corrections.mjs`. | No: regenerate it. A wrong or useless name goes into `corrections.mjs` with the reason (and, better, gets fixed upstream in Wikidata); a camera the sources lack goes into `manual.json`. |

Both have the same shape:

```jsonc
{
  "names": {
    "<make key>": { "<model key>": "<Display Name>" }
  }
}
```

Keys are the EXIF Make and Model exactly, with whitespace collapsed, trimmed and
lower-cased: `String(x).replace(/\s+/g, " ").trim().toLowerCase()` (the app's
`normalizeMake`). No fuzzy matching: `DMC-L10` and `DC-L10` are different
cameras. Names are the marketing name with the brand, in the brand's usual
spelling, in English: `Sony α7C II`, `Nikon Z5II`, `Canon EOS R6 Mark II`,
`DJI Air 3S`, `Leica M9`. English only, since the sources name few cameras in
Chinese.

The app looks a model up in the user's own names first (Settings), then
`manual.json`, then the rules in `shared/cameraNameRules.mjs` (Canon `R6m2`,
Nikon `Z5_2`, Sony `ILCE-7CM2`), then `generated.json`, then shows the EXIF
model as written.

`generated.json` only translates **codes** (DJI `FC9113` is `DJI Air 3S`,
Sony `DSC-RX100M3` is `Sony Cyber-shot DSC-RX100 III`, OPPO `CPH2385` is
`OPPO A57s`) for the **makers on the whitelist**: makers still selling cameras,
and the big Chinese phone makers. A model that already reads as the camera's name (`Canon EOS 6D`,
`CFV 100C/907X`) is shown as EXIF writes it.

## Sources

Both are CC0 1.0, so the table can ship with the app under any license and
without attribution requirements.

- **Wikidata**: items with an Exif model (P2009) and usually an Exif make
  (P2010), queried at `query.wikidata.org`. English label, else the
  language-neutral `mul` one. [CC0 1.0](https://www.wikidata.org/wiki/Wikidata:Licensing).
- **takenwith catmapping**: the table a Wikimedia Commons bot uses to file
  photos into "Taken with …" categories by EXIF make and model
  ([garyhouston/takenwith](https://github.com/garyhouston/takenwith), file
  `catmapping`). The author releases the catmapping file under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (see its README;
  the bot's code is MIT and is not used).

## Rules

`scripts/camera-names/filter.mjs` (pure functions, unit-tested in
`filter.test.mjs`) keeps a name only when it helps:

- **Makers**: only the EXIF Makes in `MAKES`, a whitelist by the Make the
  devices write now. Cameras: `Canon`, `NIKON CORPORATION`, `SONY`,
  `FUJIFILM`, `Panasonic`, `LEICA CAMERA AG`, `OM Digital Solutions`,
  `RICOH IMAGING COMPANY, LTD.`, `Hasselblad`, `SIGMA`, `Phase One`, `DJI`,
  `Osmo`, `Arashi Vision`, `Insta360`, `GoPro`, `Autel Robotics`, `Parrot`,
  `Skydio`, `Yingling Innovations Pte. Ltd.` (Antigravity). Phones: Huawei,
  Honor, Xiaomi (`Redmi`, `POCO`), OPPO, OnePlus, realme, vivo (`iQOO`).
  Other phones (Samsung, ZTE, Lenovo, Transsion...), makers out of cameras
  (Kodak, Casio, Minolta), Makes only old cameras write
  (`OLYMPUS IMAGING CORP.`, `PENTAX Corporation`) and anything typed into
  Make are left out. A phone sold under a camera maker's name (Sony's Xperia)
  is dropped, and so is a name that starts with another brand. A sub-brand's
  phone goes by the sub-brand (`Honor 10 Lite`, `Redmi Note 13 Pro+`).
- **Models a camera writes**: no brackets or quotes, no digital back on a
  body (`Ixpress 96 - Hasselblad H1`), no lens after the model
  (`GXR MOUNT A12_Summicron-M 35`), and a Canon model starts with `Canon`.
  A model typed by a person is dropped too: one whose name is a code
  (`alpha 7R III` named `Sony ILCE-7RM3`), or the name misspelled
  (`Canon ESO 600D`).
- **Codes only**: a model every part of which is in the name, or whose name is
  in the model, already names the camera (`M9 Digital Camera` is `Leica M9`)
  and is left out; so is a model one of the rules names, and one that lists
  every market's name (Olympus `X200,D560Z,C350Z`).
- **Reviewed corrections** (`corrections.mjs`): every camera entry was checked
  against Commons file metadata, Flickr camera pages, LibRaw / RawSpeed /
  lensfun and the maker's pages, then challenged by a second reviewer
  (2026-10-01). A correction renames an entry (`AC003` is the Osmo Action 4,
  not the 3) or drops it (film cameras typed on scans, a Wikidata slip, a
  market's name for a camera sold under several). The build lists corrections
  that no longer match an entry.

- **Wikidata items**: lens models (P31 Q109672300) are skipped, and so are
  series and list items (model series, Wikimedia list, product line: their
  label names a family). A DJI, Hasselblad or Osmo camera that is part of
  (P361) a drone takes the drone's name (FC9113 is `DJI Air 3S`), only when the
  target is a drone (instance or subclass of unmanned aerial vehicle,
  quadcopter or camera drone model) and not a series. An item without an Exif
  make takes the makes Commons saw with that exact model.
- **catmapping rows**: the first field is the make, the last the Commons
  category, everything between the model. Rows filed under anything but
  "Taken with" (scanners, software, ambiguous or invalid equipment), rows with
  an empty make or model, makes that are software (Adobe, apps, an OS,
  websites) and catch-all categories (ambiguous, unidentified, unknown) are
  dropped.
- **Adds information**: a name must say more than the EXIF model, ignoring
  case, spaces and the brand in front: `Sony ILCE-7CM2` adds nothing,
  `Sony α7C II` does; `Fujifilm X-T3` for `X-T3` adds nothing, so it is left to
  the EXIF.
- **Regional renames** are dropped: one camera sold under a name per market,
  EXIF one market's and the name another's (`Canon EOS REBEL T7i` named
  `Canon EOS 800D`; Canon Rebel / Kiss / IXUS / IXY / ELPH, Panasonic TZ / ZS,
  Minolta Dynax / Maxxum; or a Wikidata label that is another of the same
  item's EXIF models).
- **Other judgement calls**, each counted in the build summary: a name that
  drops the model's number (`iPad` for `iPad 4`), a bare DJI camera code for a
  model that is a name (`DJI FC3582` for `DJI Mini 3 Pro`), another model
  number in the same series (`FinePix F770EXR` for `FinePix F775EXR`, Lumix
  `DMC-FT5` for `DMC-TS5`), a list of models for a model that is one
  (`Canon HF R10 / R16`), and one person's camera (`AFF's Canon EOS 750D`).
- **Brand spelling** at the start of a name is normalized with a small map
  (`NIKON Z5II` becomes `Nikon Z5II`, `SONY` `Sony`, `FUJIFILM` `Fujifilm`);
  the rest of the name is left as the source has it. A name without a brand is
  not given one: guessing it from the make goes wrong too often.
- **Choosing**: Wikidata over catmapping; among Wikidata items the one with
  the most sitelinks, then the smallest Q id; among catmapping rows the name
  most rows give. A drone camera the Wikidata items name differently (the
  Hasselblad L2D-20c is on the Mavic 3, 3 Classic and 3 Pro) is dropped and
  listed as a conflict: name it in `manual.json` if needed.

## Sources not bundled

Other camera tables exist, but their terms would travel with the data:

- **Lensfun**: the database is CC BY-SA 3.0 (attribution and share-alike).
- **RawSpeed** (`cameras.xml`) and **LibRaw**: LGPL 2.1 (LibRaw also CDDL).
- **GPL tools**: ExifTool (Perl's terms: GPL or Artistic), Exiv2 (GPL 2),
  darktable, RawTherapee and ART (GPL 3), digiKam (GPL 2).
- **PhotoPrism**: AGPL 3.
- **Flickr** camera pages: no license for reuse; Flickr's terms of service.
- **Adobe** supported-camera lists (Camera Raw, DNG Converter): Adobe's
  copyright, no license for reuse.

They are fine for checking a name by hand; a name found there goes into
`manual.json` as our own entry, not copied in bulk.

## Regenerate

From the repository root:

```sh
node apps/desktop/scripts/camera-names/build.mjs
```

It fetches both sources (Wikidata's query service can take a minute), writes
`generated.json` (keys sorted, one name per line) and prints the names per
make, what was dropped and why, and the conflicts. `--wikidata <file>` and
`--catmapping <file>` read saved copies instead of fetching. Review the diff
before committing: the sources change, and a new wrong name belongs in
`manual.json`.

Tests: `cd apps/desktop && node --test scripts/camera-names/filter.test.mjs`
(also part of `npm run test:electron`).
