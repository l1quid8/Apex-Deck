//! The session and settings files, read by the host rather than passed
//! through as opaque JSON.
//!
//! Both are still written whole by the desktop UI, which also checks every
//! value (src/settings.ts, src/App.tsx). So reading them here never loses
//! anything: a field the host doesn't know, or whose value it can't read, is
//! kept in `other` exactly as it was and written back unchanged.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

/// Remove `key` from `fields` when its value reads as `T`; otherwise leave it.
fn take<T: DeserializeOwned>(fields: &mut Map<String, Value>, key: &str) -> Option<T> {
    let parsed = serde_json::from_value(fields.get(key)?.clone()).ok()?;
    fields.remove(key);
    Some(parsed)
}

fn put<T: Serialize>(fields: &mut Map<String, Value>, key: &str, value: &Option<T>) {
    if let Some(value) = value {
        if let Ok(value) = serde_json::to_value(value) {
            fields.insert(key.to_string(), value);
        }
    }
}

macro_rules! document {
    ($(#[$meta:meta])* $name:ident { $($(#[$field_meta:meta])* $field:ident: $ty:ty = $key:literal,)* }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Default)]
        pub struct $name {
            $($(#[$field_meta])* pub $field: Option<$ty>,)*
            /// Fields this version doesn't know or couldn't read, kept as they were.
            pub other: Map<String, Value>,
        }

        impl $name {
            /// Read a saved document. Only a value that isn't an object is an error.
            pub fn from_value(value: Value) -> Result<Self, String> {
                let Value::Object(mut other) = value else {
                    return Err(format!("{} must be a JSON object", stringify!($name).to_lowercase()));
                };
                Ok(Self { $($field: take(&mut other, $key),)* other })
            }

            /// The document as it is saved and sent to the UI.
            pub fn to_value(&self) -> Value {
                let mut fields = self.other.clone();
                $(put(&mut fields, $key, &self.$field);)*
                Value::Object(fields)
            }
        }
    };
}

document! {
    /// What is open and where: src/types.ts `AppSession`.
    Session {
        version: u64 = "version",
        workspaces: Vec<Value> = "workspaces",
        /// Threads, and terminals as descriptors.
        panes: Vec<Value> = "panes",
        /// Saved agent profiles.
        profiles: Vec<Value> = "profiles",
        /// Older versions kept this here; it now lives in the settings.
        disabled_providers: Vec<String> = "disabledProviders",
        active_workspace: String = "activeWorkspace",
        focused_pane: String = "focusedPane",
        section: String = "section",
        layout: String = "layout",
        layouts: Map<String, Value> = "layouts",
        thread_details_open: bool = "threadDetailsOpen",
        thread_details_collapsed: Map<String, Value> = "threadDetailsCollapsed",
    }
}

document! {
    /// App-wide preferences: src/settings.ts `AppSettings`.
    Settings {
        version: u64 = "version",
        disabled_providers: Vec<String> = "disabledProviders",
        new_thread: Map<String, Value> = "newThread",
        new_bot_access: String = "newBotAccess",
        terminal: Map<String, Value> = "terminal",
        preview: Map<String, Value> = "preview",
        confirm_steer: bool = "confirmSteer",
    }
}

/// Bring settings saved by an older version up to date. The list of turned
/// off providers used to live in the session file; it is used only when the
/// settings have none of their own.
pub fn migrate_settings(settings: Option<Settings>, session: Option<&Session>) -> Option<Settings> {
    let legacy = session.and_then(|s| s.disabled_providers.clone());
    match (settings, legacy) {
        (Some(mut settings), Some(legacy)) if settings.disabled_providers.is_none() => {
            settings.disabled_providers = Some(legacy);
            Some(settings)
        }
        (None, Some(legacy)) => Some(Settings { disabled_providers: Some(legacy), ..Settings::default() }),
        (settings, _) => settings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn saved_session() -> Value {
        json!({
            "version": 1,
            "workspaces": [{ "id": "ws1", "name": "apex-deck", "path": "/code/apex-deck" }],
            "panes": [{ "id": "p1", "workspaceId": "ws1", "kind": "chat", "title": "Plan" }],
            "profiles": [{ "id": "null", "backend": { "kind": "agent", "tool": "codex" } }],
            "activeWorkspace": "ws1",
            "focusedPane": null,
            "section": "threads",
            "layout": "top",
            "layouts": { "ws1:threads": { "kind": "pane", "id": "p1" } },
            "threadDetailsOpen": false,
            "threadDetailsCollapsed": { "usage": true },
            "addedByANewerVersion": [1, 2, 3]
        })
    }

    #[test]
    fn a_saved_session_reads_and_writes_back_unchanged() {
        let session = Session::from_value(saved_session()).unwrap();
        assert_eq!(session.active_workspace.as_deref(), Some("ws1"));
        assert_eq!(session.panes.as_ref().map(Vec::len), Some(1));
        assert_eq!(session.focused_pane, None, "null reads as unset");
        assert_eq!(session.to_value(), saved_session());
    }

    #[test]
    fn a_value_of_the_wrong_kind_is_kept_as_it_was() {
        let saved = json!({ "section": 7, "threadDetailsOpen": "yes", "panes": {} });
        let session = Session::from_value(saved.clone()).unwrap();
        assert_eq!((session.section.clone(), session.thread_details_open, session.panes.clone()), (None, None, None));
        assert_eq!(session.to_value(), saved);
    }

    #[test]
    fn only_an_object_is_a_document() {
        assert!(Session::from_value(json!([1])).is_err());
        assert!(Settings::from_value(json!("x")).is_err());
    }

    #[test]
    fn saved_settings_read_and_write_back_unchanged() {
        let saved = json!({
            "version": 1,
            "disabledProviders": ["venice"],
            "newThread": { "policy": "mentioned", "max_bot_hops": 2 },
            "newBotAccess": "read",
            "terminal": { "fontSize": 13, "scrollback": 5000 },
            "preview": { "openExternally": ["github.com"] },
            "confirmSteer": true
        });
        let settings = Settings::from_value(saved.clone()).unwrap();
        assert_eq!(settings.disabled_providers, Some(vec!["venice".to_string()]));
        assert_eq!(settings.confirm_steer, Some(true));
        assert_eq!(settings.to_value(), saved);
    }

    #[test]
    fn turned_off_providers_move_from_an_old_session_into_the_settings() {
        let old_session = Session::from_value(json!({ "disabledProviders": ["grok"] })).unwrap();
        let without = Settings::from_value(json!({ "confirmSteer": false })).unwrap();
        let migrated = migrate_settings(Some(without), Some(&old_session)).unwrap();
        assert_eq!(migrated.to_value(), json!({ "confirmSteer": false, "disabledProviders": ["grok"] }));

        let own = Settings::from_value(json!({ "disabledProviders": [] })).unwrap();
        assert_eq!(migrate_settings(Some(own.clone()), Some(&old_session)), Some(own), "the settings' own list wins, even empty");

        assert_eq!(migrate_settings(None, Some(&old_session)).unwrap().to_value(), json!({ "disabledProviders": ["grok"] }));
        assert_eq!(migrate_settings(None, None), None);
        assert_eq!(migrate_settings(None, Some(&Session::default())), None);
    }
}
