# Official VEILSTRIKE logo integration report

## Authoritative source

The supplied `/home/user/uploads/image-1.jpeg` is **877 × 877 pixels, RGB, JPEG, no alpha channel**. Its bytes were copied without alteration to `assets/logo-veilstrike.jpg`; SHA-256 of both source and project copy is `b1da1e85ac32e29cf20cf6b0cfdcda563c45f61f783ed7b8f58c3490b359f16e`.

The source image has an opaque dark background, so transparency could not be preserved or created. No crop, recoloring, redraw, or distortion was applied. Generated size variants use proportional square resizing from the supplied square artwork.

## Locations

- Loading screen: full provided artwork at `assets/logo-veilstrike.jpg`.
- Main menu brand: `assets/logo-veilstrike.jpg`.
- Campaign/theater selection: `assets/logo-veilstrike.jpg`.
- Pause screen: `assets/logo-veilstrike.jpg`.
- In-game HUD: compact source-derived `favicon-48.png` mark in the top-left safe corner, pointer-events disabled.
- Shared topbar avatar and application surfaces: source-derived manifest/favicon icons.

## Generated icon variants

`assets/icons/favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `apple-touch-icon.png` (180×180), `icon-192.png`, `icon-512.png`, `maskable-192.png`, and `maskable-512.png`. Manifest declarations reference 192×192 and 512×512 standard and maskable variants. Browser-tab icon links declare 16, 32, and 48 pixel files.

## Verification limits

File dimensions, source hash, paths, and manifest declarations were checked. The automated static report verifies all declared paths exist. No browser was available to visually inspect clipping or mobile/desktop rendering, so browser visual verification and screenshot capture are outstanding.
