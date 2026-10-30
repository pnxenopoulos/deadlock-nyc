use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

use boon::Serializer;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

mod barriers;
mod pickups;
mod statuses;
mod summary;
mod win_probability;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct DemoParser {
    inner: boon::Parser,
    barrier_history: OnceCell<barriers::Barriers>,
    win_probability: Option<win_probability::Replay>,
    stat_catalog: Option<boon::hero_stats::StatCatalog>,
    state_catalog: Option<boon::player_states::StateCatalog>,
    stat_replay: Option<boon::hero_stats::StatReplay>,
    pickup_catalog: Option<pickups::Catalog>,
}

impl DemoParser {
    /// Recorded barriers are shared by map frames and ML snapshots; decode them once per file.
    fn barriers(&self) -> boon::Result<&barriers::Barriers> {
        if let Some(history) = self.barrier_history.get() {
            return Ok(history);
        }
        let history = barriers::Barriers::read(&self.inner)?;
        Ok(self.barrier_history.get_or_init(|| history))
    }
}

const PAWN_CLASS: &str = "CCitadelPlayerPawn";
const CONTROLLER_CLASS: &str = "CCitadelPlayerController";
const GAMERULES_CLASS: &str = "CCitadelGameRulesProxy";
const HIDDEN_MODIFIER_IDS: &[u32] = &[barriers::TRACKER_ID];
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
    "CNPC_Boss_Tier3",               // Patron (both phases)
    "CNPC_MidBoss",                  // Mid-Boss (neutral)
];

/// Lane creeps (the marching troopers), plotted live on the minimap.
const TROOPER_CLASS: &str = "CNPC_Trooper";

/// Whether an NPC has usable live state at this tick.
///
/// pbdems2 retains entities after they leave the PVS and marks them inactive so
/// they can reactivate later. Their last fields remain readable, so lifestate
/// alone is not enough to decide whether they should be plotted.
fn is_live_npc(
    entity: &boon::Entity,
    class_name: &str,
    life_key: Option<u64>,
    max_health_key: Option<u64>,
) -> bool {
    entity.active
        && entity.class_name.as_ref() == class_name
        && entity.get_i64(life_key) == 0
        && entity.get_i64(max_health_key) > 0
}

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

const IDOL_RETURN_CLASS: &str = "CCitadelIdolReturnTrigger";

fn pawn_index(entities: &boon::EntityContainer, handle: Option<u32>) -> Option<i32> {
    entities
        .get_by_handle(handle?)
        .filter(|entity| entity.class_name.as_ref() == PAWN_CLASS)
        .map(|entity| entity.id().index)
}

/// Every current hero exposes four ESlot_Signature_N abilities. The network
/// vector has eight storage slots, but unused trailing slots can retain a
/// previous hero's IDs during initialization.
const SIGNATURE_ABILITY_SLOTS: usize = 4;

const ABILITY_UPGRADE_SLOTS: usize = 8;
/// The game clears the Rift location to FLT_MAX when it resolves. This sanity
/// bound rejects that finite sentinel and any other implausible map coordinate.
const RIFT_COORD_SANITY: f32 = 1.0e6;

#[derive(Deserialize)]
struct EmbeddedCatalogNames {
    heroes: HashMap<i64, String>,
    abilities: HashMap<u32, String>,
    ability_display_names: HashMap<String, String>,
    modifiers: HashMap<u32, String>,
    breakables: HashMap<u32, String>,
}

fn catalog_names() -> Result<boon::CatalogNames, JsError> {
    let names: EmbeddedCatalogNames =
        serde_json::from_str(include_str!("../catalog-names.json"))
            .map_err(|error| JsError::new(&format!("invalid embedded Boon catalog: {error}")))?;
    Ok(boon::CatalogNames {
        heroes: names.heroes,
        abilities: names.abilities,
        ability_display_names: names.ability_display_names,
        modifiers: names.modifiers,
        breakables: names.breakables,
    })
}

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

fn objective_kill_action(kind: &str, phase: Option<i64>) -> &'static str {
    match (kind, phase) {
        ("patron", Some(0 | 2)) => "phase_one_destroyed",
        ("mid_boss", _) => "killed",
        _ => "destroyed",
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
    denies: u32,
    ability_points: u32,
    player_healing: Option<u32>,
    self_healing: Option<u32>,
    teammate_healing: Option<u32>,
    player_damage_taken: Option<u32>,
    creep_damage: Option<u32>,
    neutral_damage: Option<u32>,
    boss_damage: Option<u32>,
    damage_absorbed: Option<u32>,
    damage_mitigated: Option<u32>,
    heal_prevented: Option<u32>,
    heal_lost: Option<u32>,
    possible_creeps: Option<u32>,
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
    healing_by_source: Vec<DamageSourceSeries>,
    regen_by_source: Vec<DamageSourceSeries>,
    assigned_lanes: Vec<LaneAssignment>,
}

#[derive(Serialize)]
struct LaneAssignment {
    hero_id: u32,
    lane: Option<u32>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
struct PlayerStatusResult {
    states: Option<Vec<String>>,
    enabled_states: Option<Vec<String>>,
    disabled_states: Option<Vec<String>>,
    unknown_states: Vec<u32>,
    unknown_enabled_states: Vec<u32>,
    unknown_disabled_states: Vec<u32>,
}

#[derive(Serialize)]
struct PlayerDetailsResult {
    hero_stats: boon::hero_stats::StatResult,
    ability_stats: boon::ability_stats::AbilityStatResult,
    imbues: boon::ability_stats::ImbueResult,
    status: Option<PlayerStatusResult>,
}

#[wasm_bindgen]
impl DemoParser {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<DemoParser, JsError> {
        let inner = boon::Parser::from_bytes(bytes);
        inner.verify().map_err(to_js_error)?;
        Ok(Self {
            inner,
            barrier_history: OnceCell::new(),
            win_probability: None,
            stat_catalog: None,
            state_catalog: None,
            stat_replay: None,
            pickup_catalog: None,
        })
    }

    /// Load one matching boon-data snapshot for browser-side stat queries.
    #[wasm_bindgen(js_name = loadCatalog)]
    pub fn load_catalog(
        &mut self,
        heroes: Vec<u8>,
        abilities: Vec<u8>,
        modifiers: Vec<u8>,
        misc: Vec<u8>,
    ) -> Result<(), JsError> {
        let stat_catalog =
            boon::hero_stats::StatCatalog::from_json_bytes(&heroes, &abilities, &modifiers, &misc)
                .map_err(|error| JsError::new(&error.to_string()))?;
        let state_catalog = boon::player_states::StateCatalog::from_json_bytes(&modifiers)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let pickup_catalog = pickups::Catalog::load(&modifiers, &misc)
            .map_err(|error| JsError::new(&error.to_string()))?;
        self.stat_catalog = Some(stat_catalog);
        self.state_catalog = Some(state_catalog);
        self.pickup_catalog = Some(pickup_catalog);
        self.stat_replay = None;
        Ok(())
    }

    /// Prepare bounded exact stat checkpoints once, before interactive seeks.
    #[wasm_bindgen(js_name = prepareStats)]
    pub fn prepare_stats(&mut self) -> Result<bool, JsError> {
        if let Some(replay) = &self.stat_replay {
            return Ok(!replay.is_empty());
        }
        let catalog = self
            .stat_catalog
            .as_ref()
            .ok_or_else(|| JsError::new("load a catalog first"))?;
        // Bound decoded state retained for interactive queries.
        let replay = self
            .inner
            .prepare_stat_replay(catalog, 16)
            .map_err(to_js_error)?;
        let prepared = !replay.is_empty();
        self.stat_replay = Some(replay);
        Ok(prepared)
    }

    /// Calculate the selected player's exact stats, imbues and recorded state
    /// masks after one demo tick. Explanations are retained for UI tooltips.
    #[wasm_bindgen(js_name = playerDetails)]
    pub fn player_details(&self, tick: i32, steam_id: String) -> Result<JsValue, JsError> {
        use boon::ability_stats::{AbilityRuleset, AbilityStat, AbilityStatQuery, ImbueQuery};
        use boon::hero_stats::{HeroStat, HeroStatQuery, Ruleset, StatBatch, StatMode};
        use boon::player_states::PlayerStateQuery;

        let steam_id = steam_id
            .parse::<u64>()
            .map_err(|_| JsError::new("invalid Steam ID"))?;
        let catalog = self
            .stat_catalog
            .as_ref()
            .ok_or_else(|| JsError::new("load a boon-data catalog first"))?;
        let state_catalog = self
            .state_catalog
            .as_ref()
            .ok_or_else(|| JsError::new("load a boon-data state catalog first"))?;
        let hero_stats = [
            HeroStat::ClipSize,
            HeroStat::BulletVelocity,
            HeroStat::MeleeDistance,
            HeroStat::ReloadTime,
            HeroStat::FireRate,
            HeroStat::FalloffStart,
            HeroStat::FalloffEnd,
            HeroStat::LightMeleeDamage,
            HeroStat::HeavyMeleeDamage,
            HeroStat::SlideDistance,
            HeroStat::BulletEvasion,
            HeroStat::DebuffResist,
            HeroStat::WeaponDamage,
            HeroStat::BulletResist,
            HeroStat::SpiritResist,
            HeroStat::MeleeResist,
            HeroStat::BulletLifesteal,
            HeroStat::SpiritLifesteal,
            HeroStat::MeleeLifesteal,
            HeroStat::GravityScale,
            HeroStat::Stamina,
            HeroStat::StaminaCooldown,
            HeroStat::DashSpeed,
            HeroStat::DashDuration,
            HeroStat::AirDashSpeed,
            HeroStat::AirDashDuration,
            HeroStat::MoveSpeed,
            HeroStat::SprintSpeed,
        ];
        let hero_rules = hero_stats
            .iter()
            .fold(Ruleset::new(), |rules, stat| rules.with(stat.rule()));
        let hero_query = HeroStatQuery::new([tick], hero_stats)
            .mode(StatMode::Current)
            .steam_ids([steam_id])
            .explain(true)
            .strict(false);
        let ability_rules = AbilityStat::ALL
            .iter()
            .fold(AbilityRuleset::new(), |rules, stat| rules.with(stat.rule()));
        let ability_query = AbilityStatQuery::new([tick], AbilityStat::ALL)
            .mode(StatMode::Current)
            .steam_ids([steam_id])
            .explain(true)
            .strict(false);
        let imbue_query = ImbueQuery::new([tick]).steam_ids([steam_id]);
        let batch = StatBatch::new()
            .hero_stats(&hero_query, &hero_rules)
            .ability_stats(&ability_query, &ability_rules)
            .imbues(&imbue_query);
        let stats = match &self.stat_replay {
            Some(replay) => self
                .inner
                .calculate_stats_with_replay(&batch, catalog, replay),
            None => self.inner.calculate_stats(&batch, catalog),
        };
        let stats = stats.map_err(to_js_error)?;
        let boon::hero_stats::StatBatchResult {
            hero_stats: Some(hero_stats),
            ability_stats: Some(ability_stats),
            imbues: Some(imbues),
        } = stats
        else {
            return Err(JsError::new("Boon omitted a requested stat dataset"));
        };

        let status = self
            .inner
            .player_states(
                &PlayerStateQuery::default()
                    .ticks([tick])
                    .steam_ids([steam_id]),
                state_catalog,
            )
            .map_err(|error| JsError::new(&error.to_string()))?
            .into_iter()
            .next()
            .map(PlayerStatusResult::from);

        let result = PlayerDetailsResult {
            hero_stats,
            ability_stats,
            imbues,
            status,
        };
        let serializer =
            serde_wasm_bindgen::Serializer::new().serialize_large_number_types_as_bigints(true);
        result
            .serialize(&serializer)
            .map_err(|error| JsError::new(&error.to_string()))
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
        let mut healing_by_source = Vec::new();
        let mut regen_by_source = Vec::new();
        let mut assigned_lanes = Vec::new();
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
                assigned_lanes.push(LaneAssignment {
                    hero_id,
                    lane: player.assigned_lane,
                });
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
                        denies: st.denies(),
                        ability_points: st.ability_points(),
                        player_healing: st.player_healing,
                        self_healing: st.self_healing,
                        teammate_healing: st.teammate_healing,
                        player_damage_taken: st.player_damage_taken,
                        creep_damage: st.creep_damage,
                        neutral_damage: st.neutral_damage,
                        boss_damage: st.boss_damage,
                        damage_absorbed: st.damage_absorbed,
                        damage_mitigated: st.damage_mitigated,
                        heal_prevented: st.heal_prevented,
                        heal_lost: st.heal_lost,
                        possible_creeps: st.possible_creeps,
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

            if let Some(matrix) = &match_info.damage_matrix {
                let slot_to_hero = match_info
                    .players
                    .iter()
                    .filter_map(|p| p.player_slot.map(|slot| (slot, p.hero_id())))
                    .collect();
                let totals = summary::matrix(matrix, &slot_to_hero).map_err(JsError::new)?;
                damage_sample_times = matrix.sample_time_s.clone();
                damage_matrix = totals.damage;
                damage_by_source = totals.sources;
                healing_by_source = totals.healing;
                regen_by_source = totals.regen;
            }

            break; // a single PostMatchDetails carries the whole match
        }
        serde_wasm_bindgen::to_value(&SummaryResult {
            snapshots,
            damage_sample_times,
            damage_matrix,
            damage_by_source,
            healing_by_source,
            regen_by_source,
            assigned_lanes,
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
        include_modifiers: Option<bool>,
    ) -> Result<JsValue, JsError> {
        let include_modifiers = include_modifiers.unwrap_or(true);
        let names = catalog_names()?;
        let catalog = self
            .stat_catalog
            .as_ref()
            .ok_or_else(|| JsError::new("load a boon-data catalog first"))?;
        let initial = self.inner.parse_init().map_err(to_js_error)?;
        let barriers = self.barriers().map_err(to_js_error)?;
        let pickup_catalog = self
            .pickup_catalog
            .as_ref()
            .ok_or_else(|| JsError::new("load a boon-data catalog first"))?;
        let mut pickup_history = pickups::History::default();
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
            IDOL_RETURN_CLASS,
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
        let mut ck_hero_pawn: Option<u64> = None;
        let mut ck_pawn: Option<u64> = None;
        let mut ck_steam: Option<u64> = None;
        let mut ck_team: Option<u64> = None;
        let mut ck_name: Option<u64> = None;
        let mut ck_rank: Option<u64> = None;
        let mut ck_net_worth: Option<u64> = None;
        let mut ck_ap_net_worth: Option<u64> = None;
        let mut ck_kills: Option<u64> = None;
        let mut ck_deaths: Option<u64> = None;
        let mut ck_assists: Option<u64> = None;
        let mut ck_damage: Option<u64> = None;
        let mut ck_objective_damage: Option<u64> = None;
        let mut ck_health_max: Option<u64> = None;
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
        // ticks come from BossKilled or final Patron lifestate. Its first kill
        // is a transformation, not removal. Field keys resolve once per class.
        let mut obj_keys: HashMap<&'static str, ObjKeys> = HashMap::new();
        let mut obj_roster: HashMap<i32, ObjectiveBuild> = HashMap::new();
        let mut obj_last_hp = HashMap::new();
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
        let mut tk_max_health: Option<u64> = None;

        // Urn (Idol) spawn tracking. Position keys resolved once; a per-tick
        // "present last tick" set turns a newly-appearing idol entity into one
        // "urn spawns" objective event at its spawn location.
        let mut idol_keys_resolved = false;
        let mut idk_cell_x: Option<u64> = None;
        let mut idk_vec_x: Option<u64> = None;
        let mut idk_cell_y: Option<u64> = None;
        let mut idk_vec_y: Option<u64> = None;
        let mut idk_team: Option<u64> = None;
        let mut idol_prev: HashSet<boon::EntityId> = HashSet::new();
        let mut idol_now: HashSet<boon::EntityId> = HashSet::new();
        let mut urn_state = boon::urn::UrnState::with_catalog(catalog)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let mut carrier_pawns: HashSet<u32> = HashSet::new();
        let mut carrier_positions: HashMap<u32, (i64, i32, f32, f32)> = HashMap::new();
        let mut urn_events: Vec<ObjectiveEvent> = Vec::new();
        let return_schema = initial.serializers().get(IDOL_RETURN_CLASS);
        let return_disabled = return_schema.and_then(|s| s.resolve_field_key("m_bDisabled"));
        let return_team = return_schema.and_then(|s| s.resolve_field_key("m_iTeamNum"));
        let mut return_previous: HashMap<boon::EntityId, (bool, i64)> = HashMap::new();

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
        // Boon merges ordered modifier writes, ignores table snapshots, and
        // applies shared catalog lifetime rules. Emit one span [start, end)
        // per visible state of each application. Each span is labeled by its
        // *source* ability/item (`ability_subclass` resolves far more often
        // than the modifier's own subclass) with the modifier's own name as a
        // secondary label; spans that resolve to neither are dropped. Reading
        // the string table is independent of the entity class filter.
        let mut modifier_state = boon::EffectiveModifierState::with_catalog(catalog);
        let modifier_clock = boon::ModifierClock::resolve(&initial);
        modifier_state.rebuild(&initial, modifier_clock.game_time(&initial));
        let mut mod_open: HashMap<u32, OpenModifier> = HashMap::new();
        let mut modifier_spans: Vec<ModifierSpan> = Vec::new();

        // --- Ability cooldowns (per-ability entity state) -----------------
        // Each ability entity carries identity and cooldown/charge fields; we
        // emit a row only when they change (change-only, like the
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
        let mut abil_prev: HashMap<boon::EntityId, AbilityState> = HashMap::new();
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

                // World entities supply spawn locations, not carrier identity.
                // Boon's holding-modifier transitions below distinguish carries.
                idol_now.clear();
                for (_, e) in ctx.entities().iter() {
                    if !e.active || e.class_name.as_ref() != IDOL_CLASS {
                        continue;
                    }
                    idol_now.insert(e.id());
                    let ux =
                        boon::cell_to_world(get_i64(e, idk_cell_x) as i32, get_f32(e, idk_vec_x));
                    let uy =
                        boon::cell_to_world(get_i64(e, idk_cell_y) as i32, get_f32(e, idk_vec_y));
                    if !idol_prev.contains(&e.id()) && carrier_pawns.is_empty() {
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
                std::mem::swap(&mut idol_prev, &mut idol_now);

                if !ctrl_keys_resolved && let Some(s) = ctx.serializers().get(CONTROLLER_CLASS) {
                    ck_hero = s.resolve_field_key("m_PlayerDataGlobal.m_nHeroID");
                    ck_hero_pawn = s.resolve_field_key("m_hHeroPawn");
                    ck_pawn = s.resolve_field_key("m_hPawn");
                    ck_steam = s.resolve_field_key("m_steamID");
                    ck_team = s.resolve_field_key("m_iTeamNum");
                    ck_name = s.resolve_field_key("m_iszPlayerName");
                    ck_rank = s.resolve_field_key("m_PlayerDataGlobal.m_unPackedRank");
                    ck_net_worth = s.resolve_field_key("m_PlayerDataGlobal.m_iGoldNetWorth");
                    ck_ap_net_worth = s.resolve_field_key("m_PlayerDataGlobal.m_iAPNetWorth");
                    ck_kills = s.resolve_field_key("m_PlayerDataGlobal.m_iPlayerKills");
                    ck_deaths = s.resolve_field_key("m_PlayerDataGlobal.m_iDeaths");
                    ck_assists = s.resolve_field_key("m_PlayerDataGlobal.m_iPlayerAssists");
                    ck_damage = s.resolve_field_key("m_PlayerDataGlobal.m_iHeroDamage");
                    ck_objective_damage =
                        s.resolve_field_key("m_PlayerDataGlobal.m_iObjectiveDamage");
                    // Effective max health. The pawn's m_iMaxHealth is a base/
                    // stale value (current health exceeds it ~55% of ticks); the
                    // controller's m_iHealthMax already folds in level growth,
                    // items and buffs, so it's the correct denominator.
                    ck_health_max = s.resolve_field_key("m_PlayerDataGlobal.m_iHealthMax");
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
                        let steam_id = get_i64(entity, ck_steam);
                        if let Some(serializer) = ctx.serializers().get(CONTROLLER_CLASS) {
                            pickup_history.record(
                                entity,
                                serializer,
                                pickup_catalog,
                                steam_id.max(0) as u64,
                                ctx.tick(),
                            );
                        }
                        if hero_id != 0 {
                            slot_to_hero.insert(idx - 1, hero_id);
                        }
                        let team = get_i64(entity, ck_team) as i32;
                        let name = get_string(entity, ck_name);
                        let rank = get_i64(entity, ck_rank);
                        let entry = roster.entry(idx).or_insert_with(|| PlayerInfo {
                            name: String::new(),
                            steam_id: String::new(),
                            hero_id: 0,
                            hero_name: String::new(),
                            team: 0,
                            rank: 0,
                        });
                        if !name.is_empty() {
                            entry.name = name;
                        }
                        if steam_id > 0 {
                            entry.steam_id = steam_id.to_string();
                        }
                        if hero_id > 0 && entry.hero_id != hero_id {
                            entry.hero_id = hero_id;
                            entry.hero_name = names.hero_name(hero_id).to_string();
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
                            let phase = ctx.entities().get(killed_idx).and_then(|entity| {
                                let serializer = ctx.serializers().get(&entity.class_name)?;
                                let key = serializer.resolve_field_key("m_ePhase")?;
                                Some(entity.get_i64(Some(key)))
                            });
                            let action = objective_kill_action(kind, phase);
                            if action != "phase_one_destroyed" {
                                obj_death_tick.entry(killed_idx).or_insert(event.tick);
                            }
                            let killer_pawn =
                                boon::protobuf_handle_index(msg.entity_killer).unwrap_or(-1);
                            let (x, y) = msg
                                .entity_position
                                .map(|v| (Some(v.x.unwrap_or(0.0)), Some(v.y.unwrap_or(0.0))))
                                .unwrap_or((None, None));
                            objective_events_raw.push(RawObjectiveEvent {
                                tick: event.tick,
                                kind,
                                action,
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

                let game_time = modifier_clock.game_time(ctx);
                let changes = modifier_state.update(ctx, game_time);
                let mut delivery_closed = false;
                for &idx in ctx.entities().updated_indices() {
                    let Some(entity) = ctx
                        .entities()
                        .get(idx)
                        .filter(|e| e.class_name.as_ref() == IDOL_RETURN_CLASS)
                    else {
                        continue;
                    };
                    let Some(boon::FieldValue::Bool(disabled)) =
                        return_disabled.and_then(|key| entity.fields.get(&key))
                    else {
                        continue;
                    };
                    if return_team.is_none_or(|key| !entity.fields.contains_key(&key)) {
                        continue;
                    }
                    let previous = return_previous
                        .insert(entity.id(), (*disabled, get_i64(entity, return_team)));
                    delivery_closed |=
                        *disabled && previous.is_some_and(|(was_disabled, _)| !was_disabled);
                }
                // Keep a last observed position for an absent carrier's event;
                // absence itself does not end a carry or transfer it to a reused slot.
                let carrier_position = |handle| {
                    ctx.entities()
                        .get_by_handle(handle)
                        .filter(|e| e.class_name.as_ref() == PAWN_CLASS)
                        .map(|pawn| {
                            (
                                get_i64(pawn, pk_hero),
                                get_i64(pawn, pk_team) as i32,
                                boon::cell_to_world(
                                    get_i64(pawn, pk_cell_x) as i32,
                                    get_f32(pawn, pk_x),
                                ),
                                boon::cell_to_world(
                                    get_i64(pawn, pk_cell_y) as i32,
                                    get_f32(pawn, pk_y),
                                ),
                            )
                        })
                };
                for &handle in &carrier_pawns {
                    if let Some(position) = carrier_position(handle) {
                        carrier_positions.insert(handle, position);
                    }
                }
                for change in urn_state.update(&changes, game_time, delivery_closed) {
                    let position = carrier_position(change.parent)
                        .or_else(|| carrier_positions.get(&change.parent).copied());
                    if change.kind == boon::urn::UrnEventKind::PickedUp {
                        carrier_pawns.insert(change.parent);
                        if let Some(position) = position {
                            carrier_positions.insert(change.parent, position);
                        }
                    } else {
                        carrier_pawns.remove(&change.parent);
                        carrier_positions.remove(&change.parent);
                    }
                    if let Some((hero_id, team, x, y)) =
                        position.filter(|(hero, _, _, _)| *hero != 0)
                    {
                        urn_events.push(ObjectiveEvent {
                            tick: ctx.tick(),
                            kind: "urn".to_string(),
                            action: change.kind.as_str().to_string(),
                            team,
                            killer_hero_id: hero_id,
                            x: Some(x),
                            y: Some(y),
                        });
                    }
                }

                for change in changes.into_iter().filter(|_| include_modifiers) {
                    let serial = change.serial;
                    if change.kind == boon::ModifierChangeKind::Removed {
                        if let Some(open) = mod_open.remove(&serial) {
                            modifier_spans.push(open.into_span(Some(ctx.tick())));
                        }
                        continue;
                    }

                    let m = &change.entry;
                    // Internal pool trackers are not player-facing effects.
                    if m.modifier_subclass
                        .is_some_and(|id| HIDDEN_MODIFIER_IDS.contains(&id))
                    {
                        continue;
                    }
                    let Some(mut next) = OpenModifier::from_entry(
                        serial,
                        m,
                        ctx.tick(),
                        active_ticks,
                        ctx.entities(),
                        &pawn_to_hero,
                        &names,
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
                // row when identity or cooldown/charge fields differ from last
                // seen. Mirrors boon-python's `ability_ticks`. Runs every tick
                // (not the sampled cadence) so a cast's exact tick is captured.
                for change in ctx.entities().entity_changes() {
                    if change.kind == boon::EntityChangeKind::Deleted {
                        abil_prev.remove(&change.id());
                    }
                }
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
                    let Some(owner) = entity.get_handle(keys.owner) else {
                        continue;
                    };
                    let hero_id = ctx
                        .entities()
                        .get_by_handle(owner)
                        .filter(|pawn| pawn.class_name.as_ref() == PAWN_CLASS)
                        .map_or(0, |pawn| pawn.get_i64(pk_hero));
                    if hero_id == 0 {
                        continue;
                    }
                    let state = AbilityState {
                        owner,
                        hero_id,
                        ability_id: entity.get_u32(keys.subclass_id),
                        slot: get_i64(entity, keys.slot) as i32,
                        cooldown_start: get_f32(entity, keys.cooldown_start),
                        cooldown_end: get_f32(entity, keys.cooldown_end),
                        remaining_charges: get_i64(entity, keys.remaining_charges) as i32,
                        recharge_start: get_f32(entity, keys.recharge_start),
                        recharge_end: get_f32(entity, keys.recharge_end),
                    };
                    let changed = abil_prev
                        .get(&entity.id())
                        .map(|p| *p != state)
                        .unwrap_or(true);
                    if changed {
                        ability_ticks.push(AbilityTick {
                            tick: ctx.tick(),
                            hero_id: state.hero_id,
                            ability_id: state.ability_id,
                            slot: state.slot,
                            cooldown_start: state.cooldown_start,
                            cooldown_end: state.cooldown_end,
                            remaining_charges: state.remaining_charges,
                            charge_recharge_start: state.recharge_start,
                            charge_recharge_end: state.recharge_end,
                        });
                        abil_prev.insert(entity.id(), state);
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
                    let phase = if class == "CNPC_Boss_Tier3" {
                        keys.phase.map(|key| entity.get_i64(Some(key)) as i32)
                    } else {
                        None
                    };
                    let team = get_i64(entity, keys.team) as i32;
                    let cx = get_i64(entity, keys.cell_x) as i32;
                    let cy = get_i64(entity, keys.cell_y) as i32;
                    let wx = boon::cell_to_world(cx, get_f32(entity, keys.vec_x));
                    let wy = boon::cell_to_world(cy, get_f32(entity, keys.vec_y));
                    // The final Patron death may end the match without another
                    // BossKilled message. Do not hide it at the phase-one kill.
                    if phase == Some(1) && get_i64(entity, keys.life) != 0 {
                        obj_death_tick.entry(idx).or_insert(ctx.tick());
                    }

                    obj_roster.entry(idx).or_insert_with(|| ObjectiveBuild {
                        kind: objective_kind(&entity.class_name),
                        team,
                        x: wx,
                        y: wy,
                        max_health,
                        spawn_tick: ctx.tick(),
                    });

                    // Keep phase and position changes on the same entity ID.
                    let state = (health, max_health, phase, wx.to_bits(), wy.to_bits());
                    if max_health > 0 && obj_last_hp.get(&idx) != Some(&state) {
                        obj_last_hp.insert(idx, state);
                        obj_health_events.push(ObjectiveHealthEvent {
                            tick: ctx.tick(),
                            id: idx,
                            health,
                            max_health,
                            phase,
                            x: wx,
                            y: wy,
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
                    let mut neutrals: Vec<(i32, f32, f32, u8)> = Vec::new();
                    for (idx, e) in ctx.entities().iter() {
                        if !is_live_npc(e, NEUTRAL_CLASS, nk_life, nk_max_health) {
                            continue;
                        }
                        let x =
                            boon::cell_to_world(get_i64(e, nk_cell_x) as i32, get_f32(e, nk_vec_x));
                        let y =
                            boon::cell_to_world(get_i64(e, nk_cell_y) as i32, get_f32(e, nk_vec_y));
                        let tier = neutral_tier(get_i64(e, nk_max_health) as i32);
                        neutrals.push((idx, x, y, tier));
                    }

                    // Roster: cluster each creep's first-seen (≈ spawn) position.
                    // Spawn positions are exact, so clustering them is stable
                    // (live positions drift when creeps aggro).
                    for &(idx, x, y, tier) in &neutrals {
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
                    for &(_, x, y, _) in &neutrals {
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

                // Build the controller state once per sampled frame.
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

                        let mut slots = Vec::with_capacity(SIGNATURE_ABILITY_SLOTS);
                        for (slot_idx, (item_key, bits_key)) in ck_ability_keys.iter().enumerate() {
                            let ability_id = entity.get_u32(*item_key);
                            if ability_id == 0 {
                                continue;
                            }
                            let level =
                                (entity.get_u32(*bits_key) >> 17).count_ones().min(3) as i32;
                            if slot_idx >= SIGNATURE_ABILITY_SLOTS {
                                continue;
                            }
                            slots.push(AbilitySlot {
                                ability_id,
                                ability_name: names.ability_name(ability_id).to_string(),
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

                        stats_by_hero.insert(
                            hero_id,
                            PlayerStats {
                                pawn_handle: entity
                                    .get_handle(ck_hero_pawn)
                                    .or_else(|| entity.get_handle(ck_pawn)),
                                net_worth: get_i64(entity, ck_net_worth) as i32,
                                ap_net_worth: get_i64(entity, ck_ap_net_worth) as i32,
                                kills: get_i64(entity, ck_kills) as i32,
                                deaths: get_i64(entity, ck_deaths) as i32,
                                assists: get_i64(entity, ck_assists) as i32,
                                hero_damage: get_i64(entity, ck_damage) as i32,
                                objective_damage: get_i64(entity, ck_objective_damage) as i32,
                                health_max: get_i64(entity, ck_health_max) as i32,
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
                    let barrier = stats
                        .pawn_handle
                        .filter(|&handle| pawn_index(ctx.entities(), Some(handle)) == Some(idx))
                        .map(|handle| barriers.at(ctx.tick(), handle))
                        .unwrap_or_default();

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
                        barrier: barrier.remaining,
                        max_barrier: barrier.capacity,
                        // Prefer the controller's effective max; fall back to
                        // the pawn's base max for heroes without a controller
                        // entity yet (m_iHealthMax not populated).
                        max_health: if stats.health_max > 0 {
                            stats.health_max
                        } else {
                            get_i64(entity, pk_max_health) as i32
                        },
                        net_worth: stats.net_worth,
                        ap_net_worth: stats.ap_net_worth,
                        kills: stats.kills,
                        deaths: stats.deaths,
                        assists: stats.assists,
                        hero_damage: stats.hero_damage,
                        objective_damage: stats.objective_damage,
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
                    tk_max_health = s.resolve_field_key("m_iMaxHealth");
                    trooper_keys_resolved = true;
                }
                let mut troopers: Vec<i32> = Vec::new();
                if trooper_keys_resolved {
                    for (_, e) in ctx.entities().iter() {
                        if !is_live_npc(e, TROOPER_CLASS, tk_life, tk_max_health) {
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
                    if !e.active || e.class_name.as_ref() != IDOL_CLASS {
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
                if urns.is_empty() {
                    for &handle in &carrier_pawns {
                        let Some(e) = ctx
                            .entities()
                            .get_by_handle(handle)
                            .filter(|e| e.active && e.class_name.as_ref() == PAWN_CLASS)
                        else {
                            continue;
                        };
                        urns.push(boon::cell_to_world(
                            get_i64(e, pk_cell_x) as i32,
                            get_f32(e, pk_x),
                        ));
                        urns.push(boon::cell_to_world(
                            get_i64(e, pk_cell_y) as i32,
                            get_f32(e, pk_y),
                        ));
                    }
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
                subclass_name: names.breakable_name(state.subclass_id).to_string(),
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
                ability_name: names.ability_name(raw.ability_id).to_string(),
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
        let mut objective_events: Vec<ObjectiveEvent> = objective_events_raw
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

        objective_events.extend(urn_events);
        objective_events.sort_by_key(|event| event.tick);

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
            permanent_buffs: pickup_history.events,
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
    permanent_buffs: Vec<pickups::Event>,
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

#[derive(Clone, Copy, Debug, PartialEq)]
struct AbilityState {
    owner: u32,
    hero_id: i64,
    ability_id: u32,
    slot: i32,
    cooldown_start: f32,
    cooldown_end: f32,
    remaining_charges: i32,
    recharge_start: f32,
    recharge_end: f32,
}

/// A change in one ability's identity or cooldown/charge state.
/// `cooldown_start`/`_end` are game-time seconds (active until game time reaches
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
        entities: &boon::EntityContainer,
        pawn_to_hero: &HashMap<i32, i64>,
        names: &boon::CatalogNames,
    ) -> Option<Self> {
        let parent = pawn_index(entities, entry.parent)?;
        let hero_id = pawn_to_hero.get(&parent).copied()?;
        let ability_id = entry.ability_subclass.unwrap_or(0);
        let modifier_id = entry.modifier_subclass.unwrap_or(0);
        let ability_name = match names.ability_name(ability_id) {
            "ABILITY_NOT_FOUND" => String::new(),
            name => name.to_string(),
        };
        let modifier_name = match names.modifier_name(modifier_id) {
            "MODIFIER_NOT_FOUND" => String::new(),
            name => name.to_string(),
        };
        if ability_name.is_empty() && modifier_name.is_empty() {
            return None;
        }
        let caster_hero_id = pawn_index(entities, entry.caster)
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
        boon::world_position(entity, self.cell, self.offset)
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
    phase: Option<u64>,
    life: Option<u64>,
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
        phase: s.resolve_field_key("m_ePhase"),
        life: s.resolve_field_key("m_lifeState"),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<i32>,
    x: f32,
    y: f32,
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
    /// Decimal text preserves the full 64-bit account ID across JS runtimes.
    steam_id: String,
    hero_id: i64,
    hero_name: String,
    team: i32,
    /// `tier * 10 + subdivision`; zero means unavailable or unranked.
    rank: i64,
}

const PLAYER_I32_STRIDE: usize = 13;
const PLAYER_F32_STRIDE: usize = 7;

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
        // Reserve for 6v6 so 12-player demos do not grow both player columns.
        let player_capacity = frame_capacity.saturating_mul(12);
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
                player.objective_damage,
            ]);
            self.player_f32.extend_from_slice(&[
                player.x,
                player.y,
                player.z,
                player.yaw,
                player.pitch,
                player.barrier,
                player.max_barrier,
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
    max_barrier: f32,
    net_worth: i32,
    ap_net_worth: i32,
    kills: i32,
    deaths: i32,
    assists: i32,
    hero_damage: i32,
    objective_damage: i32,
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

#[derive(Default, Clone, Copy)]
struct PlayerStats {
    pawn_handle: Option<u32>,
    net_worth: i32,
    ap_net_worth: i32,
    kills: i32,
    deaths: i32,
    assists: i32,
    hero_damage: i32,
    objective_damage: i32,
    health_max: i32,
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

fn to_js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        AbilitySlot, MapEntityKeys, OpenModifier, PAWN_CLASS, TROOPER_CLASS, is_live_npc,
        pawn_index, should_replace_ability_slots,
    };

    #[test]
    fn ability_identity_changes_emit_even_with_unchanged_cooldowns() {
        let state = super::AbilityState {
            owner: (7 << 14) | 2,
            hero_id: 63,
            ability_id: 123,
            slot: 0,
            cooldown_start: 0.0,
            cooldown_end: 0.0,
            remaining_charges: 1,
            recharge_start: 0.0,
            recharge_end: 0.0,
        };
        assert_eq!(state, state);
        for changed in [
            super::AbilityState {
                owner: (8 << 14) | 2,
                ..state
            },
            super::AbilityState {
                hero_id: 15,
                ..state
            },
            super::AbilityState {
                ability_id: 456,
                ..state
            },
            super::AbilityState { slot: 1, ..state },
        ] {
            assert_ne!(state, changed);
        }
    }

    #[test]
    fn patron_phase_one_kill_is_not_final_destruction() {
        for phase in [0, 2] {
            assert_eq!(
                super::objective_kill_action("patron", Some(phase)),
                "phase_one_destroyed"
            );
        }
        assert_eq!(super::objective_kill_action("patron", Some(1)), "destroyed");
        assert_eq!(super::objective_kill_action("patron", None), "destroyed");
        assert_eq!(super::objective_kill_action("walker", Some(0)), "destroyed");
        assert_eq!(super::objective_kill_action("mid_boss", None), "killed");
    }

    #[test]
    fn reserves_full_6v6_frame_columns_without_growth() {
        let mut frames = super::PackedFrames::with_capacity(3);
        let capacity = (frames.player_i32.capacity(), frames.player_f32.capacity());
        for _ in 0..3 * 12 {
            frames
                .player_i32
                .extend_from_slice(&[0; super::PLAYER_I32_STRIDE]);
            frames
                .player_f32
                .extend_from_slice(&[0.0; super::PLAYER_F32_STRIDE]);
        }
        assert_eq!(
            (frames.player_i32.capacity(), frames.player_f32.capacity()),
            capacity
        );
    }

    #[test]
    fn modifier_owners_reject_reused_slots_and_non_pawns() {
        let mut entities = boon::EntityContainer::new();
        for (index, serial, class) in [(2, 7, PAWN_CLASS), (3, 9, PAWN_CLASS), (4, 1, "Ability")] {
            entities
                .insert(
                    boon::Entity::from_fields(index, serial, 1, class, true, Default::default())
                        .unwrap(),
                )
                .unwrap();
        }
        assert_eq!(pawn_index(&entities, Some((7 << 14) | 2)), Some(2));
        assert_eq!(pawn_index(&entities, Some((6 << 14) | 2)), None);
        assert_eq!(pawn_index(&entities, Some((1 << 14) | 4)), None);
        assert_eq!(pawn_index(&entities, None), None);
        let heroes = std::collections::HashMap::from([(2, 63), (3, 15)]);
        let mut names = boon::CatalogNames::default();
        names
            .abilities
            .insert(123, "citadel_ability_hook".to_string());
        let mut entry = boon_proto::proto::CModifierTableEntry {
            parent: Some((7 << 14) | 2),
            caster: Some((9 << 14) | 3),
            ability_subclass: Some(123),
            ..Default::default()
        };
        let span =
            |entry: &_| OpenModifier::from_entry(1, entry, 10, 10, &entities, &heroes, &names);
        assert_eq!(span(&entry).unwrap().caster_hero_id, 15);
        entry.caster = Some((8 << 14) | 3);
        assert_eq!(span(&entry).unwrap().caster_hero_id, 0);
        entry.parent = Some((6 << 14) | 2);
        assert!(span(&entry).is_none());
    }

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

    #[test]
    fn map_entities_use_deadlock_coordinate_origin() {
        let keys = MapEntityKeys {
            cell: [Some(1), Some(2), Some(3)],
            offset: [Some(4), Some(5), Some(6)],
            team: None,
            health: None,
            max_health: None,
            subclass_id: None,
        };
        let mut entity =
            boon::Entity::from_fields(1, 1, 1, "CCitadel_BreakableProp", true, Default::default())
                .expect("valid test entity");
        for (key, cell, offset) in [(1, 64, 0.0), (2, 63, 128.0), (3, 65, 32.0)] {
            entity.fields.insert(key, boon::FieldValue::U32(cell));
            entity.fields.insert(key + 3, boon::FieldValue::F32(offset));
        }
        assert_eq!(boon::cell_to_world(64, 0.0), 0.0);
        assert_eq!(keys.position(&entity), [0.0, -384.0, 544.0]);
    }

    #[test]
    fn live_npc_requires_active_alive_entity_with_health() {
        const LIFE_KEY: u64 = 1;
        const MAX_HEALTH_KEY: u64 = 2;

        let npc = |active, class_name: &str, life, max_health| {
            let mut entity =
                boon::Entity::from_fields(1, 1, 1, class_name, active, Default::default())
                    .expect("valid test entity");
            entity.fields.insert(LIFE_KEY, boon::FieldValue::I64(life));
            entity
                .fields
                .insert(MAX_HEALTH_KEY, boon::FieldValue::I64(max_health));
            entity
        };
        let is_live = |entity: &boon::Entity| {
            is_live_npc(entity, TROOPER_CLASS, Some(LIFE_KEY), Some(MAX_HEALTH_KEY))
        };

        assert!(is_live(&npc(true, TROOPER_CLASS, 0, 100)));
        assert!(!is_live(&npc(false, TROOPER_CLASS, 0, 100)));
        assert!(!is_live(&npc(true, TROOPER_CLASS, 2, 100)));
        assert!(!is_live(&npc(true, TROOPER_CLASS, 0, 0)));
        assert!(!is_live(&npc(true, "CNPC_TrooperNeutral", 0, 100)));
    }
}
