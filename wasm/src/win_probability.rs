//! Recorded-state ML snapshots. Mirrors Boon Python 0.19 + dwp schema v1.
//! No result, post-match counters, interpolation, or reconstructed match clock.

use boon::{Entity, EntityId, Parser, Serializer};
use boon_proto::proto::CitadelUserMessageIds;
use prost::Message;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use wasm_bindgen::prelude::*;

use super::{DemoParser, barriers::Barriers};
type Node = Map<String, Value>;
const PAWN: &str = "CCitadelPlayerPawn";
const CTRL: &str = "CCitadelPlayerController";
const WORLD: &str = "CCitadelGameRulesProxy";
const OBJECTIVES: &[(&str, &str)] = &[
    ("CNPC_Boss_Tier2", "walker"),
    ("CNPC_Boss_Tier3", "patron"),
    ("CNPC_BarrackBoss", "barracks"),
    ("CNPC_MidBoss", "mid_boss"),
    ("CCitadel_Destroyable_Building", "shrine"),
];
const ORIGIN: &str = "CBodyComponent.m_skeletonInstance.m_vecOrigin";

struct Reader<'a>(Option<&'a Serializer>);
impl Reader<'_> {
    fn key(&self, name: &str) -> Option<u64> {
        self.0.and_then(|s| s.resolve_field_key(name))
    }
    fn position(&self, e: &Entity) -> [f32; 3] {
        boon::world_position(
            e,
            [
                self.key(&format!("{ORIGIN}.m_cellX")),
                self.key(&format!("{ORIGIN}.m_cellY")),
                self.key(&format!("{ORIGIN}.m_cellZ")),
            ],
            [
                self.key(&format!("{ORIGIN}.m_vecX")),
                self.key(&format!("{ORIGIN}.m_vecY")),
                self.key(&format!("{ORIGIN}.m_vecZ")),
            ],
        )
    }
}
fn position(node: &mut Node, xyz: [f32; 3]) {
    for (name, v) in ["x", "y", "z"].into_iter().zip(xyz) {
        node.insert(name.into(), json!(v));
    }
}
#[derive(Serialize)]
struct Frame {
    tick: i32,
    elapsed_seconds: f64,
    global_info: Node,
    players: Vec<Node>,
    objectives: Vec<Node>,
}
pub(super) struct Replay {
    frames: Vec<Frame>,
    ziplines: boon::ziplines::ZiplineHistory,
}

impl Replay {
    fn read(
        parser: &Parser,
        barriers: &Barriers,
        roster: Vec<(String, i32)>,
        progress: &js_sys::Function,
    ) -> boon::Result<Self> {
        let ziplines = boon::ziplines::ZiplineHistory::build(parser)?;
        let initial = parser.parse_init()?;
        let p = Reader(initial.serializers().get(PAWN));
        let c = Reader(initial.serializers().get(CTRL));
        let w = Reader(initial.serializers().get(WORLD));
        let objects: HashMap<&str, Reader<'_>> = OBJECTIVES
            .iter()
            .map(|&(class, _)| (class, Reader(initial.serializers().get(class))))
            .collect();
        let mut upgrade_reader =
            boon::replay_inputs::UpgradeReader::new(initial.serializers().get(CTRL));
        let mut teams: HashMap<u64, Option<i32>> = HashMap::new();
        for (id, team) in roster {
            if let Ok(id) = id.parse::<u64>() {
                teams
                    .entry(id)
                    .and_modify(|v| *v = None)
                    .or_insert(Some(team));
            }
        }
        // Boon Python resolves NPC fields from the first available NPC serializer.
        let npc_class = OBJECTIVES
            .iter()
            .find(|(class, _)| {
                *class != "CCitadel_Destroyable_Building" && objects[class].0.is_some()
            })
            .map(|p| p.0)
            .unwrap_or("CNPC_MidBoss");
        let mut frames = Vec::new();
        let mut history: BTreeMap<(i32, u32), Node> = BTreeMap::new();
        let mut previous: HashMap<EntityId, (i64, i64, i64)> = HashMap::new();
        let mut mid_boss: Option<bool> = None;
        let mut game_over = i32::MAX;
        let mut paused_before = 0;
        let mut next_active = None;
        let classes: HashSet<&str> = [PAWN, CTRL, WORLD]
            .into_iter()
            .chain(OBJECTIVES.iter().map(|x| x.0))
            .collect();
        let event_types = HashSet::from([
            CitadelUserMessageIds::KEUserMsgMidBossSpawned as u32,
            CitadelUserMessageIds::KEUserMsgBossKilled as u32,
            CitadelUserMessageIds::KEUserMsgGameOver as u32,
        ]);
        let total = parser.file_info()?.playback_ticks.unwrap_or(0);
        let mut visit = |ctx: &boon::Context, events: &[boon::GameEvent]| {
            let tick = ctx.tick();
            for event in events {
                if event.msg_type == CitadelUserMessageIds::KEUserMsgGameOver as u32 {
                    game_over = game_over.min(event.tick);
                }
                if event.msg_type == CitadelUserMessageIds::KEUserMsgMidBossSpawned as u32 {
                    mid_boss = Some(true);
                }
                if event.msg_type == CitadelUserMessageIds::KEUserMsgBossKilled as u32
                    && let Ok(msg) = boon_proto::proto::CCitadelUserMsgBossKilled::decode(
                        event.payload.as_slice(),
                    )
                    && msg.entity_killed_class.unwrap_or(0) == 8
                {
                    mid_boss = Some(false);
                }
            }
            for &idx in ctx.entities().updated_indices() {
                let Some(e) = ctx.entities().get(idx) else {
                    continue;
                };
                let class = e.class_name.as_ref();
                let Some(&(_, kind)) = OBJECTIVES.iter().find(|x| x.0 == class) else {
                    continue;
                };
                let r = &objects[if kind == "shrine" { class } else { npc_class }];
                let max = e.get_i64(r.key("m_iMaxHealth"));
                if max == 0 {
                    continue;
                }
                let hp = e.get_i64(r.key("m_iHealth"));
                let phase = if class == "CNPC_Boss_Tier3" {
                    e.get_i64(objects[class].key("m_ePhase"))
                } else {
                    0
                };
                if previous.insert(e.id(), (hp, max, phase)) == Some((hp, max, phase)) {
                    continue;
                }
                let mut node=json!({"entity_id":idx,"entity_serial":e.id().serial,"objective_type":kind,"team_num":e.get_i64(r.key("m_iTeamNum")),"lane":if kind=="shrine" {0}else{e.get_i64(r.key("m_iLane"))},"health":hp,"max_health":max,"phase":phase,"destroyed":hp<=0}).as_object().unwrap().clone();
                position(&mut node, r.position(e));
                history.insert((idx, e.id().serial), node);
            }
            let Some((_, rules)) = ctx
                .entities()
                .iter()
                .find(|(_, e)| e.class_name.as_ref() == WORLD)
            else {
                return;
            };
            let paused = rules.get_bool(w.key("m_pGameRules.m_bGamePaused"));
            let active = (tick - paused_before).max(0);
            if paused {
                paused_before += 1;
                return;
            }
            if tick < 0 || tick >= game_over {
                return;
            }
            let target = next_active.get_or_insert(active);
            if active < *target {
                return;
            }
            while *target <= active {
                *target += 64;
            }
            if frames.len() % 64 == 0 {
                let _ = progress.call2(&JsValue::NULL, &JsValue::from(tick), &JsValue::from(total));
            }
            let mut players = Vec::new();
            for (_, ctrl) in ctx
                .entities()
                .iter()
                .filter(|(_, e)| e.class_name.as_ref() == CTRL)
            {
                let Some(handle) = ctrl.get_handle(c.key("m_hPawn")) else {
                    continue;
                };
                let Some(pawn) = ctx
                    .entities()
                    .get_by_handle(handle)
                    .filter(|e| e.class_name.as_ref() == PAWN)
                else {
                    continue;
                };
                let hero = pawn.get_i64(p.key("m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID"));
                if hero == 0 {
                    continue;
                }
                let steam = ctrl.get_u64(c.key("m_steamID"));
                let upgrades = upgrade_reader.read(ctrl);
                let max = ctrl.get_i64(c.key("m_PlayerDataGlobal.m_iHealthMax"));
                let mut node=json!({"hero_id":hero,"team_num":steam.filter(|id| *id!=0).and_then(|id| teams.get(&id).copied().flatten()),"health":pawn.get_i64(p.key("m_iHealth")),"max_health":if max>0{max}else{pawn.get_i64(p.key("m_iMaxHealth"))},"barrier":barriers.at(tick,handle).remaining,"souls":pawn.get_i64(p.key("m_nCurrencies.m_nCurrencies")),"spent_souls":pawn.get_i64(p.key("m_nSpentCurrencies.m_nSpentCurrencies")),"respawn_time":pawn.get_f32(p.key("m_flRespawnTime")),"upgrade_ids":upgrades,"item_ids":null,"baseline_stats":null}).as_object().unwrap().clone();
                position(&mut node, p.position(pawn));
                for (name, field) in [
                    ("level", "m_iLevel"),
                    ("ap_net_worth", "m_iAPNetWorth"),
                    ("gold_net_worth", "m_iGoldNetWorth"),
                ] {
                    node.insert(
                        name.into(),
                        json!(ctrl.get_i64(c.key(&format!("m_PlayerDataGlobal.{field}")))),
                    );
                }
                for (name, field) in [
                    ("is_alive", "m_bAlive"),
                    ("has_rebirth", "m_bHasRebirth"),
                    ("has_rejuvenator", "m_bHasRejuvenator"),
                    ("has_ultimate_trained", "m_bUltimateTrained"),
                ] {
                    node.insert(
                        name.into(),
                        json!(ctrl.get_bool(c.key(&format!("m_PlayerDataGlobal.{field}")))),
                    );
                }
                // Boon 0.19 intentionally exposes these two recorded cooldown fields in this order.
                for (name, field) in [
                    ("health_regen", "m_flHealthRegen"),
                    ("ultimate_cooldown_start", "m_flUltimateCooldownEnd"),
                    ("ultimate_cooldown_end", "m_flUltimateCooldownStart"),
                ] {
                    node.insert(
                        name.into(),
                        json!(ctrl.get_f32(c.key(&format!("m_PlayerDataGlobal.{field}")))),
                    );
                }
                players.push(node);
            }
            if players.is_empty() {
                return;
            }
            let elapsed = f64::from(active) / 64.;
            frames.push(Frame {tick,elapsed_seconds:elapsed,global_info:json!({"elapsed_seconds":elapsed,"mid_boss_up":mid_boss,"next_midboss":rules.get_f32(w.key("m_pGameRules.m_tNextMidBossSpawnTime"))}).as_object().unwrap().clone(),players,objectives:history.values().cloned().collect()});
        };
        parser.run_to_end_with_event_types_filtered(&classes, &event_types, &mut visit)?;
        frames.retain(|f| f.tick < game_over);
        Ok(Self { frames, ziplines })
    }
}

#[wasm_bindgen]
impl DemoParser {
    #[wasm_bindgen(js_name=prepareWinProbability)]
    pub fn prepare_win_probability(
        &mut self,
        roster: JsValue,
        progress: js_sys::Function,
    ) -> Result<u32, JsError> {
        let roster =
            serde_wasm_bindgen::from_value(roster).map_err(|e| JsError::new(&e.to_string()))?;
        let replay = Replay::read(
            &self.inner,
            self.barriers().map_err(super::to_js_error)?,
            roster,
            &progress,
        )
        .map_err(super::to_js_error)?;
        let count = replay.frames.len() as u32;
        self.win_probability = Some(replay);
        Ok(count)
    }
    #[wasm_bindgen(js_name=winProbabilityBatch)]
    pub fn win_probability_batch(&self, start: u32, count: u32) -> Result<JsValue, JsError> {
        let replay = self
            .win_probability
            .as_ref()
            .ok_or_else(|| JsError::new("Prepare win probability snapshots first"))?;
        let frames = &replay.frames[(start as usize).min(replay.frames.len())
            ..(start.saturating_add(count) as usize).min(replay.frames.len())];
        let mut zips: HashMap<i32, Vec<Node>> = HashMap::new();
        replay.ziplines.visit_snapshots(&frames.iter().map(|f|f.tick).collect::<Vec<_>>(),|tick,node,team|{
            let g=&node.geometry;
            zips.entry(tick).or_default().push(json!({"node_handle":node.node_handle,"team_num":team,"lane":g.lane,"x":g.position[0],"y":g.position[1],"z":g.position[2],"connections":g.connections,"cumulative_distance":g.cumulative_distance,"capturable":g.capturable}).as_object().unwrap().clone());
        });
        #[derive(Serialize)]
        struct Graph<'a> {
            tick: i32,
            elapsed_seconds: f64,
            global_info: &'a Node,
            players: &'a [Node],
            objectives: &'a [Node],
            ziplines: Vec<Node>,
        }
        let graphs: Vec<_> = frames
            .iter()
            .map(|f| Graph {
                tick: f.tick,
                elapsed_seconds: f.elapsed_seconds,
                global_info: &f.global_info,
                players: &f.players,
                objectives: &f.objectives,
                ziplines: zips.remove(&f.tick).unwrap_or_default(),
            })
            .collect();
        graphs
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|e| JsError::new(&e.to_string()))
    }
    #[wasm_bindgen(js_name=clearWinProbability)]
    pub fn clear_win_probability(&mut self) {
        self.win_probability = None;
    }
}
