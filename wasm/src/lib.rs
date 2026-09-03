use std::collections::{HashMap, HashSet};

use boon::Serializer;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct DemoParser {
    inner: boon::Parser,
}

const PAWN_CLASS: &str = "CCitadelPlayerPawn";
const CONTROLLER_CLASS: &str = "CCitadelPlayerController";
const GAMERULES_CLASS: &str = "CCitadelGameRulesProxy";
const BARRIER_TRACKER_MODIFIER_ID: u32 = 4_267_845_006;
const BREAKABLE_CLASS: &str = "CCitadel_BreakableProp";
const SINNER_CLASSES: &[&str] = &[
    "CNPC_Neutral_SinnersSacrifice",
    "CNPC_Neutral_SinnersSacrifice_Hideout",
];

/// Networked classes of the destructible objectives, used to label
/// `k_EUserMsg_BossKilled` events for the objectives feed. The killed entity is
/// already despawned by the time the message arrives, so we keep a rolling
/// index→class cache; the class name is the stable signal (the message's
/// `entity_killed_class` enum can drift between patches). Verified empirically
/// against demos — see `objective_kind`.
const OBJ_CLASSES: &[&str] = &[
    "CNPC_TrooperBoss",              // Guardian (tier 1)
    "CNPC_Boss_Tier2",               // Walker (tier 2)
    "CNPC_BarrackBoss",              // Base Guardian
    "CCitadel_Destroyable_Building", // Shrine
    "CNPC_Boss_Tier3",               // Patron (final)
    "CNPC_MidBoss",                  // Mid-Boss (neutral)
];

/// Lane creeps (the marching troopers), plotted live on the minimap.
const TROOPER_CLASS: &str = "CNPC_Trooper";

/// Pack one alive trooper into an i32 so frames hold a flat number array rather
/// than ~30 objects each (there are ~18k frames). Layout: bits 11–20 = qx,
/// bits 1–10 = qy (world coord quantized to 32 units over the ±16384 range,
/// ~1px on the minimap), bit 0 = team (0 → team 2, 1 → team 3). The frontend
/// reverses this. Precision loss is invisible for the small dots.
fn pack_trooper(x: f32, y: f32, team: i64) -> i32 {
    let qx = (((x + 16384.0) / 32.0).round() as i32).clamp(0, 1023);
    let qy = (((y + 16384.0) / 32.0).round() as i32).clamp(0, 1023);
    let t = if team == 3 { 1 } else { 0 };
    (qx << 11) | (qy << 1) | t
}

/// Neutral jungle creeps. There is no camp entity in the demo, so camps are
/// derived by clustering these creeps' spawn positions (see player_positions).
const NEUTRAL_CLASS: &str = "CNPC_TrooperNeutral";

/// The Urn pickup ("Idol" in the gameplay code). A fresh entity of this class
/// appears each time the Urn spawns into the world (~every 5 min, alternating
/// mid-lane sides), so a newly-seen index = an "urn spawns" objective event.
const IDOL_CLASS: &str = "CCitadelItemPickupIdol";

/// While the Urn is carried, its world entity despawns (it's held abstractly on
/// the player). The picker is the hero standing on the urn the instant it
/// vanishes, so a despawn within this radius of a living pawn = a pickup, and we
/// then plot the urn on that carrier until the entity reappears (drop), the
/// carrier dies, or this timeout (a backstop for the deliver-and-survive case
/// the demo gives us no clean end-signal for).
const URN_PICKUP_RADIUS: f32 = 350.0;
const URN_CARRY_MAX_TICKS: i32 = 90 * 64;

/// Every current hero exposes four ESlot_Signature_N abilities. The network
/// vector has eight storage slots, but unused trailing slots can retain a
/// previous hero's IDs during initialization.
const SIGNATURE_ABILITY_SLOTS: usize = 4;

const ABILITY_UPGRADE_SLOTS: usize = 8;
const UPGRADE_SLOTS: usize = 16;
/// The game clears the Rift location to FLT_MAX when it resolves. This sanity
/// bound rejects that finite sentinel and any other implausible map coordinate.
const RIFT_COORD_SANITY: f32 = 1.0e6;

fn rift_xy(location: Option<[f32; 3]>) -> (Option<f32>, Option<f32>) {
    location
        .map(|point| (Some(point[0]), Some(point[1])))
        .unwrap_or((None, None))
}

/// Clustering / occupancy radius for grouping creeps into a camp (world units).
/// Tuned so a camp's spread (~600) groups but adjacent camps (~1000+) don't.
const CAMP_RADIUS: f32 = 700.0;

/// Camp size bucket (1 = small, 2 = medium, 3 = large) from a creep's max
/// health — the three neutral creep types are ~142 / ~355 / ~1323 HP. A camp's
/// size is the largest creep tier it contains.
fn neutral_tier(max_health: i32) -> u8 {
    if max_health >= 900 {
        3
    } else if max_health >= 250 {
        2
    } else {
        1
    }
}

/// Stable slug for an objective, from its networked class name. The frontend
/// turns these into display labels + icons.
fn objective_kind(class_name: &str) -> &'static str {
    match class_name {
        "CNPC_TrooperBoss" => "guardian",
        "CNPC_Boss_Tier2" => "walker",
        "CNPC_BarrackBoss" => "base_guardian",
        "CCitadel_Destroyable_Building" => "shrine",
        "CNPC_Boss_Tier3" => "patron",
        "CNPC_MidBoss" => "mid_boss",
        _ => "objective",
    }
}

/// Whether a damage-matrix `source_name` is one of Valve's coarse damage-type
/// buckets (`Bullet`/`Ability`/`Melee`/`Misc`/`UnknownAbility`) rather than a
/// specific source. Coarse buckets use Capitalized display names; specific
/// sources use snake_case identifiers (e.g. `citadel_weapon_astro_set`). The
/// matrix records each damage hit under both, so summing all rows double-counts
/// — pick one. We use categories for the by-source bands and specific sources
/// for the hero-vs-hero totals. Mirrors boon-python's `is_category_source`.
fn is_category_source(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase) && !name.contains('_')
}

/// One post-match summary snapshot for a player: running totals at a sampled
/// match time. Team/color is resolved frontend-side from the roster by
/// `hero_id`. Emitted by `DemoParser::summary`.
#[derive(Serialize)]
struct SnapshotStat {
    time_s: u32,
    hero_id: u32,
    net_worth: u32,
    kills: u32,
    deaths: u32,
    assists: u32,
    creep_kills: u32,
    neutral_kills: u32,
    player_damage: u32,
    player_healing: u32,
    denies: u32,
    ability_points: u32,
    // Per-source souls (gold + soul orbs) from `gold_sources`, for the player
    // souls-by-source view. `souls_other` lumps the rare item/ability sources.
    souls_players: u32,
    souls_lane: u32,
    souls_neutral: u32,
    souls_boss: u32,
    souls_treasure: u32,
    souls_denies: u32,
    souls_assists: u32,
    souls_team_bonus: u32,
    souls_other: u32,
}

/// Total hero-damage dealt from one hero to another over the whole match, from
/// the post-match damage matrix (specific sources only, so no double-count).
/// Powers the hero-vs-hero Matrix view.
#[derive(Serialize)]
struct DamagePair {
    dealer_hero: u32,
    target_hero: u32,
    damage: u32,
}

/// A dealer hero's cumulative damage in one coarse source category
/// (`Bullet`/`Ability`/`Melee`/`Misc`/…), summed over all targets and sampled
/// at `damage_sample_times`. Powers the Graph view's damage-by-source bands.
#[derive(Serialize)]
struct DamageSourceSeries {
    hero_id: u32,
    source: String,
    values: Vec<u32>,
}

#[derive(Serialize)]
struct SummaryResult {
    snapshots: Vec<SnapshotStat>,
    /// Shared time axis (seconds) for `damage_by_source` cumulative series.
    damage_sample_times: Vec<u32>,
    /// Hero-vs-hero total damage (Matrix view).
    damage_matrix: Vec<DamagePair>,
    /// Per (hero, coarse category) cumulative damage series (Graph view).
    damage_by_source: Vec<DamageSourceSeries>,
}

#[wasm_bindgen]
impl DemoParser {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<DemoParser, JsError> {
        let inner = boon::Parser::from_bytes(bytes);
        inner.verify().map_err(to_js_error)?;
        Ok(Self { inner })
    }

    #[wasm_bindgen(js_name = fileHeader)]
    pub fn file_header(&self) -> Result<JsValue, JsError> {
        let header = self.inner.file_header().map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&header).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Post-match summary from the demo's `PostMatchDetails` user message: the
    /// per-player time-series snapshots (net worth, KDA, farm, damage, …) the
    /// game records at intervals through the match. Returns empty `snapshots`
    /// when the demo has no post-match details (e.g. an incomplete recording).
    #[wasm_bindgen(js_name = summary)]
    pub fn summary(&self) -> Result<JsValue, JsError> {
        use boon_proto::proto::{
            CCitadelUserMsgPostMatchDetails, CMsgMatchMetaDataContents,
            CitadelUserMessageIds as Msg,
        };
        use prost::Message;

        let event_types = [Msg::KEUserMsgPostMatchDetails as u32]
            .into_iter()
            .collect();
        let events = self
            .inner
            .events_filtered(None, &event_types)
            .map_err(to_js_error)?;
        let mut snapshots: Vec<SnapshotStat> = Vec::new();
        let mut damage_sample_times: Vec<u32> = Vec::new();
        let mut damage_matrix: Vec<DamagePair> = Vec::new();
        let mut damage_by_source: Vec<DamageSourceSeries> = Vec::new();
        for event in &events {
            if event.msg_type != Msg::KEUserMsgPostMatchDetails as u32 {
                continue;
            }
            let Ok(outer) = CCitadelUserMsgPostMatchDetails::decode(event.payload.as_slice())
            else {
                continue;
            };
            let Some(details) = outer.match_details else {
                continue;
            };
            let Ok(contents) = CMsgMatchMetaDataContents::decode(details.as_slice()) else {
                continue;
            };
            let Some(match_info) = contents.match_info else {
                continue;
            };
            for player in &match_info.players {
                let hero_id = player.hero_id();
                for st in &player.stats {
                    // Souls per source = gold + orbs, keyed by the EGoldSource
                    // enum (1=players, 2=lane, 3=neutrals, 4=bosses, 5=treasure,
                    // 6=assists, 7=denies, 8=team_bonus, 9..13=rare items/abilities).
                    let mut by = [0u32; 14];
                    for gs in &st.gold_sources {
                        let src = gs.source.unwrap_or(0);
                        if (1..=13).contains(&src) {
                            by[src as usize] += gs.gold() + gs.gold_orbs();
                        }
                    }
                    snapshots.push(SnapshotStat {
                        time_s: st.time_stamp_s(),
                        hero_id,
                        net_worth: st.net_worth(),
                        kills: st.kills(),
                        deaths: st.deaths(),
                        assists: st.assists(),
                        creep_kills: st.creep_kills(),
                        neutral_kills: st.neutral_kills(),
                        player_damage: st.player_damage(),
                        player_healing: st.player_healing(),
                        denies: st.denies(),
                        ability_points: st.ability_points(),
                        souls_players: by[1],
                        souls_lane: by[2],
                        souls_neutral: by[3],
                        souls_boss: by[4],
                        souls_treasure: by[5],
                        souls_denies: by[7],
                        souls_assists: by[6],
                        souls_team_bonus: by[8],
                        souls_other: by[9] + by[10] + by[11] + by[12] + by[13],
                    });
                }
            }

            // --- Damage matrix → hero-vs-hero totals + by-source series ----
            // Per (dealer, source, target) the matrix stores a cumulative,
            // right-aligned `damage` array over `sample_time_s`. Each hit is
            // recorded under both a coarse category and a specific source:
            // categories feed the by-source bands (clean handful of buckets),
            // specific sources feed the hero-vs-hero totals (no double-count).
            if let Some(matrix) = &match_info.damage_matrix {
                let times = &matrix.sample_time_s;
                let n = times.len();
                damage_sample_times = times.clone();
                let slot_to_hero: HashMap<u32, u32> = match_info
                    .players
                    .iter()
                    .filter_map(|p| p.player_slot.map(|slot| (slot, p.hero_id())))
                    .collect();
                let (names, stats): (&[String], &[i32]) = match matrix.source_details.as_ref() {
                    Some(sd) => (sd.source_name.as_slice(), sd.stat_type.as_slice()),
                    None => (&[], &[]),
                };
                let mut pair_totals: HashMap<(u32, u32), u32> = HashMap::new();
                let mut series: HashMap<(u32, String), Vec<u32>> = HashMap::new();
                for dealer in &matrix.damage_dealers {
                    let Some(&dhero) = slot_to_hero.get(&dealer.dealer_player_slot()) else {
                        continue;
                    };
                    if dhero == 0 {
                        continue;
                    }
                    for source in &dealer.damage_sources {
                        let idx = source.source_details_index() as usize;
                        // EStatType: 0 = damage. The Matrix/by-source views are
                        // about hero damage only.
                        if stats.get(idx).copied().unwrap_or(0) != 0 {
                            continue;
                        }
                        let name = names.get(idx).cloned().unwrap_or_default();
                        let category = is_category_source(&name);
                        for dtp in &source.damage_to_players {
                            let arr = &dtp.damage;
                            if arr.is_empty() {
                                continue;
                            }
                            // Cumulative arrays cover the last `arr.len()` samples.
                            let start = n.saturating_sub(arr.len());
                            if category {
                                let s = series
                                    .entry((dhero, name.clone()))
                                    .or_insert_with(|| vec![0u32; n]);
                                for (k, &cum) in arr.iter().enumerate() {
                                    let i = start + k;
                                    if i < s.len() {
                                        s[i] = s[i].saturating_add(cum);
                                    }
                                }
                            } else if let Some(&thero) = slot_to_hero.get(&dtp.target_player_slot())
                            {
                                // Final cumulative value = total for this pair.
                                if thero != 0 {
                                    *pair_totals.entry((dhero, thero)).or_insert(0) +=
                                        arr.last().copied().unwrap_or(0);
                                }
                            }
                        }
                    }
                }
                damage_matrix = pair_totals
                    .into_iter()
                    .map(|((dealer_hero, target_hero), damage)| DamagePair {
                        dealer_hero,
                        target_hero,
                        damage,
                    })
                    .collect();
                damage_by_source = series
                    .into_iter()
                    .map(|((hero_id, source), values)| DamageSourceSeries {
                        hero_id,
                        source,
                        values,
                    })
                    .collect();
            }

            break; // a single PostMatchDetails carries the whole match
        }
        serde_wasm_bindgen::to_value(&SummaryResult {
            snapshots,
            damage_sample_times,
            damage_matrix,
            damage_by_source,
        })
        .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Walk every tick and emit per-player frames sampled every
    /// `sample_every` ticks. Each frame contains both the position from
    /// CCitadelPlayerPawn and the live stats from CCitadelPlayerController,
    /// merged by hero ID.
    ///
    /// `progress` is invoked periodically as `(tick, total_ticks)` so the caller
    /// can render a progress bar; `total_ticks` is 0 if the demo trailer lacks a
    /// playback-tick count.
    #[wasm_bindgen(js_name = playerPositions)]
    pub fn player_positions(
        &self,
        sample_every: u32,
        progress: &js_sys::Function,
    ) -> Result<JsValue, JsError> {
        // Every ability a hero owns is its own networked entity — one class per
        // ability (hundreds total). To track per-ability cooldowns we must decode
        // them all; their class names come from the send tables (any class whose
        // name contains "Ability"). Collected into an owned Vec that outlives the
        // borrowed `&str` class filter below.
        let ability_class_names: Vec<String> = self
            .inner
            .parse_send_tables()
            .map(|sc| {
                sc.iter()
                    .filter(|(name, _)| name.contains("Ability"))
                    .map(|(name, _)| name.to_owned())
                    .collect()
            })
            .unwrap_or_default();

        let class_filter: HashSet<&str> = [
            PAWN_CLASS,
            CONTROLLER_CLASS,
            GAMERULES_CLASS,
            NEUTRAL_CLASS,
            TROOPER_CLASS,
            IDOL_CLASS,
            BREAKABLE_CLASS,
        ]
        .into_iter()
        .chain(OBJ_CLASSES.iter().copied())
        .chain(SINNER_CLASSES.iter().copied())
        .chain(ability_class_names.iter().map(String::as_str))
        .collect();

        let step = sample_every.max(1) as i32;
        let mut last_emitted: Option<i32> = None;

        // Total tick count from the demo trailer, for the progress bar (0 if
        // absent). Progress is reported at most every ~512 ticks to keep the
        // JS round-trips cheap.
        let total_ticks = self
            .inner
            .file_info()
            .ok()
            .and_then(|fi| fi.playback_ticks)
            .unwrap_or(0);
        let mut last_progress_tick: i32 = i32::MIN;
        const PROGRESS_EVERY: i32 = 512;

        // Pawn keys
        let mut pawn_keys_resolved = false;
        let mut pk_x: Option<u64> = None;
        let mut pk_y: Option<u64> = None;
        let mut pk_z: Option<u64> = None;
        let mut pk_cell_x: Option<u64> = None;
        let mut pk_cell_y: Option<u64> = None;
        let mut pk_cell_z: Option<u64> = None;
        let mut pk_team: Option<u64> = None;
        let mut pk_hero: Option<u64> = None;
        let mut pk_life: Option<u64> = None;
        let mut pk_health: Option<u64> = None;
        let mut pk_max_health: Option<u64> = None;
        // m_angEyeAngles: QAngle(pitch, yaw, roll) — the hero's look direction.
        let mut pk_eye: Option<u64> = None;

        // Controller keys
        let mut ctrl_keys_resolved = false;
        let mut ck_hero: Option<u64> = None;
        let mut ck_team: Option<u64> = None;
        let mut ck_name: Option<u64> = None;
        let mut ck_rank: Option<u64> = None;
        let mut ck_net_worth: Option<u64> = None;
        let mut ck_ap_net_worth: Option<u64> = None;
        let mut ck_kills: Option<u64> = None;
        let mut ck_deaths: Option<u64> = None;
        let mut ck_assists: Option<u64> = None;
        let mut ck_damage: Option<u64> = None;
        let mut ck_healing: Option<u64> = None;
        let mut ck_objective_damage: Option<u64> = None;
        let mut ck_health_max: Option<u64> = None;
        let mut ck_pawn: Option<u64> = None;
        // (eValType key, value key) pairs for the 20 stat-modifier slots on
        // m_PlayerDataGlobal.m_vecStatViewerModifierValues.
        let mut ck_stat_keys: Vec<(Option<u64>, Option<u64>)> = Vec::with_capacity(20);
        let mut ck_level: Option<u64> = None;
        let mut ck_upgrade_count: Option<u64> = None;
        let mut ck_upgrade_keys = [None; UPGRADE_SLOTS];
        // (m_ItemID key, m_nUpgradeInfo key) pairs for the four signature slots
        // on m_PlayerDataGlobal.m_vecAbilityUpgradeState.
        let mut ck_ability_keys: Vec<(Option<u64>, Option<u64>)> =
            Vec::with_capacity(ABILITY_UPGRADE_SLOTS);

        let frame_capacity = (total_ticks.max(0) as usize / step as usize).saturating_add(1);
        let mut frames = PackedFrames::with_capacity(frame_capacity);
        let mut pawn_to_hero: HashMap<i32, i64> = HashMap::new();
        let mut slot_to_hero: HashMap<i32, i64> = HashMap::new();
        let mut roster: HashMap<i32, PlayerInfo> = HashMap::new();
        let mut winner: Option<i32> = None;
        let mut item_events_raw: Vec<RawItemEvent> = Vec::new();
        let mut kill_events_raw: Vec<RawKillEvent> = Vec::new();
        let mut ability_events_raw: Vec<RawAbilityEvent> = Vec::new();
        let mut chat_events_raw: Vec<RawChatEvent> = Vec::new();
        // Gun-fire tallies. CMsgFireBullets fires once per trigger pull; we
        // accumulate per shooter pawn across each sample window and flush a
        // per-frame count on every emitted frame (resolved to hero IDs after
        // the walk, like kills). Powers the live-map muzzle pulses.
        let mut fire_accum: HashMap<i32, u16> = HashMap::new();
        let mut fire_events_raw: Vec<RawFireEvent> = Vec::new();

        // Objective destructions (Guardian/Walker/Shrine/Base Guardian/Patron +
        // Mid-Boss). Resolved post-loop to hero IDs via pawn_to_hero. The
        // rolling cache holds each objective entity's kind by index so a kill
        // message can still be labeled after the entity despawns on its kill
        // tick.
        let mut obj_kind_by_idx: HashMap<i32, &'static str> = HashMap::new();
        let mut objective_events_raw: Vec<RawObjectiveEvent> = Vec::new();

        // Live objective state for the map overlay. Buildings are static, so we
        // capture a constant roster (kind/team/position/max_health, keyed by
        // entity index) plus sparse health samples — health is recorded only
        // when it changes at a sampled tick, like items/ability upgrades. Death
        // ticks come from BossKilled. Field keys are resolved once per class.
        let mut obj_keys: HashMap<&'static str, ObjKeys> = HashMap::new();
        let mut obj_roster: HashMap<i32, ObjectiveBuild> = HashMap::new();
        let mut obj_last_hp: HashMap<i32, (i32, i32)> = HashMap::new();
        let mut obj_health_events: Vec<ObjectiveHealthEvent> = Vec::new();
        let mut obj_death_tick: HashMap<i32, i32> = HashMap::new();

        // Stable entity identities keep PVS leaves and slot reuse from being
        // mistaken for destruction or a fresh spawn.
        let mut breakable_keys: Option<MapEntityKeys> = None;
        let mut breakable_live: HashMap<boon::EntityId, BreakableState> = HashMap::new();
        let mut breakable_pending: HashMap<boon::EntityId, (i32, BreakableState)> = HashMap::new();
        let mut sinner_keys: Option<MapEntityKeys> = None;
        let mut sinner_health: HashMap<boon::EntityId, i32> = HashMap::new();
        let mut sinner_events: Vec<SinnerEvent> = Vec::new();

        // Neutral camps. No camp entity exists, so camps are clustered from
        // creep spawn positions (first-seen ≈ at-rest at the camp). Size is the
        // largest creep tier in the cluster; up/down state is sparse (a camp is
        // "up" at a sampled tick if a live creep is within CAMP_RADIUS of it).
        let mut neutral_keys_resolved = false;
        let mut nk_cell_x: Option<u64> = None;
        let mut nk_vec_x: Option<u64> = None;
        let mut nk_cell_y: Option<u64> = None;
        let mut nk_vec_y: Option<u64> = None;
        let mut nk_max_health: Option<u64> = None;
        let mut nk_life: Option<u64> = None;
        let mut camps: Vec<CampBuild> = Vec::new();
        let mut seen_creeps: HashSet<i32> = HashSet::new();
        let mut camp_state_events: Vec<CampStateEvent> = Vec::new();

        // Lane troopers — packed into each frame (see pack_trooper).
        let mut trooper_keys_resolved = false;
        let mut tk_cell_x: Option<u64> = None;
        let mut tk_vec_x: Option<u64> = None;
        let mut tk_cell_y: Option<u64> = None;
        let mut tk_vec_y: Option<u64> = None;
        let mut tk_team: Option<u64> = None;
        let mut tk_life: Option<u64> = None;

        // Urn (Idol) spawn tracking. Position keys resolved once; a per-tick
        // "present last tick" set turns a newly-appearing idol entity into one
        // "urn spawns" objective event at its spawn location.
        let mut idol_keys_resolved = false;
        let mut idk_cell_x: Option<u64> = None;
        let mut idk_vec_x: Option<u64> = None;
        let mut idk_cell_y: Option<u64> = None;
        let mut idk_vec_y: Option<u64> = None;
        let mut idk_team: Option<u64> = None;
        let mut idol_prev: HashSet<i32> = HashSet::new();
        let mut idol_now: HashSet<i32> = HashSet::new();
        let mut idol_last_pos: HashMap<i32, (f32, f32)> = HashMap::new();
        // The pawn currently carrying the urn (entity despawned), or None.
        let mut carrier_pawn: Option<i32> = None;
        let mut carry_start: i32 = 0;

        // Ability upgrades are stored as a sparse event log rather than on every
        // frame (each hero's 4 abilities only change a dozen times a match). The
        // constant per-hero ability set is captured once in `ability_slots`; the
        // frontend reconstructs current levels at the playback tick, like items.
        let mut ability_slots: HashMap<i64, Vec<AbilitySlot>> = HashMap::new();
        let mut ability_prev_level: HashMap<(i64, usize), i32> = HashMap::new();
        let mut ability_upgrade_events: Vec<AbilityUpgradeEvent> = Vec::new();

        // Pause / regulation tracking. `active_ticks` accumulates non-paused
        // ticks from the start of the recording (boon's regulation clock);
        // pauses come from CCitadelGameRulesProxy.m_pGameRules.m_bGamePaused.
        let mut gr_keys_resolved = false;
        let mut gk_paused: Option<u64> = None;
        let mut gk_game_mode: Option<u64> = None;
        let mut gk_match_mode: Option<u64> = None;
        let mut game_mode: i32 = 0;
        let mut match_mode: i32 = 0;
        // Rift (Koth) lifecycle fields, also carried by the game-rules entity.
        let mut rk_cashin_started: Option<u64> = None;
        let mut rk_scoring_team: Option<u64> = None;
        let mut rk_location: Option<u64> = None;

        // A Rift opens, then resolves exactly once by capture or expiration.
        let mut rift_live = false;
        let mut rift_captured = false;
        let mut rift_seen_contested = false;
        let mut rift_location: Option<[f32; 3]> = None;
        let mut prev_tick: Option<i32> = None;
        let mut prev_paused = false;
        let mut active_ticks: i32 = 0;
        let mut pause_intervals: Vec<PauseInterval> = Vec::new();
        let mut cur_pause_start: Option<i32> = None;
        let mut game_over_tick: Option<i32> = None;
        let mut regulation_ticks: Option<i32> = None;

        // --- Active modifiers (buffs / debuffs) ---------------------------
        // The networked "ActiveModifiers" string table holds one
        // CModifierTableEntry per live modifier instance, delta-updated each
        // tick. We diff it by serial number (mirroring boon-python's
        // `active_modifiers`) and emit one span [start_tick, end_tick) per
        // modifier applied to a player pawn. Each span is labeled by its
        // *source* ability/item (`ability_subclass` resolves far more often
        // than the modifier's own subclass) with the modifier's own name as a
        // secondary label; spans that resolve to neither are dropped. Reading
        // the string table is independent of the entity class filter.
        let mut modifier_state = boon::ModifierState::default();
        let mut mod_open: HashMap<u32, OpenModifier> = HashMap::new();
        let mut modifier_spans: Vec<ModifierSpan> = Vec::new();
        // Barrier is not a pawn send-table field. Its persistent tracker uses
        // float1 for capacity and float2 for current remaining barrier.
        let mut barrier_by_pawn: HashMap<i32, f32> = HashMap::new();
        let mut barrier_serial_pawn: HashMap<u32, i32> = HashMap::new();

        // --- Ability cooldowns (per-ability entity state) -----------------
        // Each ability entity carries cooldown/charge fields; we diff them every
        // tick and emit a row only when they change (change-only, like the
        // modifier table). Field keys differ per ability class, so they are
        // resolved once per class and cached. Owner ehandle → pawn → hero.
        struct AbilityKeys {
            subclass_id: Option<u64>,
            slot: Option<u64>,
            cooldown_start: Option<u64>,
            cooldown_end: Option<u64>,
            remaining_charges: Option<u64>,
            recharge_start: Option<u64>,
            recharge_end: Option<u64>,
            owner: Option<u64>,
        }
        let mut ability_keys_cache: HashMap<String, AbilityKeys> = HashMap::new();
        // entity idx → last (cooldown_start, cooldown_end, remaining_charges,
        // recharge_start, recharge_end), for change detection.
        let mut abil_prev: HashMap<i32, (f32, f32, i32, f32, f32)> = HashMap::new();
        let mut ability_ticks: Vec<AbilityTick> = Vec::new();

        use boon_proto::proto::{CitadelUserMessageIds as Msg, ECitadelGameEvents};
        let event_types: HashSet<u32> = [
            Msg::KEUserMsgAbilitiesChanged as u32,
            Msg::KEUserMsgHeroKilled as u32,
            Msg::KEUserMsgGameOver as u32,
            Msg::KEUserMsgImportantAbilityUsed as u32,
            Msg::KEUserMsgBossKilled as u32,
            Msg::KEUserMsgChatMsg as u32,
            ECitadelGameEvents::GeFireBullets as u32,
        ]
        .into_iter()
        .collect();

        self.inner
            .run_to_end_with_event_types_filtered(&class_filter, &event_types, |ctx, events| {
                // --- report parse progress (throttled) ---
                // saturating_sub: last_progress_tick starts at i32::MIN, so a
                // plain subtraction would overflow and the bar would never
                // advance until the final 100% call.
                if ctx.tick().saturating_sub(last_progress_tick) >= PROGRESS_EVERY {
                    last_progress_tick = ctx.tick();
                    let _ = progress.call2(
                        &JsValue::NULL,
                        &JsValue::from(ctx.tick()),
                        &JsValue::from(total_ticks),
                    );
                }

                // --- pause / regulation tracking (runs every tick) ---
                if !gr_keys_resolved && let Some(s) = ctx.serializers().get(GAMERULES_CLASS) {
                    gk_paused = s.resolve_field_key("m_pGameRules.m_bGamePaused");
                    gk_game_mode = s.resolve_field_key("m_pGameRules.m_eGameMode");
                    gk_match_mode = s.resolve_field_key("m_pGameRules.m_eMatchMode");
                    rk_cashin_started = s.resolve_field_key("m_pGameRules.m_timeKothCashInStarted");
                    rk_scoring_team = s.resolve_field_key("m_pGameRules.m_nKothScoringTeam");
                    rk_location = s.resolve_field_key("m_pGameRules.m_vKothCashInCurrentLocation");
                    gr_keys_resolved = true;
                }
                let game_rules = ctx
                    .entities()
                    .iter()
                    .find(|(_, e)| e.class_name.as_ref() == GAMERULES_CLASS)
                    .map(|(_, e)| e);
                if let Some(entity) = game_rules {
                    let observed_game_mode = entity.get_i64(gk_game_mode) as i32;
                    let observed_match_mode = entity.get_i64(gk_match_mode) as i32;
                    if observed_game_mode != 0 {
                        game_mode = observed_game_mode;
                    }
                    if observed_match_mode != 0 {
                        match_mode = observed_match_mode;
                    }
                }
                let paused_now = game_rules
                    .map(|e| e.get_bool(gk_paused))
                    .unwrap_or(prev_paused);
                if let Some(pt) = prev_tick
                    && !prev_paused
                {
                    // Attribute the elapsed ticks to the (prior) play state.
                    active_ticks += (ctx.tick() - pt).max(0);
                }
                if paused_now && !prev_paused {
                    cur_pause_start = Some(ctx.tick());
                } else if !paused_now
                    && prev_paused
                    && let Some(start) = cur_pause_start.take()
                {
                    pause_intervals.push(PauseInterval {
                        start,
                        end: ctx.tick(),
                    });
                }
                prev_tick = Some(ctx.tick());
                prev_paused = paused_now;

                // --- Rift (Koth) lifecycle --------------------------------
                // This mirrors boon's Rift dataset: the cash-in timer marks the
                // live window, while the scoring team gives the final winner.
                if let Some(entity) = game_rules {
                    let cashin_started = entity.get_f32(rk_cashin_started);
                    let is_live = cashin_started > 0.0 && cashin_started.is_finite();
                    let scoring_team = entity.get_i64(rk_scoring_team) as i32;
                    let opened = is_live && !rift_live;

                    if opened {
                        rift_live = true;
                        rift_captured = false;
                        rift_seen_contested = scoring_team <= 0;
                        rift_location = None;
                    }

                    if rift_live {
                        // Read the location only while live: the resolving tick
                        // replaces it with FLT_MAX.
                        if is_live {
                            let location = entity.get_vector3(rk_location);
                            if location != [0.0; 3]
                                && location
                                    .iter()
                                    .all(|coordinate| coordinate.abs() < RIFT_COORD_SANITY)
                            {
                                rift_location = Some(location);
                            }
                        }

                        if opened {
                            let (x, y) = rift_xy(rift_location);
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: ctx.tick(),
                                kind: "rift",
                                action: "opened",
                                team: -1,
                                killer_pawn: -1,
                                x,
                                y,
                            });
                        }

                        if scoring_team <= 0 {
                            rift_seen_contested = true;
                        } else if rift_seen_contested && !rift_captured {
                            rift_captured = true;
                            let (x, y) = rift_xy(rift_location);
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: ctx.tick(),
                                kind: "rift",
                                action: "captured",
                                team: scoring_team,
                                killer_pawn: -1,
                                x,
                                y,
                            });
                        }
                    }

                    if !is_live && rift_live {
                        if !rift_captured {
                            let (x, y) = rift_xy(rift_location);
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: ctx.tick(),
                                kind: "rift",
                                action: "expired",
                                team: -1,
                                killer_pawn: -1,
                                x,
                                y,
                            });
                        }
                        rift_live = false;
                    }
                }
                // Keep each changed objective entity's kind cached by index.
                for &idx in ctx.entities().updated_indices() {
                    let Some(e) = ctx.entities().get(idx) else {
                        continue;
                    };
                    if OBJ_CLASSES.contains(&e.class_name.as_ref()) {
                        let kind = objective_kind(&e.class_name);
                        if obj_kind_by_idx.get(&idx) != Some(&kind) {
                            obj_kind_by_idx.insert(idx, kind);
                        }
                    }
                }

                // Resolve the Urn's position keys once it first appears.
                if !idol_keys_resolved && let Some(s) = ctx.serializers().get(IDOL_CLASS) {
                    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                    idk_cell_x = s.resolve_field_key(&format!("{o}.m_cellX"));
                    idk_vec_x = s.resolve_field_key(&format!("{o}.m_vecX"));
                    idk_cell_y = s.resolve_field_key(&format!("{o}.m_cellY"));
                    idk_vec_y = s.resolve_field_key(&format!("{o}.m_vecY"));
                    idk_team = s.resolve_field_key("m_iTeamNum");
                    idol_keys_resolved = true;
                }

                // Urn lifecycle. A newly-seen idol entity is either a fresh
                // spawn (emit the "urn" objective event) or the urn being
                // dropped back into the world by the player who was carrying it
                // (no event — just end the carry). An idol that vanishes next to
                // a living hero was picked up by that hero.
                idol_now.clear();
                for (idx, e) in ctx.entities().iter() {
                    if e.class_name.as_ref() != IDOL_CLASS {
                        continue;
                    }
                    idol_now.insert(idx);
                    let ux =
                        boon::cell_to_world(get_i64(e, idk_cell_x) as i32, get_f32(e, idk_vec_x));
                    let uy =
                        boon::cell_to_world(get_i64(e, idk_cell_y) as i32, get_f32(e, idk_vec_y));
                    idol_last_pos.insert(idx, (ux, uy));
                    if !idol_prev.contains(&idx) {
                        if carrier_pawn.is_some() {
                            // The carried urn reappeared → it was dropped, not a
                            // fresh spawn.
                            carrier_pawn = None;
                        } else {
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: ctx.tick(),
                                kind: "urn",
                                action: "spawns",
                                team: get_i64(e, idk_team) as i32,
                                killer_pawn: -1,
                                x: Some(ux),
                                y: Some(uy),
                            });
                        }
                    }
                }
                // Pickups: an idol that despawned next to a living pawn.
                for &idx in idol_prev.iter() {
                    if idol_now.contains(&idx) {
                        continue;
                    }
                    let (lx, ly) = idol_last_pos.remove(&idx).unwrap_or((0.0, 0.0));
                    let mut best = (f32::MAX, -1i32);
                    for (pidx, pe) in ctx.entities().iter() {
                        if pe.class_name.as_ref() != PAWN_CLASS || get_i64(pe, pk_life) != 0 {
                            continue;
                        }
                        let x =
                            boon::cell_to_world(get_i64(pe, pk_cell_x) as i32, get_f32(pe, pk_x));
                        let y =
                            boon::cell_to_world(get_i64(pe, pk_cell_y) as i32, get_f32(pe, pk_y));
                        let d = ((x - lx).powi(2) + (y - ly).powi(2)).sqrt();
                        if d < best.0 {
                            best = (d, pidx);
                        }
                    }
                    if best.0 < URN_PICKUP_RADIUS {
                        carrier_pawn = Some(best.1);
                        carry_start = ctx.tick();
                    }
                }
                std::mem::swap(&mut idol_prev, &mut idol_now);
                // End a carry when the carrier dies / disappears, or the backstop
                // timeout elapses.
                if let Some(cp) = carrier_pawn {
                    let ended = match ctx.entities().get(cp) {
                        Some(e) if e.class_name.as_ref() == PAWN_CLASS => get_i64(e, pk_life) != 0,
                        _ => true,
                    } || ctx.tick().saturating_sub(carry_start) > URN_CARRY_MAX_TICKS;
                    if ended {
                        carrier_pawn = None;
                    }
                }

                if !pawn_keys_resolved && let Some(s) = ctx.serializers().get(PAWN_CLASS) {
                    let origin = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                    pk_x = s.resolve_field_key(&format!("{origin}.m_vecX"));
                    pk_y = s.resolve_field_key(&format!("{origin}.m_vecY"));
                    pk_z = s.resolve_field_key(&format!("{origin}.m_vecZ"));
                    pk_cell_x = s.resolve_field_key(&format!("{origin}.m_cellX"));
                    pk_cell_y = s.resolve_field_key(&format!("{origin}.m_cellY"));
                    pk_cell_z = s.resolve_field_key(&format!("{origin}.m_cellZ"));
                    pk_team = s.resolve_field_key("m_iTeamNum");
                    pk_hero =
                        s.resolve_field_key("m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID");
                    pk_life = s.resolve_field_key("m_lifeState");
                    pk_health = s.resolve_field_key("m_iHealth");
                    pk_max_health = s.resolve_field_key("m_iMaxHealth");
                    pk_eye = s.resolve_field_key("m_angEyeAngles");
                    pawn_keys_resolved = true;
                }

                if !ctrl_keys_resolved && let Some(s) = ctx.serializers().get(CONTROLLER_CLASS) {
                    ck_hero = s.resolve_field_key("m_PlayerDataGlobal.m_nHeroID");
                    ck_team = s.resolve_field_key("m_iTeamNum");
                    ck_name = s.resolve_field_key("m_iszPlayerName");
                    ck_rank = s.resolve_field_key("m_PlayerDataGlobal.m_unPackedRank");
                    ck_net_worth = s.resolve_field_key("m_PlayerDataGlobal.m_iGoldNetWorth");
                    ck_ap_net_worth = s.resolve_field_key("m_PlayerDataGlobal.m_iAPNetWorth");
                    ck_kills = s.resolve_field_key("m_PlayerDataGlobal.m_iPlayerKills");
                    ck_deaths = s.resolve_field_key("m_PlayerDataGlobal.m_iDeaths");
                    ck_assists = s.resolve_field_key("m_PlayerDataGlobal.m_iPlayerAssists");
                    ck_damage = s.resolve_field_key("m_PlayerDataGlobal.m_iHeroDamage");
                    ck_healing = s.resolve_field_key("m_PlayerDataGlobal.m_iHeroHealing");
                    ck_objective_damage =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iObjectiveDamage");
                    // Effective max health. The pawn's m_iMaxHealth is a base/
                    // stale value (current health exceeds it ~55% of ticks); the
                    // controller's m_iHealthMax already folds in level growth,
                    // items and buffs, so it's the correct denominator.
                    ck_health_max = s.resolve_field_key("m_PlayerDataGlobal.m_iHealthMax");
                    ck_pawn = s.resolve_field_key("m_hPawn");
                    ck_level = s.resolve_field_key("m_PlayerDataGlobal.m_iLevel");
                    ck_upgrade_count = s.resolve_field_key("m_PlayerDataGlobal.m_vecUpgrades");
                    ck_upgrade_keys = std::array::from_fn(|i| {
                        s.resolve_field_key(&format!("m_PlayerDataGlobal.m_vecUpgrades.{i}"))
                    });
                    for i in 0..20usize {
                        let vt = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecStatViewerModifierValues.{i}.m_eValType"
                        ));
                        let val = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecStatViewerModifierValues.{i}.m_flValue"
                        ));
                        ck_stat_keys.push((vt, val));
                    }
                    for i in 0..ABILITY_UPGRADE_SLOTS {
                        let item = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecAbilityUpgradeState.{i:04}.m_ItemID"
                        ));
                        let bits = s.resolve_field_key(&format!(
                            "m_PlayerDataGlobal.m_vecAbilityUpgradeState.{i:04}.m_nUpgradeInfo"
                        ));
                        ck_ability_keys.push((item, bits));
                    }
                    ctrl_keys_resolved = true;
                }

                if !pawn_keys_resolved {
                    return;
                }

                // Keep the pawn-to-hero map current on every entity tick. This
                // lets modifier applications resolve before the next sampled
                // frame instead of silently losing short-lived effects.
                for &idx in ctx.entities().updated_indices() {
                    let Some(entity) = ctx.entities().get(idx) else {
                        continue;
                    };
                    if entity.class_name.as_ref() == PAWN_CLASS {
                        let hero_id = get_i64(entity, pk_hero);
                        if hero_id != 0 {
                            pawn_to_hero.insert(idx, hero_id);
                        }
                    }
                }
                if ctrl_keys_resolved {
                    for &idx in ctx.entities().updated_indices() {
                        let Some(entity) = ctx.entities().get(idx) else {
                            continue;
                        };
                        if entity.class_name.as_ref() != CONTROLLER_CLASS {
                            continue;
                        }
                        let hero_id = get_i64(entity, ck_hero);
                        if hero_id != 0 {
                            slot_to_hero.insert(idx - 1, hero_id);
                        }
                        let team = get_i64(entity, ck_team) as i32;
                        let name = get_string(entity, ck_name);
                        let rank = get_i64(entity, ck_rank);
                        let entry = roster.entry(idx).or_insert_with(|| PlayerInfo {
                            name: String::new(),
                            hero_id: 0,
                            hero_name: String::new(),
                            team: 0,
                            rank: 0,
                        });
                        if !name.is_empty() {
                            entry.name = name;
                        }
                        if hero_id > 0 && entry.hero_id != hero_id {
                            entry.hero_id = hero_id;
                            entry.hero_name = boon::hero_name(hero_id).to_string();
                        }
                        if team != 0 {
                            entry.team = team;
                        }
                        if rank > 0 {
                            entry.rank = rank;
                        }
                    }
                }

                // Breakable props report destruction as a terminal PVS leave.
                // Keep the candidate until the full demo confirms that the
                // same stable entity identity never reactivated.
                if breakable_keys.is_none()
                    && let Some(serializer) = ctx.serializers().get(BREAKABLE_CLASS)
                {
                    breakable_keys = Some(MapEntityKeys::resolve(serializer));
                }
                if let Some(keys) = breakable_keys {
                    let changes = ctx.entities().entity_changes();
                    for change in changes {
                        if change.class_name.as_ref() == BREAKABLE_CLASS
                            && change.kind == boon::EntityChangeKind::Reactivated
                        {
                            breakable_pending.remove(&change.id());
                        }
                    }
                    for &idx in ctx.entities().updated_indices() {
                        let Some(entity) = ctx.entities().get(idx) else {
                            continue;
                        };
                        if entity.class_name.as_ref() != BREAKABLE_CLASS {
                            continue;
                        }
                        let id = boon::EntityId::new(idx, entity.serial);
                        if breakable_pending.contains_key(&id) {
                            continue;
                        }
                        let [x, y, z] = keys.position(entity);
                        breakable_live.insert(
                            id,
                            BreakableState {
                                subclass_id: entity.get_u32(keys.subclass_id),
                                team: entity.get_i64(keys.team) as i32,
                                x,
                                y,
                                z,
                            },
                        );
                    }
                    for change in changes {
                        if change.class_name.as_ref() != BREAKABLE_CLASS {
                            continue;
                        }
                        let removed = match change.kind {
                            boon::EntityChangeKind::LeftPvs => true,
                            boon::EntityChangeKind::Deleted => {
                                if let Some(entity) = ctx.entities().get(change.index) {
                                    if boon::EntityId::new(entity.index, entity.serial)
                                        != change.id()
                                    {
                                        breakable_live.remove(&change.id());
                                    }
                                    false
                                } else {
                                    true
                                }
                            }
                            _ => false,
                        };
                        if removed && let Some(state) = breakable_live.remove(&change.id()) {
                            breakable_pending
                                .entry(change.id())
                                .or_insert((ctx.tick(), state));
                        }
                    }
                }

                // Sinner's Sacrifice machines stay on the map. Emit sparse
                // spawn/hit/reset rows whenever their health changes.
                if sinner_keys.is_none() {
                    sinner_keys = SINNER_CLASSES
                        .iter()
                        .find_map(|class| ctx.serializers().get(class))
                        .map(MapEntityKeys::resolve);
                }
                if let Some(keys) = sinner_keys {
                    for change in ctx.entities().entity_changes() {
                        if !SINNER_CLASSES.contains(&change.class_name.as_ref())
                            || change.kind != boon::EntityChangeKind::Deleted
                        {
                            continue;
                        }
                        let current_id = ctx
                            .entities()
                            .get(change.index)
                            .map(|entity| boon::EntityId::new(entity.index, entity.serial));
                        if current_id != Some(change.id()) {
                            sinner_health.remove(&change.id());
                        }
                    }
                    for &idx in ctx.entities().updated_indices() {
                        let Some(entity) = ctx.entities().get(idx) else {
                            continue;
                        };
                        if !SINNER_CLASSES.contains(&entity.class_name.as_ref()) {
                            continue;
                        }
                        let health = entity.get_i64(keys.health) as i32;
                        let max_health = entity.get_i64(keys.max_health) as i32;
                        if health <= 0 || max_health <= 0 {
                            continue;
                        }
                        let id = boon::EntityId::new(idx, entity.serial);
                        let [x, y, z] = keys.position(entity);
                        let transition = match sinner_health.insert(id, health) {
                            None => Some(("spawned", 0)),
                            Some(previous) if health > previous => Some(("reset", 0)),
                            Some(previous) if health < previous => {
                                Some(("hit", previous.saturating_sub(health)))
                            }
                            _ => None,
                        };
                        if let Some((event, damage)) = transition {
                            sinner_events.push(SinnerEvent {
                                tick: ctx.tick(),
                                event,
                                id: idx,
                                serial: id.serial,
                                health,
                                max_health,
                                damage,
                                x,
                                y,
                                z,
                            });
                        }
                    }
                }

                // Capture AbilitiesChanged events (item purchases / sells /
                // upgrades) and HeroKilled events. Hero IDs are mapped after
                // the parse via slot_to_hero / pawn_to_hero.
                {
                    use boon_proto::proto::{
                        CCitadelUserMessageGameOver, CCitadelUserMessageImportantAbilityUsed,
                        CCitadelUserMsgAbilitiesChanged, CCitadelUserMsgBossKilled,
                        CCitadelUserMsgChatMsg, CCitadelUserMsgHeroKilled, CMsgFireBullets,
                        CitadelUserMessageIds as Msg, ECitadelGameEvents,
                    };
                    use prost::Message;
                    for event in events {
                        if event.msg_type == Msg::KEUserMsgAbilitiesChanged as u32 {
                            if let Ok(msg) =
                                CCitadelUserMsgAbilitiesChanged::decode(event.payload.as_slice())
                            {
                                item_events_raw.push(RawItemEvent {
                                    tick: event.tick,
                                    player_slot: msg.purchaser_player_slot.unwrap_or(-1),
                                    ability_id: msg.ability_id.unwrap_or(0),
                                    change: msg.change.unwrap_or(-1),
                                });
                            }
                        } else if event.msg_type == Msg::KEUserMsgHeroKilled as u32
                            && let Ok(msg) =
                                CCitadelUserMsgHeroKilled::decode(event.payload.as_slice())
                        {
                            // Prefer scorer (last-hit attribution), fall back to
                            // raw attacker. Self-kills (suicide) come through
                            // with the same idx for victim/attacker.
                            let attacker = msg.entindex_scorer.unwrap_or(-1);
                            let attacker = if attacker > 0 {
                                attacker
                            } else {
                                msg.entindex_attacker.unwrap_or(-1)
                            };
                            let victim = msg.entindex_victim.unwrap_or(-1);
                            // Sample the victim pawn's current position so the
                            // map can show a marker at the kill location.
                            let (kx, ky) = ctx
                                .entities()
                                .get(victim)
                                .map(|e| {
                                    let raw_x = get_f32(e, pk_x);
                                    let raw_y = get_f32(e, pk_y);
                                    let cx = get_i64(e, pk_cell_x) as i32;
                                    let cy = get_i64(e, pk_cell_y) as i32;
                                    (
                                        boon::cell_to_world(cx, raw_x),
                                        boon::cell_to_world(cy, raw_y),
                                    )
                                })
                                .unwrap_or((0.0, 0.0));
                            kill_events_raw.push(RawKillEvent {
                                tick: event.tick,
                                victim_pawn: victim,
                                attacker_pawn: attacker,
                                x: kx,
                                y: ky,
                            });
                        } else if event.msg_type == Msg::KEUserMsgGameOver as u32
                            && let Ok(msg) =
                                CCitadelUserMessageGameOver::decode(event.payload.as_slice())
                        {
                            if game_over_tick.is_none() {
                                // First GameOver marks the end of regulation play;
                                // freeze the regulation clock here.
                                game_over_tick = Some(event.tick);
                                regulation_ticks = Some(active_ticks);
                            }
                            winner = msg.winning_team;
                        } else if event.msg_type == Msg::KEUserMsgImportantAbilityUsed as u32
                            && let Ok(msg) = CCitadelUserMessageImportantAbilityUsed::decode(
                                event.payload.as_slice(),
                            )
                        {
                            let name = msg.ability_name.unwrap_or_default();
                            if !name.is_empty() {
                                // `player` is a protobuf entity handle; its low
                                // bits index the casting pawn, mapped to a hero
                                // after the walk via pawn_to_hero.
                                ability_events_raw.push(RawAbilityEvent {
                                    tick: event.tick,
                                    pawn: boon::protobuf_handle_index(msg.player).unwrap_or(-1),
                                    ability_name: name,
                                });
                            }
                        } else if event.msg_type == Msg::KEUserMsgBossKilled as u32
                            && let Ok(msg) =
                                CCitadelUserMsgBossKilled::decode(event.payload.as_slice())
                        {
                            // An objective was destroyed. The killed entity has
                            // usually despawned by now, so label it from the
                            // rolling index→kind cache. entity_position is
                            // already world-space (same frame as kill markers).
                            let killed_idx =
                                boon::protobuf_handle_index(msg.entity_killed).unwrap_or(-1);
                            let kind = obj_kind_by_idx
                                .get(&killed_idx)
                                .copied()
                                .unwrap_or("objective");
                            // Mark it dead for the live overlay (drop after this
                            // tick). First death wins.
                            obj_death_tick.entry(killed_idx).or_insert(event.tick);
                            let killer_pawn =
                                boon::protobuf_handle_index(msg.entity_killer).unwrap_or(-1);
                            let (x, y) = msg
                                .entity_position
                                .map(|v| (Some(v.x.unwrap_or(0.0)), Some(v.y.unwrap_or(0.0))))
                                .unwrap_or((None, None));
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: event.tick,
                                kind,
                                action: if kind == "mid_boss" {
                                    "killed"
                                } else {
                                    "destroyed"
                                },
                                team: msg.objective_team.unwrap_or(-1),
                                killer_pawn,
                                x,
                                y,
                            });
                        } else if event.msg_type == Msg::KEUserMsgChatMsg as u32
                            && let Ok(msg) =
                                CCitadelUserMsgChatMsg::decode(event.payload.as_slice())
                        {
                            // Player chat. `player_slot` maps to a hero via
                            // slot_to_hero (same as item purchases); resolved
                            // after the walk. all_chat distinguishes global vs
                            // team chat.
                            let text = msg.text.unwrap_or_default();
                            if !text.trim().is_empty() {
                                chat_events_raw.push(RawChatEvent {
                                    tick: event.tick,
                                    player_slot: msg.player_slot.unwrap_or(-1),
                                    all_chat: msg.all_chat.unwrap_or(false),
                                    text,
                                });
                            }
                        } else if event.msg_type == ECitadelGameEvents::GeFireBullets as u32
                            && let Ok(msg) = CMsgFireBullets::decode(event.payload.as_slice())
                            && msg.fired_from_gun.unwrap_or(true)
                        {
                            // Gun shots only — abilities also emit FireBullets.
                            // Tally per shooter pawn; bucketed per frame and
                            // resolved to a hero after the walk, like kills.
                            let shooter = msg.shooter_entity.unwrap_or(-1);
                            if shooter > 0 {
                                let c = fire_accum.entry(shooter).or_insert(0);
                                *c = c.saturating_add(1);
                            }
                        }
                    }
                }

                // Boon merges partial ActiveModifiers protobufs and reports
                // applied/changed/removed lifecycles with complete entries.
                for change in modifier_state.update(ctx) {
                    let serial = change.serial;
                    if change.kind == boon::ModifierChangeKind::Removed {
                        if let Some(open) = mod_open.remove(&serial) {
                            modifier_spans.push(open.into_span(Some(ctx.tick())));
                        }
                        if let Some(pawn) = barrier_serial_pawn.remove(&serial)
                            && !barrier_serial_pawn.values().any(|other| *other == pawn)
                        {
                            barrier_by_pawn.remove(&pawn);
                        }
                        continue;
                    }

                    let m = &change.entry;
                    if m.modifier_subclass == Some(BARRIER_TRACKER_MODIFIER_ID)
                        && let Some(parent_idx) = boon::protobuf_handle_index(m.parent)
                    {
                        let remaining = m.float2.unwrap_or(0.0);
                        barrier_by_pawn.insert(
                            parent_idx,
                            if remaining.is_finite() {
                                remaining.max(0.0)
                            } else {
                                0.0
                            },
                        );
                        if let Some(old_pawn) = barrier_serial_pawn.insert(serial, parent_idx)
                            && old_pawn != parent_idx
                            && !barrier_serial_pawn.values().any(|other| *other == old_pawn)
                        {
                            barrier_by_pawn.remove(&old_pawn);
                        }
                    }

                    let Some(mut next) = OpenModifier::from_entry(
                        serial,
                        m,
                        ctx.tick(),
                        active_ticks,
                        &pawn_to_hero,
                    ) else {
                        continue;
                    };
                    if let Some(mut open) = mod_open.remove(&serial) {
                        let reapplied = next.duration > 0.0
                            && next.last_applied_time.to_bits() != open.last_applied_time.to_bits();
                        if !open.same_visible_state(&next) {
                            let visible_at_a_frame =
                                last_emitted.is_some_and(|tick| open.start_tick <= tick);
                            if visible_at_a_frame {
                                modifier_spans.push(open.clone().into_span(Some(ctx.tick())));
                                open.start_tick = ctx.tick();
                            }
                            next.start_tick = open.start_tick;
                            next.applied_reg_tick = if reapplied {
                                active_ticks
                            } else {
                                open.applied_reg_tick
                            };
                        } else {
                            next.start_tick = open.start_tick;
                            next.applied_reg_tick = open.applied_reg_tick;
                        }
                    }
                    mod_open.insert(serial, next);
                }
                // --- Ability cooldown / charge state (change-only) ---------
                // Walk only the ability entities that changed this tick; emit a
                // row when an ability's cooldown/charge fields differ from last
                // seen. Mirrors boon-python's `ability_ticks`. Runs every tick
                // (not the sampled cadence) so a cast's exact tick is captured.
                for &idx in ctx.entities().updated_indices() {
                    let Some(entity) = ctx.entities().get(idx) else {
                        continue;
                    };
                    if !entity.class_name.contains("Ability") {
                        continue;
                    }
                    if !ability_keys_cache.contains_key(entity.class_name.as_ref()) {
                        let s = ctx.serializers().get(entity.class_name.as_ref());
                        let r = |p: &str| s.and_then(|s| s.resolve_field_key(p));
                        let ak = AbilityKeys {
                            subclass_id: r("m_nSubclassID"),
                            slot: r("m_eAbilitySlot"),
                            cooldown_start: r("m_flCooldownStart"),
                            cooldown_end: r("m_flCooldownEnd"),
                            remaining_charges: r("m_iRemainingCharges"),
                            recharge_start: r("m_flChargeRechargeStart"),
                            recharge_end: r("m_flChargeRechargeEnd"),
                            owner: r("m_hOwnerEntity"),
                        };
                        ability_keys_cache.insert(entity.class_name.to_string(), ak);
                    }
                    let keys = &ability_keys_cache[entity.class_name.as_ref()];
                    // Real abilities expose cooldown + charges; other "Ability"
                    // classes (bare bases etc.) don't — skip them.
                    if keys.cooldown_end.is_none() || keys.remaining_charges.is_none() {
                        continue;
                    }
                    let hero_id = entity
                        .get_handle(keys.owner)
                        .map(|h| (h & boon::ENTITY_HANDLE_INDEX_MASK) as i32)
                        .and_then(|owner_idx| pawn_to_hero.get(&owner_idx).copied())
                        .unwrap_or(0);
                    if hero_id == 0 {
                        continue;
                    }
                    let state = (
                        get_f32(entity, keys.cooldown_start),
                        get_f32(entity, keys.cooldown_end),
                        get_i64(entity, keys.remaining_charges) as i32,
                        get_f32(entity, keys.recharge_start),
                        get_f32(entity, keys.recharge_end),
                    );
                    let changed = abil_prev.get(&idx).map(|p| *p != state).unwrap_or(true);
                    if changed {
                        ability_ticks.push(AbilityTick {
                            tick: ctx.tick(),
                            hero_id,
                            ability_id: get_i64(entity, keys.subclass_id) as u32,
                            slot: get_i64(entity, keys.slot) as i32,
                            cooldown_start: state.0,
                            cooldown_end: state.1,
                            remaining_charges: state.2,
                            charge_recharge_start: state.3,
                            charge_recharge_end: state.4,
                        });
                        abil_prev.insert(idx, state);
                    }
                }

                if let Some(last) = last_emitted
                    && ctx.tick() - last < step
                {
                    return;
                }

                // --- Live objective roster + sparse health (sampled cadence) ---
                for (idx, entity) in ctx.entities().iter() {
                    let Some(class) = OBJ_CLASSES
                        .iter()
                        .copied()
                        .find(|c| *c == entity.class_name.as_ref())
                    else {
                        continue;
                    };
                    if !obj_keys.contains_key(class) {
                        if let Some(s) = ctx.serializers().get(class) {
                            obj_keys.insert(class, resolve_obj_keys(s));
                        } else {
                            continue;
                        }
                    }
                    let keys = &obj_keys[class];
                    let health = get_i64(entity, keys.health) as i32;
                    let max_health = get_i64(entity, keys.max_health) as i32;
                    let team = get_i64(entity, keys.team) as i32;
                    let cx = get_i64(entity, keys.cell_x) as i32;
                    let cy = get_i64(entity, keys.cell_y) as i32;
                    let wx = boon::cell_to_world(cx, get_f32(entity, keys.vec_x));
                    let wy = boon::cell_to_world(cy, get_f32(entity, keys.vec_y));

                    obj_roster.entry(idx).or_insert_with(|| ObjectiveBuild {
                        kind: objective_kind(&entity.class_name),
                        team,
                        x: wx,
                        y: wy,
                        max_health,
                        spawn_tick: ctx.tick(),
                    });

                    // Sparse health: record only when (health, max) changes.
                    if max_health > 0 && obj_last_hp.get(&idx) != Some(&(health, max_health)) {
                        obj_last_hp.insert(idx, (health, max_health));
                        obj_health_events.push(ObjectiveHealthEvent {
                            tick: ctx.tick(),
                            id: idx,
                            health,
                            max_health,
                        });
                    }
                }

                // --- Neutral camps (sampled cadence) ---
                if !neutral_keys_resolved && let Some(s) = ctx.serializers().get(NEUTRAL_CLASS) {
                    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                    nk_cell_x = s.resolve_field_key(&format!("{o}.m_cellX"));
                    nk_vec_x = s.resolve_field_key(&format!("{o}.m_vecX"));
                    nk_cell_y = s.resolve_field_key(&format!("{o}.m_cellY"));
                    nk_vec_y = s.resolve_field_key(&format!("{o}.m_vecY"));
                    nk_max_health = s.resolve_field_key("m_iMaxHealth");
                    nk_life = s.resolve_field_key("m_lifeState");
                    neutral_keys_resolved = true;
                }
                if neutral_keys_resolved {
                    // Gather this tick's neutral creeps once.
                    let mut neutrals: Vec<(i32, f32, f32, bool, u8)> = Vec::new();
                    for (idx, e) in ctx.entities().iter() {
                        if e.class_name.as_ref() != NEUTRAL_CLASS {
                            continue;
                        }
                        let x =
                            boon::cell_to_world(get_i64(e, nk_cell_x) as i32, get_f32(e, nk_vec_x));
                        let y =
                            boon::cell_to_world(get_i64(e, nk_cell_y) as i32, get_f32(e, nk_vec_y));
                        let alive = get_i64(e, nk_life) == 0;
                        let tier = neutral_tier(get_i64(e, nk_max_health) as i32);
                        neutrals.push((idx, x, y, alive, tier));
                    }

                    // Roster: cluster each creep's first-seen (≈ spawn) position.
                    // Spawn positions are exact, so clustering them is stable
                    // (live positions drift when creeps aggro).
                    for &(idx, x, y, _, tier) in &neutrals {
                        if !seen_creeps.insert(idx) {
                            continue;
                        }
                        let nearest = nearest_camp(&camps, x, y);
                        match nearest {
                            Some(i) => {
                                let c = &mut camps[i];
                                let n = c.spots as f32;
                                c.x = (c.x * n + x) / (n + 1.0);
                                c.y = (c.y * n + y) / (n + 1.0);
                                c.spots += 1;
                                if tier > c.size {
                                    c.size = tier;
                                }
                            }
                            None => camps.push(CampBuild {
                                x,
                                y,
                                spots: 1,
                                size: tier,
                                up: false,
                            }),
                        }
                    }

                    // Occupancy: a live creep marks its nearest camp "up".
                    let mut occupied = vec![false; camps.len()];
                    for &(_, x, y, alive, _) in &neutrals {
                        if !alive {
                            continue;
                        }
                        if let Some(i) = nearest_camp(&camps, x, y) {
                            occupied[i] = true;
                        }
                    }
                    for (i, c) in camps.iter_mut().enumerate() {
                        if occupied[i] != c.up {
                            c.up = occupied[i];
                            camp_state_events.push(CampStateEvent {
                                tick: ctx.tick(),
                                camp_id: i as u32,
                                up: occupied[i],
                            });
                        }
                    }
                }

                // Build the controller stats once per sampled frame. Boon owns
                // the cross-build stat IDs, item catalog, hero progression,
                // active-modifier formulas, and resistance stacking rules.
                let mut stats_by_hero: HashMap<i64, PlayerStats> = HashMap::new();
                if ctrl_keys_resolved {
                    for (_, entity) in ctx.entities().iter() {
                        if entity.class_name.as_ref() != CONTROLLER_CLASS {
                            continue;
                        }
                        let hero_id = get_i64(entity, ck_hero);
                        if hero_id == 0 {
                            continue;
                        }

                        let mut bonus_health = 0.0;
                        let mut ammo = 0.0;
                        for (value_type_key, value_key) in &ck_stat_keys {
                            let Some(decoded) = boon::decode_stat_modifier_value_type(
                                entity.get_u32(*value_type_key),
                            ) else {
                                continue;
                            };
                            let value = entity.get_f32(*value_key) * decoded.value_scale;
                            match decoded.kind {
                                boon::StatModifierKind::Health => bonus_health += value,
                                boon::StatModifierKind::Ammo => ammo += value,
                                _ => {}
                            }
                        }

                        let upgrade_count = get_i64(entity, ck_upgrade_count)
                            .clamp(0, UPGRADE_SLOTS as i64)
                            as usize;
                        let upgrades: Vec<u32> = ck_upgrade_keys[..upgrade_count]
                            .iter()
                            .map(|key| entity.get_u32(*key))
                            .filter(|id| *id != 0)
                            .collect();
                        let mut ability_tiers = HashMap::with_capacity(ABILITY_UPGRADE_SLOTS);
                        let mut slots = Vec::with_capacity(SIGNATURE_ABILITY_SLOTS);
                        for (slot_idx, (item_key, bits_key)) in ck_ability_keys.iter().enumerate() {
                            let ability_id = entity.get_u32(*item_key);
                            if ability_id == 0 {
                                continue;
                            }
                            let level =
                                (entity.get_u32(*bits_key) >> 17).count_ones().min(3) as i32;
                            ability_tiers.insert(ability_id, level as u8);
                            if slot_idx >= SIGNATURE_ABILITY_SLOTS {
                                continue;
                            }
                            slots.push(AbilitySlot {
                                ability_id,
                                ability_name: boon::ability_name(ability_id).to_string(),
                            });
                            let previous = ability_prev_level
                                .get(&(hero_id, slot_idx))
                                .copied()
                                .unwrap_or(0);
                            if level > previous {
                                ability_prev_level.insert((hero_id, slot_idx), level);
                                ability_upgrade_events.push(AbilityUpgradeEvent {
                                    tick: ctx.tick(),
                                    hero_id,
                                    ability_id,
                                    level,
                                });
                            }
                        }
                        if should_replace_ability_slots(
                            ability_slots.get(&hero_id).map(Vec::as_slice),
                            &slots,
                        ) && !slots.is_empty()
                        {
                            ability_slots.insert(hero_id, slots);
                        }

                        let pawn_index = entity
                            .get_handle(ck_pawn)
                            .and_then(|handle| boon::protobuf_handle_index(Some(handle)));
                        let layers = boon::evaluate_player_stats(
                            hero_id,
                            get_i64(entity, ck_level),
                            &upgrades,
                            &ability_tiers,
                            modifier_state.entries().values().filter(|entry| {
                                boon::protobuf_handle_index(entry.parent) == pawn_index
                            }),
                        );
                        stats_by_hero.insert(
                            hero_id,
                            PlayerStats {
                                net_worth: get_i64(entity, ck_net_worth) as i32,
                                ap_net_worth: get_i64(entity, ck_ap_net_worth) as i32,
                                kills: get_i64(entity, ck_kills) as i32,
                                deaths: get_i64(entity, ck_deaths) as i32,
                                assists: get_i64(entity, ck_assists) as i32,
                                hero_damage: get_i64(entity, ck_damage) as i32,
                                hero_healing: get_i64(entity, ck_healing) as i32,
                                objective_damage: get_i64(entity, ck_objective_damage) as i32,
                                health_max: get_i64(entity, ck_health_max) as i32,
                                bonus_health,
                                spirit_power: layers.effective[boon::StatId::SpiritPower],
                                fire_rate: layers.effective[boon::StatId::FireRateBonus],
                                weapon_damage: layers.effective[boon::StatId::WeaponDamageBonus],
                                cooldown_reduction: layers.effective
                                    [boon::StatId::CooldownReduction],
                                ammo,
                                bullet_resist: layers.effective[boon::StatId::BulletResist],
                                spirit_resist: layers.effective[boon::StatId::SpiritResist],
                                status_resist: layers.effective[boon::StatId::StatusResist],
                                bullet_lifesteal: layers.effective[boon::StatId::BulletLifesteal],
                                spirit_lifesteal: layers.effective[boon::StatId::SpiritLifesteal],
                                stat_complete_mask: stat_complete_mask(layers.complete),
                            },
                        );
                    }
                }

                let mut players: Vec<PlayerPosition> = Vec::new();
                for (idx, entity) in ctx.entities().iter() {
                    if entity.class_name.as_ref() != PAWN_CLASS {
                        continue;
                    }

                    let team = get_i64(entity, pk_team);

                    let hero = get_i64(entity, pk_hero);
                    if hero != 0 {
                        pawn_to_hero.insert(idx, hero);
                    }
                    let hero_id = pawn_to_hero.get(&idx).copied().unwrap_or(0);

                    // Cell + offset are combined into world x/y/z here. z is
                    // kept (unlike troopers/objectives) to layer heroes onto the
                    // surface vs the tunnels minimap.
                    let raw_x = get_f32(entity, pk_x);
                    let raw_y = get_f32(entity, pk_y);
                    let raw_z = get_f32(entity, pk_z);
                    let cx = get_i64(entity, pk_cell_x) as i32;
                    let cy = get_i64(entity, pk_cell_y) as i32;
                    let cz = get_i64(entity, pk_cell_z) as i32;

                    let stats = stats_by_hero.get(&hero_id).copied().unwrap_or_default();

                    // Look direction: QAngle is [pitch, yaw, roll] in degrees.
                    let [pitch, yaw, _] = entity.get_qangle(pk_eye);

                    players.push(PlayerPosition {
                        slot: idx,
                        team,
                        hero_id,
                        alive: get_i64(entity, pk_life) == 0,
                        x: boon::cell_to_world(cx, raw_x),
                        y: boon::cell_to_world(cy, raw_y),
                        z: boon::cell_to_world(cz, raw_z),
                        yaw,
                        pitch,
                        health: get_i64(entity, pk_health) as i32,
                        // Prefer the controller's effective max; fall back to
                        // the pawn's base max for heroes without a controller
                        // entity yet (m_iHealthMax not populated).
                        max_health: if stats.health_max > 0 {
                            stats.health_max
                        } else {
                            get_i64(entity, pk_max_health) as i32
                        },
                        barrier: barrier_by_pawn.get(&idx).copied().unwrap_or(0.0),
                        net_worth: stats.net_worth,
                        ap_net_worth: stats.ap_net_worth,
                        kills: stats.kills,
                        deaths: stats.deaths,
                        assists: stats.assists,
                        hero_damage: stats.hero_damage,
                        hero_healing: stats.hero_healing,
                        objective_damage: stats.objective_damage,
                        bonus_health: stats.bonus_health,
                        spirit_power: stats.spirit_power,
                        fire_rate: stats.fire_rate,
                        weapon_damage: stats.weapon_damage,
                        cooldown_reduction: stats.cooldown_reduction,
                        ammo: stats.ammo,
                        bullet_resist: stats.bullet_resist,
                        spirit_resist: stats.spirit_resist,
                        status_resist: stats.status_resist,
                        bullet_lifesteal: stats.bullet_lifesteal,
                        spirit_lifesteal: stats.spirit_lifesteal,
                        stat_complete_mask: stats.stat_complete_mask,
                    });
                }

                if players.is_empty() {
                    return;
                }

                // Lane troopers: pack each alive one into the frame.
                if !trooper_keys_resolved && let Some(s) = ctx.serializers().get(TROOPER_CLASS) {
                    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
                    tk_cell_x = s.resolve_field_key(&format!("{o}.m_cellX"));
                    tk_vec_x = s.resolve_field_key(&format!("{o}.m_vecX"));
                    tk_cell_y = s.resolve_field_key(&format!("{o}.m_cellY"));
                    tk_vec_y = s.resolve_field_key(&format!("{o}.m_vecY"));
                    tk_team = s.resolve_field_key("m_iTeamNum");
                    tk_life = s.resolve_field_key("m_lifeState");
                    trooper_keys_resolved = true;
                }
                let mut troopers: Vec<i32> = Vec::new();
                if trooper_keys_resolved {
                    for (_, e) in ctx.entities().iter() {
                        if e.class_name.as_ref() != TROOPER_CLASS || get_i64(e, tk_life) != 0 {
                            continue;
                        }
                        let x =
                            boon::cell_to_world(get_i64(e, tk_cell_x) as i32, get_f32(e, tk_vec_x));
                        let y =
                            boon::cell_to_world(get_i64(e, tk_cell_y) as i32, get_f32(e, tk_vec_y));
                        troopers.push(pack_trooper(x, y, get_i64(e, tk_team)));
                    }
                }

                // Urn(s): plot each live idol entity's world position. Flat
                // [x0, y0, x1, y1, …] (usually 0–1 present, briefly 2 during a
                // handoff). The idol keys are resolved by the spawn-tracking
                // block above once the first urn appears.
                let mut urns: Vec<f32> = Vec::new();
                for (_, e) in ctx.entities().iter() {
                    if e.class_name.as_ref() != IDOL_CLASS {
                        continue;
                    }
                    let x =
                        boon::cell_to_world(get_i64(e, idk_cell_x) as i32, get_f32(e, idk_vec_x));
                    let y =
                        boon::cell_to_world(get_i64(e, idk_cell_y) as i32, get_f32(e, idk_vec_y));
                    urns.push(x);
                    urns.push(y);
                }
                // No world entity but someone's carrying it → plot it on the
                // carrier so the urn stays visible through the carry.
                if urns.is_empty()
                    && let Some(cp) = carrier_pawn
                    && let Some(e) = ctx.entities().get(cp)
                    && e.class_name.as_ref() == PAWN_CLASS
                {
                    urns.push(boon::cell_to_world(
                        get_i64(e, pk_cell_x) as i32,
                        get_f32(e, pk_x),
                    ));
                    urns.push(boon::cell_to_world(
                        get_i64(e, pk_cell_y) as i32,
                        get_f32(e, pk_y),
                    ));
                }

                last_emitted = Some(ctx.tick());
                frames.push(ctx.tick(), active_ticks, players, troopers, urns);

                // Flush this window's gun-shot tallies onto the frame's tick.
                for (pawn, count) in fire_accum.drain() {
                    fire_events_raw.push(RawFireEvent {
                        tick: ctx.tick(),
                        pawn,
                        count,
                    });
                }
            })
            .map_err(to_js_error)?;

        // Final 100% tick so the progress bar lands on full.
        let _ = progress.call2(
            &JsValue::NULL,
            &JsValue::from(total_ticks),
            &JsValue::from(total_ticks),
        );

        // Close a pause that was still open when the recording ended.
        if let Some(start) = cur_pause_start.take() {
            let end = prev_tick.unwrap_or(start);
            pause_intervals.push(PauseInterval { start, end });
        }

        // Close any modifiers still active when the recording ended
        // (end_tick = None), then order spans by start for a stable feed.
        for (_, open) in mod_open {
            modifier_spans.push(open.into_span(None));
        }
        modifier_spans.sort_by_key(|s| s.start_tick);

        let mut breakable_events: Vec<BreakableEvent> = breakable_pending
            .into_iter()
            .map(|(id, (tick, state))| BreakableEvent {
                tick,
                id: id.index,
                serial: id.serial,
                subclass_name: boon::breakable_name(state.subclass_id).to_string(),
                team: state.team,
                x: state.x,
                y: state.y,
                z: state.z,
            })
            .collect();
        breakable_events.sort_by_key(|event| (event.tick, event.id, event.serial));
        sinner_events.sort_by_key(|event| (event.tick, event.id, event.serial));

        // Resolve raw item events to hero-keyed events. Drop events whose
        // slot we never saw (rare; mostly events fired before a controller
        // had a hero assigned) and anything outside the changes we care
        // about. We keep purchased / upgraded / sold for current-inventory
        // reconstruction on the JS side.
        let mut item_events: Vec<ItemEvent> = Vec::with_capacity(item_events_raw.len());
        for raw in item_events_raw {
            let hero_id = match slot_to_hero.get(&raw.player_slot).copied() {
                Some(h) => h,
                None => continue,
            };
            let kind = match raw.change {
                0 => "purchased",
                1 => "upgraded",
                2 => "sold",
                _ => continue,
            };
            item_events.push(ItemEvent {
                tick: raw.tick,
                hero_id,
                ability_id: raw.ability_id,
                ability_name: boon::ability_name(raw.ability_id).to_string(),
                change: kind.to_string(),
            });
        }

        // Resolve raw kill events via pawn_to_hero. Drop entries we can't
        // attribute on either side.
        let mut kill_events: Vec<KillEvent> = Vec::with_capacity(kill_events_raw.len());
        for raw in kill_events_raw {
            let victim_hero_id = match pawn_to_hero.get(&raw.victim_pawn).copied() {
                Some(h) => h,
                None => continue,
            };
            let attacker_hero_id = pawn_to_hero.get(&raw.attacker_pawn).copied().unwrap_or(0);
            kill_events.push(KillEvent {
                tick: raw.tick,
                attacker_hero_id,
                victim_hero_id,
                x: raw.x,
                y: raw.y,
            });
        }

        // Resolve gun-fire tallies (shooter pawn → hero); drop shots from pawns
        // we never mapped (rare, pre-roster). Already tick-ordered by frame.
        let mut fire_events: Vec<FireEvent> = Vec::with_capacity(fire_events_raw.len());
        for raw in fire_events_raw {
            if let Some(&hero_id) = pawn_to_hero.get(&raw.pawn) {
                fire_events.push(FireEvent {
                    tick: raw.tick,
                    hero_id,
                    count: raw.count,
                });
            }
        }

        // Resolve important-ability-used events to hero IDs via pawn_to_hero.
        let mut ability_events: Vec<AbilityEvent> = Vec::with_capacity(ability_events_raw.len());
        for raw in ability_events_raw {
            let hero_id = match pawn_to_hero.get(&raw.pawn).copied() {
                Some(h) => h,
                None => continue,
            };
            ability_events.push(AbilityEvent {
                tick: raw.tick,
                hero_id,
                ability_name: raw.ability_name,
            });
        }

        // Resolve chat senders to hero IDs via slot_to_hero (same slot space as
        // item purchases). Unresolved senders (spectators) keep hero_id 0.
        let chat_events: Vec<ChatEvent> = chat_events_raw
            .into_iter()
            .map(|raw| ChatEvent {
                tick: raw.tick,
                hero_id: slot_to_hero.get(&raw.player_slot).copied().unwrap_or(0),
                all_chat: raw.all_chat,
                text: raw.text,
            })
            .collect();

        // Keep cooldown rows only for the heroes' signature abilities (the four
        // the player panel shows); drop innate movement abilities and item
        // actives. Built before `ability_slots` is consumed below.
        let signature_abilities: HashSet<(i64, u32)> = ability_slots
            .iter()
            .flat_map(|(&hero, slots)| slots.iter().map(move |s| (hero, s.ability_id)))
            .collect();
        ability_ticks.retain(|a| signature_abilities.contains(&(a.hero_id, a.ability_id)));

        // Per-hero ability sets, sorted by hero_id for a stable order.
        let mut ability_slots_out: Vec<HeroAbilities> = ability_slots
            .into_iter()
            .map(|(hero_id, abilities)| HeroAbilities { hero_id, abilities })
            .collect();
        ability_slots_out.sort_by_key(|h| h.hero_id);

        // Resolve objective killers (entity handle → pawn → hero). Non-player
        // killers (troopers, self-destructs) resolve to 0.
        let objective_events: Vec<ObjectiveEvent> = objective_events_raw
            .into_iter()
            .map(|raw| {
                let killer_hero_id = if raw.killer_pawn > 0 {
                    pawn_to_hero.get(&raw.killer_pawn).copied().unwrap_or(0)
                } else {
                    0
                };
                ObjectiveEvent {
                    tick: raw.tick,
                    kind: raw.kind.to_string(),
                    action: raw.action.to_string(),
                    team: raw.team,
                    killer_hero_id,
                    x: raw.x,
                    y: raw.y,
                }
            })
            .collect();

        // Objective roster, folding in death ticks; sorted by id for stability.
        let mut objectives: Vec<ObjectiveInfo> = obj_roster
            .into_iter()
            .map(|(id, b)| ObjectiveInfo {
                id,
                kind: b.kind.to_string(),
                team: b.team,
                x: b.x,
                y: b.y,
                max_health: b.max_health,
                spawn_tick: b.spawn_tick,
                death_tick: obj_death_tick.get(&id).copied(),
            })
            .collect();
        objectives.sort_by_key(|o| o.id);

        // Neutral camp roster (id = index, matching camp_state_events.camp_id).
        let neutral_camps: Vec<NeutralCamp> = camps
            .iter()
            .enumerate()
            .map(|(i, c)| NeutralCamp {
                id: i as u32,
                x: c.x,
                y: c.y,
                size: c.size,
            })
            .collect();
        let mut players: Vec<PlayerInfo> = roster
            .into_values()
            .filter(|player| player.team == 2 || player.team == 3)
            .collect();
        players.sort_by_key(|player| (player.team, player.hero_id));

        let result = PositionsResult {
            players,
            winner,
            game_mode,
            match_mode,
            item_events,
            kill_events,
            fire_events,
            ability_events,
            ability_slots: ability_slots_out,
            ability_upgrade_events,
            ability_ticks,
            objective_events,
            objectives,
            objective_health: obj_health_events,
            neutral_camps,
            camp_state_events,
            breakable_events,
            sinner_events,
            chat_events,
            modifier_spans,
            pause_intervals,
            game_over_tick,
            regulation_ticks,
        };
        let value =
            serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))?;
        frames.attach(&value)?;
        Ok(value)
    }
}

#[derive(Serialize)]
struct PositionsResult {
    players: Vec<PlayerInfo>,
    winner: Option<i32>,
    /// `ECitadelGameMode`: 1 = regular 6v6, 4 = Street Brawl.
    game_mode: i32,
    /// `ECitadelMatchMode`: 4 = ranked; regular matchmaking is 1.
    match_mode: i32,
    item_events: Vec<ItemEvent>,
    kill_events: Vec<KillEvent>,
    /// Per-frame gun-shot tallies per hero (count > 0 only); `tick` matches a
    /// PositionFrame tick. Powers the live-map muzzle pulses.
    fire_events: Vec<FireEvent>,
    /// Important-ability-used events (ults / signature abilities).
    ability_events: Vec<AbilityEvent>,
    /// Each hero's signature abilities (constant), for the player ability panel.
    ability_slots: Vec<HeroAbilities>,
    /// Sparse ability upgrade-tier increases; reconstructed per tick like items.
    ability_upgrade_events: Vec<AbilityUpgradeEvent>,
    /// Per-ability cooldown/charge state changes (change-only), tick-ordered.
    /// The frontend reconstructs each ability's cooldown at the playback tick.
    ability_ticks: Vec<AbilityTick>,
    /// Objective destructions + Mid-Boss kill, in tick order.
    objective_events: Vec<ObjectiveEvent>,
    /// Constant roster of objectives (position, kind, team, max health, spawn /
    /// death ticks) for the live map overlay.
    objectives: Vec<ObjectiveInfo>,
    /// Sparse objective health samples; reconstructed per tick like items.
    objective_health: Vec<ObjectiveHealthEvent>,
    /// Neutral jungle camps (clustered from creep spawns), for the map overlay.
    neutral_camps: Vec<NeutralCamp>,
    /// Sparse camp up/down transitions; reconstructed per tick.
    camp_state_events: Vec<CampStateEvent>,
    /// Confirmed breakable-prop destruction events.
    breakable_events: Vec<BreakableEvent>,
    /// Sparse Sinner's Sacrifice machine lifecycle and health events.
    sinner_events: Vec<SinnerEvent>,
    /// Player chat (all + team), in tick order.
    chat_events: Vec<ChatEvent>,
    /// Per-player active buff/debuff spans (from the ActiveModifiers table),
    /// in start-tick order. Reconstructed per tick on the frontend.
    modifier_spans: Vec<ModifierSpan>,
    /// Tick ranges during which the match was paused.
    pause_intervals: Vec<PauseInterval>,
    /// Tick of the first GameOver user message, if the demo contains one.
    game_over_tick: Option<i32>,
    /// Active (non-paused) ticks from the start of the recording up to
    /// `game_over_tick` — the regulation duration. `None` without a GameOver.
    regulation_ticks: Option<i32>,
}

#[derive(Serialize)]
struct PauseInterval {
    start: i32,
    end: i32,
}

struct RawItemEvent {
    tick: i32,
    player_slot: i32,
    ability_id: u32,
    change: i32,
}

#[derive(Serialize)]
struct ItemEvent {
    tick: i32,
    hero_id: i64,
    ability_id: u32,
    ability_name: String,
    change: String,
}

struct RawKillEvent {
    tick: i32,
    victim_pawn: i32,
    attacker_pawn: i32,
    x: f32,
    y: f32,
}

#[derive(Serialize)]
struct KillEvent {
    tick: i32,
    attacker_hero_id: i64,
    victim_hero_id: i64,
    x: f32,
    y: f32,
}

struct RawFireEvent {
    tick: i32,
    pawn: i32,
    count: u16,
}

/// Gun shots fired by a hero, aggregated over one sampled frame's tick window
/// (emitted only when count > 0). `tick` matches a PositionFrame tick; powers
/// the live-map muzzle pulses.
#[derive(Serialize)]
struct FireEvent {
    tick: i32,
    hero_id: i64,
    count: u16,
}

struct RawAbilityEvent {
    tick: i32,
    pawn: i32,
    ability_name: String,
}

#[derive(Serialize)]
struct AbilityEvent {
    tick: i32,
    hero_id: i64,
    ability_name: String,
}

/// A change in one ability's cooldown/charge state. `cooldown_start`/`_end` are
/// game-time seconds (the cooldown is active until game time reaches
/// `cooldown_end`). Emitted only on change, per ability entity, tick-ordered.
#[derive(Serialize)]
struct AbilityTick {
    tick: i32,
    hero_id: i64,
    ability_id: u32,
    slot: i32,
    cooldown_start: f32,
    cooldown_end: f32,
    remaining_charges: i32,
    charge_recharge_start: f32,
    charge_recharge_end: f32,
}

struct RawObjectiveEvent {
    tick: i32,
    kind: &'static str,
    action: &'static str,
    team: i32,
    killer_pawn: i32,
    x: Option<f32>,
    y: Option<f32>,
}

struct RawChatEvent {
    tick: i32,
    player_slot: i32,
    all_chat: bool,
    text: String,
}

/// A player chat message. `hero_id` is the sender (0 if unresolved); `all_chat`
/// is true for global chat, false for team-only.
#[derive(Serialize)]
struct ChatEvent {
    tick: i32,
    hero_id: i64,
    all_chat: bool,
    text: String,
}

/// In-flight modifier state while its ActiveModifiers serial is live. A serial
/// can be refreshed in place, so `last_applied_time` detects a new countdown;
/// `applied_reg_tick` anchors that countdown to non-paused match time.
#[derive(Clone)]
struct OpenModifier {
    serial: u32,
    modifier_id: u32,
    hero_id: i64,
    ability_id: u32,
    ability_name: String,
    modifier_name: String,
    caster_hero_id: i64,
    stacks: i32,
    duration: f32,
    start_tick: i32,
    applied_reg_tick: i32,
    last_applied_time: f32,
}

impl OpenModifier {
    fn from_entry(
        serial: u32,
        entry: &boon_proto::proto::CModifierTableEntry,
        tick: i32,
        reg_tick: i32,
        pawn_to_hero: &HashMap<i32, i64>,
    ) -> Option<Self> {
        let parent = boon::protobuf_handle_index(entry.parent)?;
        let hero_id = pawn_to_hero.get(&parent).copied()?;
        let ability_id = entry.ability_subclass.unwrap_or(0);
        let modifier_id = entry.modifier_subclass.unwrap_or(0);
        let ability_name = match boon::ability_name(ability_id) {
            "ABILITY_NOT_FOUND" => String::new(),
            name => name.to_string(),
        };
        let modifier_name = match boon::modifier_name(modifier_id) {
            "MODIFIER_NOT_FOUND" => String::new(),
            name => name.to_string(),
        };
        if ability_name.is_empty() && modifier_name.is_empty() {
            return None;
        }
        let caster_hero_id = boon::protobuf_handle_index(entry.caster)
            .and_then(|index| pawn_to_hero.get(&index).copied())
            .unwrap_or(0);
        Some(Self {
            serial,
            modifier_id,
            hero_id,
            ability_id,
            ability_name,
            modifier_name,
            caster_hero_id,
            stacks: entry.stack_count.unwrap_or(0),
            duration: entry.duration.unwrap_or(-1.0),
            start_tick: tick,
            applied_reg_tick: reg_tick,
            last_applied_time: entry.last_applied_time.unwrap_or(-1.0),
        })
    }

    fn same_visible_state(&self, other: &Self) -> bool {
        self.hero_id == other.hero_id
            && self.ability_id == other.ability_id
            && self.modifier_id == other.modifier_id
            && self.caster_hero_id == other.caster_hero_id
            && self.stacks == other.stacks
            && self.duration.to_bits() == other.duration.to_bits()
            && self.last_applied_time.to_bits() == other.last_applied_time.to_bits()
    }

    fn into_span(self, end_tick: Option<i32>) -> ModifierSpan {
        ModifierSpan {
            serial: self.serial,
            modifier_id: self.modifier_id,
            hero_id: self.hero_id,
            start_tick: self.start_tick,
            end_tick,
            applied_reg_tick: self.applied_reg_tick,
            ability_id: self.ability_id,
            ability_name: self.ability_name,
            modifier_name: self.modifier_name,
            caster_hero_id: self.caster_hero_id,
            stacks: self.stacks,
            duration: self.duration,
        }
    }
}

/// One stable segment of a modifier's lifetime over [start_tick, end_tick).
/// In-place refresh/stack/duration updates split a serial into adjacent segments
/// so seeking reconstructs the values at that tick. `applied_reg_tick` is the
/// most recent application in non-paused ticks and anchors the countdown.
/// `duration` is seconds (-1 = indefinite).
#[derive(Serialize)]
struct ModifierSpan {
    serial: u32,
    modifier_id: u32,
    hero_id: i64,
    start_tick: i32,
    end_tick: Option<i32>,
    applied_reg_tick: i32,
    ability_id: u32,
    ability_name: String,
    modifier_name: String,
    caster_hero_id: i64,
    stacks: i32,
    duration: f32,
}

#[derive(Clone, Copy)]
struct MapEntityKeys {
    cell: [Option<u64>; 3],
    offset: [Option<u64>; 3],
    team: Option<u64>,
    health: Option<u64>,
    max_health: Option<u64>,
    subclass_id: Option<u64>,
}

impl MapEntityKeys {
    fn resolve(serializer: &Serializer) -> Self {
        let origin = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
        let field = |name: &str| serializer.resolve_field_key(name);
        Self {
            cell: std::array::from_fn(|axis| {
                field(&format!("{origin}.m_cell{}", ['X', 'Y', 'Z'][axis]))
            }),
            offset: std::array::from_fn(|axis| {
                field(&format!("{origin}.m_vec{}", ['X', 'Y', 'Z'][axis]))
            }),
            team: field("m_iTeamNum"),
            health: field("m_iHealth"),
            max_health: field("m_iMaxHealth"),
            subclass_id: field("m_nSubclassID"),
        }
    }

    fn position(self, entity: &boon::Entity) -> [f32; 3] {
        entity.world_position(self.cell, self.offset)
    }
}

#[derive(Clone, Copy)]
struct BreakableState {
    subclass_id: u32,
    team: i32,
    x: f32,
    y: f32,
    z: f32,
}

#[derive(Serialize)]
struct BreakableEvent {
    tick: i32,
    id: i32,
    serial: u32,
    subclass_name: String,
    team: i32,
    x: f32,
    y: f32,
    z: f32,
}

#[derive(Serialize)]
struct SinnerEvent {
    tick: i32,
    event: &'static str,
    id: i32,
    serial: u32,
    health: i32,
    max_health: i32,
    damage: i32,
    x: f32,
    y: f32,
    z: f32,
}

/// An objective destruction. `kind` is a stable slug ("guardian", "walker",
/// "shrine", "base_guardian", "patron", "mid_boss"); `team` is the
/// losing/owning team (−1/4 for the neutral Mid-Boss). `x`/`y` are world-space.
/// Rift events use `opened`, `captured`, or `expired`; a capture's team is
/// the winner, while neutral lifecycle points use -1.
#[derive(Serialize)]
struct ObjectiveEvent {
    tick: i32,
    kind: String,
    action: String,
    team: i32,
    killer_hero_id: i64,
    x: Option<f32>,
    y: Option<f32>,
}

/// Resolved field keys for an objective entity's networked position + health.
struct ObjKeys {
    cell_x: Option<u64>,
    vec_x: Option<u64>,
    cell_y: Option<u64>,
    vec_y: Option<u64>,
    health: Option<u64>,
    max_health: Option<u64>,
    team: Option<u64>,
}

fn resolve_obj_keys(s: &Serializer) -> ObjKeys {
    // Objectives carry their transform on the body component's scene node.
    let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
    ObjKeys {
        cell_x: s.resolve_field_key(&format!("{o}.m_cellX")),
        vec_x: s.resolve_field_key(&format!("{o}.m_vecX")),
        cell_y: s.resolve_field_key(&format!("{o}.m_cellY")),
        vec_y: s.resolve_field_key(&format!("{o}.m_vecY")),
        health: s.resolve_field_key("m_iHealth"),
        max_health: s.resolve_field_key("m_iMaxHealth"),
        team: s.resolve_field_key("m_iTeamNum"),
    }
}

/// Roster build state for one objective (constant for the match).
struct ObjectiveBuild {
    kind: &'static str,
    team: i32,
    x: f32,
    y: f32,
    max_health: i32,
    spawn_tick: i32,
}

/// One objective for the live map overlay. `death_tick` is None if it survived.
#[derive(Serialize)]
struct ObjectiveInfo {
    id: i32,
    kind: String,
    team: i32,
    x: f32,
    y: f32,
    max_health: i32,
    spawn_tick: i32,
    death_tick: Option<i32>,
}

/// A sparse objective health sample (recorded only when it changes).
#[derive(Serialize)]
struct ObjectiveHealthEvent {
    tick: i32,
    id: i32,
    health: i32,
    max_health: i32,
}

/// Index of the nearest camp within CAMP_RADIUS of (x, y), or None.
fn nearest_camp(camps: &[CampBuild], x: f32, y: f32) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut best_d = CAMP_RADIUS * CAMP_RADIUS;
    for (i, c) in camps.iter().enumerate() {
        let d = (c.x - x).powi(2) + (c.y - y).powi(2);
        if d < best_d {
            best_d = d;
            best = Some(i);
        }
    }
    best
}

/// Accumulating build state for one neutral camp (centroid is a running mean of
/// member spawn positions; `size` is the largest creep tier seen).
struct CampBuild {
    x: f32,
    y: f32,
    spots: u32,
    size: u8,
    up: bool,
}

/// A neutral camp for the map overlay. `size` is 1/2/3 (small/medium/large) and
/// drives the chevron count.
#[derive(Serialize)]
struct NeutralCamp {
    id: u32,
    x: f32,
    y: f32,
    size: u8,
}

/// A point at which a camp came up (spawned) or went down (cleared).
#[derive(Serialize)]
struct CampStateEvent {
    tick: i32,
    camp_id: u32,
    up: bool,
}

#[derive(Serialize)]
struct PlayerInfo {
    name: String,
    hero_id: i64,
    hero_name: String,
    team: i32,
    /// `tier * 10 + subdivision`; zero means unavailable or unranked.
    rank: i64,
}

const PLAYER_I32_STRIDE: usize = 15;
const PLAYER_F32_STRIDE: usize = 17;

/// Columnar sampled-frame storage. Numeric typed arrays are both much smaller
/// than nested JavaScript objects and transferable from the worker without a
/// structured-clone copy.
struct PackedFrames {
    frame_ticks: Vec<i32>,
    frame_reg_ticks: Vec<i32>,
    player_offsets: Vec<u32>,
    player_i32: Vec<i32>,
    player_f32: Vec<f32>,
    trooper_offsets: Vec<u32>,
    troopers: Vec<i32>,
    urn_offsets: Vec<u32>,
    urns: Vec<f32>,
}

impl PackedFrames {
    fn with_capacity(frame_capacity: usize) -> Self {
        let player_capacity = frame_capacity.saturating_mul(10);
        let mut player_offsets = Vec::with_capacity(frame_capacity + 1);
        let mut trooper_offsets = Vec::with_capacity(frame_capacity + 1);
        let mut urn_offsets = Vec::with_capacity(frame_capacity + 1);
        player_offsets.push(0);
        trooper_offsets.push(0);
        urn_offsets.push(0);
        Self {
            frame_ticks: Vec::with_capacity(frame_capacity),
            frame_reg_ticks: Vec::with_capacity(frame_capacity),
            player_offsets,
            player_i32: Vec::with_capacity(player_capacity.saturating_mul(PLAYER_I32_STRIDE)),
            player_f32: Vec::with_capacity(player_capacity.saturating_mul(PLAYER_F32_STRIDE)),
            trooper_offsets,
            troopers: Vec::with_capacity(frame_capacity.saturating_mul(32)),
            urn_offsets,
            urns: Vec::with_capacity(frame_capacity.saturating_mul(2)),
        }
    }

    fn push(
        &mut self,
        tick: i32,
        reg_ticks: i32,
        players: Vec<PlayerPosition>,
        troopers: Vec<i32>,
        urns: Vec<f32>,
    ) {
        self.frame_ticks.push(tick);
        self.frame_reg_ticks.push(reg_ticks);
        for player in players {
            self.player_i32.extend_from_slice(&[
                player.slot,
                player.team as i32,
                player.hero_id as i32,
                i32::from(player.alive),
                player.health,
                player.max_health,
                player.net_worth,
                player.ap_net_worth,
                player.kills,
                player.deaths,
                player.assists,
                player.hero_damage,
                player.hero_healing,
                player.objective_damage,
                player.stat_complete_mask,
            ]);
            self.player_f32.extend_from_slice(&[
                player.x,
                player.y,
                player.z,
                player.yaw,
                player.pitch,
                player.bonus_health,
                player.spirit_power,
                player.fire_rate,
                player.weapon_damage,
                player.cooldown_reduction,
                player.ammo,
                player.barrier,
                player.bullet_resist,
                player.spirit_resist,
                player.status_resist,
                player.bullet_lifesteal,
                player.spirit_lifesteal,
            ]);
        }
        self.player_offsets
            .push((self.player_i32.len() / PLAYER_I32_STRIDE) as u32);
        self.troopers.extend(troopers);
        self.trooper_offsets.push(self.troopers.len() as u32);
        self.urns.extend(urns);
        self.urn_offsets.push(self.urns.len() as u32);
    }

    fn attach(&self, target: &JsValue) -> Result<(), JsError> {
        let frame_ticks = js_sys::Int32Array::from(self.frame_ticks.as_slice());
        set_js_property(target, "frame_ticks", frame_ticks.as_ref())?;
        let frame_reg_ticks = js_sys::Int32Array::from(self.frame_reg_ticks.as_slice());
        set_js_property(target, "frame_reg_ticks", frame_reg_ticks.as_ref())?;
        let player_offsets = js_sys::Uint32Array::from(self.player_offsets.as_slice());
        set_js_property(target, "player_offsets", player_offsets.as_ref())?;
        let player_i32 = js_sys::Int32Array::from(self.player_i32.as_slice());
        set_js_property(target, "player_i32", player_i32.as_ref())?;
        let player_f32 = js_sys::Float32Array::from(self.player_f32.as_slice());
        set_js_property(target, "player_f32", player_f32.as_ref())?;
        set_js_property(
            target,
            "player_i32_stride",
            &JsValue::from_f64(PLAYER_I32_STRIDE as f64),
        )?;
        set_js_property(
            target,
            "player_f32_stride",
            &JsValue::from_f64(PLAYER_F32_STRIDE as f64),
        )?;
        let trooper_offsets = js_sys::Uint32Array::from(self.trooper_offsets.as_slice());
        set_js_property(target, "trooper_offsets", trooper_offsets.as_ref())?;
        let troopers = js_sys::Int32Array::from(self.troopers.as_slice());
        set_js_property(target, "troopers", troopers.as_ref())?;
        let urn_offsets = js_sys::Uint32Array::from(self.urn_offsets.as_slice());
        set_js_property(target, "urn_offsets", urn_offsets.as_ref())?;
        let urns = js_sys::Float32Array::from(self.urns.as_slice());
        set_js_property(target, "urns", urns.as_ref())?;
        Ok(())
    }
}

fn set_js_property(target: &JsValue, name: &str, value: &JsValue) -> Result<(), JsError> {
    js_sys::Reflect::set(target, &JsValue::from_str(name), value)
        .map(|_| ())
        .map_err(|_| JsError::new(&format!("failed to set {name}")))
}

#[derive(Serialize)]
struct PlayerPosition {
    slot: i32,
    team: i64,
    hero_id: i64,
    alive: bool,
    x: f32,
    y: f32,
    /// World height of the body origin. Used to place the hero on the surface
    /// vs the tunnels layer: the underground/tunnel floor sits below z = 0,
    /// the surface ground and structures above it.
    z: f32,
    /// Look angles in degrees from m_angEyeAngles: yaw is the horizontal facing
    /// (0 = +X / east, CCW), pitch is the vertical look (wraps 0..360).
    yaw: f32,
    pitch: f32,
    health: i32,
    max_health: i32,
    barrier: f32,
    net_worth: i32,
    ap_net_worth: i32,
    kills: i32,
    deaths: i32,
    assists: i32,
    hero_damage: i32,
    hero_healing: i32,
    objective_damage: i32,
    bonus_health: f32,
    spirit_power: f32,
    fire_rate: f32,
    weapon_damage: f32,
    cooldown_reduction: f32,
    ammo: f32,
    bullet_resist: f32,
    spirit_resist: f32,
    status_resist: f32,
    bullet_lifesteal: f32,
    spirit_lifesteal: f32,
    stat_complete_mask: i32,
}

/// One of a hero's signature abilities (constant for the match), emitted once
/// per hero in PositionsResult.ability_slots in slot order.
#[derive(Serialize, Clone)]
struct AbilitySlot {
    ability_id: u32,
    ability_name: String,
}

fn should_replace_ability_slots(
    current: Option<&[AbilitySlot]>,
    candidate: &[AbilitySlot],
) -> bool {
    let Some(current) = current else {
        return !candidate.is_empty();
    };
    candidate.len() > current.len()
        || (candidate.len() == current.len()
            && candidate
                .iter()
                .zip(current)
                .any(|(new, old)| new.ability_id != old.ability_id))
}

#[derive(Serialize)]
struct HeroAbilities {
    hero_id: i64,
    abilities: Vec<AbilitySlot>,
}

/// A point at which an ability's spent upgrade tier increased (0 → up to 3).
/// Sparse — the frontend reconstructs the current level at the playback tick.
#[derive(Serialize)]
struct AbilityUpgradeEvent {
    tick: i32,
    hero_id: i64,
    ability_id: u32,
    level: i32,
}

fn stat_complete_mask(mask: boon::StatMask) -> i32 {
    boon::StatId::ALL
        .into_iter()
        .enumerate()
        .filter_map(|(bit, stat)| mask.contains(stat).then_some(1_i32 << bit))
        .fold(0, |bits, bit| bits | bit)
}

#[derive(Default, Clone, Copy)]
struct PlayerStats {
    net_worth: i32,
    ap_net_worth: i32,
    kills: i32,
    deaths: i32,
    assists: i32,
    hero_damage: i32,
    hero_healing: i32,
    objective_damage: i32,
    health_max: i32,
    bonus_health: f32,
    spirit_power: f32,
    fire_rate: f32,
    weapon_damage: f32,
    cooldown_reduction: f32,
    ammo: f32,
    bullet_resist: f32,
    spirit_resist: f32,
    status_resist: f32,
    bullet_lifesteal: f32,
    spirit_lifesteal: f32,
    stat_complete_mask: i32,
}

fn get_i64(e: &boon::Entity, key: Option<u64>) -> i64 {
    key.and_then(|k| e.fields.get(&k))
        .and_then(|v| match v {
            boon::FieldValue::U32(n) => Some(*n as i64),
            boon::FieldValue::U64(n) => Some(*n as i64),
            boon::FieldValue::I32(n) => Some(*n as i64),
            boon::FieldValue::I64(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(0)
}

fn get_f32(e: &boon::Entity, key: Option<u64>) -> f32 {
    key.and_then(|k| e.fields.get(&k))
        .and_then(|v| match v {
            boon::FieldValue::F32(f) => Some(*f),
            _ => None,
        })
        .unwrap_or(0.0)
}

fn get_string(e: &boon::Entity, key: Option<u64>) -> String {
    key.and_then(|k| e.fields.get(&k))
        .and_then(|v| match v {
            boon::FieldValue::String(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        })
        .unwrap_or_default()
}

fn to_js_error(e: boon::Error) -> JsError {
    JsError::new(&e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{AbilitySlot, should_replace_ability_slots};

    fn slots(ids: &[u32]) -> Vec<AbilitySlot> {
        ids.iter()
            .map(|&ability_id| AbilitySlot {
                ability_id,
                ability_name: String::new(),
            })
            .collect()
    }

    #[test]
    fn replaces_stale_equal_length_ability_set() {
        let werewolf = slots(&[1, 2, 3, 4]);
        let geist = slots(&[5, 6, 7, 8]);
        assert!(should_replace_ability_slots(Some(&werewolf), &geist));
        assert!(!should_replace_ability_slots(Some(&geist), &geist));
    }
}
