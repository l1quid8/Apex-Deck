use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub(crate) async fn verify(
    checks: Arc<Semaphore>,
    budget: Duration,
    check: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    // One deadline covers queueing and execution. A cancelled/timed-out worker
    // retains its permit until the blocking function actually exits.
    tokio::time::timeout(budget, async move {
        let permit = checks
            .acquire_owned()
            .await
            .map_err(|_| "Peer verification unavailable")?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            check()
        })
        .await
        .map_err(|e| format!("Peer verification worker failed: {e}"))?
    })
    .await
    .map_err(|_| "Peer verification timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fifth_check_waits_for_a_slot() {
        let checks = Arc::new(Semaphore::new(4));
        let held = checks.clone().acquire_many_owned(4).await.unwrap();
        let (started, mut received) = tokio::sync::oneshot::channel();
        let request = tokio::spawn(verify(checks.clone(), Duration::from_secs(2), move || {
            started.send(()).unwrap();
            Ok(())
        }));
        tokio::task::yield_now().await;
        assert!(!request.is_finished(), "a busy verifier must queue");
        assert!(received.try_recv().is_err());
        drop(held);
        request.await.unwrap().unwrap();
        received.await.unwrap();
        assert_eq!(checks.available_permits(), 4);
    }

    #[tokio::test]
    async fn queue_timeout_does_not_start_a_worker() {
        let checks = Arc::new(Semaphore::new(0));
        let result = verify(checks, Duration::from_millis(20), || {
            panic!("timed-out queued request must never execute")
        })
        .await;
        assert_eq!(result.unwrap_err(), "Peer verification timed out");
    }

    #[tokio::test]
    async fn timed_out_worker_retains_slot_until_it_exits() {
        let checks = Arc::new(Semaphore::new(1));
        let (release, wait) = std::sync::mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let request = tokio::spawn(verify(
            checks.clone(),
            Duration::from_millis(100),
            move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                Ok(())
            },
        ));
        ready.await.unwrap();
        assert_eq!(
            request.await.unwrap().unwrap_err(),
            "Peer verification timed out"
        );
        assert_eq!(checks.available_permits(), 0);
        release.send(()).unwrap();
        let _permit = tokio::time::timeout(Duration::from_secs(2), checks.acquire())
            .await
            .unwrap()
            .unwrap();
    }
}
