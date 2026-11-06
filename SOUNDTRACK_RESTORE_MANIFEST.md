# VEILSTRIKE — Exact Soundtrack Filename Manifest

## Required original files

The player retains the existing three track IDs, display names, and controls. Its exact root-relative
file paths are:

| Track ID | Display name | Required deployment path |
|---|---|---|
| `mortals` | MORTALS | `/assets/music/MORTALS.mp3` |
| `ins-fearless-pt-2` | FEARLESS PT 2 | `/assets/music/FEARLESS-PT-II.mp3` |
| `krezus-skins` | SKINS | `/assets/music/KREZUS-SKINS.mp3` |

Path capitalization and hyphens are intentional. Put the original files directly in `assets/music/`;
do not rename the originals or substitute music. No audio files were found in the current source tree,
so they are not included in this source ZIP. Missing files are reported, not represented as playable.

## Existing player behavior

- Play/Resume, Pause, Next, Previous, track selection, shuffle, and volume controls are preserved.
- Track IDs and display names are unchanged; only exact file paths were corrected.
- The player uses one audio element, resolves the root-relative URL, and continues to respect browser
  autoplay restrictions and explicit user gestures.
- CHECK FILES issues HEAD requests only for the three exact paths and reports HTTP/MIME/network results.
- Music paths remain excluded from service-worker precache and fetch interception so the static host
  can deliver streaming/range requests.

## Current verification limits

The current workspace does not contain these three files, and the generated source ZIP therefore does
not contain them. The existing public deployment at `https://veilstrike.vercel.app` returned `206` with
`audio/mpeg` for a ranged GET of MORTALS, but returned `404` for FEARLESS-PT-II and KREZUS-SKINS. That
existing deployment was not changed by this task. The state-machine tests verify track URL switching
with a mock audio element; real playback and three-track switching cannot be verified while two tracks
are absent and no browser playback session is available. See `MUSIC_FILENAME_PLAYBACK_REPORT.md` for
the dated URL and package checks.
