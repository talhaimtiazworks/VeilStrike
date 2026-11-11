# VEILSTRIKE — Collision Coverage Report

Maps audited: **110** (10 legacy layouts + 100 campaign operations)
Solid render meshes: **24524**, enclosed by a collider: **23947** → **97.65%** coverage
Maps with incomplete coverage before fix: **108**

## Per-map coverage

| map | colliders | solid meshes | covered | coverage % | top uncovered group |
|---|---|---|---|---|---|
| facility | 291 | 405 | 364 | 89.88% | boxgeometry ×19 |
| desert | 61 | 77 | 66 | 85.71% | boxgeometry ×5 |
| urban | 64 | 89 | 75 | 84.27% | boxgeometry ×9 |
| snow | 67 | 73 | 61 | 83.56% | boxgeometry ×5 |
| recon_canyon | 47 | 51 | 47 | 92.16% | buffergeometry ×2 |
| industrial | 155 | 178 | 159 | 89.33% | boxgeometry ×8 |
| rural | 128 | 111 | 106 | 95.5% | boxgeometry ×3 |
| riverside_village | 56 | 64 | 59 | 92.19% | buffergeometry ×2 |
| canal_market | 60 | 79 | 71 | 89.87% | boxgeometry ×5 |
| ridge_hold | 42 | 54 | 48 | 88.89% | boxgeometry ×4 |
| facility | 291 | 405 | 364 | 89.88% | boxgeometry ×19 |
| desert | 61 | 77 | 66 | 85.71% | boxgeometry ×5 |
| urban | 64 | 89 | 75 | 84.27% | boxgeometry ×9 |
| snow | 67 | 73 | 61 | 83.56% | boxgeometry ×5 |
| recon_canyon | 47 | 51 | 47 | 92.16% | buffergeometry ×2 |
| industrial | 155 | 178 | 159 | 89.33% | boxgeometry ×8 |
| rural | 128 | 111 | 106 | 95.5% | boxgeometry ×3 |
| riverside_village | 56 | 64 | 59 | 92.19% | buffergeometry ×2 |
| canal_market | 60 | 79 | 71 | 89.87% | boxgeometry ×5 |
| ridge_hold | 42 | 54 | 48 | 88.89% | boxgeometry ×4 |
| convoy_valley | 237 | 185 | 183 | 98.92% | buffergeometry ×2 |
| wadi_outpost | 252 | 225 | 223 | 99.11% | buffergeometry ×2 |
| glacier_pass | 168 | 131 | 129 | 98.47% | buffergeometry ×2 |
| harbor_boulevard | 564 | 513 | 511 | 99.61% | buffergeometry ×2 |
| foundry_rail | 138 | 140 | 138 | 98.57% | buffergeometry ×2 |
| rowhouse_grid | 495 | 449 | 447 | 99.55% | buffergeometry ×2 |
| kestrel_annex | 355 | 331 | 328 | 99.09% | buffergeometry ×2 |
| metro | 71 | 82 | 74 | 90.24% | boxgeometry ×8 |
| sector_019_redgate_crossing | 294 | 278 | 274 | 98.56% | buffergeometry ×2 |
| sector_020_pinewatch_battery | 302 | 257 | 253 | 98.44% | buffergeometry ×2 |
| sector_021_seawall_bastion | 276 | 253 | 250 | 98.81% | buffergeometry ×2 |
| sector_022_gantries_at_dusk | 263 | 256 | 251 | 98.05% | boxgeometry ×3 |
| sector_023_highwater_lock | 315 | 308 | 304 | 98.7% | buffergeometry ×2 |
| sector_024_silent_turbine | 168 | 160 | 157 | 98.13% | buffergeometry ×2 |
| sector_025_amber_flare | 178 | 167 | 163 | 97.6% | buffergeometry ×2 |
| sector_026_volt_switch | 311 | 293 | 288 | 98.29% | boxgeometry ×3 |
| sector_027_tarmac_spear | 164 | 160 | 156 | 97.5% | buffergeometry ×2 |
| sector_028_cryo_wing | 305 | 278 | 275 | 98.92% | buffergeometry ×2 |
| sector_029_sublevel_zero | 186 | 194 | 191 | 98.45% | boxgeometry ×3 |
| sector_030_casemate_nine | 186 | 183 | 183 | 100% | — |
| sector_031_freight_spur | 288 | 278 | 274 | 98.56% | buffergeometry ×2 |
| sector_032_tollgate_iron | 239 | 224 | 221 | 98.66% | buffergeometry ×2 |
| sector_033_orchard_hollow | 291 | 264 | 260 | 98.48% | buffergeometry ×2 |
| sector_034_garrison_vanguard | 320 | 298 | 294 | 98.66% | buffergeometry ×2 |
| sector_035_broken_foundry | 467 | 427 | 424 | 99.3% | buffergeometry ×2 |
| sector_036_breakwater_dock | 279 | 258 | 254 | 98.45% | buffergeometry ×2 |
| sector_037_drydock_shadow | 264 | 250 | 246 | 98.4% | buffergeometry ×2 |
| sector_038_timber_ambush | 261 | 224 | 220 | 98.21% | buffergeometry ×2 |
| sector_039_span_breaker | 238 | 228 | 224 | 98.25% | buffergeometry ×2 |
| sector_040_outpost_scorpion | 316 | 291 | 287 | 98.63% | buffergeometry ×2 |
| sector_041_slag_corridor | 171 | 169 | 165 | 97.63% | buffergeometry ×2 |
| sector_042_dead_loom | 280 | 258 | 254 | 98.45% | buffergeometry ×2 |
| sector_043_black_cracker | 179 | 171 | 167 | 97.66% | buffergeometry ×2 |
| sector_044_gridlock_seven | 169 | 164 | 160 | 97.56% | buffergeometry ×2 |
| sector_045_deep_archive | 186 | 189 | 187 | 98.94% | boxgeometry ×2 |
| sector_046_iron_gallery | 188 | 194 | 192 | 98.97% | boxgeometry ×2 |
| sector_047_isotope_vault | 311 | 290 | 285 | 98.28% | boxgeometry ×3 |
| sector_048_dune_radar | 291 | 260 | 257 | 98.85% | buffergeometry ×2 |
| sector_049_frost_citadel | 227 | 207 | 204 | 98.55% | buffergeometry ×2 |
| sector_050_roundhouse_siege | 294 | 284 | 279 | 98.24% | boxgeometry ×3 |
| sector_051_checkpoint_viper | 292 | 273 | 269 | 98.53% | buffergeometry ×2 |
| sector_052_crossroads_mill | 298 | 273 | 269 | 98.53% | buffergeometry ×2 |
| sector_053_camp_centurion | 283 | 259 | 256 | 98.84% | buffergeometry ×2 |
| sector_054_midtown_overpass | 472 | 426 | 423 | 99.3% | buffergeometry ×2 |
| sector_055_headland_battery | 229 | 214 | 211 | 98.6% | buffergeometry ×2 |
| sector_056_bunkering_pier | 269 | 249 | 246 | 98.8% | buffergeometry ×2 |
| sector_057_apron_thunder | 163 | 162 | 159 | 98.15% | buffergeometry ×2 |
| sector_058_canopy_watch | 304 | 253 | 251 | 99.21% | buffergeometry ×2 |
| sector_059_gorge_powerhouse | 323 | 310 | 305 | 98.39% | boxgeometry ×3 |
| sector_060_bastion_kronos | 315 | 291 | 287 | 98.63% | buffergeometry ×2 |
| sector_061_crosswind_runway | 162 | 169 | 164 | 97.04% | boxgeometry ×3 |
| sector_062_rotor_base | 168 | 163 | 160 | 98.16% | buffergeometry ×2 |
| sector_063_steel_junction | 297 | 283 | 279 | 98.59% | buffergeometry ×2 |
| sector_064_borderlock_north | 214 | 216 | 211 | 97.69% | boxgeometry ×3 |
| sector_065_pipeline_zero | 281 | 261 | 257 | 98.47% | buffergeometry ×2 |
| sector_066_dark_reactor | 309 | 289 | 285 | 98.62% | buffergeometry ×2 |
| sector_067_avionics_dome | 167 | 172 | 167 | 97.09% | boxgeometry ×3 |
| sector_068_subterranean_spur | 187 | 184 | 184 | 100% | — |
| sector_069_bunker_complex_delta | 185 | 193 | 190 | 98.45% | boxgeometry ×3 |
| sector_070_chemical_row | 173 | 170 | 166 | 97.65% | buffergeometry ×2 |
| sector_071_rusted_turbine | 171 | 163 | 160 | 98.16% | buffergeometry ×2 |
| sector_072_wadi_citadel | 323 | 294 | 290 | 98.64% | buffergeometry ×2 |
| sector_073_whiteeout_ridge | 230 | 216 | 212 | 98.15% | buffergeometry ×2 |
| sector_074_darkwater_woods | 308 | 265 | 260 | 98.11% | boxgeometry ×3 |
| sector_075_amphibious_gate | 276 | 250 | 247 | 98.8% | buffergeometry ×2 |
| sector_076_port_sovereign | 258 | 248 | 244 | 98.39% | buffergeometry ×2 |
| sector_077_floodgate_locks | 313 | 296 | 293 | 98.99% | buffergeometry ×2 |
| sector_078_valley_settlement | 257 | 230 | 226 | 98.26% | buffergeometry ×2 |
| sector_079_fob_vanguard | 318 | 298 | 294 | 98.66% | buffergeometry ×2 |
| sector_080_hightower_keep | 473 | 425 | 422 | 99.29% | buffergeometry ×2 |
| sector_081_downtown_siege | 471 | 430 | 426 | 99.07% | buffergeometry ×2 |
| sector_082_smelter_titan | 298 | 279 | 276 | 98.92% | buffergeometry ×2 |
| sector_083_hollow_arsenal | 321 | 298 | 294 | 98.66% | buffergeometry ×2 |
| sector_084_red_mirage | 174 | 172 | 168 | 97.67% | buffergeometry ×2 |
| sector_085_summit_battery | 232 | 214 | 210 | 98.13% | buffergeometry ×2 |
| sector_086_shadow_timber | 315 | 264 | 261 | 98.86% | buffergeometry ×2 |
| sector_087_iron_headland | 279 | 259 | 254 | 98.07% | boxgeometry ×3 |
| sector_088_terminal_zulu | 268 | 257 | 253 | 98.44% | buffergeometry ×2 |
| sector_089_skyline_runway | 173 | 172 | 167 | 97.09% | boxgeometry ×3 |
| sector_090_abyss_vault | 185 | 193 | 190 | 98.45% | boxgeometry ×3 |
| sector_091_aegis_tunnels | 187 | 195 | 192 | 98.46% | boxgeometry ×3 |
| sector_092_omega_labs | 314 | 292 | 287 | 98.29% | boxgeometry ×3 |
| sector_093_hv_core_prime | 171 | 166 | 162 | 97.59% | buffergeometry ×2 |
| sector_094_inferno_terminal | 181 | 167 | 164 | 98.2% | buffergeometry ×2 |
| sector_095_stonebridge_town | 250 | 226 | 222 | 98.23% | buffergeometry ×2 |
| sector_096_titan_spillway | 316 | 306 | 301 | 98.37% | boxgeometry ×3 |
| sector_097_iron_gateway | 296 | 272 | 268 | 98.53% | buffergeometry ×2 |
| sector_098_central_depot | 291 | 275 | 271 | 98.55% | buffergeometry ×2 |
| sector_099_garrison_prime | 165 | 162 | 158 | 97.53% | buffergeometry ×2 |
| sector_100_iron_citadel | 318 | 297 | 292 | 98.32% | boxgeometry ×3 |

## Most frequent uncovered mesh families

| mesh family | instances | maps affected | typical size (m) |
|---|---|---|---|
| boxgeometry | 289 | 91 | 0.9x0.6x0.12 |
| buffergeometry | 200 | 90 | 44x18.79x261.12 |
| conegeometry | 76 | 6 | 0.65x0.3x0.68 |
| cylindergeometry | 10 | 2 | 58x0.18x0.18 |
| environment-pine-canopies | 2 | 1 | 22.07x2.65x40.34 |
