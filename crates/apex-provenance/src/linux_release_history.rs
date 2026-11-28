//! Admin release selection. Stored separately so older runtime brokers can still
//! read their activation state after an explicit rollback.
use crate::linux_activation::{Descriptor, Store, VerifiedCandidate};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Release {
    build: u64,
    descriptor: Descriptor,
}

impl Release {
    fn verified(candidate: &VerifiedCandidate) -> Result<Self, String> {
        Ok(Self {
            build: candidate
                .manifest()
                .build_number
                .ok_or("Missing Nightly build number")?,
            descriptor: candidate.descriptor().clone(),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Activate,
    Repair,
    Rollback,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct History {
    #[serde(deserialize_with = "Option::deserialize")]
    highest: Option<Release>,
    #[serde(deserialize_with = "Option::deserialize")]
    current: Option<Release>,
    #[serde(deserialize_with = "Option::deserialize")]
    previous: Option<Release>,
    #[serde(deserialize_with = "Option::deserialize")]
    pending: Option<Release>,
}

impl History {
    pub(super) fn load(root: &Path) -> Result<Self, String> {
        let file = root.join("release-history.json");
        if file.try_exists().map_err(|e| e.to_string())? {
            let history: Self = serde_json::from_slice(&crate::io::root_file_limit(&file, 16384)?)
                .map_err(|e| e.to_string())?;
            for release in [
                &history.current,
                &history.previous,
                &history.pending,
                &history.highest,
            ]
            .into_iter()
            .flatten()
            {
                release.descriptor.validate()?;
                if release.build == 0
                    || release.descriptor.epoch != 0
                    || history.highest.as_ref().is_none_or(|h| {
                        release.build > h.build || (release.build == h.build && release != h)
                    })
                {
                    return Err("Invalid release history or build floor".into());
                }
            }
            Ok(history)
        } else {
            Self::legacy(root)
        }
    }

    fn legacy(root: &Path) -> Result<Self, String> {
        // Legacy install: bootstrap only from a healthy selected descriptor and
        // its retained signed inputs. Ambiguous retained history needs inspection.
        let store = Store::open()?;
        let state = store.state()?;
        let selected = state.ready_selection()?;
        let releases = root.join("releases");
        if releases.try_exists().map_err(|e| e.to_string())? {
            for entry in releases.read_dir().map_err(|e| e.to_string())? {
                let name = entry.map_err(|e| e.to_string())?.file_name();
                if selected.is_none_or(|d| name.to_str() != Some(&d.manifest_sha256)) {
                    return Err(
                        "Cannot reconstruct absent Nightly history from multiple releases".into(),
                    );
                }
            }
        }
        let current = selected
            .map(|descriptor| {
                let dir = releases.join(&descriptor.manifest_sha256);
                let candidate = VerifiedCandidate::verify(
                    &descriptor.tree,
                    &dir.join("manifest.json"),
                    &dir.join("manifest.sig"),
                    &dir.join("payload.tar"),
                )?;
                if candidate.descriptor().manifest_sha256 != descriptor.manifest_sha256 {
                    return Err("Retained release differs from installed descriptor".into());
                }
                Release::verified(&candidate)
            })
            .transpose()?;
        Ok(Self {
            highest: current.clone(),
            current,
            ..Self::default()
        })
    }

    pub(super) fn target(&self, action: Action) -> Result<&Descriptor, String> {
        let release = match action {
            Action::Rollback if self.pending.is_some() => self.current.as_ref(),
            Action::Rollback => self.previous.as_ref(),
            Action::Repair => self.pending.as_ref().or(self.current.as_ref()),
            Action::Activate => None,
        };
        release
            .map(|r| &r.descriptor)
            .ok_or_else(|| "No recorded release for this operation".into())
    }

    pub(super) fn already_current(&self, candidate: &VerifiedCandidate) -> bool {
        self.pending.is_none()
            && self.highest == self.current
            && self
                .current
                .as_ref()
                .is_some_and(|r| &r.descriptor == candidate.descriptor())
    }

    pub(super) fn authorize(
        &mut self,
        candidate: &VerifiedCandidate,
        action: Action,
    ) -> Result<(), String> {
        self.select(Release::verified(candidate)?, action)
    }

    fn select(&mut self, next: Release, action: Action) -> Result<(), String> {
        if action == Action::Activate {
            if self.pending.is_some() {
                return Err("Interrupted update requires repair or rollback".into());
            }
            if self.current.as_ref() == Some(&next) {
                return Err("This Nightly build is already installed".into());
            }
            if let Some(high) = &self.highest {
                if next.build < high.build || (next.build == high.build && next != *high) {
                    return Err(
                        "Nightly build is below the highest accepted release or conflicts with it"
                            .into(),
                    );
                }
            }
            self.highest = Some(next.clone());
        } else if self.target(action)? != &next.descriptor {
            return Err("Release differs from the recorded recovery target".into());
        }
        self.pending = Some(next);
        Ok(())
    }

    pub(super) fn healthy(&mut self) {
        let next = self.pending.take().expect("selection before health");
        if self.current.as_ref() != Some(&next) {
            self.previous = self.current.take().filter(|old| old.build < next.build);
            self.current = Some(next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn build(n: u64) -> Release {
        Release {
            build: n,
            descriptor: Descriptor {
                tree: format!("/opt/test/staging-{n}").into(),
                manifest_sha256: format!("{n:064x}"),
                protocol: 1,
                epoch: 0,
            },
        }
    }
    #[test]
    fn failed_upgrade_and_rollback_preserve_floor_and_exact_identity() {
        let mut h = History::default();
        for n in [3, 5] {
            h.select(build(n), Action::Activate).unwrap();
            h.healthy();
        }
        assert!(h.select(build(4), Action::Repair).is_err());
        h.select(build(3), Action::Rollback).unwrap();
        h.healthy();
        assert!(h.select(build(4), Action::Activate).is_err());
        let mut conflict = build(5);
        conflict.descriptor.manifest_sha256 = "a".repeat(64);
        assert!(h.select(conflict, Action::Activate).is_err());
        h.select(build(5), Action::Activate).unwrap();
        let mut h: History = serde_json::from_slice(&serde_json::to_vec(&h).unwrap()).unwrap();
        assert!(h.select(build(6), Action::Activate).is_err());
        h.select(build(5), Action::Repair).unwrap();
        h.select(build(3), Action::Rollback).unwrap();
        h.healthy();
        assert!(h.select(build(4), Action::Activate).is_err());
        h.select(build(6), Action::Activate).unwrap();
        h.healthy();
        assert_eq!(h.target(Action::Rollback).unwrap(), &build(3).descriptor);
    }
}
