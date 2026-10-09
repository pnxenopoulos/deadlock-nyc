use super::*;
use boon::player_states::{DecodedStates, PlayerStateQuery, PlayerStateRow};
use std::sync::Arc;

impl From<PlayerStateRow> for PlayerStatusResult {
    fn from(row: PlayerStateRow) -> Self {
        let names = |mask: &Option<Arc<DecodedStates>>| {
            mask.as_ref()
                .map(|m| m.names.iter().map(ToString::to_string).collect())
        };
        let unknown =
            |mask: Option<Arc<DecodedStates>>| mask.map_or_else(Vec::new, |m| m.unknown.clone());
        Self {
            states: names(&row.states),
            enabled_states: names(&row.enabled_states),
            disabled_states: names(&row.disabled_states),
            unknown_states: unknown(row.states),
            unknown_enabled_states: unknown(row.enabled_states),
            unknown_disabled_states: unknown(row.disabled_states),
        }
    }
}

#[derive(Default, Serialize)]
struct StatusChanges {
    steam_id: String,
    ticks: Vec<i32>,
    indices: Vec<u32>,
}

#[derive(Serialize)]
struct StatusHistory {
    values: Vec<PlayerStatusResult>,
    players: Vec<StatusChanges>,
}

#[wasm_bindgen]
impl DemoParser {
    /// Change-only, interned recorded masks at every displayed frame tick.
    #[wasm_bindgen(js_name = playerStatusHistory)]
    pub fn player_status_history(&self, ticks: Vec<i32>) -> Result<JsValue, JsError> {
        let catalog = self
            .state_catalog
            .as_ref()
            .ok_or_else(|| JsError::new("load a catalog first"))?;
        let mut palette = HashMap::<PlayerStatusResult, u32>::new();
        let mut previous = HashMap::<u64, [Option<Arc<DecodedStates>>; 3]>::new();
        let mut players = std::collections::BTreeMap::<u64, StatusChanges>::new();
        if !ticks.is_empty() {
            self.inner
                .visit_player_states(&PlayerStateQuery::default().ticks(ticks), catalog, |row| {
                    let Some(steam_id) = row.steam_id else {
                        return;
                    };
                    let tick = row.tick;
                    let masks = [
                        row.states.clone(),
                        row.enabled_states.clone(),
                        row.disabled_states.clone(),
                    ];
                    if previous.get(&steam_id) == Some(&masks) {
                        return;
                    }
                    previous.insert(steam_id, masks);
                    let next = palette.len() as u32;
                    let index = *palette.entry(row.into()).or_insert(next);
                    let changes = players.entry(steam_id).or_insert_with(|| StatusChanges {
                        steam_id: steam_id.to_string(),
                        ..Default::default()
                    });
                    if changes.indices.last() != Some(&index) {
                        changes.ticks.push(tick);
                        changes.indices.push(index);
                    }
                })
                .map_err(to_js_error)?;
        }
        let mut values: Vec<_> = palette.into_iter().collect();
        values.sort_unstable_by_key(|(_, index)| *index);
        serde_wasm_bindgen::to_value(&StatusHistory {
            values: values.into_iter().map(|(value, _)| value).collect(),
            players: players.into_values().collect(),
        })
        .map_err(to_js_error)
    }
}
