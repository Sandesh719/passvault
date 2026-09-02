# Build resources

`icon.png` is the source for every icon the app shows: the macOS `.icns`, the
Windows `.ico`, and the mark in the window's own corner. electron-builder
renders the platform formats from it at package time, so there is one file to
change and no set of derived icons to keep in step.

Requirements: **PNG, square, 1024×1024**, with transparency where the artwork
does not reach the edges. Smaller than 512×512 and macOS has nothing to show at
full size; non-square and both platforms distort it.

`pnpm --filter @passvault/desktop icons` checks those before a build does, and
every `package:*` script runs it first. That check exists because
electron-builder falls back to the default Electron icon and mentions it in one
line among hundreds — which is exactly how the first builds shipped generic.

## Replacing the logo

`icon-source.png` is the artwork as supplied: 728×606, on an opaque white
background. `icon.png` was derived from it by

1. flood-filling inward from the border through light pixels, so the background
   becomes transparent while the keyhole — light, but sealed inside the solid
   shield — stays white,
2. taking alpha from each cleared pixel's distance from white, so anti-aliased
   edges fade out instead of leaving a pale fringe on a dark dock,
3. padding to a 728×728 square, centred, and
4. resampling to 1024×1024.

Supplying a square PNG with real transparency skips all of that; drop it in as
`icon.png` and the check will pass.
