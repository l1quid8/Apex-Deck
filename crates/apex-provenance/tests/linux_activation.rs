#![cfg(unix)]
use apex_provenance::linux_activation::{Activation, Descriptor, Phase};

fn release(commit: char) -> Descriptor {
    Descriptor {
        tree: format!("/opt/apex-deck/1.0-{}-arm64", commit.to_string().repeat(40)).into(),
        manifest_sha256: commit.to_string().repeat(64),
        protocol: 1,
        epoch: 0,
    }
}

#[test]
fn activation_closes_admission_until_health_and_rollback_advances_epoch() {
    let mut state = Activation::default();
    assert!(state.admitted().is_err());
    state.prepare(release('a')).unwrap();
    assert_eq!(state.phase(), Phase::Prepared);
    assert!(state.admitted().is_err());
    assert!(state.healthy().is_err());
    state.services_stopped().unwrap();
    assert!(state.admitted().is_err());
    state.healthy().unwrap();
    assert_eq!(state.admitted().unwrap().epoch, 1);
    state.prepare(release('b')).unwrap();
    assert!(state.prepare(release('c')).is_err());
    state.services_stopped().unwrap();
    state.healthy().unwrap();
    assert_eq!(state.admitted().unwrap().epoch, 2);
    state.prepare(release('a')).unwrap();
    state.services_stopped().unwrap();
    state.healthy().unwrap();
    assert_eq!(state.admitted().unwrap().epoch, 3);
}

#[test]
fn every_serialized_boundary_preserves_closed_admission_and_epoch() {
    let mut state = Activation::default();
    for commit in ['a', 'b', 'a'] {
        state.prepare(release(commit)).unwrap();
        let bytes = serde_json::to_vec(&state).unwrap();
        let mut restored = Activation::restore(&bytes).unwrap();
        assert!(restored.admitted().is_err());
        restored.services_stopped().unwrap();
        let bytes = serde_json::to_vec(&restored).unwrap();
        let mut restored = Activation::restore(&bytes).unwrap();
        assert!(restored.admitted().is_err());
        restored.healthy().unwrap();
        let epoch = restored.admitted().unwrap().epoch;
        state = Activation::restore(&serde_json::to_vec(&restored).unwrap()).unwrap();
        assert_eq!(state.admitted().unwrap().epoch, epoch);
    }
    assert_eq!(state.admitted().unwrap().epoch, 3);
}

#[test]
fn corrupt_or_incompatible_state_never_becomes_admissible() {
    let mut state = Activation::default();
    for mut candidate in [release('a'), release('b'), release('c')] {
        candidate.protocol = 2;
        assert!(state.prepare(candidate).is_err());
    }
    let mut candidate = release('a');
    candidate.tree = "/opt/apex-deck/../untrusted".into();
    assert!(state.prepare(candidate).is_err());
    state.prepare(release('a')).unwrap();
    state.services_stopped().unwrap();
    state.healthy().unwrap();
    let bytes = serde_json::to_value(&state).unwrap();
    for (field, value) in [
        ("epoch", serde_json::json!(0)),
        ("schema", serde_json::json!(2)),
        ("phase", serde_json::json!("switched")),
        ("unexpected", serde_json::json!(true)),
    ] {
        let mut corrupt = bytes.clone();
        corrupt[field] = value;
        assert!(
            Activation::restore(&serde_json::to_vec(&corrupt).unwrap()).is_err(),
            "{corrupt}"
        );
    }
    assert!(Activation::restore(b"{}").is_err());
    assert!(Activation::restore(b"not json").is_err());
}

#[test]
fn recovery_never_reuses_the_interrupted_epoch() {
    for switched in [false, true] {
        let mut state = Activation::default();
        state.prepare(release('a')).unwrap();
        state.services_stopped().unwrap();
        state.healthy().unwrap();
        state.prepare(release('b')).unwrap();
        if switched {
            state.services_stopped().unwrap();
        }
        let mut restored = Activation::restore(&serde_json::to_vec(&state).unwrap()).unwrap();
        restored.recover(release('a')).unwrap();
        assert!(restored.admitted().is_err());
        restored.services_stopped().unwrap();
        restored.healthy().unwrap();
        assert_eq!(restored.admitted().unwrap().epoch, 3);
    }
    assert!(Activation::default().recover(release('a')).is_err());
}
