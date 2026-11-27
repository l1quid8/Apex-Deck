use super::*;

impl Host {
    pub(super) fn admin_project(
        &self,
        owner: &str,
        call: &AdminToolCall,
    ) -> Result<Outcome, String> {
        let mut args = call.args.clone();
        if call.tool.starts_with("app.project.memory_") {
            let host_id = self.local_host_id()?;
            // Notebook authority is always the active assistant, never a model-supplied identity.
            args["assistant"] = json!({"assistantId":owner,"hostId":host_id});
            let path = string(&args["project"], "cwd")?;
            let (data, summary) = match call.tool.as_str() {
                "app.project.memory_list" => (
                    json!(self.project_memory_list(
                        serde_json::from_value(args).map_err(|e| e.to_string())?
                    )?),
                    "Read project memory",
                ),
                "app.project.memory_save" => (
                    json!(self.project_memory_save(
                        serde_json::from_value(args).map_err(|e| e.to_string())?
                    )?),
                    "Saved project memory",
                ),
                "app.project.memory_forget" => {
                    self.project_memory_forget(
                        serde_json::from_value(args).map_err(|e| e.to_string())?,
                    )?;
                    (Value::Null, "Forgot project memory")
                }
                _ => return Err("Unknown memory operation".into()),
            };
            return Ok((data, summary.into(), Some(UiTarget::Project { path }), None));
        }
        let path = string(&args, "path")?;
        let path = std::fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(path);
        let action = call
            .tool
            .strip_prefix("app.project.")
            .ok_or("Unknown project operation")?;
        let name = if action == "rename" {
            Some(string(&args, "name")?)
        } else {
            args["name"].as_str().map(str::to_owned)
        };
        let (current, previous) = self.store().change_project_checked(path.clone(), name, action, true, None)?;
        self.emit(HostEvent::ThreadCatalogChanged {});
        let undo = UndoPatch::RestoreProject {
            path: current.path.clone(), expected_revision: current.revision,
            name: previous.as_ref().map(|p| p.name.clone()),
            removed: previous.as_ref().is_none_or(|p| p.removed),
        };
        Ok((
            json!(current),
            format!("Project {action} completed"),
            Some(UiTarget::Project { path }),
            Some(undo),
        ))
    }
}
