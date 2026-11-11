# VEILSTRIKE soundtrack asset manifest

The single supported soundtrack is `FEARLESS PT 2`, served from:

`/assets/music/FEARLESS-PT-II.mp3`

It is the only configured music entry, the default selection, and a required entry in the service-worker precache. The playlist and settings selector contain one track. Existing transport and volume controls remain available.

The music system does not run HEAD checks or other diagnostic network calls. Its audio URL is same-origin and resolved locally. In an installed PWA the file is returned from the verified offline cache.

Validation: tests assert that `assets/music/` contains exactly one MP3, its exact path is in the music registry and the service-worker precache, and the local HTTP server returns `audio/mpeg`. Real-browser audible/offline playback remains subject to browser availability.
