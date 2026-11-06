// ============================================================================
// campaign-data.js — 100-Mission Tactical Campaign Catalog & Registry
// ============================================================================
// Defines:
//   - Exact enemy progression formula: 50 + (missionNumber - 1) * 2
//   - All 20 required military/tactical environment categories
//   - All 12 macro-spatial combat map topologies
//   - Full 100-mission catalog (Missions 1–18 + Missions 19–100) with 100
//     distinct 3D layout IDs, briefings, multi-step objectives, and vehicles
//   - Extensible registration API for Mission 101+ without code refactors
// ============================================================================

export function getMissionMinEnemies(missionNumber) {
  const n = Math.max(1, Math.floor(Number(missionNumber) || 1));
  return 50 + (n - 1) * 2;
}

export const CAMPAIGN_ACTS = [
  { act: 1, range: [1, 20], code: 'ACT I', title: 'BORDER & RECONNAISSANCE OPS' },
  { act: 2, range: [21, 40], code: 'ACT II', title: 'INFRASTRUCTURE & COASTAL RAIDS' },
  { act: 3, range: [41, 60], code: 'ACT III', title: 'INDUSTRIAL & SUBTERRANEAN SIEGE' },
  { act: 4, range: [61, 80], code: 'ACT IV', title: 'AIRFIELD, RAIL & STRATEGIC DEEP-STRIKE' },
  { act: 5, range: [81, 100], code: 'ACT V', title: 'CITADEL & ARGUS COMMAND ENDGAME' },
];

export const ENVIRONMENT_CATEGORIES = {
  military_base: {
    id: 'military_base',
    label: 'MODERN MILITARY BASE',
    intelKey: 'facility',
    ground: 'gravel',
    groundTint: 0x6f6d65,
    sky: 'dusk',
    weather: 'clear',
    vehiclePool: ['latv4', 'apc8', 'tac_pickup'],
  },
  dense_urban: {
    id: 'dense_urban',
    label: 'DENSE URBAN CITY',
    intelKey: 'urban',
    ground: 'asphalt',
    groundTint: 0x666b72,
    sky: 'overcast',
    weather: 'rain',
    vehiclePool: ['sedan_civ', 'suv_patrol', 'van_util'],
  },
  industrial_district: {
    id: 'industrial_district',
    label: 'INDUSTRIAL DISTRICT',
    intelKey: 'industrial',
    ground: 'gravel',
    groundTint: 0x5c5a55,
    sky: 'dusk',
    weather: 'clear',
    vehiclePool: ['cargo6', 'van_util', 'tac_pickup'],
  },
  abandoned_factory: {
    id: 'abandoned_factory',
    label: 'ABANDONED FACTORY',
    intelKey: 'industrial',
    ground: 'gravel',
    groundTint: 0x58534c,
    sky: 'overcast',
    weather: 'clear',
    vehiclePool: ['pickup_util', 'cargo6', 'van_util'],
  },
  desert_installation: {
    id: 'desert_installation',
    label: 'DESERT MILITARY INSTALLATION',
    intelKey: 'desert',
    ground: 'sand',
    groundTint: 0xc9b086,
    sky: 'sand',
    weather: 'dust',
    vehiclePool: ['sand_buggy', 'tac_pickup', 'apc8'],
  },
  mountain_combat: {
    id: 'mountain_combat',
    label: 'MOUNTAIN COMBAT ZONE',
    intelKey: 'snow',
    ground: 'snow',
    groundTint: 0xe6edf4,
    sky: 'snow',
    weather: 'snow',
    vehiclePool: ['snow_rover', 'latv4', 'apc8'],
  },
  forest_woodland: {
    id: 'forest_woodland',
    label: 'FOREST / WOODLAND OPERATIONS',
    intelKey: 'rural',
    ground: 'grass',
    groundTint: 0x455438,
    sky: 'dawn',
    weather: 'clear',
    vehiclePool: ['pickup_util', 'latv4', 'tac_pickup'],
  },
  coastal_military: {
    id: 'coastal_military',
    label: 'COASTAL MILITARY FACILITY',
    intelKey: 'facility',
    ground: 'concrete',
    groundTint: 0x767c82,
    sky: 'overcast',
    weather: 'rain',
    vehiclePool: ['latv4', 'suv_patrol', 'apc8'],
  },
  harbor_port: {
    id: 'harbor_port',
    label: 'HARBOR / PORT / SHIPPING YARD',
    intelKey: 'industrial',
    ground: 'asphalt',
    groundTint: 0x626870,
    sky: 'night',
    weather: 'rain',
    vehiclePool: ['cargo6', 'van_util', 'suv_patrol'],
  },
  airport_airfield: {
    id: 'airport_airfield',
    label: 'AIRPORT / AIRFIELD / RUNWAY',
    intelKey: 'facility',
    ground: 'asphalt',
    groundTint: 0x6d7278,
    sky: 'day',
    weather: 'clear',
    vehiclePool: ['latv4', 'tac_pickup', 'hx7'],
  },
  underground_facility: {
    id: 'underground_facility',
    label: 'UNDERGROUND FACILITY',
    intelKey: 'metro',
    ground: 'concrete',
    groundTint: 0x52565d,
    sky: 'underground',
    weather: 'clear',
    vehiclePool: ['van_util', 'suv_patrol'],
  },
  underground_bunker: {
    id: 'underground_bunker',
    label: 'UNDERGROUND BUNKER / TUNNELS',
    intelKey: 'metro',
    ground: 'concrete',
    groundTint: 0x4c5054,
    sky: 'underground',
    weather: 'clear',
    vehiclePool: ['latv4', 'apc8'],
  },
  research_lab: {
    id: 'research_lab',
    label: 'RESEARCH / LABORATORY FACILITY',
    intelKey: 'facility',
    ground: 'concrete',
    groundTint: 0x82888e,
    sky: 'night',
    weather: 'clear',
    vehiclePool: ['suv_patrol', 'van_util', 'latv4'],
  },
  power_station: {
    id: 'power_station',
    label: 'POWER STATION / UTILITY COMPLEX',
    intelKey: 'industrial',
    ground: 'gravel',
    groundTint: 0x646668,
    sky: 'night',
    weather: 'rain',
    vehiclePool: ['van_util', 'pickup_util', 'latv4'],
  },
  oil_refinery: {
    id: 'oil_refinery',
    label: 'OIL & GAS / REFINERY INSTALLATION',
    intelKey: 'industrial',
    ground: 'sand',
    groundTint: 0xa59272,
    sky: 'dusk',
    weather: 'dust',
    vehiclePool: ['tac_pickup', 'cargo6', 'sand_buggy'],
  },
  rural_village: {
    id: 'rural_village',
    label: 'RURAL SETTLEMENT / VILLAGE',
    intelKey: 'rural',
    ground: 'grass',
    groundTint: 0x556042,
    sky: 'day',
    weather: 'clear',
    vehiclePool: ['pickup_util', 'sedan_civ', 'tac_pickup'],
  },
  dam_bridge: {
    id: 'dam_bridge',
    label: 'DAM / BRIDGE / HYDROELECTRIC',
    intelKey: 'industrial',
    ground: 'concrete',
    groundTint: 0x74787c,
    sky: 'dawn',
    weather: 'clear',
    vehiclePool: ['latv4', 'apc8', 'suv_patrol'],
  },
  border_checkpoint: {
    id: 'border_checkpoint',
    label: 'BORDER CHECKPOINT / CROSSING',
    intelKey: 'desert',
    ground: 'gravel',
    groundTint: 0x8d826e,
    sky: 'day',
    weather: 'dust',
    vehiclePool: ['apc8', 'latv4', 'tac_pickup'],
  },
  rail_transport: {
    id: 'rail_transport',
    label: 'TRANSPORTATION HUB / RAIL YARD',
    intelKey: 'metro',
    ground: 'gravel',
    groundTint: 0x605d58,
    sky: 'dusk',
    weather: 'clear',
    vehiclePool: ['cargo6', 'van_util', 'tac_pickup'],
  },
  command_compound: {
    id: 'command_compound',
    label: 'FORTIFIED ENEMY COMPOUND / HQ',
    intelKey: 'facility',
    ground: 'concrete',
    groundTint: 0x686b70,
    sky: 'night',
    weather: 'clear',
    vehiclePool: ['apc8', 'latv4', 'hx7'],
  },
};

export const TOPOLOGY_FAMILIES = [
  'linear_convoy_corridor',
  'twin_bridge_crossing',
  'central_citadel_ring',
  'harbor_pier_waterfront',
  'airfield_runway_apron',
  'switchback_mountain_pass',
  'underground_bunker_grid',
  'urban_city_blocks',
  'rail_marshaling_yard',
  'refinery_pipeline_maze',
  'hydro_dam_gorge',
  'multi_compound_valley',
];

// Metadata for Missions 1–18 (preserving all existing IDs, upgrading 11–17 to unique layouts)
export const LEGACY_CAMPAIGN_ENTRIES = [
  { missionNumber: 1, id: 'facility', code: 'OP 001', name: 'KESTREL YARD', location: 'LOGISTICS DEPOT 04, NORTHERN RAIL SPUR', category: 'military_base', layoutId: 'facility', topology: 'central_citadel_ring' },
  { missionNumber: 2, id: 'desert', code: 'OP 002', name: 'DUSTBOWL CACHE', location: 'ARID OUTPOST, SECTOR 9 SOUTH', category: 'desert_installation', layoutId: 'desert', topology: 'multi_compound_valley' },
  { missionNumber: 3, id: 'urban', code: 'OP 003', name: 'GREYSTONE BLOCK', location: 'OLD QUARTER, FINANCIAL DISTRICT', category: 'dense_urban', layoutId: 'urban', topology: 'urban_city_blocks' },
  { missionNumber: 4, id: 'snow', code: 'OP 004', name: 'WHITEPINE RELAY', location: 'HIGH-ALTITUDE COMMS STATION, 2,400M', category: 'mountain_combat', layoutId: 'snow', topology: 'switchback_mountain_pass' },
  { missionNumber: 5, id: 'recon_desert', code: 'OP 005', name: 'GLASS WATCH', location: 'WADI APPROACH, EASTERN SECTOR', category: 'desert_installation', layoutId: 'recon_canyon', topology: 'switchback_mountain_pass' },
  { missionNumber: 6, id: 'sabotage_industrial', code: 'OP 006', name: 'COLD FURNACE', location: 'FORGE WORKS 12, RIVER INDUSTRIAL ZONE', category: 'industrial_district', layoutId: 'industrial', topology: 'refinery_pipeline_maze' },
  { missionNumber: 7, id: 'investigate_rural', code: 'OP 007', name: 'QUIET FIELD', location: 'ABANDONED FARMSTEAD, VALLEY ROAD', category: 'rural_village', layoutId: 'rural', topology: 'multi_compound_valley' },
  { missionNumber: 8, id: 'rescue_rural', code: 'OP 008', name: 'BROKEN LINE', location: 'RIVER CROSSING, NORTH COUNTY', category: 'rural_village', layoutId: 'riverside_village', topology: 'twin_bridge_crossing' },
  { missionNumber: 9, id: 'defense_urban', code: 'OP 009', name: 'IRON CORNER', location: 'TRANSIT RELAY, OLD QUARTER', category: 'dense_urban', layoutId: 'canal_market', topology: 'twin_bridge_crossing' },
  { missionNumber: 10, id: 'hold_snow', code: 'OP 010', name: 'LAST LIGHT', location: 'HIGH RELAY, NORTHERN APPROACH', category: 'mountain_combat', layoutId: 'ridge_hold', topology: 'switchback_mountain_pass' },
  { missionNumber: 11, id: 'convoy_rural', code: 'OP 011', name: 'LONG ROAD', location: 'TIMBER VALLEY HIGHWAY, NORTH BOUNDARY', category: 'forest_woodland', layoutId: 'convoy_valley', topology: 'linear_convoy_corridor' },
  { missionNumber: 12, id: 'extract_desert', code: 'OP 012', name: 'RED DUST', location: 'SCORPION BASIN GARRISON, SECTOR 9', category: 'desert_installation', layoutId: 'wadi_outpost', topology: 'linear_convoy_corridor' },
  { missionNumber: 13, id: 'recovery_snow', code: 'OP 013', name: 'BROKEN AXLE', location: 'GLACIER SWITCHBACK PASS, RIDGE ROAD', category: 'mountain_combat', layoutId: 'glacier_pass', topology: 'switchback_mountain_pass' },
  { missionNumber: 14, id: 'escort_urban', code: 'OP 014', name: 'SLOW MOVING', location: 'HARBOR ARTERIAL BOULEVARD, DOCK DISTRICT', category: 'dense_urban', layoutId: 'harbor_boulevard', topology: 'linear_convoy_corridor' },
  { missionNumber: 15, id: 'transit_industrial', code: 'OP 015', name: 'IRON FREIGHT', location: 'SMELTER RAIL CORRIDOR, EAST FOUNDRY', category: 'industrial_district', layoutId: 'foundry_rail', topology: 'rail_marshaling_yard' },
  { missionNumber: 16, id: 'cq_urban', code: 'OP 016', name: 'CLOSE QUARTERS', location: 'MERCHANT ROWHOUSE GRID, NORTH QUARTER', category: 'dense_urban', layoutId: 'rowhouse_grid', topology: 'urban_city_blocks' },
  { missionNumber: 17, id: 'archive_facility', code: 'OP 017', name: 'SECOND COPY', location: 'KESTREL DATA ANNEX, WEST WING', category: 'research_lab', layoutId: 'kestrel_annex', topology: 'central_citadel_ring' },
  { missionNumber: 18, id: 'city_blackout', code: 'OP 018', name: 'BLACKOUT LINE', location: 'CIVIC TRANSIT DISTRICT, METRO LINE 4', category: 'rail_transport', layoutId: 'metro', topology: 'urban_city_blocks' },
];

// 82 Newly Authored Operations (OP 019 – OP 100), systematically spanning all
// 20 Environment Categories, all 12 Spatial Topologies, and 10 Objective Modes!
const NEW_OPERATION_SPECS = [
  // --- ACT I COMPLETION (19–20) ---
  [19, 'REDGATE CROSSING', 'FORTIFIED CUSTOMS HIGHWAY, SECTOR 2', 'border_checkpoint', 'linear_convoy_corridor', 'sabotage_destruct', 'day'],
  [20, 'PINEWATCH BATTERY', 'BLACKWOOD TIMBER RIDGE, NORTH WOODS', 'forest_woodland', 'multi_compound_valley', 'assault_breach', 'dawn'],

  // --- ACT II: INFRASTRUCTURE & COASTAL RAIDS (21–40) ---
  [21, 'SEAWALL BASTION', 'HEADLAND NAVAL RADAR BATTERY, CAPE VERN', 'coastal_military', 'harbor_pier_waterfront', 'sabotage_destruct', 'overcast'],
  [22, 'GANTries AT DUSK', 'CONTAINER TERMINAL QUAY 7, DEEP PORT', 'harbor_port', 'harbor_pier_waterfront', 'assault_breach', 'dusk'],
  [23, 'HIGHWATER LOCK', 'CASCADE SPILLWAY & INTAKE DAM, GORGE 3', 'dam_bridge', 'hydro_dam_gorge', 'sabotage_demo', 'dawn'],
  [24, 'SILENT TURBINE', 'SHUTTERED MUNITION MILL, RUST BELT', 'abandoned_factory', 'refinery_pipeline_maze', 'recon_uplink', 'overcast'],
  [25, 'AMBER FLARE', 'CRUDE SEPARATION MANIFOLD, SALT FLAT', 'oil_refinery', 'refinery_pipeline_maze', 'sabotage_destruct', 'dusk'],
  [26, 'VOLT SWITCH', 'REGIONAL HV SUBSTATION 09, EAST GRID', 'power_station', 'central_citadel_ring', 'blackout_raid', 'night'],
  [27, 'TARMAC SPEAR', 'FORWARD TACTICAL AIRSTRIP, SECTOR 6', 'airport_airfield', 'airfield_runway_apron', 'vehicle_spearhead', 'day'],
  [28, 'CRYO WING', 'BIOCONTAINMENT MODULE B, NORTHERN CAMPUS', 'research_lab', 'central_citadel_ring', 'assault_breach', 'night'],
  [29, 'SUBLEVEL ZERO', 'BURIED LOGISTICS VAULT, DEPOT ALPHA', 'underground_facility', 'underground_bunker_grid', 'assault_breach', 'underground'],
  [30, 'CASEMATE NINE', 'CUT-AND-COVER ARTILLERY TUNNEL, RIDGE 4', 'underground_bunker', 'underground_bunker_grid', 'sabotage_demo', 'underground'],
  [31, 'FREIGHT SPUR', 'INTERMODAL RAIL MARSHALING YARD, WEST', 'rail_transport', 'rail_marshaling_yard', 'capture_hold', 'dusk'],
  [32, 'TOLLGATE IRON', 'DEMILITARIZED BRIDGEHEAD CROSSING', 'border_checkpoint', 'twin_bridge_crossing', 'capture_hold', 'day'],
  [33, 'ORCHARD HOLLOW', 'TERRACED MILL HAMLET, SUNDOWN VALLEY', 'rural_village', 'multi_compound_valley', 'hostage_rescue', 'day'],
  [34, 'GARRISON VANGUARD', 'FOB HALBERD ARMOR STAGING BASE', 'military_base', 'central_citadel_ring', 'sabotage_destruct', 'day'],
  [35, 'BROKEN FOUNDRY', 'DERELICT VEHICLE ASSEMBLY PLANT 03', 'abandoned_factory', 'urban_city_blocks', 'capture_hold', 'overcast'],
  [36, 'BREAKWATER DOCK', 'LITTORAL PATROL SUB-PEN, NORTH COVE', 'coastal_military', 'harbor_pier_waterfront', 'sabotage_demo', 'night'],
  [37, 'DRYDOCK SHADOW', 'BONDED CUSTOMS WHARF & CRANE PIER', 'harbor_port', 'harbor_pier_waterfront', 'hostage_rescue', 'night'],
  [38, 'TIMBER AMBUSH', 'LOGGING DEPOT & RIVER FORD, PINE SECTOR', 'forest_woodland', 'twin_bridge_crossing', 'vehicle_spearhead', 'day'],
  [39, 'SPAN BREAKER', 'TWIN HIGHWAY VIADUCT, IRON RIVER', 'dam_bridge', 'twin_bridge_crossing', 'sabotage_demo', 'dusk'],
  [40, 'OUTPOST SCORPION', 'WALLED COMMAND REDOUBT, BASIN EDGE', 'command_compound', 'central_citadel_ring', 'citadel_siege', 'night'],

  // --- ACT III: INDUSTRIAL & SUBTERRANEAN SIEGE (41–60) ---
  [41, 'SLAG CORRIDOR', 'HEAVY SMELTING COMPLEX, DISTRICT 11', 'industrial_district', 'refinery_pipeline_maze', 'sabotage_demo', 'dusk'],
  [42, 'DEAD LOOM', 'COLLAPSED TEXTILE & CHEMICAL WORKS', 'abandoned_factory', 'multi_compound_valley', 'assault_breach', 'overcast'],
  [43, 'BLACK CRACKER', 'CATALYTIC REFINERY TOWER GRID, COAST', 'oil_refinery', 'refinery_pipeline_maze', 'sabotage_destruct', 'dusk'],
  [44, 'GRIDLOCK SEVEN', 'THERMAL TURBINE HALL & SWITCHYARD', 'power_station', 'refinery_pipeline_maze', 'blackout_raid', 'night'],
  [45, 'DEEP ARCHIVE', 'SUBTERRANEAN TELEMETRY SERVER CAVERN', 'underground_facility', 'underground_bunker_grid', 'assault_breach', 'underground'],
  [46, 'IRON GALLERY', 'HARDENED MOUNTAIN SAPPING TUNNELS', 'underground_bunker', 'underground_bunker_grid', 'capture_hold', 'underground'],
  [47, 'ISOTOPE VAULT', 'MATERIALS TESTING REACTOR WING', 'research_lab', 'central_citadel_ring', 'assault_breach', 'night'],
  [48, 'DUNE RADAR', 'SANDSTONE RADAR GARRISON, SECTOR 14', 'desert_installation', 'multi_compound_valley', 'sabotage_destruct', 'sand'],
  [49, 'FROST CITADEL', 'ALPINE ARTILLERY OBSERVATION SHELF', 'mountain_combat', 'switchback_mountain_pass', 'capture_hold', 'snow'],
  [50, 'ROUNDHOUSE SIEGE', 'LOCOMOTIVE DEPOT & TURNTABLE YARD', 'rail_transport', 'rail_marshaling_yard', 'citadel_siege', 'dusk'],
  [51, 'CHECKPOINT VIPER', 'DESERT HIGHWAY INSPECTION FORTRESS', 'border_checkpoint', 'linear_convoy_corridor', 'vehicle_spearhead', 'sand'],
  [52, 'CROSSROADS MILL', 'GRAIN SILO COOPERATIVE, EAST COUNTY', 'rural_village', 'linear_convoy_corridor', 'hostage_rescue', 'dawn'],
  [53, 'CAMP CENTURION', 'COMBINED-ARMS TRAINING CANTONMENT', 'military_base', 'multi_compound_valley', 'capture_hold', 'day'],
  [54, 'MIDTOWN OVERPASS', 'ELEVATED EXPRESSWAY & CIVIC PLAZA', 'dense_urban', 'urban_city_blocks', 'capture_hold', 'overcast'],
  [55, 'HEADLAND BATTERY', 'COASTAL MISSILE REVETMENT, CLIFF 8', 'coastal_military', 'switchback_mountain_pass', 'sabotage_destruct', 'dawn'],
  [56, 'BUNKERING PIER', 'NAVAL FUEL WHARF & STORAGE TANKS', 'harbor_port', 'harbor_pier_waterfront', 'sabotage_demo', 'night'],
  [57, 'APRON THUNDER', 'HARDENED AIRCRAFT SHELTER COMPLEX', 'airport_airfield', 'airfield_runway_apron', 'sabotage_destruct', 'dusk'],
  [58, 'CANOPY WATCH', 'CAMOUFLAGED WOODLAND SAM CLEARING', 'forest_woodland', 'multi_compound_valley', 'sabotage_destruct', 'day'],
  [59, 'GORGE POWERHOUSE', 'HYDROELECTRIC TURBINE APRON, DAM 02', 'dam_bridge', 'hydro_dam_gorge', 'blackout_raid', 'overcast'],
  [60, 'BASTION KRONOS', 'ARGUS SECTOR COMMAND COMPOUND', 'command_compound', 'central_citadel_ring', 'citadel_siege', 'night'],

  // --- ACT IV: AIRFIELD, RAIL & STRATEGIC DEEP-STRIKE (61–80) ---
  [61, 'CROSSWIND RUNWAY', 'STRATEGIC AIRLIFT TERMINAL & ATC TOWER', 'airport_airfield', 'airfield_runway_apron', 'assault_breach', 'day'],
  [62, 'ROTOR BASE', 'ROTARY-WING ATTACK HELIBASE, PLATEAU', 'airport_airfield', 'airfield_runway_apron', 'sabotage_destruct', 'dawn'],
  [63, 'STEEL JUNCTION', 'THREE-LINE RAIL TRANSFER HUB, NORTH', 'rail_transport', 'rail_marshaling_yard', 'sabotage_demo', 'night'],
  [64, 'BORDERLOCK NORTH', 'MOUNTAIN PASS CUSTOMS BASTION', 'border_checkpoint', 'switchback_mountain_pass', 'assault_breach', 'snow'],
  [65, 'PIPELINE ZERO', 'COASTAL LNG LIQUEFACTION TERMINAL', 'oil_refinery', 'harbor_pier_waterfront', 'sabotage_demo', 'dusk'],
  [66, 'DARK REACTOR', 'EMERGENCY DIESEL & GRID CONTROL PLANT', 'power_station', 'central_citadel_ring', 'blackout_raid', 'night'],
  [67, 'AVIONICS DOME', 'TELEMETRY & DRONE GUIDANCE LABS', 'research_lab', 'airfield_runway_apron', 'recon_uplink', 'night'],
  [68, 'SUBTERRANEAN SPUR', 'UNDERGROUND RAIL MUNITIONS TRANSFER', 'underground_facility', 'underground_bunker_grid', 'sabotage_demo', 'underground'],
  [69, 'BUNKER COMPLEX DELTA', 'NUCLEAR-HARDENED COMMAND SUB-BUNKER', 'underground_bunker', 'underground_bunker_grid', 'assault_breach', 'underground'],
  [70, 'CHEMICAL ROW', 'PETROCHEMICAL PROCESSING DISTRICT 07', 'industrial_district', 'refinery_pipeline_maze', 'sabotage_destruct', 'overcast'],
  [71, 'RUSTED TURBINE', 'ABANDONED HEAVY GENERATOR PLANT', 'abandoned_factory', 'refinery_pipeline_maze', 'hostage_rescue', 'dusk'],
  [72, 'WADI CITADEL', 'ARID ARMOR & MISSILE STAGING FORT', 'desert_installation', 'central_citadel_ring', 'vehicle_spearhead', 'sand'],
  [73, 'WHITEEOUT RIDGE', 'GLACIER RADOME & RELAY FORTRESS', 'mountain_combat', 'switchback_mountain_pass', 'sabotage_destruct', 'snow'],
  [74, 'DARKWATER WOODS', 'DEEP FOREST LISTENING POST & BUNKER', 'forest_woodland', 'multi_compound_valley', 'recon_uplink', 'dawn'],
  [75, 'AMPHIBIOUS GATE', 'SEAWALL LANDING DOCK & GARRISON', 'coastal_military', 'harbor_pier_waterfront', 'capture_hold', 'overcast'],
  [76, 'PORT SOVEREIGN', 'EASTERN FLEET SUPPLY TERMINAL', 'harbor_port', 'harbor_pier_waterfront', 'citadel_siege', 'night'],
  [77, 'FLOODGATE LOCKS', 'CANAL WEIR & MULTI-SPAN VIADUCT', 'dam_bridge', 'hydro_dam_gorge', 'capture_hold', 'day'],
  [78, 'VALLEY SETTLEMENT', 'OCCUPIED RIVERBEND CROSSROADS TOWN', 'rural_village', 'twin_bridge_crossing', 'hostage_rescue', 'day'],
  [79, 'FOB VANGUARD', 'FORWARD AIR-DEFENSE GARRISON 12', 'military_base', 'central_citadel_ring', 'sabotage_destruct', 'dusk'],
  [80, 'HIGHTOWER KEEP', 'FORTIFIED TELECOM COMMAND CITADEL', 'command_compound', 'urban_city_blocks', 'citadel_siege', 'night'],

  // --- ACT V: CITADEL & ARGUS COMMAND ENDGAME (81–100) ---
  [81, 'DOWNTOWN SIEGE', 'METROPOLITAN EXCHANGE & VIADUCT GRID', 'dense_urban', 'urban_city_blocks', 'citadel_siege', 'night'],
  [82, 'SMELTER TITAN', 'BLAST FURNACE & RAIL FOUNDRY CORE', 'industrial_district', 'rail_marshaling_yard', 'sabotage_demo', 'dusk'],
  [83, 'HOLLOW ARSENAL', 'DERELICT ORDNANCE PLANT, SECTOR 18', 'abandoned_factory', 'central_citadel_ring', 'sabotage_destruct', 'overcast'],
  [84, 'RED MIRAGE', 'DEEP DESERT BALLISTIC LAUNCH BASE', 'desert_installation', 'airfield_runway_apron', 'sabotage_destruct', 'sand'],
  [85, 'SUMMIT BATTERY', '3,100M CREST ARTILLERY CITADEL', 'mountain_combat', 'switchback_mountain_pass', 'citadel_siege', 'snow'],
  [86, 'SHADOW TIMBER', 'WOODLAND COMMAND REDOUBT, NORTH VALLEY', 'forest_woodland', 'linear_convoy_corridor', 'vehicle_spearhead', 'dawn'],
  [87, 'IRON HEADLAND', 'CLIFFSIDE NAVAL COMMAND FORTRESS', 'coastal_military', 'harbor_pier_waterfront', 'citadel_siege', 'night'],
  [88, 'TERMINAL ZULU', 'MEGA-CARGO SHIPYARD & DRYDOCK 01', 'harbor_port', 'harbor_pier_waterfront', 'sabotage_demo', 'night'],
  [89, 'SKYLINE RUNWAY', 'MAIN STRATEGIC AIRBASE & HANGAR ROW', 'airport_airfield', 'airfield_runway_apron', 'citadel_siege', 'dusk'],
  [90, 'ABYSS VAULT', 'DEEP-EARTH DATA & MUNITIONS CORE', 'underground_facility', 'underground_bunker_grid', 'assault_breach', 'underground'],
  [91, 'AEGIS TUNNELS', 'SUBTERRANEAN WAR-ROOM BUNKER NETWORK', 'underground_bunker', 'underground_bunker_grid', 'citadel_siege', 'underground'],
  [92, 'OMEGA LABS', 'WEAPONS R&D CONTAINMENT COMPLEX', 'research_lab', 'central_citadel_ring', 'assault_breach', 'night'],
  [93, 'HV CORE PRIME', 'NATIONAL GRID SWITCHING COMPLEX', 'power_station', 'refinery_pipeline_maze', 'blackout_raid', 'night'],
  [94, 'INFERNO TERMINAL', 'STRATEGIC OIL RESERVE & TANK FARM', 'oil_refinery', 'refinery_pipeline_maze', 'sabotage_destruct', 'dusk'],
  [95, 'STONEBRIDGE TOWN', 'FORTIFIED VALLEY TOWN & BRIDGEHEAD', 'rural_village', 'twin_bridge_crossing', 'capture_hold', 'day'],
  [96, 'TITAN SPILLWAY', 'GRAND ARCH-GRAVITY HYDROELECTRIC DAM', 'dam_bridge', 'hydro_dam_gorge', 'citadel_siege', 'dawn'],
  [97, 'IRON GATEWAY', 'SUPREME BORDER BASTION & ARMOR CORRIDOR', 'border_checkpoint', 'linear_convoy_corridor', 'citadel_siege', 'dusk'],
  [98, 'CENTRAL DEPOT', 'STRATEGIC RAIL COMMAND MARSHALING HUB', 'rail_transport', 'rail_marshaling_yard', 'citadel_siege', 'night'],
  [99, 'GARRISON PRIME', 'ARGUS MAIN MILITARY BASE & MOTOR POOL', 'military_base', 'airfield_runway_apron', 'citadel_siege', 'dusk'],
  [100, 'IRON CITADEL', 'ARGUS SUPREME COMMAND FORTRESS, CORE', 'command_compound', 'central_citadel_ring', 'citadel_siege', 'night'],
];

function getActForMission(n) {
  for (const a of CAMPAIGN_ACTS) {
    if (n >= a.range[0] && n <= a.range[1]) return a;
  }
  return { act: 6, range: [101, 999], code: 'ACT VI', title: 'EXTENDED SPECIAL OPERATIONS' };
}

function makeSlug(num, name) {
  const clean = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `sector_${String(num).padStart(3, '0')}_${clean}`;
}

function buildOperationEntry(spec) {
  const [missionNumber, name, location, category, topology, pattern, skyOverride] = spec;
  const id = `op_${String(missionNumber).padStart(3, '0')}`;
  const code = `OP ${String(missionNumber).padStart(3, '0')}`;
  const cat = ENVIRONMENT_CATEGORIES[category] || ENVIRONMENT_CATEGORIES.military_base;
  const actInfo = getActForMission(missionNumber);
  const layoutId = makeSlug(missionNumber, name);
  const minEnemies = getMissionMinEnemies(missionNumber);

  // Scale map half-extents & parTime smoothly with mission scale & topology
  const baseHalf = topology === 'underground_bunker_grid' ? 78
    : topology === 'airfield_runway_apron' ? 104
      : topology === 'linear_convoy_corridor' ? 98
        : 88;
  const scaleGrow = Math.min(18, Math.floor((missionNumber - 18) * 0.2));
  const halfX = baseHalf + ((missionNumber * 7) % 9) + Math.floor(scaleGrow * 0.5);
  const halfZ = baseHalf + ((missionNumber * 11) % 11) + scaleGrow;
  const parTime = 420 + Math.round((missionNumber - 1) * 4.5);

  // Deterministic geometric seed & offsets so every single map has unique sector placement
  const seed = (missionNumber * 2654435761) >>> 0;
  const mirrorX = (missionNumber % 2 === 0) ? -1 : 1;
  const mirrorZ = (missionNumber % 3 === 0) ? -1 : 1;

  // Insertion near +Z perimeter, Primary compound near center/-Z, Extraction on opposite flank
  const spawnPos = [mirrorX * (8 + (missionNumber % 14)), halfZ - 14];
  const vanguardKills = Math.min(minEnemies - 10, 18 + Math.floor(missionNumber * 0.35));
  const lzPos = [-mirrorX * (halfX - 20), -halfZ + 18];

  // Build authentic multi-stage primary objective steps & world placement specs
  const primarySteps = [];
  const placements = {
    spawnPos,
    lzPos,
    terminal: null,
    sabotage: [],
    destructibles: [],
    observations: [],
    generator: null,
    contactNpc: null,
    captureZone: null,
    missionVehicle: null,
  };

  const approachX = mirrorX * 6;
  const approachZ = Math.round(halfZ * 0.36);
  const coreX = -mirrorX * 4;
  const coreZ = -Math.round(halfZ * 0.14);
  const northX = mirrorX * 14;
  const northZ = -Math.round(halfZ * 0.42);

  if (pattern === 'assault_breach') {
    placements.terminal = { x: coreX, y: 0, z: coreZ, hold: 7, label: `DOWNLOAD ${name} COMMAND LEDGER` };
    primarySteps.push(
      { id: 'reach_outer', kind: 'reach', pos: [approachX, approachZ], r: 11, text: `BREACH ${cat.label} OUTER PERIMETER`, sub: 'Advance past exterior sentries into the forward sector' },
      { id: 'vanguard', kind: 'eliminate_count', count: vanguardKills, text: `BREAK SECTOR VANGUARD (${vanguardKills} HOSTILES)`, sub: 'Eliminate forward defenders to expose the command block' },
      { id: 'terminal_dl', kind: 'interact', target: 'terminal', text: `SECURE DATA AT ${name} CORE TERMINAL`, sub: 'Hold F at the encrypted command console' },
      { id: 'clear_all', kind: 'eliminate', text: 'NEUTRALISE REMAINING GARRISON FORCES', sub: 'Clear all hostile echelons across the installation' },
      { id: 'exfil', kind: 'extract', text: 'EXFILTRATE AT DESIGNATED LZ', sub: 'Reach the green extraction beacons' }
    );
  } else if (pattern === 'sabotage_demo') {
    const c1 = [-20 * mirrorX, 6];
    const c2 = [18 * mirrorX, -12];
    const c3 = [coreX, northZ + 8];
    placements.sabotage = [
      { id: 'charge_1', x: c1[0], y: 0, z: c1[1], label: 'PRIMARY INFRASTRUCTURE PYLON' },
      { id: 'charge_2', x: c2[0], y: 0, z: c2[1], label: 'SECONDARY MANIFOLD NODE' },
      { id: 'charge_3', x: c3[0], y: 0, z: c3[1], label: 'CORE STRUCTURAL SUPPORT' },
    ];
    primarySteps.push(
      { id: 'reach_outer', kind: 'reach', pos: [approachX, approachZ], r: 11, text: 'INFILTRATE DEMOLITION TARGET ZONE', sub: 'Penetrate outer security checkpoints' },
      { id: 'c1', kind: 'interact', target: 'charge_1', text: 'PLANT CHARGE 1/3 — PRIMARY PYLON', sub: 'Hold F at the primary infrastructure pylon' },
      { id: 'c2', kind: 'interact', target: 'charge_2', text: 'PLANT CHARGE 2/3 — SECONDARY NODE', sub: 'Hold F at the secondary manifold node' },
      { id: 'c3', kind: 'interact', target: 'charge_3', text: 'PLANT CHARGE 3/3 — CORE SUPPORT', sub: 'Hold F at the core structural support', alarmOnDone: true, surge: [4, 2] },
      { id: 'clear_all', kind: 'eliminate', text: 'ELIMINATE GARRISON COUNTER-RESPONSE', sub: 'Defeat all remaining hostiles in the sector' },
      { id: 'exfil', kind: 'extract', text: 'CLEAR BLAST RADIUS TO EXTRACTION LZ', sub: 'Withdraw to the lit extraction zone' }
    );
  } else if (pattern === 'sabotage_destruct') {
    const d1 = [-22 * mirrorX, 8];
    const d2 = [22 * mirrorX, -10];
    const d3 = [coreX, northZ + 10];
    placements.destructibles = [
      { id: 'dest_alpha', x: d1[0], y: 0, z: d1[1], label: 'ALPHA RADAR / FUEL ARRAY' },
      { id: 'dest_bravo', x: d2[0], y: 0, z: d2[1], label: 'BRAVO TELEMETRY / POWER BANK' },
      { id: 'dest_charlie', x: d3[0], y: 0, z: d3[1], label: 'CHARLIE COMMAND RELAY' },
    ];
    primarySteps.push(
      { id: 'reach_zone', kind: 'reach', pos: [approachX, approachZ], r: 12, text: 'ADVANCE ON TARGET INSTALLATION', sub: 'Push through perimeter defenses toward target hardware' },
      { id: 'kill_alpha', kind: 'destroy', target: 'dest_alpha', pos: [d1[0], d1[1]], text: 'DESTROY ALPHA TARGET EQUIPMENT', sub: 'Use gunfire or explosives to wreck the Alpha array' },
      { id: 'kill_bravo', kind: 'destroy', target: 'dest_bravo', pos: [d2[0], d2[1]], text: 'DESTROY BRAVO TARGET EQUIPMENT', sub: 'Destroy the Bravo telemetry/power bank' },
      { id: 'kill_charlie', kind: 'destroy', target: 'dest_charlie', pos: [d3[0], d3[1]], text: 'DESTROY CHARLIE COMMAND RELAY', sub: 'Shatter the Charlie relay unit', alarmOnDone: true, surge: [4, 2] },
      { id: 'clear_all', kind: 'eliminate', text: 'SWEEP REMAINING BASE DEFENDERS', sub: 'Neutralize all remaining hostile squads' },
      { id: 'exfil', kind: 'extract', text: 'REACH EXTRACTION POINT', sub: 'Proceed to the green extraction beacons' }
    );
  } else if (pattern === 'recon_uplink') {
    const o1 = [-24 * mirrorX, 18];
    const o2 = [24 * mirrorX, -8];
    placements.observations = [
      { id: 'obs_a', x: o1[0], y: 0, z: o1[1], label: 'WEST OVERWATCH SECTOR' },
      { id: 'obs_b', x: o2[0], y: 0, z: o2[1], label: 'EAST COMPOUND GARRISON' },
    ];
    placements.terminal = { x: coreX, y: 0, z: coreZ, hold: 6, label: 'TRANSMIT ENCRYPTED RECON PACKAGE' };
    primarySteps.push(
      { id: 'obs_1', kind: 'interact', target: 'obs_a', text: 'SURVEY TARGET FROM OVERWATCH ALPHA', sub: 'Hold F at the west observation tripod' },
      { id: 'obs_2', kind: 'interact', target: 'obs_b', text: 'LOG HOSTILE DISPOSITIONS AT BRAVO', sub: 'Hold F at the east overwatch post' },
      { id: 'uplink', kind: 'interact', target: 'terminal', text: 'TRANSMIT UPLINK AT RELAY CONSOLE', sub: 'Upload recon package from the core relay room', alarmOnDone: true, surge: [4, 2] },
      { id: 'clear_all', kind: 'eliminate', text: 'ELIMINATE PURSUING GARRISON SQUADS', sub: 'Clear all hostile forces before exfiltration' },
      { id: 'exfil', kind: 'extract', text: 'WITHDRAW TO EXTRACTION LZ', sub: 'Move to the green extraction beacons' }
    );
  } else if (pattern === 'blackout_raid') {
    const genPos = [-18 * mirrorX, 16];
    placements.generator = { x: genPos[0], y: 0, z: genPos[1] };
    placements.terminal = { x: coreX, y: 0, z: coreZ, hold: 7, label: 'OVERRIDE GRID CONTROL TERMINAL' };
    primarySteps.push(
      { id: 'reach_sub', kind: 'reach', pos: [approachX, approachZ], r: 11, text: 'ENTER UTILITY SWITCHYARD', sub: 'Cross outer barriers into the power yard' },
      { id: 'gen_on', kind: 'interact', target: 'generator', text: 'ENERGISE AUXILIARY BYPASS GENERATOR', sub: 'Hold F on the auxiliary diesel generator' },
      { id: 'grid_cut', kind: 'interact', target: 'terminal', text: 'EXECUTE GRID OVERRIDE AT CORE CONSOLE', sub: 'Sever hostile grid routing at the main terminal', alarmOnDone: true, surge: [4, 2] },
      { id: 'clear_all', kind: 'eliminate', text: 'REPEL BLACKOUT QRF & CLEAR SECTOR', sub: 'Eliminate all hostile reinforcements and garrison troops' },
      { id: 'exfil', kind: 'extract', text: 'EXFILTRATE TO LZ', sub: 'Reach the green extraction zone' }
    );
  } else if (pattern === 'hostage_rescue') {
    const npcPos = [coreX, coreZ];
    placements.contactNpc = { x: npcPos[0], z: npcPos[1] };
    primarySteps.push(
      { id: 'reach_det', kind: 'reach', pos: [approachX, approachZ], r: 11, text: 'BREACH DETENTION SECTOR', sub: 'Push into the guarded holding compound' },
      { id: 'vanguard', kind: 'eliminate_count', count: vanguardKills, text: `CLEAR CELLBLOCK GUARDS (${vanguardKills} HOSTILES)`, sub: 'Reduce hostile guard force before freeing the asset' },
      { id: 'free_vip', kind: 'interact', target: 'npc_contact', text: 'LOCATE & SECURE ALLIED ASSET', sub: 'Make contact with the friendly survivor inside the compound' },
      { id: 'escort_lz', kind: 'escort', text: 'ESCORT ALLIED ASSET TO EXTRACTION LZ', sub: 'Lead the survivor safely to the green extraction beacons' },
      { id: 'clear_all', kind: 'eliminate', text: 'CLEAR PURSUING HOSTILES FROM LZ', sub: 'Eliminate remaining hostiles contesting extraction' },
      { id: 'exfil', kind: 'extract', text: 'COMPLETE EXTRACTION', sub: 'Confirm extraction on the lit pad' }
    );
  } else if (pattern === 'vehicle_spearhead') {
    const vehType = cat.vehiclePool[0] || 'latv4';
    const vehPos = [spawnPos[0] - mirrorX * 8, spawnPos[1] - 10];
    placements.missionVehicle = { type: vehType, tag: 'spearhead_veh', x: vehPos[0], z: vehPos[1], yaw: 180 };
    placements.terminal = { x: coreX, y: 0, z: coreZ, hold: 6, label: 'RECOVER CONVOY TRANSPONDER KEYS' };
    primarySteps.push(
      { id: 'board_v', kind: 'board', veh: 'spearhead_veh', text: 'BOARD ASSAULT VEHICLE AT STAGING POINT', sub: 'Hold F beside the tactical vehicle to take the wheel' },
      { id: 'drive_in', kind: 'drive', veh: 'spearhead_veh', pos: [coreX, coreZ + 18], r: 14, text: 'SPEARHEAD THROUGH CHECKPOINT TO CORE SECTOR', sub: 'Drive along the main axis into the inner compound' },
      { id: 'term_key', kind: 'interact', target: 'terminal', text: 'SECURE TRANSPONDER KEYS IN COMMAND POST', sub: 'Dismount and access the command post terminal', alarmOnDone: true, surge: [4, 2] },
      { id: 'clear_all', kind: 'eliminate', text: 'DESTROY REMAINING GARRISON HOSTILES', sub: 'Clear all surviving hostile forces across the sector' },
      { id: 'exfil', kind: 'extract', text: 'REACH EXTRACTION ZONE', sub: 'Proceed to the green extraction beacons' }
    );
  } else if (pattern === 'capture_hold') {
    placements.captureZone = { x: coreX, z: coreZ, radius: 10, duration: 22 };
    primarySteps.push(
      { id: 'reach_front', kind: 'reach', pos: [approachX, approachZ], r: 11, text: 'PUSH INTO CONTESTED SECTOR', sub: 'Advance past forward defensive barricades' },
      { id: 'vanguard', kind: 'eliminate_count', count: vanguardKills, text: `ELIMINATE FORWARD DEFENDERS (${vanguardKills} HOSTILES)`, sub: 'Weaken the garrison before seizing the command point' },
      { id: 'cap_zone', kind: 'capture', pos: [coreX, coreZ], r: 10, duration: 22, text: 'CAPTURE & HOLD TACTICAL COMMAND POINT', sub: 'Remain inside the command zone until control reaches 100%' },
      { id: 'clear_all', kind: 'eliminate', text: 'MOP UP REMAINING HOSTILE ECHELONS', sub: 'Eliminate all surviving hostile units in the area' },
      { id: 'exfil', kind: 'extract', text: 'PROCEED TO EXTRACTION LZ', sub: 'Step onto the green extraction pad' }
    );
  } else {
    // citadel_siege — multi-phase endgame stronghold assault!
    const d1 = [-22 * mirrorX, 12];
    const c1 = [22 * mirrorX, -8];
    placements.destructibles = [
      { id: 'dest_alpha', x: d1[0], y: 0, z: d1[1], label: 'CITADEL AIR-DEFENSE RADAR' },
    ];
    placements.sabotage = [
      { id: 'charge_1', x: c1[0], y: 0, z: c1[1], label: 'ARMORED BUNKER POWER CONDUIT' },
    ];
    placements.terminal = { x: coreX, y: 0, z: coreZ, hold: 8, label: `SEIZE ${name} WAR-ROOM TERMINAL` };
    primarySteps.push(
      { id: 'breach_gate', kind: 'reach', pos: [approachX, approachZ], r: 12, text: `BREACH ${name} OUTER BASTION`, sub: 'Penetrate outer citadel defenses' },
      { id: 'kill_aa', kind: 'destroy', target: 'dest_alpha', pos: [d1[0], d1[1]], text: 'DESTROY CITADEL AIR-DEFENSE RADAR', sub: 'Eliminate the radar array to open air-corridor access' },
      { id: 'plant_bunker', kind: 'interact', target: 'charge_1', text: 'SEVER BUNKER POWER CONDUIT (PLANT C4)', sub: 'Hold F to plant demolition charge on the bunker conduit' },
      { id: 'seize_hq', kind: 'interact', target: 'terminal', text: 'ACCESS SUPREME COMMAND TERMINAL', sub: 'Download war-room command records inside the citadel', alarmOnDone: true, surge: [5, 2] },
      { id: 'clear_all', kind: 'eliminate', text: 'ANNIHILATE ALL REMAINING CITADEL FORCES', sub: 'Neutralize every remaining hostile defender' },
      { id: 'exfil', kind: 'extract', text: 'EXTRACT FROM SECURED CITADEL LZ', sub: 'Reach the green extraction beacons' }
    );
  }

  const optSets = [
    ['marksman', 'par'],
    ['light', 'par'],
    ['intel', 'marksman', 'par'],
  ];
  const optionals = optSets[missionNumber % optSets.length];

  const briefing = {
    situation: `Argus Directorate forces have fortified ${location} (${cat.label}). Satellite and SIGINT intercepts confirm at least ${minEnemies} armed personnel holding multi-layered positions across the sector.`,
    objective: `Execute ${code} — ${name}: penetrate outer defenses, complete all primary tactical directives inside the installation, neutralize the ${minEnemies}-strong hostile garrison, and exfiltrate via the designated LZ.`,
    threat: `Minimum ${minEnemies} hostile combatants deployed across exterior patrols, watchtowers, interior rooms, and staged QRF reinforcement waves. Expect heavy rifles, marksmen on elevated decks, and armored flanking teams.`,
    insertion: `Ground insertion at the southern/flank perimeter staging point. Field tactical vehicles and resupply caches are positioned along approach lanes.`,
    support: `Tactical 2D/3D sat-map active, field ammo & medical crates marked on recon, Base Strike fire-support available once charges are earned.`,
  };

  const typeMap = {
    assault_breach: 'assault',
    sabotage_demo: 'sabotage',
    sabotage_destruct: 'sabotage',
    recon_uplink: 'recon',
    blackout_raid: 'sabotage',
    hostage_rescue: 'extraction',
    vehicle_spearhead: 'transport',
    capture_hold: 'defense',
    citadel_siege: 'assault',
  };
  const hr = String((4 + missionNumber * 3) % 24).padStart(2, '0');
  const mn = String((missionNumber * 15) % 60).padStart(2, '0');
  const wxText = cat.weather === 'rain' ? 'LIGHT RAIN, GUSTS'
    : cat.weather === 'snow' ? 'BLOWING SNOW, COLD'
      : cat.weather === 'dust' ? 'ARID DUST HAZE'
        : skyOverride === 'underground' ? 'SUBTERRANEAN VENTED' : 'CLEAR VISIBILITY';

  const missionDef = {
    map: layoutId,
    flow: 'seq',
    title: name,
    tag: `${cat.label} · ${actInfo.code}`,
    type: typeMap[pattern] || 'assault',
    vehicle: pattern === 'vehicle_spearhead',
    parTime,
    objectivesTotal: primarySteps.length,
    optionals,
    minEnemies,
    missionNumber,
    category,
    categoryLabel: cat.label,
    seq: primarySteps,
  };
  const briefMeta = {
    cat: cat.label,
    loc: `${name} — ${location}`,
    time: `${hr}${mn} HRS`,
    wx: wxText,
    reward: `XP · ${actInfo.code} PROGRESSION · INTEL ARCHIVE`,
  };
  const briefText = `${briefing.situation} ${briefing.objective}`;

  return {
    missionNumber,
    id,
    code,
    name,
    location,
    act: actInfo.act,
    actCode: actInfo.code,
    actTitle: actInfo.title,
    category,
    categoryLabel: cat.label,
    intelMapKey: cat.intelKey,
    layoutId,
    topology,
    pattern,
    skyProfile: skyOverride || cat.sky,
    weather: cat.weather,
    groundType: cat.ground,
    groundTint: cat.groundTint,
    vehiclePool: cat.vehiclePool,
    boundsHalf: [halfX, halfZ],
    parTime,
    minEnemies,
    seed,
    mirrorX,
    mirrorZ,
    placements,
    primarySteps,
    optionals,
    briefing,
    missionDef,
    briefMeta,
    briefText,
  };
}

// Build complete 100-mission ordered catalog
export const CAMPAIGN_CATALOG = [];
export const CAMPAIGN_BY_ID = new Map();
export const CAMPAIGN_BY_LAYOUT = new Map();

for (const leg of LEGACY_CAMPAIGN_ENTRIES) {
  const cat = ENVIRONMENT_CATEGORIES[leg.category];
  const actInfo = getActForMission(leg.missionNumber);
  const entry = {
    ...leg,
    isLegacy: true,
    act: actInfo.act,
    actCode: actInfo.code,
    actTitle: actInfo.title,
    categoryLabel: cat.label,
    intelMapKey: cat.intelKey,
    skyProfile: cat.sky,
    weather: cat.weather,
    groundType: cat.ground,
    groundTint: cat.groundTint,
    vehiclePool: cat.vehiclePool,
    minEnemies: getMissionMinEnemies(leg.missionNumber),
  };
  CAMPAIGN_CATALOG.push(entry);
  CAMPAIGN_BY_ID.set(entry.id, entry);
  CAMPAIGN_BY_LAYOUT.set(entry.layoutId, entry);
}

for (const spec of NEW_OPERATION_SPECS) {
  const entry = buildOperationEntry(spec);
  CAMPAIGN_CATALOG.push(entry);
  CAMPAIGN_BY_ID.set(entry.id, entry);
  CAMPAIGN_BY_LAYOUT.set(entry.layoutId, entry);
}

/**
 * Extensibility API: dynamically register Mission 101+ into the campaign
 * catalog without refactoring mission menus, progression, or map builders.
 */
export function registerCampaignOperation(customSpec) {
  const nextNum = customSpec.missionNumber || (CAMPAIGN_CATALOG.length + 1);
  const specArr = [
    nextNum,
    customSpec.name || `OPERATION ${nextNum}`,
    customSpec.location || `CONTESTED SECTOR ${nextNum}`,
    customSpec.category || 'military_base',
    customSpec.topology || TOPOLOGY_FAMILIES[nextNum % TOPOLOGY_FAMILIES.length],
    customSpec.pattern || 'assault_breach',
    customSpec.skyProfile || null,
  ];
  const entry = buildOperationEntry(specArr);
  if (customSpec.id) entry.id = customSpec.id;
  CAMPAIGN_CATALOG.push(entry);
  CAMPAIGN_BY_ID.set(entry.id, entry);
  CAMPAIGN_BY_LAYOUT.set(entry.layoutId, entry);
  return entry;
}
