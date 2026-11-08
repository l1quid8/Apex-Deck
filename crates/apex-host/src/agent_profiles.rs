//! Narrow saved-profile mutations. Executable overrides and grants never enter
//! this interface; callers choose one of the supported provider runtimes.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::Host;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct SaveProfile {
    pub handle: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub name: String,
    pub provider: String,
    pub model: Option<String>,
    pub instructions: String,
    pub access: String,
    pub expected_revision: u64,
    #[serde(default)]
    pub replace: bool,
}

impl SaveProfile {
    pub fn profile(&self) -> Result<Value,String> {
        let handle=self.handle.trim().trim_start_matches('@').to_lowercase();
        if handle.is_empty() || handle.len()>64 || !handle.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-'||c==b'_') || matches!(handle.as_str(),"all"|"user"|"system") {
            return Err("Handle must contain 1–64 letters, digits, - or _; all/user/system are reserved".into());
        }
        if self.name.trim().is_empty() || self.name.len()>128 || self.name.chars().any(char::is_control) { return Err("Name must contain 1–128 printable characters".into()); }
        if self.instructions.len()>64*1024 { return Err("Agent instructions exceed 64 KiB".into()); }
        let tool=match self.provider.as_str(){"codex"=>"codex","claude"=>"claude_code",_=>return Err("Choose Codex or Claude".into())};
        if !matches!(self.access.as_str(),"ask"|"read") { return Err("New agent access must be ask or read".into()); }
        if self.model.as_ref().is_some_and(|m|m.trim().is_empty() || m.len()>200 || m.starts_with('-') || m.chars().any(char::is_control)) { return Err("Invalid model".into()); }
        if self.profile_id.is_some() && !self.replace { return Err("profileId is allowed only when editing an existing agent".into()); }
        let id=match self.profile_id.as_deref() {
            Some(id) if id.trim().is_empty() || id.len()>256 || id.chars().any(char::is_control) => return Err("Invalid saved profile identity".into()),
            Some(id)=>id,
            None=>handle.as_str(),
        };
        let value=json!({"id":id,"display_name":self.name.trim(),"backend":{"kind":"agent","tool":tool,"model":self.model},"persona":self.instructions,"access":self.access});
        let parsed=serde_json::from_value::<apex_core::ParticipantConfig>(value.clone()).map_err(|e|e.to_string())?;
        let mention=apex_core::mention_for(&parsed);
        if mention!=handle { return Err(format!("Deck derives mentions from the agent name; this name uses @{mention}. Use that handle or change the name.")); }
        Ok(value)
    }
}
impl Host {
    pub fn agent_profile_list(&self)->Result<Value,String>{
        let session=self.session_load()?.unwrap_or(json!({}));
        Ok(json!({"revision":session["profileRevision"].as_u64().unwrap_or(0),"profiles":session["profiles"].as_array().cloned().unwrap_or_default()}))
    }
    pub fn agent_profile_save(&self,input:SaveProfile)->Result<Value,String>{
        let profile=input.profile()?;
        let session=self.store().update_agent_profile(profile.clone(),input.expected_revision,input.replace)?;
        let saved=session["profiles"].as_array().and_then(|profiles|profiles.iter().find(|saved|saved["id"].as_str().zip(profile["id"].as_str()).is_some_and(|(a,b)|a.eq_ignore_ascii_case(b)))).cloned().ok_or("Saved agent was not found after updating")?;
        self.emit(crate::events::HostEvent::SessionChanged(session.clone()));
        Ok(json!({"revision":session["profileRevision"],"profile":saved}))
    }
}

#[cfg(test)] mod tests {
    use super::*;
    fn input(handle:&str)->SaveProfile {SaveProfile{profile_id:None,handle:handle.into(),name:handle.into(),provider:"codex".into(),model:None,instructions:"line one\nline two".into(),access:"ask".into(),expected_revision:0,replace:false}}
    #[test] fn persists_named_agents_preserves_session_and_checks_revision(){
        let path=std::env::temp_dir().join(format!("apex-profiles-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let store=crate::storage::Store::new(path.clone());
        store.save_session(&json!({"version":1,"panes":[{"id":"keep"}],"future":{"keep":true}})).unwrap();
        store.update_agent_profile(input("Jigga").profile().unwrap(),0,false).unwrap();
        assert!(store.update_agent_profile(input("jigga").profile().unwrap(),1,false).is_err());
        assert!(store.update_agent_profile(input("Null").profile().unwrap(),0,false).is_err());
        store.update_agent_profile(input("Null").profile().unwrap(),1,false).unwrap();
        let reopened=crate::storage::Store::new(path.clone()).session().unwrap().unwrap();
        assert_eq!(reopened["profiles"][0]["id"],"jigga"); assert_eq!(reopened["profiles"][1]["id"],"null");
        assert_eq!(reopened["profiles"][1]["persona"],"line one\nline two");
        assert_eq!(reopened["future"]["keep"],true); assert_eq!(reopened["panes"][0]["id"],"keep");
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn stale_desktop_saves_keep_cli_profiles_and_revision() {
        let path=std::env::temp_dir().join(format!("apex-profiles-stale-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let store=crate::storage::Store::new(path.clone());
        let initial=store.save_session_snapshot(&json!({"version":1,"profiles":[],"savedBy":"desktop:1"})).unwrap();
        let revision=initial["profileRevision"].as_u64().unwrap();
        store.update_agent_profile(input("null").profile().unwrap(),revision,false).unwrap();
        let accepted=store.save_session_snapshot(&json!({"version":1,"profiles":[],"profileRevision":revision,"panes":[{"id":"new-layout"}],"savedBy":"desktop:2"})).unwrap();
        assert_eq!(accepted["profiles"][0]["id"],"null");
        assert_eq!(accepted["profileRevision"],revision+1);
        assert_eq!(accepted["profileSavedBy"],"agent-profile");
        assert_eq!(accepted["panes"][0]["id"],"new-layout");
        let mut edit=accepted.clone();
        edit["profiles"][0]["persona"]=json!("desktop edit");
        let edited=store.save_session_snapshot(&edit).unwrap();
        assert_eq!(edited["profileRevision"],revision+2);
        assert!(store.update_agent_profile(input("muck").profile().unwrap(),revision+1,false).is_err());
        store.save_session(&json!({"version":1,"panes":[]})).unwrap();
        let reopened=store.session().unwrap().unwrap();
        assert_eq!(reopened["profiles"][0]["persona"],"desktop edit");
        assert_eq!(reopened["profileRevision"],revision+2);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn desktop_identity_and_metadata_survive_cli_edits_and_mentions_stay_unique() {
        let path=std::env::temp_dir().join(format!("apex-profile-desktop-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let store=crate::storage::Store::new(path.clone());
        let id="bot-5a11a6ed-603c-44df-8128-bc588d6ef174";
        let desktop=json!({"id":id,"display_name":"Null","persona":"desktop instructions","access":"full","backend":{"kind":"agent","tool":"codex","model":"old-model"},"appearance":{"seed":"desktop-seed","color":"#123456"},"avatar":{"image":"desktop-avatar"},"voice":"bf_emma","speed":"fast","effort":"high","future":{"keep":true}});
        let initial=store.save_session_snapshot(&json!({"version":1,"profiles":[desktop.clone()]})).unwrap();
        let revision=initial["profileRevision"].as_u64().unwrap();
        // A different generated ID does not make a duplicate @null acceptable.
        assert!(store.update_agent_profile(input("null").profile().unwrap(),revision,false).is_err());
        let mut edit=input("null"); edit.profile_id=Some(id.into());edit.replace=true;edit.model=Some("new-model".into());
        let updated=store.update_agent_profile(edit.profile().unwrap(),revision,true).unwrap();
        let saved=&updated["profiles"][0];
        assert_eq!(saved["id"],id);
        assert_eq!(saved["backend"]["model"],"new-model");
        assert_eq!(saved["persona"],"line one\nline two");
        for key in ["appearance","avatar","voice","speed","effort","future"] {assert_eq!(saved[key],desktop[key],"{key}");}
        assert_eq!(updated["profiles"].as_array().unwrap().len(),1);
        let mut create=input("muck");create.profile_id=Some("forged-id".into());assert!(create.profile().is_err());
        edit.profile_id=Some("missing-id".into());assert!(store.update_agent_profile(edit.profile().unwrap(),revision+1,true).is_err());
        store.update_agent_profile(input("muck").profile().unwrap(),revision+1,false).unwrap();
        edit.profile_id=Some(id.into());edit.handle="muck".into();edit.name="Muck".into();
        assert!(store.update_agent_profile(edit.profile().unwrap(),revision+2,true).is_err(),"renaming cannot steal another agent's mention");
        assert_eq!(store.session().unwrap().unwrap()["profileRevision"],revision+2);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn profile_save_response_returns_the_preserved_desktop_identity_and_metadata() {
        let path=std::env::temp_dir().join(format!("apex-profile-response-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let runtime=tokio::runtime::Runtime::new().unwrap();
        let host=Host::new(crate::HostPaths{data:path.clone(),downloads:None},runtime.handle().clone());
        let id="bot-02342126-dd5c-46a2-89ac-56e318ab96e4";
        host.session_save(json!({"version":1,"profiles":[{"id":id,"display_name":"Null","persona":"","backend":{"kind":"agent","tool":"codex"},"voice":"bf_emma","future":{"keep":true}}]})).unwrap();
        let mut edit=input("null");edit.profile_id=Some(id.into());edit.replace=true;edit.expected_revision=host.session_load().unwrap().unwrap()["profileRevision"].as_u64().unwrap();
        let response=host.agent_profile_save(edit).unwrap();
        assert_eq!(response["profile"]["id"],id);
        assert_eq!(response["profile"]["voice"],"bf_emma");
        assert_eq!(response["profile"]["future"]["keep"],true);
        drop(host);drop(runtime);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn rejects_unsafe_profile_fields(){
        for handle in ["all","bad name","../null",""] {assert!(input(handle).profile().is_err());}
        let mut p=input("null");p.access="full".into();assert!(p.profile().is_err());
        p.access="read".into();p.provider="shell".into();assert!(p.profile().is_err());
    }
}
