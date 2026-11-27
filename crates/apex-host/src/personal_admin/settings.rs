use super::*;
use serde_json::Map;

/// Record only changed keys so that an unrelated later edit survives Undo.
#[derive(JsonSchema, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SettingChange {
    path: Vec<String>,
    previous: Option<Value>,
    applied: Value,
}

fn merge(
    into: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    path: &mut Vec<String>,
    changes: &mut Vec<SettingChange>,
) {
    for (key, value) in patch {
        path.push(key.clone());
        if let (Some(existing), Some(child)) = (
            into.get_mut(key).and_then(Value::as_object_mut),
            value.as_object(),
        ) {
            merge(existing, child, path, changes);
        } else if into.get(key) != Some(value) {
            let previous = into.insert(key.clone(), value.clone());
            changes.push(SettingChange {
                path: path.clone(),
                previous,
                applied: value.clone(),
            });
        }
        path.pop();
    }
}

impl Host {
    pub(super) fn admin_settings(&self, patch: &Value) -> Result<Outcome, String> {
        let patch = patch
            .as_object()
            .ok_or("Settings patch must be an object")?;
        let changes = self.admin_edit_settings(|settings| {
            let mut changes = Vec::new();
            merge(
                settings.as_object_mut().ok_or("Invalid saved settings")?,
                patch,
                &mut Vec::new(),
                &mut changes,
            );
            Ok(changes)
        })?;
        Ok((
            json!({"changed":changes.len()}),
            "Updated settings".into(),
            Some(UiTarget::Settings { hub: None }),
            Some(UndoPatch::RestoreSettings { changes }),
        ))
    }

    pub(super) fn undo_settings(&self, changes: &[SettingChange]) -> Result<(), String> {
        self.admin_edit_settings(|settings| {
            for change in changes {
                let (key, parents) = change.path.split_last().ok_or("Invalid settings undo")?;
                let mut target = &mut *settings;
                for parent in parents {
                    target = target
                        .get_mut(parent)
                        .ok_or("Settings changed since this action")?;
                }
                let obj = target
                    .as_object_mut()
                    .ok_or("Settings changed since this action")?;
                if obj.get(key) != Some(&change.applied) {
                    return Err("Settings changed since this action".into());
                }
                match &change.previous {
                    Some(value) => {
                        obj.insert(key.clone(), value.clone());
                    }
                    None => {
                        obj.remove(key);
                    }
                }
            }
            Ok(())
        })
    }
}
