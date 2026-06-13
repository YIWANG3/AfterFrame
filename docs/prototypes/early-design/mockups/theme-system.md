# Theme System

This workspace should support both dark and light themes, but the primary mode is a neutral dark desktop UI similar in intensity to Lightroom's darkest library mode.

## Principles

- Backgrounds should be neutral black and graphite, not blue-black.
- Gold is the only warm accent and should stay scarce.
- Most separators should come from value contrast, not visible outlines.
- Containers should disappear behind the content whenever possible.
- Selected state should read immediately without making the rest of the UI noisy.

## Dark Tokens

- `bg.app`: `#101010`
- `bg.chrome`: `#151515`
- `bg.sidebar`: `#181818`
- `bg.panel`: `#1D1D1D`
- `bg.hover`: `#252525`
- `bg.selected`: `#2B2B2B`
- `border.subtle`: `#262626`
- `text.primary`: `#F2F2F2`
- `text.secondary`: `#B0B0B0`
- `text.tertiary`: `#7D7D7D`
- `accent.primary`: `#C49452`
- `accent.primaryStrong`: `#D5A35F`
- `accent.success`: `#8EBB8B`
- `accent.warning`: `#D8BC87`
- `accent.error`: `#C97E68`

## Light Tokens

- `bg.app`: `#F2F0EC`
- `bg.chrome`: `#ECE8E1`
- `bg.sidebar`: `#E7E3DC`
- `bg.panel`: `#FBF8F2`
- `bg.hover`: `#E4DED4`
- `bg.selected`: `#DED6CB`
- `border.subtle`: `#D8D0C5`
- `text.primary`: `#1A1A1A`
- `text.secondary`: `#54504A`
- `text.tertiary`: `#8A8378`
- `accent.primary`: `#B8833F`
- `accent.primaryStrong`: `#9F6E30`
- `accent.success`: `#557A52`
- `accent.warning`: `#9A7A3E`
- `accent.error`: `#A15D49`

## Usage Rules

- Default shell, sidebars, and inspectors use `bg.chrome` or `bg.sidebar`.
- Grid canvas should usually stay on `bg.app` to keep the thumbnails dominant.
- Avoid drawing borders around every card. Use:
  - background contrast for grouping
  - one selected ring or glow for focus
  - thin separators only in lists and inspectors
- Gold should appear in:
  - current selection
  - primary call to action
  - active segmented control
  - key review status
- Gold should not appear as a global wash or broad background tint.

## Theme Switch Behavior

- Theme switch changes tokens only, not layout.
- Density, panel widths, and information hierarchy must remain identical between themes.
- Thumbnails and media content should keep their own colors and not be tinted by the app theme.
