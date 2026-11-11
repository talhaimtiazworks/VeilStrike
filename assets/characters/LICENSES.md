# vs_soldier.glb: sources and licences

`vs_soldier.glb` is a derived asset built offline by `build_soldier.mjs`
(the pipeline is shipped in the report folder, not loaded by the game).
Both sources are **CC0 1.0 (public domain)**, so commercial use, modification
and redistribution are allowed with no attribution required. Credit is given anyway.

| Part | Source | Licence | Notes |
|---|---|---|---|
| Mesh, skin weights, skeleton, textures | Grab3D "Soldier", rigged variant: https://grab3d.com/models/characters/soldier/ (file `soldier-rigged.glb`, published 2026-09-28) | CC0 1.0: `LICENSE-Grab3D-Soldier.txt` | **AI-assisted asset**: Grab3D states the base mesh and textures were generated with an AI image-to-3D tool (Meshy), then cleaned up and textured in Blender. Platforms that require AI-content disclosure (e.g. Steam) should list it. Grab3D's name and trademarks are not licensed, and no endorsement is implied. |
| Animation clips | Quaternius "Universal Animation Library" (Standard): https://quaternius.itch.io/universal-animation-library (`UAL1_Standard.glb`, in-place variant) | CC0 1.0: `LICENSE-Quaternius-UAL.txt` | Retargeted to the Grab3D skeleton. 13 clips used. |

Changes made: decimated from ~400k to 8,997 triangles, merged into one mesh with one material,
basecolour downscaled to 1024 px and normal map to 512 px, Meshy clips removed,
and UAL clips retargeted in place (hips scaled ×1.058).

Source file SHA-256:
- `soldier-rigged.glb`: b1f32017868a6f951c21c45b84646696431e6b4c813d563af37944123f673a59
- `UAL_Standard.zip`: cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724
