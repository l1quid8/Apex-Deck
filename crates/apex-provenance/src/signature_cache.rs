//! Only successful signature checks may be reused, briefly, for unchanged files.
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) struct ModuleIdentity {
    pub volume: u64,
    pub id: [u8; 16],
    pub changed: i64,
    pub written: i64,
    pub size: u64,
}

#[derive(Default)]
pub(crate) struct SignatureCache {
    entries: HashMap<ModuleIdentity, Instant>,
}

impl SignatureCache {
    pub(crate) fn verify(
        &mut self,
        key: ModuleIdentity,
        now: Instant,
        verify: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.entries.retain(|_, checked| {
            now.checked_duration_since(*checked)
                .is_some_and(|age| age < Duration::from_secs(60))
        });
        if self.entries.contains_key(&key) {
            return Ok(());
        }
        verify()?;
        // Bounded even when many distinct modules are presented. Eviction only
        // causes another verification; it cannot confer trust on a new file.
        if self.entries.len() >= 256 {
            self.entries.clear();
        }
        self.entries.insert(key, now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key() -> ModuleIdentity {
        ModuleIdentity {
            volume: 1,
            id: [2; 16],
            changed: 3,
            written: 4,
            size: 5,
        }
    }

    #[test]
    fn unchanged_file_reuses_verification_but_changes_require_it_again() {
        let mut cache = SignatureCache::default();
        let now = Instant::now();
        cache.verify(key(), now, || Ok(())).unwrap();
        cache
            .verify(key(), now, || Err("unchanged file was reverified".into()))
            .unwrap();
        for changed in [
            ModuleIdentity {
                id: [9; 16],
                ..key()
            },
            ModuleIdentity { volume: 9, ..key() },
            ModuleIdentity {
                changed: 9,
                ..key()
            },
            ModuleIdentity {
                written: 9,
                ..key()
            },
            ModuleIdentity { size: 9, ..key() },
        ] {
            assert!(cache
                .verify(changed, now, || Err("must reverify".into()))
                .is_err());
        }
    }

    #[test]
    fn failures_are_not_cached_and_successes_expire() {
        let mut cache = SignatureCache::default();
        let now = Instant::now();
        assert!(cache.verify(key(), now, || Err("invalid".into())).is_err());
        cache.verify(key(), now, || Ok(())).unwrap();
        assert!(cache
            .verify(key(), now + Duration::from_secs(60), || Err(
                "expired".into()
            ))
            .is_err());
        assert!(cache
            .verify(key(), now, || Err("expired entry was removed".into()))
            .is_err());
    }

    #[test]
    fn cache_is_bounded() {
        let mut cache = SignatureCache::default();
        for volume in 0..300 {
            cache
                .verify(
                    ModuleIdentity { volume, ..key() },
                    Instant::now(),
                    || Ok(()),
                )
                .unwrap();
        }
        assert!(cache.entries.len() <= 256);
    }
}
