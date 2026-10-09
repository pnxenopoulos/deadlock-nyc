use super::{DamagePair, DamageSourceSeries, is_category_source};
use boon_proto::proto::CMsgMatchPlayerDamageMatrix;
use boon_proto::proto::c_msg_match_player_damage_matrix::EStatType;
use std::collections::HashMap;

type Series = HashMap<(u32, String), Vec<u32>>;

fn add(
    series: &mut Series,
    hero: u32,
    source: &str,
    values: &[u32],
    n: usize,
) -> Result<(), &'static str> {
    let start = n
        .checked_sub(values.len())
        .ok_or("summary series exceeds its time axis")?;
    let target = series
        .entry((hero, source.to_owned()))
        .or_insert_with(|| vec![0; n]);
    for (slot, &value) in target[start..].iter_mut().zip(values) {
        *slot = slot.saturating_add(value);
    }
    Ok(())
}

fn finish(series: Series) -> Vec<DamageSourceSeries> {
    let mut rows: Vec<_> = series
        .into_iter()
        .map(|((hero_id, source), values)| DamageSourceSeries {
            hero_id,
            source,
            values,
        })
        .collect();
    rows.sort_by(|a, b| (a.hero_id, &a.source).cmp(&(b.hero_id, &b.source)));
    rows
}

pub(super) struct Matrix {
    pub damage: Vec<DamagePair>,
    pub sources: Vec<DamageSourceSeries>,
    pub healing: Vec<DamageSourceSeries>,
    pub regen: Vec<DamageSourceSeries>,
}

pub(super) fn matrix(
    matrix: &CMsgMatchPlayerDamageMatrix,
    heroes: &HashMap<u32, u32>,
) -> Result<Matrix, &'static str> {
    let n = matrix.sample_time_s.len();
    if !matrix.sample_time_s.windows(2).all(|w| w[0] < w[1]) {
        return Err("summary sample times are not increasing");
    }
    let mut pairs: HashMap<(u32, u32), u32> = HashMap::new();
    let mut damage = Series::new();
    let mut healing = Series::new();
    let mut regen = Series::new();
    if let Some(details) = &matrix.source_details {
        for dealer in &matrix.damage_dealers {
            let hero = heroes
                .get(&dealer.dealer_player_slot())
                .copied()
                .filter(|&id| id != 0);
            for source in &dealer.damage_sources {
                let index = source.source_details_index() as usize;
                let (Some(name), Some(&kind)) =
                    (details.source_name.get(index), details.stat_type.get(index))
                else {
                    continue;
                };
                let Ok(kind) = EStatType::try_from(kind) else {
                    continue;
                };
                let category = is_category_source(name);
                for target in &source.damage_to_players {
                    if target.damage.is_empty() {
                        continue;
                    }
                    if target.damage.len() > n {
                        return Err("summary series exceeds its time axis");
                    }
                    let receiver = heroes
                        .get(&target.target_player_slot())
                        .copied()
                        .filter(|&id| id != 0);
                    match (kind, category, hero, receiver) {
                        (EStatType::KETypeDamage, true, Some(hero), _) => {
                            add(&mut damage, hero, name, &target.damage, n)?
                        }
                        (EStatType::KETypeDamage, false, Some(hero), Some(receiver)) => {
                            let value = pairs.entry((hero, receiver)).or_default();
                            *value = value.saturating_add(*target.damage.last().unwrap());
                        }
                        (EStatType::KETypeHealing, false, Some(hero), _) => {
                            add(&mut healing, hero, name, &target.damage, n)?
                        }
                        // Regen belongs to the receiving player, including
                        // environmental sources without a player dealer.
                        (EStatType::KETypeRegen, false, _, Some(receiver)) => {
                            add(&mut regen, receiver, name, &target.damage, n)?
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    let mut pairs: Vec<_> = pairs
        .into_iter()
        .map(|((dealer_hero, target_hero), damage)| DamagePair {
            dealer_hero,
            target_hero,
            damage,
        })
        .collect();
    pairs.sort_by_key(|p| (p.dealer_hero, p.target_hero));
    Ok(Matrix {
        damage: pairs,
        sources: finish(damage),
        healing: finish(healing),
        regen: finish(regen),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use boon_proto::proto::c_msg_match_player_damage_matrix::{
        DamageDealer, DamageSource, DamageToPlayer, SourceDetails,
    };

    #[test]
    fn source_breakdowns_exclude_categories_and_regen_uses_the_receiver() {
        let row = |index, values: Vec<u32>| DamageSource {
            source_details_index: Some(index),
            damage_to_players: vec![DamageToPlayer {
                target_player_slot: Some(2),
                damage: values,
            }],
        };
        let data = CMsgMatchPlayerDamageMatrix {
            sample_time_s: vec![60, 120],
            source_details: Some(SourceDetails {
                source_name: [
                    "Ability",
                    "ability_heal",
                    "Regen",
                    "base_stat_regen",
                    "weapon_damage",
                ]
                .map(str::to_owned)
                .to_vec(),
                stat_type: vec![1, 1, 5, 5, 0],
            }),
            damage_dealers: vec![
                DamageDealer {
                    dealer_player_slot: Some(1),
                    damage_sources: vec![
                        row(0, vec![20, 50]),
                        row(1, vec![20, 50]),
                        row(4, vec![10, 30]),
                    ],
                },
                DamageDealer {
                    dealer_player_slot: Some(99),
                    damage_sources: vec![row(2, vec![5, 15]), row(3, vec![5, 15])],
                },
            ],
        };
        let totals = matrix(&data, &HashMap::from([(1, 7), (2, 63)])).unwrap();
        assert_eq!(totals.healing.len(), 1);
        assert_eq!(totals.healing[0].hero_id, 7);
        assert_eq!(totals.healing[0].values, [20, 50]);
        assert_eq!(totals.regen.len(), 1);
        assert_eq!(totals.regen[0].hero_id, 63);
        assert_eq!(totals.regen[0].values, [5, 15]);
        assert_eq!(totals.damage[0].damage, 30);
        assert_eq!(totals.damage[0].target_hero, 63);
    }

    #[test]
    fn cumulative_series_are_right_aligned_and_added_not_differenced() {
        let mut series = Series::new();
        add(&mut series, 7, "source", &[10, 30], 4).unwrap();
        add(&mut series, 7, "source", &[5], 4).unwrap();
        assert_eq!(finish(series)[0].values, [0, 0, 10, 35]);
        assert!(add(&mut Series::new(), 7, "source", &[1, 2], 1).is_err());
    }
}
