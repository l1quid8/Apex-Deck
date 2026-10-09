//! Host-owned execution of durable monitor wake requests.

use crate::Host;
use std::{collections::HashSet, future::Future, pin::Pin, sync::Arc, time::Duration};

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl Host {
    /// Start once per daemon, after opening its store. A weak owner prevents
    /// the sleeping clock from keeping an abandoned host alive.
    pub fn start_monitor_clock(self: &Arc<Self>) -> Result<(), String> {
        self.start_monitor_clock_with(|host, id| {
            Box::pin(async move { host.monitor_check(&id, false).await })
        })
    }

    fn start_monitor_clock_with(
        self: &Arc<Self>,
        run_check: impl Fn(Arc<Host>, String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
            + Send
            + Sync
            + 'static,
    ) -> Result<(), String> {
        let mut worker = self.monitor_clock.lock().unwrap();
        if worker.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(());
        }
        self.change_monitors(|monitors| {
            let at = now();
            for monitor in monitors {
                monitor.recover(at);
            }
            Ok(())
        })?;
        let owner = Arc::downgrade(self);
        let wake = self.monitor_wake.clone();
        let run_check = Arc::new(run_check);
        *worker = Some(self.runtime().spawn(async move {
            let mut checks = tokio::task::JoinSet::new();
            let mut running = HashSet::new();
            loop {
                let Some(host) = owner.upgrade() else {
                    break;
                };
                let at = now();
                let mut delay = 60_000;
                match host.monitor_list() {
                    Ok(mut monitors) => {
                        monitors.sort_by_key(|m| m.next_check_at);
                        for m in monitors {
                            if m.paused
                                || m.completed
                                || m.active_check.is_some()
                                || running.contains(&m.workspace_id)
                            {
                                continue;
                            }
                            let Some(due) = m.next_check_at else {
                                continue;
                            };
                            if due <= at {
                                if checks.len() < 2 {
                                    let host = host.clone();
                                    let id = m.workspace_id;
                                    let run_check = run_check.clone();
                                    running.insert(id.clone());
                                    checks.spawn(async move {
                                        if let Err(error) = run_check(host, id.clone()).await {
                                            eprintln!("ApexAgent check {id}: {error}");
                                        }
                                        id
                                    });
                                }
                            } else {
                                delay = delay.min(due.saturating_sub(at));
                            }
                        }
                    }
                    Err(error) => eprintln!("ApexAgent clock: {error}"),
                }
                drop(host);
                // Wall-clock deadlines are recomputed after every wake, including
                // the backstop after sleep or a wall-clock jump. No catch-up burst.
                tokio::select! {
                    _ = wake.notified() => {},
                    _ = tokio::time::sleep(Duration::from_millis(delay)) => {},
                    result = checks.join_next(), if !checks.is_empty() => {
                        if let Some(Ok(id)) = result { running.remove(&id); }
                    }
                }
            }
            // Dropping JoinSet aborts calls; their durable claims recover on boot.
        }));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{monitor_commands::Assignment, Host, HostPaths};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    static FIXTURE_ID: AtomicUsize = AtomicUsize::new(0);

    async fn fixture() -> (Arc<Host>, Arc<AtomicUsize>, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "apex-clock-{}-{}-{}",
            std::process::id(),
            FIXTURE_ID.fetch_add(1, Ordering::SeqCst),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(path.join("project")).unwrap();
        std::fs::write(
            path.join("project/plan.md"),
            "SSO tests must pass before launch. SSO tests FAILED.",
        )
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let host = Host::new(
            HostPaths {
                data: path.join("data"),
                downloads: None,
            },
            tokio::runtime::Handle::current(),
        );
        let profile = serde_json::from_value(serde_json::json!({"id":"monitor", "display_name":"Monitor", "backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:9/v1","model":"text"}})).unwrap();
        host.monitor_assign(Assignment {
            workspace_id: "w".into(),
            cwd: path.join("project").to_string_lossy().into(),
            host_id: "local".into(),
            text: "Keep launch on track".into(),
            files: vec!["plan.md".into()],
            threads: vec![],
            profile,
        })
        .unwrap();
        (host, calls, path)
    }

    fn start_test_clock(host: &Arc<Host>, calls: Arc<AtomicUsize>) {
        host.start_monitor_clock_with(move |host, id| {
            let calls = calls.clone();
            Box::pin(async move {
                host.monitor_check_with(&id, false, move |_, _| async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(serde_json::json!({
                        "message":"SSO blocks launch",
                        "messageEvidence":[{"id":"file:plan.md"}],
                        "findings":[{"summary":"SSO tests failed","reason":"SSO is required","confidence":"observed","nextStep":"Fix or defer SSO","evidence":[{"id":"file:plan.md"}]}],
                        "nextStep":"Review SSO",
                        "nextCheckInMinutes":60,
                        "wakeReason":"Awaiting SSO changes"
                    }).to_string())
                }).await
            })
        }).unwrap();
    }

    async fn checked(host: &Host, n: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let m = host.monitor_get("w").unwrap().unwrap();
                if m.activity
                    .iter()
                    .filter(|a| a.kind == "check_started")
                    .count()
                    >= n
                    && m.active_check.is_none()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn clock_executes_initial_and_check_now_without_duplicate_workers() {
        let (host, calls, path) = fixture().await;
        start_test_clock(&host, calls.clone());
        start_test_clock(&host, calls.clone());
        checked(&host, 1).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.monitor_get("w").unwrap().unwrap().findings.len(), 1);
        host.monitor_check_now("w").unwrap();
        checked(&host, 2).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        host.shutdown();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn clock_skips_paused_and_recovers_pending_request_after_restart() {
        let (host, calls, path) = fixture().await;
        host.monitor_pause("w", true).unwrap();
        start_test_clock(&host, calls.clone());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        host.shutdown();
        host.monitor_pause("w", false).unwrap();
        host.change_monitor("w", |m, at| {
            m.claim(at, true).unwrap();
            m.request_check_now(at)?;
            Ok(())
        })
        .unwrap();
        let reopened = Host::new(
            HostPaths {
                data: path.join("data"),
                downloads: None,
            },
            tokio::runtime::Handle::current(),
        );
        start_test_clock(&reopened, calls.clone());
        checked(&reopened, 2).await;
        let m = reopened.monitor_get("w").unwrap().unwrap();
        assert!(m.activity.iter().any(|a| a.kind == "interrupted"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        reopened.shutdown();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn clock_recomputes_saved_wall_deadline_after_wake() {
        let (host, calls, path) = fixture().await;
        host.change_monitor("w", |m, at| {
            m.next_check_at = Some(at + 3_600_000);
            Ok(())
        })
        .unwrap();
        start_test_clock(&host, calls.clone());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // The saved deadline is now past, without advancing Tokio's sleep.
        host.change_monitor("w", |m, _| {
            m.next_check_at = Some(1);
            Ok(())
        })
        .unwrap();
        checked(&host, 1).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        host.shutdown();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn restart_backs_off_interrupted_check_without_pending_request() {
        let (host, calls, path) = fixture().await;
        host.change_monitor("w", |m, at| {
            m.claim(at, true).unwrap();
            Ok(())
        })
        .unwrap();
        start_test_clock(&host, calls.clone());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let m = host.monitor_get("w").unwrap().unwrap();
        assert!(m.active_check.is_none());
        assert_eq!(m.wake_reason, "recovery");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        host.shutdown();
        std::fs::remove_dir_all(path).unwrap();
    }
}
