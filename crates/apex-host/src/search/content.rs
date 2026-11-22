//! The content lane: names, messages, tasks, saved notes and Library
//! pictures. Runs on a blocking thread; checks `cancel` between threads.
//! Reads only. Visibility is read fresh here on every query and applied after
//! the text cache, so a thread trashed a moment ago is gone from the next
//! answer even when its text is still warm.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::cache::Loaded;
use super::query::{snippet, Query, SNIPPET_CHARS};
use super::{SearchHit, SearchKind, SearchReply, SearchRequest, SearchTarget, SkipReason, Skipped, Total, DEFAULT_LIMIT, MAX_LIMIT};
use crate::storage::ProjectEntry;
use crate::Host;

const TITLE_CHARS: usize = 80;

struct Room {
    id: String,
    title: String,
    kind: &'static str,
    project: Option<String>,
    archived: bool,
    trashed: bool,
    names: HashMap<String, String>,
    /// When its newest message was added.
    latest: Option<u64>,
}

/// A matching message, copied out so the thread's text need not be kept.
struct Said {
    at: Option<u64>,
    room: usize,
    line: usize,
    seq: usize,
    origin_seq: Option<usize>,
    client_message_id: Option<String>,
    by: Option<String>,
    text: String,
}

struct Named {
    rank: u8,
    hit: SearchHit,
}

/// The first line of `text`, shortened for a row title.
fn headline(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default();
    let mut out: String = line.chars().take(TITLE_CHARS).collect();
    if line.chars().count() > TITLE_CHARS {
        out.push('…');
    }
    out
}

fn text_hit(kind: SearchKind, title: String, text: &str, ranges: &[(usize, usize)], at: Option<u64>, project: Option<String>, target: SearchTarget) -> SearchHit {
    let (snippet, ranges) = snippet(text, ranges, SNIPPET_CHARS);
    SearchHit { kind, title, snippet, ranges, at, project, room_title: None, archived: false, trashed: false, target }
}

/// Which project a folder belongs to: the registered path, by path or alias.
struct Projects {
    entries: Vec<ProjectEntry>,
}

impl Projects {
    fn of(&self, folder: Option<&str>) -> Option<String> {
        let folder = folder?;
        Some(self.entries.iter().find(|p| p.path == folder || p.aliases.iter().any(|a| a == folder)).map_or_else(|| folder.to_owned(), |p| p.path.clone()))
    }
}

pub(super) fn scan(host: &Host, query: &Query, request: &SearchRequest, cancel: &AtomicBool) -> Result<SearchReply, String> {
    let store = host.store();
    let wants = |kind: SearchKind| request.kinds.is_empty() || request.kinds.contains(&kind);
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let projects = Projects { entries: store.projects_on_record()? };
    // The scope is one of this machine's registered projects, or nothing.
    // What the client sent is only ever compared, never opened.
    let scope: Option<String> = match &request.project {
        None => None,
        Some(asked) => Some(
            projects.entries.iter().find(|p| !p.removed && (&p.path == asked || p.aliases.contains(asked))).map(|p| p.path.clone())
                .ok_or("That project isn't registered on this machine.")?,
        ),
    };
    let in_scope = |folder: Option<&str>| scope.as_ref().is_none_or(|scope| projects.of(folder).as_ref() == Some(scope));

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut totals: BTreeMap<SearchKind, Total> = BTreeMap::new();
    let mut skipped: Vec<Skipped> = Vec::new();
    let settle = |kind: SearchKind, mut found: Vec<Named>, exact: bool, hits: &mut Vec<SearchHit>, totals: &mut BTreeMap<SearchKind, Total>| {
        totals.insert(kind, Total { count: found.len(), exact });
        found.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| b.hit.at.cmp(&a.hit.at)).then_with(|| a.hit.title.cmp(&b.hit.title)));
        hits.extend(found.into_iter().take(limit).map(|named| named.hit));
    };
    let named = |kind: SearchKind, name: &str, also: &str, at: Option<u64>, project: Option<String>, target: SearchTarget| -> Option<Named> {
        // A name hit shows the name; a hit on the other field (a folder path,
        // a file name) shows that instead, so the match is always visible.
        if let Some(rank) = query.name_rank(name) {
            let ranges = query.matches(name)?;
            let mut hit = text_hit(kind, name.to_owned(), name, &ranges, at, project, target);
            hit.title = name.to_owned();
            return Some(Named { rank, hit });
        }
        let ranges = query.matches(also)?;
        Some(Named { rank: 3, hit: text_hit(kind, name.to_owned(), also, &ranges, at, project, target) })
    };

    // Project and agent names. Neither belongs to one project, so a scoped
    // search leaves them out.
    if scope.is_none() && wants(SearchKind::Project) {
        let found = projects.entries.iter().filter(|p| !p.removed)
            .filter_map(|p| named(SearchKind::Project, &p.name, &p.path, None, Some(p.path.clone()), SearchTarget::Project { path: p.path.clone() }))
            .collect();
        settle(SearchKind::Project, found, true, &mut hits, &mut totals);
    }
    let session = store.session()?.unwrap_or_default();
    if scope.is_none() && wants(SearchKind::Agent) {
        let found = session["profiles"].as_array().into_iter().flatten()
            .filter_map(|profile| {
                let id = profile["id"].as_str()?;
                let name = profile["display_name"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or(id);
                named(SearchKind::Agent, name, id, None, None, SearchTarget::Agent { id: id.to_owned() })
            })
            .collect();
        settle(SearchKind::Agent, found, true, &mut hits, &mut totals);
    }

    // Threads and their messages.
    if wants(SearchKind::Thread) || wants(SearchKind::Message) {
        let hooks = host.search().hooks();
        let reader = store.room_reader()?;
        let deleted: HashSet<String> = store.deleted_threads()?.into_iter().collect();
        let pane_titles: HashMap<&str, &str> = session["panes"].as_array().into_iter().flatten()
            .filter_map(|pane| Some((pane["id"].as_str()?, pane["title"].as_str()?))).collect();
        let ids = reader.ids()?;
        let mut listed = HashSet::with_capacity(ids.len());
        let mut rooms: Vec<Room> = Vec::new();
        let mut whole = true;
        // Messages are matched thread by thread as each is loaded, and only
        // the newest `limit` are kept, so a search never holds every thread's
        // text at once.
        let scan = host.search().cache.begin_scan();
        let mut said: Vec<Said> = Vec::new();
        let mut count = 0;
        let newest_first = |said: &mut Vec<Said>, rooms: &[Room]| {
            // Undated messages last, later in the thread first.
            said.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| rooms[a.room].id.cmp(&rooms[b.room].id)).then_with(|| b.line.cmp(&a.line)));
            said.truncate(limit);
        };
        for id in ids {
            if cancel.load(Ordering::SeqCst) {
                return Ok(SearchReply::default());
            }
            let path = reader.file(&id);
            listed.insert(path.clone());
            // Permanently deleted threads are never returned.
            if deleted.contains(&id) {
                continue;
            }
            let meta = reader.meta(&id);
            let trashed = meta.is_some_and(|meta| meta.trashed_at.is_some());
            let archived = meta.is_some_and(|meta| meta.archived);
            if (trashed && !request.include_trashed) || (archived && !trashed && !request.include_archived) {
                continue;
            }
            // A protected store with no manifest entry: a legacy room nobody
            // reauthorized. The thread list leaves it out, and so does search.
            let Ok(place) = reader.place(&id) else { continue };
            if let Some(hook) = &hooks.before_room {
                hook(&id);
            }
            let text = match host.search().cache.load(&path, scan, &|path: &Path| if let Some(hook) = &hooks.before_read { hook(path) }) {
                Loaded::Text(text) => text,
                Loaded::Missing => continue,
                Loaded::BeingWritten => {
                    whole = false;
                    skipped.push(Skipped { source: id, reason: SkipReason::BeingWritten });
                    continue;
                }
                Loaded::Unreadable => {
                    whole = false;
                    skipped.push(Skipped { source: id, reason: SkipReason::Unreadable });
                    continue;
                }
            };
            let (chat, folder, names) = match place {
                Some(place) => (place.chat, place.project_cwd.or(place.cwd), place.names),
                None => (text.chat, text.project_cwd.clone().or_else(|| text.cwd.clone()), text.names.clone()),
            };
            if !in_scope(folder.as_deref()) {
                continue;
            }
            let title = meta.map(|meta| meta.title.trim()).filter(|title| !title.is_empty())
                .or_else(|| pane_titles.get(id.as_str()).map(|title| title.trim()).filter(|title| !title.is_empty()))
                .unwrap_or_default().to_owned();
            let latest = text.lines.iter().filter_map(|line| line.at).max();
            rooms.push(Room { id, title, kind: if chat { "chat" } else { "work" }, project: projects.of(folder.as_deref()), archived, trashed, names, latest });
            if wants(SearchKind::Message) {
                let room = rooms.len() - 1;
                for (at_line, line) in text.lines.iter().enumerate() {
                    if query.matches_lowered(&line.lowered) {
                        count += 1;
                        said.push(Said { at: line.at, room, line: at_line, seq: line.seq, origin_seq: line.origin_seq, client_message_id: line.client_message_id.clone(), by: line.by.clone(), text: line.text.clone() });
                    }
                }
                if said.len() > limit * 2 + 64 {
                    newest_first(&mut said, &rooms);
                }
            }
        }
        host.search().cache.keep_only(&listed);

        if wants(SearchKind::Thread) {
            let found = rooms.iter().filter(|room| !room.title.is_empty())
                .filter_map(|room| {
                    let mut found = named(SearchKind::Thread, &room.title, "", room.latest, room.project.clone(), SearchTarget::Room { room: room.id.clone(), room_kind: room.kind.into() })?;
                    found.hit.room_title = Some(room.title.clone());
                    found.hit.archived = room.archived;
                    found.hit.trashed = room.trashed;
                    Some(found)
                })
                .collect();
            settle(SearchKind::Thread, found, whole, &mut hits, &mut totals);
        }

        if wants(SearchKind::Message) {
            // Every match was counted; only the newest `limit` get a snippet.
            newest_first(&mut said, &rooms);
            let mut shown = 0;
            for line in said {
                let room = &rooms[line.room];
                let Some(ranges) = query.matches(&line.text) else { continue };
                let speaker = match &line.by {
                    None => "You".to_owned(),
                    Some(id) => room.names.get(id).filter(|name| !name.trim().is_empty()).cloned().unwrap_or_else(|| id.clone()),
                };
                let mut hit = text_hit(SearchKind::Message, room.title.clone(), &line.text, &ranges, line.at, room.project.clone(), SearchTarget::Message {
                    room: room.id.clone(), room_kind: room.kind.into(), seq: line.seq, origin_seq: line.origin_seq,
                    client_message_id: line.client_message_id, speaker,
                });
                hit.room_title = Some(room.title.clone());
                hit.archived = room.archived;
                hit.trashed = room.trashed;
                hits.push(hit);
                shown += 1;
            }
            // Conversations with the assistant: what was asked and what it
            // answered. They carry no time, so they follow the dated messages.
            let mut assistant: Vec<SearchHit> = Vec::new();
            host.assistant_conversations.for_each_record(|record| {
                let owner = &record.request.owner;
                if !in_scope(Some(owner.cwd.as_str())) {
                    return;
                }
                let said = [(Some(record.request.text.as_str()), "You", 0usize), (record.response.as_deref(), "Assistant", 1usize)];
                for (text, speaker, seq) in said {
                    let Some(text) = text else { continue };
                    let Some(ranges) = query.matches(text) else { continue };
                    count += 1;
                    if shown + assistant.len() >= limit {
                        continue;
                    }
                    let mut hit = text_hit(SearchKind::Message, "Assistant".into(), text, &ranges, None, projects.of(Some(owner.cwd.as_str())), SearchTarget::Message {
                        room: owner.conversation_id.clone(), room_kind: "assistant".into(), seq, origin_seq: None,
                        client_message_id: Some(record.request.request_id.clone()), speaker: speaker.into(),
                    });
                    hit.room_title = Some("Assistant".into());
                    assistant.push(hit);
                }
            });
            hits.extend(assistant);
            totals.insert(SearchKind::Message, Total { count, exact: whole });
        }
    }

    if wants(SearchKind::Task) {
        let tasks = host.assistant_tasks.list(None).map_err(|e| e.to_string())?;
        let found = tasks.iter().filter(|task| in_scope(Some(task.owner.cwd.as_str())))
            .filter_map(|task| {
                let title = headline(if task.brief.trim().is_empty() { &task.original_request } else { &task.brief });
                let fields = [Some(task.brief.as_str()), Some(task.original_request.as_str()), task.result.as_deref()];
                let (text, ranges) = fields.into_iter().flatten().find_map(|text| Some((text, query.matches(text)?)))?;
                Some(Named { rank: 0, hit: text_hit(SearchKind::Task, title, text, &ranges, Some(task.updated_at_ms), projects.of(Some(task.owner.cwd.as_str())), SearchTarget::Task { id: task.id.clone() }) })
            })
            .collect();
        settle(SearchKind::Task, found, true, &mut hits, &mut totals);
    }

    if wants(SearchKind::Note) {
        let notes = host.project_memory.all_current().map_err(|e| e.to_string())?;
        let found = notes.iter().filter(|note| in_scope(Some(note.project.cwd.as_str())))
            .filter_map(|note| {
                let ranges = query.matches(&note.text)?;
                let project = projects.of(Some(note.project.cwd.as_str()));
                Some(Named { rank: 0, hit: text_hit(SearchKind::Note, headline(&note.text), &note.text, &ranges, Some(note.updated_at), project.clone(), SearchTarget::Note { id: note.id.clone(), project }) })
            })
            .collect();
        settle(SearchKind::Note, found, true, &mut hits, &mut totals);
    }

    // The Library belongs to the machine, not to a project.
    if scope.is_none() && wants(SearchKind::Library) {
        let found = crate::reply_images::list(&host.data_dir().join("library")).iter()
            .filter_map(|item| {
                let name = item.name.as_deref().filter(|name| !name.trim().is_empty()).unwrap_or(&item.file);
                let mut found = named(SearchKind::Library, name, &item.file, Some(item.created), None, SearchTarget::Library { file: item.file.clone() })?;
                found.rank = 0;
                Some(found)
            })
            .collect();
        settle(SearchKind::Library, found, true, &mut hits, &mut totals);
    }

    if cancel.load(Ordering::SeqCst) {
        return Ok(SearchReply::default());
    }
    Ok(SearchReply { hits, totals, skipped, took_ms: 0 })
}
