# VEILSTRIKE gameplay and soundtrack release notes

## v17.6.0 single-soundtrack offline release — 2026-11-06

- Kept `FEARLESS-PT-II.mp3` as the sole music asset and the sole soundtrack registry entry.
- Set it as the default track, kept it in the service-worker precache, and updated the settings selector/status.
- Removed the obsolete playlist entries and the optional HEAD-based music-file diagnostic. Music controls no longer initiate diagnostic network requests.
- Existing play/pause, next/previous, shuffle, music volume, game SFX, and ambience systems remain in place.
- Service-worker cache version bumped to `v17.6.0-single-soundtrack-offline-final-20261106`.

## Current file audit

`assets/music/` contains one MP3: `FEARLESS-PT-II.mp3`. There are no alternate or substitute audio files. The automated source, service-worker, and extracted-package checks enforce this single-file inventory.
