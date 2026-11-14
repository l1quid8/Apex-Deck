//! Retry only unavailable revocation checks, never other trust failures.
pub(crate) fn verify_with_offline_fallback(mut verify: impl FnMut(bool) -> i32) -> i32 {
    let result = verify(true);
    if matches!(result as u32, 0x80092012 | 0x80092013) {
        // Missing revocation data is not evidence of a valid signature. Redo
        // the full signature/chain policy without revocation, on the same file.
        verify(false)
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_revocation_requires_successful_full_signature_retry() {
        for unavailable in [0x80092012u32, 0x80092013] {
            let mut modes = Vec::new();
            assert_eq!(
                verify_with_offline_fallback(|revocation| {
                    modes.push(revocation);
                    if revocation {
                        unavailable as i32
                    } else {
                        0
                    }
                }),
                0
            );
            assert_eq!(modes, [true, false]);
        }
    }

    #[test]
    fn revoked_and_other_failures_never_retry() {
        for failure in [
            0x800b010cu32,
            0x80092010,
            0x80096010,
            0x800b0109,
            0x800b0100,
        ] {
            let mut calls = 0;
            assert_eq!(
                verify_with_offline_fallback(|revocation| {
                    calls += 1;
                    assert!(revocation);
                    failure as i32
                }),
                failure as i32
            );
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn offline_retry_still_rejects_bad_digest_untrusted_chain_and_revocation() {
        for failure in [0x80096010u32, 0x800b0109, 0x800b010c, 0x80092013] {
            assert_eq!(
                verify_with_offline_fallback(|revocation| {
                    if revocation {
                        0x80092013u32 as i32
                    } else {
                        failure as i32
                    }
                }),
                failure as i32
            );
        }
    }

    #[test]
    fn successful_cached_revocation_check_never_retries() {
        let mut calls = 0;
        assert_eq!(
            verify_with_offline_fallback(|revocation| {
                calls += 1;
                assert!(revocation);
                0
            }),
            0
        );
        assert_eq!(calls, 1);
    }
}
