use std::collections::{HashMap, HashSet};

use boon::{Entity, Serializer};
use serde::{Deserialize, Serialize};

// Order shared with src/wasm/pickups.ts. Bonuses, not final hero stats.
const STATS: [&str; 9] = [
    "MODIFIER_VALUE_HEALTH_MAX",
    "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST",
    "MODIFIER_VALUE_AMMO_CLIP_SIZE_PERCENT",
    "MODIFIER_VALUE_TECH_POWER",
    "MODIFIER_VALUE_TECH_RESIST",
    "MODIFIER_VALUE_COOLDOWN_REDUCTION_PERCENTAGE",
    "MODIFIER_VALUE_FIRE_RATE",
    "MODIFIER_VALUE_MOVEMENT_SPEED_MAX",
    "MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE",
];
const VECTOR: &str = "m_PlayerDataGlobal.m_vecStatViewerModifierValues";

#[derive(Deserialize)]
struct Records<T> {
    records: Vec<T>,
}
#[derive(Deserialize)]
struct Misc {
    misc_id: u32,
    definition: Permanent,
}
#[derive(Deserialize)]
struct Permanent {
    #[serde(default, rename = "m_bIsPermanentPickup")]
    permanent: bool,
}
#[derive(Deserialize)]
struct Modifier {
    qualified_modifier_id: u32,
    misc_id: Option<u32>,
    stat_changes: Vec<Change>,
}
#[derive(Deserialize)]
struct Change {
    stat: String,
    value: Option<f64>,
}
#[derive(Clone, Copy)]
struct Bonus {
    stat: usize,
    amount: Option<f64>,
}

pub(super) struct Catalog(HashMap<u32, Bonus>);

impl Catalog {
    pub fn load(modifiers: &[u8], misc: &[u8]) -> serde_json::Result<Self> {
        let permanent: HashSet<_> = serde_json::from_slice::<Records<Misc>>(misc)?
            .records
            .into_iter()
            .filter(|m| m.definition.permanent)
            .map(|m| m.misc_id)
            .collect();
        let mut bonuses = HashMap::new();
        for modifier in serde_json::from_slice::<Records<Modifier>>(modifiers)?.records {
            if !modifier.misc_id.is_some_and(|id| permanent.contains(&id)) {
                continue;
            }
            // These pickups have one unambiguous stat. Older demos can have
            // different enum IDs: use the qualified source, not a numeric enum
            // interpreted using a different build. Do not guess multi-stat sources.
            if let [change] = modifier.stat_changes.as_slice()
                && let Some(stat) = STATS.iter().position(|&name| name == change.stat)
            {
                bonuses.insert(
                    modifier.qualified_modifier_id,
                    Bonus {
                        stat,
                        amount: change.value,
                    },
                );
            }
        }
        Ok(Self(bonuses))
    }
}

#[derive(Clone, PartialEq)]
struct Totals {
    values: [f64; 9],
    counts: [Option<u32>; 9],
}

impl Totals {
    fn from_values(catalog: &Catalog, rows: impl Iterator<Item = (u32, f64)>) -> Self {
        let mut totals = Self {
            values: [0.0; 9],
            counts: [Some(0); 9],
        };
        for (source, value) in rows {
            let Some(bonus) = catalog.0.get(&source) else {
                continue;
            };
            if !value.is_finite() {
                continue;
            }
            totals.values[bonus.stat] += value;
            // Recorded values are cumulative per source/tier, not live stacks.
            // A count is available only if the catalog bonus divides that value.
            let count = bonus
                .amount
                .filter(|&amount| amount > 0.0)
                .and_then(|amount| {
                    let ratio = value / amount;
                    (ratio >= 0.0
                        && (ratio - ratio.round()).abs() < 0.001
                        && ratio <= u32::MAX as f64)
                        .then_some(ratio.round() as u32)
                });
            totals.counts[bonus.stat] = totals.counts[bonus.stat]
                .zip(count)
                .and_then(|(a, b)| a.checked_add(b));
        }
        totals.values[7] *= boon::rulesets::METERS_PER_SOURCE_UNIT;
        totals
    }
}

#[derive(Serialize)]
pub(super) struct Event {
    steam_id: String,
    tick: i32,
    values: [f64; 9],
    counts: [Option<u32>; 9],
}

#[derive(Default)]
pub(super) struct History {
    length: Option<Option<u64>>,
    keys: Vec<[Option<u64>; 2]>,
    previous: HashMap<u64, Totals>,
    pub events: Vec<Event>,
}

impl History {
    pub fn record(
        &mut self,
        entity: &Entity,
        serializer: &Serializer,
        catalog: &Catalog,
        steam_id: u64,
        tick: i32,
    ) {
        let length = *self
            .length
            .get_or_insert_with(|| serializer.resolve_field_key(VECTOR));
        if steam_id == 0 || !length.is_some_and(|key| entity.fields.contains_key(&key)) {
            return;
        }
        let count = entity.get_u32(length) as usize;
        while self.keys.len() < count {
            let prefix = format!("{VECTOR}.{:04}", self.keys.len());
            self.keys.push([
                serializer.resolve_field_key(&format!("{prefix}.m_SourceModifierID")),
                serializer.resolve_field_key(&format!("{prefix}.m_flValue")),
            ]);
        }
        let totals = Totals::from_values(
            catalog,
            self.keys[..count]
                .iter()
                .filter(|&&[source, value]| {
                    [source, value]
                        .iter()
                        .all(|key| key.is_some_and(|key| entity.fields.contains_key(&key)))
                })
                .map(|&[source, value]| (entity.get_u32(source), f64::from(entity.get_f32(value)))),
        );
        if self.previous.get(&steam_id) == Some(&totals) {
            return;
        }
        self.previous.insert(steam_id, totals.clone());
        self.events.push(Event {
            steam_id: steam_id.to_string(),
            tick,
            values: totals.values,
            counts: totals.counts,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_use_qualified_sources_and_tier_amounts_not_live_stacks_or_enum_ids() {
        let catalog = Catalog(HashMap::from([
            (
                1,
                Bonus {
                    stat: 0,
                    amount: Some(15.0),
                },
            ),
            (
                2,
                Bonus {
                    stat: 0,
                    amount: Some(25.0),
                },
            ),
            (
                3,
                Bonus {
                    stat: 3,
                    amount: Some(2.0),
                },
            ),
            (
                4,
                Bonus {
                    stat: 7,
                    amount: Some(3.937),
                },
            ),
        ]));
        let totals = Totals::from_values(
            &catalog,
            [(1, 30.0), (2, 75.0), (3, 8.0), (4, 7.874), (99, 500.0)].into_iter(),
        );
        assert_eq!(totals.values[0], 105.0);
        assert_eq!(totals.counts[0], Some(5));
        assert_eq!(totals.counts[3], Some(4));
        assert!((totals.values[7] - 0.2).abs() < 0.00001);
        let partial = Totals::from_values(&catalog, [(1, 20.0)].into_iter());
        assert_eq!(partial.counts[0], None);
    }

    #[test]
    fn catalog_accepts_only_permanent_unambiguous_qualified_sources() {
        let misc = br#"{"records":[{"misc_id":1,"definition":{"m_bIsPermanentPickup":true}},{"misc_id":2,"definition":{}}]}"#;
        let modifiers = br#"{"records":[
            {"qualified_modifier_id":11,"misc_id":1,"stat_changes":[{"stat":"MODIFIER_VALUE_TECH_POWER","value":2}]},
            {"qualified_modifier_id":12,"misc_id":2,"stat_changes":[{"stat":"MODIFIER_VALUE_TECH_POWER","value":2}]},
            {"qualified_modifier_id":13,"misc_id":1,"stat_changes":[{"stat":"MODIFIER_VALUE_TECH_POWER","value":2},{"stat":"OTHER","value":3}]}
        ]}"#;
        let catalog = Catalog::load(modifiers, misc).unwrap();
        assert_eq!(catalog.0.len(), 1);
        let totals =
            Totals::from_values(&catalog, [(11, 8.0), (12, 20.0), (13, 100.0)].into_iter());
        assert_eq!(totals.values[3], 8.0);
        assert_eq!(totals.counts[3], Some(4));
    }
}
