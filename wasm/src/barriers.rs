use std::collections::HashMap;

use boon::{ModifierChange, ModifierChangeKind, Parser};

pub(super) const TRACKER_ID: u32 = 4_267_845_006;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Barrier {
    pub remaining: f32,
    pub capacity: f32,
}

/// Packet-delta history keyed by full pawn handle, not a reusable entity slot.
/// Relay keyframe modifier snapshots can be ahead of the recorded tick.
#[derive(Default)]
pub(super) struct Barriers {
    values: HashMap<u32, Vec<(i32, Barrier)>>,
    owners: HashMap<u32, u32>,
}

impl Barriers {
    pub fn read(parser: &Parser) -> boon::Result<Self> {
        let mut barriers = Self::default();
        parser.visit_modifier_changes(|tick, change| barriers.apply(tick, change))?;
        Ok(barriers)
    }

    fn apply(&mut self, tick: i32, change: ModifierChange) {
        let entry = &change.entry;
        let parent = entry
            .parent
            .filter(|&h| boon::protobuf_handle_index(Some(h)).is_some());
        if change.kind == ModifierChangeKind::Removed
            || entry.modifier_subclass != Some(TRACKER_ID)
            || parent.is_none()
        {
            if let Some(parent) = self.owners.remove(&change.serial) {
                self.record(tick, parent, Barrier::default());
            }
            return;
        }
        let parent = parent.expect("validated tracker parent");
        if let Some(old) = self.owners.insert(change.serial, parent)
            && old != parent
        {
            self.record(tick, old, Barrier::default());
        }
        // A replaced tracker's later removal must not clear the new pool.
        self.owners
            .retain(|&serial, owner| serial == change.serial || *owner != parent);
        let remaining = entry
            .float2
            .filter(|v| v.is_finite())
            .unwrap_or(0.0)
            .max(0.0);
        let capacity = entry
            .float1
            .filter(|v| v.is_finite())
            .unwrap_or(remaining)
            .max(remaining);
        self.record(
            tick,
            parent,
            Barrier {
                remaining,
                capacity,
            },
        );
    }

    fn record(&mut self, tick: i32, parent: u32, value: Barrier) {
        let values = self.values.entry(parent).or_default();
        if let Some(last) = values.last_mut() {
            if last.0 == tick {
                last.1 = value;
                return;
            }
            if last.1 == value {
                return;
            }
        }
        values.push((tick, value));
    }

    pub fn at(&self, tick: i32, parent: u32) -> Barrier {
        self.values
            .get(&parent)
            .and_then(|values| {
                let end = values.partition_point(|&(at, _)| at <= tick);
                end.checked_sub(1).map(|index| values[index].1)
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boon_proto::proto::CModifierTableEntry;

    fn change(
        serial: u32,
        parent: u32,
        kind: ModifierChangeKind,
        remaining: f32,
    ) -> ModifierChange {
        ModifierChange {
            serial,
            kind,
            entry: CModifierTableEntry {
                serial_number: Some(serial),
                parent: Some(parent),
                modifier_subclass: Some(TRACKER_ID),
                float1: Some(600.0),
                float2: Some(remaining),
                ..Default::default()
            },
        }
    }

    #[test]
    fn pool_changes_and_removal_follow_recorded_ticks() {
        let mut barriers = Barriers::default();
        barriers.apply(10, change(1, 123, ModifierChangeKind::Applied, 526.6));
        barriers.apply(20, change(1, 123, ModifierChangeKind::Changed, 100.0));
        barriers.apply(30, change(1, 123, ModifierChangeKind::Removed, 100.0));
        assert_eq!(barriers.at(9, 123), Barrier::default());
        assert_eq!(
            barriers.at(19, 123),
            Barrier {
                remaining: 526.6,
                capacity: 600.0
            }
        );
        assert_eq!(barriers.at(29, 123).remaining, 100.0);
        assert_eq!(barriers.at(30, 123), Barrier::default());
        assert_eq!(barriers.at(19, 123 + 16384), Barrier::default());
    }

    #[test]
    fn replacement_late_removal_and_owner_reuse_do_not_mix_pools() {
        let mut barriers = Barriers::default();
        barriers.apply(10, change(1, 123, ModifierChangeKind::Applied, 200.0));
        barriers.apply(20, change(2, 123, ModifierChangeKind::Applied, 300.0));
        barriers.apply(30, change(1, 123, ModifierChangeKind::Removed, 0.0));
        assert_eq!(barriers.at(30, 123).remaining, 300.0);
        barriers.apply(40, change(2, 456, ModifierChangeKind::Changed, 400.0));
        assert_eq!(barriers.at(40, 123), Barrier::default());
        assert_eq!(barriers.at(40, 456).remaining, 400.0);
    }

    #[test]
    fn same_tick_updates_and_invalid_amounts_are_safe() {
        let mut barriers = Barriers::default();
        barriers.apply(10, change(1, 123, ModifierChangeKind::Applied, 200.0));
        barriers.apply(10, change(1, 123, ModifierChangeKind::Changed, 100.0));
        barriers.apply(20, change(1, 123, ModifierChangeKind::Changed, f32::NAN));
        barriers.apply(30, change(1, 123, ModifierChangeKind::Changed, -100.0));
        assert_eq!(barriers.at(10, 123).remaining, 100.0);
        assert_eq!(barriers.values[&123].len(), 2);
        assert_eq!(barriers.at(30, 123).remaining, 0.0);
    }
}
