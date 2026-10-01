// Reviewed corrections to what the sources give, applied by buildNames after
// the rules: [make, model, name, why]. A name replaces the source's; null
// drops the entry. Keys as in generated.json (normKey). Each entry was checked
// against Wikimedia Commons file metadata, Flickr camera pages, LibRaw /
// RawSpeed / lensfun lists and the maker's pages, then challenged by a second
// reviewer (2026-10-01). A camera the sources lack goes into manual.json.

export const CORRECTIONS = [
  // DJI
  ["dji", "ac003", "DJI Osmo Action 4", "AC003 is the Action 4 (retail model numbers); catmapping says Action 3"],
  ["dji", "c6510", null, "a Wikidata slip: the Zenmuse X4S writes FC6510 (in manual.json)"],
  ["dji", "fc2204", "DJI Mavic 2 Zoom", "Flickr's Mavic 2 Zoom is FC2204 (93k photos); Wikidata says Mavic 2 Enterprise"],
  ["dji", "fc2220", null, "unconfirmed: likely the Mavic 2 Enterprise Zoom, not the Mavic 2 Zoom"],
  ["dji", "fc2403", "DJI Mavic 2 Enterprise Dual", "the Dual's visual camera (4056x3040, no zoom)"],
  ["osmo", "oq001e", null, "Wikidata says Avata 360 but cites Osmo 360 samples; the Avata 360 writes FCA188"],
  // Hasselblad
  ["hasselblad", "hasselblad 500 mech.", null, "a CFV back on any V body writes it; the body is a guess"],
  ["hasselblad", "ixpress 132c-22", null, "already the back's name"],
  ["hasselblad", "xplan ll", null, "a film camera, typed on a scan"],
  // Sony: the RX line goes by Cyber-shot, generations by numeral
  ["sony", "dsc-rx0m2", "Sony Cyber-shot DSC-RX0 II", "house style of the RX line"],
  ["sony", "dsc-rx100m2", "Sony Cyber-shot DSC-RX100 II", "Sony's name is RX100 II, not Mark II"],
  ["sony", "dsc-rx100m7a", "Sony Cyber-shot DSC-RX100 VII", "the RX100 VII with external charging, sold as RX100 VII"],
  ["sony", "dsc-rx1rm2", "Sony Cyber-shot DSC-RX1R II", "house style of the RX line"],
  ["sony", "dsc-rx1rm3", "Sony Cyber-shot DSC-RX1R III", "house style of the RX line"],
  ["sony", "hdr-as30v", null, "already the product's name"],
  // Nikon: film bodies and edited files
  ["nikon", "ds-l1-5m", null, "a microscope camera"],
  ["nikon", "f2 photomic a", null, "a film camera, typed on a scan"],
  ["nikon", "n5005", null, "a film camera, typed on a scan"],
  ["nikon", "n75", null, "a film camera, typed on a scan"],
  ["nikon", "n80", null, "a film camera, typed on a scan"],
  ["nikon", "new fm2", null, "a film camera, typed on a scan"],
  ["nikon", "nikon n65", null, "a film camera, typed on a scan"],
  ["nikon", "nikon one touch 100", null, "a film camera, typed on a scan"],
  ["nikon", "vba560ae", null, "a phone photo with edited tags"],
  ["nikon corporation", "e3200", null, "files rewritten by a tool; the camera writes NIKON"],
  // Autel writes EVO in capitals
  ["autel robotics", "xb015", "Autel Robotics EVO", "Autel's spelling"],
  ["autel robotics", "xl709", "Autel Robotics EVO II Dual 640T V3", "Autel's spelling"],
  ["autel robotics", "xl720", "Autel Robotics EVO Lite+", "Autel's spelling"],
  ["autel robotics", "xl724", "Autel Robotics EVO Nano+", "Autel's spelling"],
  ["autel robotics", "xt701", "Autel Robotics EVO II", "Autel's spelling"],
  ["autel robotics", "xt705", "Autel Robotics EVO II Pro", "Autel's spelling"],
  ["autel robotics", "xt709", "Autel Robotics EVO II Dual 640T", "the V1/V2 640T; V3 writes XL709"],
  // Canon
  ["canon", "canon elura60", null, "the Americas' name; MVX200i elsewhere"],
  ["canon", "canon eos m50 m2", null, "edited files; the camera writes Canon EOS M50m2"],
  ["canon", "canon m50 m2", null, "typed; the camera writes Canon EOS M50m2"],
  ["canon", "canon vixia hf r20", null, "already the product's name"],
  // Fujifilm
  ["fujifilm", "a170 a180", null, "already the product's name (both markets)"],
  ["fujifilm", "fujifilm a170 a180", null, "already the product's name (both markets)"],
  ["fujifilm", "fujifilm a220 a230", null, "already the product's name (both markets)"],
  ["fujifilm", "ds-20", null, "the Japanese Clip-it DS-20; the DX-7 writes DX-7"],
  ["fujifilm", "ds-30", null, "the Japanese Clip-it DS-30; the DX-9 writes DX-9"],
  ["fujifilm", "hc-300/hc-300z", null, "already the product's name"],
  ["fujifilm", "fi019", "Fujifilm Instax mini Evo", "Fujifilm writes mini in lower case"],
  ["fujifilm", "hm1", "Fujifilm Instax mini LiPlay", "Fujifilm's spelling"],
  // GoPro
  ["gopro", "gdh30", "GoPro Digital HERO 3", "GoPro's spelling (3 megapixels)"],
  ["gopro", "gopro hd2", null, "edited files; the camera writes HD2"],
  // Olympus
  ["olympus corporation", "c5060wz", "Olympus C-5060 Wide Zoom", "one name worldwide, as its siblings"],
  ["olympus corporation", "ferrarimodel2003", null, "already the product's name"],
  ["olympus corporation", "ferrarimodel2004", null, "already the product's name"],
  // Panasonic
  ["panasonic", "ag-gh4", null, "the pro GH4's own name"],
  ["panasonic", "dc-lx100m2", "Panasonic Lumix DC-LX100 II", "Panasonic's name, as the G9 II and GH5 II"],
  ["panasonic", "dc-s1m2", "Panasonic Lumix DC-S1 II", "Panasonic's name, as the G9 II and GH5 II"],
];
