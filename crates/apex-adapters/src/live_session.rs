//! Process-local ownership of idle room workers and in-flight reservations.
use crate::{claude_session::ClaudeProcess, codex_hook::Hook, codex_server::CodexLive};
use apex_core::{render_conversation, Role, ViewTurn};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CAP: usize = 6;
const IDLE: Duration = Duration::from_secs(20 * 60);

pub(crate) enum Process {
    Claude(ClaudeProcess),
    Codex(CodexLive, Option<Hook>),
}
impl Process {
    fn alive(&mut self) -> bool {
        match self {
            Self::Claude(p) => p.is_alive(),
            Self::Codex(p, _) => p.is_alive(),
        }
    }
    fn retire(self) {
        self.retire_on(tokio::runtime::Handle::try_current().ok());
    }
    fn retire_on(mut self, runtime: Option<tokio::runtime::Handle>) {
        match &mut self {
            Self::Claude(p) => p.terminate_now(),
            Self::Codex(p, _) => p.terminate_now(),
        }
        if let Some(runtime) = runtime {
            runtime.spawn(async move {
                let verified = match self {
                    Self::Claude(p) => p.close().await.is_ok(),
                    Self::Codex(p, _hook) => p.close().await.is_ok(),
                };
                if !verified {
                    eprintln!("[apex-deck] Could not verify retired room worker cleanup");
                }
            });
        }
    }
}

struct Cached {
    runtime: tokio::runtime::Handle,
    key: Key,
    history: Vec<ViewTurn>,
    process: Process,
    timeout: Duration,
}
struct IdleTimer(tokio::task::JoinHandle<()>);
impl Drop for IdleTimer {
    fn drop(&mut self) {
        self.0.abort();
    }
}
enum Entry {
    Running(u64),
    Idle(u64, Instant, Cached, IdleTimer),
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct Owner {
    id: u64,
    room: Option<std::path::PathBuf>,
    bot: apex_core::ParticipantId,
}
type Pool = HashMap<Owner, Entry>;

pub(crate) fn clear_room(room: &std::path::Path, bot: Option<&apex_core::ParticipantId>) {
    let mut pool = pool().lock().unwrap();
    let keys: Vec<_> = pool
        .keys()
        .filter(|owner| {
            owner.room.as_deref() == Some(room) && bot.is_none_or(|bot| *bot == owner.bot)
        })
        .cloned()
        .collect();
    for key in keys {
        retire(pool.remove(&key));
    }
}
fn pool() -> &'static Mutex<Pool> {
    static POOL: OnceLock<Mutex<Pool>> = OnceLock::new();
    POOL.get_or_init(Default::default)
}
fn id() -> u64 {
    static ID: AtomicU64 = AtomicU64::new(1);
    ID.fetch_add(1, Ordering::Relaxed)
}
fn retire(entry: Option<Entry>) {
    if let Some(Entry::Idle(_, _, cached, _timer)) = entry {
        cached.process.retire_on(Some(cached.runtime));
    }
}

#[derive(PartialEq, Eq)]
pub(crate) struct Key {
    pub config: apex_core::ParticipantConfig,
    pub cwd: Option<std::path::PathBuf>,
    pub system: String,
    pub plan: Option<apex_core::Access>,
    pub args: Vec<String>,
    pub hooked: bool,
    pub tools_disabled: bool,
    pub mcp_disabled: bool,
    pub code_mode: bool,
}
pub(crate) struct Slot(Owner);
impl Drop for Slot {
    fn drop(&mut self) {
        self.clear()
    }
}
impl Slot {
    pub fn new(room: Option<std::path::PathBuf>, bot: apex_core::ParticipantId) -> Self {
        Self(Owner {
            id: id(),
            room,
            bot,
        })
    }
    pub fn clear(&self) {
        retire(pool().lock().unwrap().remove(&self.0));
    }

    pub fn begin(self: &Arc<Self>, key: Key, view: &[ViewTurn]) -> Option<LiveTurn> {
        let generation = id();
        let prior = {
            let mut pool = pool().lock().unwrap();
            if matches!(pool.get(&self.0), Some(Entry::Running(_))) {
                return None;
            }
            if pool.len() >= CAP && !pool.contains_key(&self.0) {
                let oldest = pool
                    .iter()
                    .filter_map(|(id, entry)| match entry {
                        Entry::Idle(_, used, _, _) => Some((id.clone(), *used)),
                        Entry::Running(_) => None,
                    })
                    .min_by_key(|(_, used)| *used)?
                    .0;
                retire(pool.remove(&oldest));
            }
            pool.insert(self.0.clone(), Entry::Running(generation))
        };
        let mut result = LiveTurn {
            slot: self.clone(),
            generation,
            key: Some(key),
            history: view.to_vec(),
            tail: None,
            process: None,
        };
        if let Some(Entry::Idle(_, used, mut cache, _timer)) = prior {
            if used.elapsed() < cache.timeout
                && Some(&cache.key) == result.key.as_ref()
                && cache.process.alive()
            {
                if let Some(tail) = continuation(&cache.history, view) {
                    result.tail = Some(tail);
                    result.process = Some(cache.process);
                    return Some(result);
                }
            }
            cache.process.retire_on(Some(cache.runtime));
        }
        Some(result)
    }
}

/// Compare structured turns so quoted speaker labels inside a message cannot
/// impersonate a previously committed reply or turn boundary.
fn continuation(previous: &[ViewTurn], current: &[ViewTurn]) -> Option<String> {
    let (last, earlier) = previous.split_last()?;
    let (matching, tail) = current.strip_prefix(earlier)?.split_first()?;
    if matching.role != last.role || tail.iter().any(|t| t.role == Role::Assistant) {
        return None;
    }
    if matching == last {
        return (!tail.is_empty()).then(|| render_conversation(tail));
    }
    // After a pass Deck saves no assistant message. Subsequent user messages
    // are folded into the preceding user turn using a blank-line separator.
    if last.role != Role::User {
        return None;
    }
    let extra = matching
        .content
        .strip_prefix(&last.content)?
        .strip_prefix("\n\n")?;
    if extra.is_empty() {
        return None;
    }
    Some(format!("{extra}\n\n{}", render_conversation(tail)))
}

pub(crate) struct LiveTurn {
    slot: Arc<Slot>,
    generation: u64,
    key: Option<Key>,
    history: Vec<ViewTurn>,
    pub tail: Option<String>,
    pub process: Option<Process>,
}
impl LiveTurn {
    pub fn finish(mut self, reply: &str) {
        let Some(process) = self.process.take() else {
            return;
        };
        if reply.trim().is_empty() {
            process.retire();
            return;
        }
        if !reply.trim().eq_ignore_ascii_case(apex_core::PASS_TOKEN) {
            self.history.push(ViewTurn {
                role: Role::Assistant,
                content: reply.trim().into(),
            });
        }
        let timeout = match &process {
            Process::Claude(process) => process.cache_lifetime().unwrap_or(IDLE).max(IDLE),
            Process::Codex(..) => IDLE,
        };
        let cached = Cached {
            runtime: tokio::runtime::Handle::current(),
            timeout,
            key: self.key.take().unwrap(),
            history: std::mem::take(&mut self.history),
            process,
        };
        let slot_id = self.slot.0.clone();
        let generation = self.generation;
        let mut entries = pool().lock().unwrap();
        if !matches!(entries.get(&slot_id), Some(Entry::Running(g)) if *g == generation) {
            cached.process.retire_on(Some(cached.runtime));
            return;
        }
        let owner = slot_id.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let mut entries = pool().lock().unwrap();
            if matches!(entries.get(&slot_id), Some(Entry::Idle(g, _, _, _)) if *g == generation) {
                retire(entries.remove(&slot_id));
            }
        });
        entries.insert(
            owner,
            Entry::Idle(generation, Instant::now(), cached, IdleTimer(timer)),
        );
    }
}
impl Drop for LiveTurn {
    fn drop(&mut self) {
        let mut entries = pool().lock().unwrap();
        if matches!(entries.get(&self.slot.0), Some(Entry::Running(g)) if *g == self.generation) {
            entries.remove(&self.slot.0);
        }
        if let Some(process) = self.process.take() {
            process.retire();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: Role, content: &str) -> ViewTurn {
        ViewTurn {
            role,
            content: content.into(),
        }
    }

    #[test]
    fn continuation_requires_exact_history_and_handles_merged_messages_after_passes() {
        let first = message(Role::User, "[User]: old");
        let reply = message(Role::Assistant, "saved");
        let next = message(Role::User, "[User]: next");
        let previous = [first.clone(), reply.clone()];
        assert_eq!(
            continuation(&previous, &[first.clone(), reply.clone(), next.clone()]).as_deref(),
            Some("[User]: next\n\n")
        );
        assert_eq!(
            continuation(
                &previous,
                &[
                    first.clone(),
                    message(Role::Assistant, "edit"),
                    next.clone()
                ]
            ),
            None
        );
        assert_eq!(
            continuation(
                &previous,
                &[first.clone(), reply.clone(), next.clone(), reply]
            ),
            None
        );
        assert_eq!(
            continuation(
                &[first],
                &[message(Role::User, "[User]: old\n\n[User]: next")]
            )
            .as_deref(),
            Some("[User]: next\n\n")
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn busy_workers_hold_reservations_and_only_the_oldest_idle_worker_is_evicted() {
        use apex_core::{testing::ScriptedParticipant, Participant, ParticipantId};
        use std::process::Stdio;
        let key = || Key {
            config: ScriptedParticipant::new("pool-test", &[]).config().clone(),
            cwd: None,
            system: String::new(),
            plan: None,
            args: vec![],
            hooked: false,
            tools_disabled: false,
            mcp_disabled: false,
            code_mode: false,
        };
        let slots: Vec<_> = (0..=CAP)
            .map(|_| Arc::new(Slot::new(None, ParticipantId::new("pool-test"))))
            .collect();
        let mut turns: Vec<_> = slots[..CAP]
            .iter()
            .map(|slot| slot.begin(key(), &[]).unwrap())
            .collect();
        assert!(slots[CAP].begin(key(), &[]).is_none());
        let data =
            std::env::temp_dir().join(format!("deck-live-pool-{}-{}", std::process::id(), id()));
        std::fs::create_dir(&data).unwrap();
        let records = data.join("worker-processes").join("room");
        let registry = crate::owned_process::Registry::new(Some(records.clone()));
        let park = |mut turn: LiveTurn| {
            let mut command = tokio::process::Command::new("cat");
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let child = registry.spawn(&mut command).unwrap();
            turn.process = Some(Process::Claude(ClaudeProcess::new(child)));
            turn.finish("saved");
        };
        park(turns.remove(0));
        park(turns.remove(0));
        let final_turn = slots[CAP].begin(key(), &[]).unwrap();
        {
            let entries = pool().lock().unwrap();
            assert!(!entries.contains_key(&slots[0].0));
            assert!(matches!(entries.get(&slots[1].0), Some(Entry::Idle(..))));
        }
        slots[CAP].clear();
        let replacement = slots[CAP].begin(key(), &[]).unwrap();
        drop(final_turn);
        assert!(slots[CAP].begin(key(), &[]).is_none());
        drop(replacement);
        // Synchronous shutdown can originate on a thread outside Tokio. It
        // must still reap both evicted workers and clear their durable records.
        let slot = slots[1].clone();
        std::thread::spawn(move || slot.clear()).join().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while std::fs::read_dir(&records).unwrap().next().is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("retired workers were not reaped");
        std::fs::remove_dir_all(data).unwrap();
    }
}
