//! Interactive profile creation uses the existing editor, including multiline
//! instructions. No full session document is sent back from a client.
use serde_json::{json,Value};
#[derive(Debug,Clone)]
pub struct Wizard { pub fields:Vec<String>, pub stage:usize, pub provider:String, pub revision:u64, pub replace:bool, pub handle:Option<String>, pub profile_id:Option<String> }
impl Wizard {
    pub fn new(provider:String,revision:u64)->Self {Self{fields:vec![],stage:0,provider,revision,replace:false,handle:None,profile_id:None}}
    pub fn prompt(&self)->String {
        if self.stage==5 {return format!("Save {} · @{} · {} · model {} · access {}? Instructions: {} · type save or /cancel",self.fields[0],self.fields[1],self.provider,self.fields[2],self.fields[4],self.fields[3]);}
        format!("{} · /cancel cancels",match self.stage {
            0=>"Agent name (for example Jigga or Null)",
            1=>"Unique handle (for example jigga or null, without @)",
            2=>"Model: type default for the provider default, or a model ID",
            3=>"Instructions: Ctrl-J adds lines; Enter continues; type none for no extra instructions",
            4=>"Default Work access: ask or read (Talk always stays read-only)",
            _=>"Save this agent? Type save to confirm",
        })
    }
    pub fn advance(&mut self,text:&str)->Result<Option<Value>,String>{
        let trimmed=text.trim();
        if trimmed.is_empty(){return Err("A value is required; /cancel cancels".into());}
        if self.stage==5 {
            if trimmed!="save" {return Err("Type save to confirm, or /cancel".into());}
            let input=json!({"name":self.fields[0],"handle":self.fields[1],"provider":self.provider,"model":if self.fields[2]=="default"{Value::Null}else{json!(self.fields[2])},"instructions":if self.fields[3]=="none"{""}else{&self.fields[3]},"access":self.fields[4],"expectedRevision":self.revision,"replace":self.replace,"profileId":self.profile_id});
            let parsed:apex_host::agent_profiles::SaveProfile=serde_json::from_value(input.clone()).map_err(|e|e.to_string())?;
            parsed.profile()?;
            return Ok(Some(input));
        }
        match self.stage {
            0 if trimmed.len()>128||trimmed.chars().any(char::is_control)=>return Err("Use a printable name up to 128 characters".into()),
            1 if trimmed.len()>64 || !trimmed.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'_') || matches!(trimmed.to_lowercase().as_str(),"all"|"user"|"system")=>return Err("Use letters, digits, - or _; all/user/system are reserved".into()),
            4 if !matches!(trimmed,"ask"|"read")=>return Err("Choose ask or read".into()),
            _=>{},
        }
        if self.stage==0 {
            if let Some(handle)=&self.handle {
                let trial=apex_host::agent_profiles::SaveProfile{handle:handle.clone(),name:trimmed.into(),provider:self.provider.clone(),model:None,instructions:String::new(),access:"ask".into(),expected_revision:self.revision,replace:true,profile_id:self.profile_id.clone()};
                trial.profile()?;
            }
        }
        if self.stage==1 {
            let trial=apex_host::agent_profiles::SaveProfile{handle:trimmed.into(),name:self.fields[0].clone(),provider:self.provider.clone(),model:None,instructions:String::new(),access:"ask".into(),expected_revision:self.revision,replace:false,profile_id:None};
            trial.profile()?;
        }
        if self.stage==2 && trimmed!="default" && (trimmed.starts_with('-')||trimmed.len()>200||trimmed.chars().any(char::is_control)){return Err("Enter default or a valid provider model ID".into());}
        self.fields.push(if self.stage==3{text.to_string()}else{trimmed.to_string()});self.stage+=1;
        if self.stage==1 {if let Some(handle)=&self.handle {self.fields.push(handle.clone());self.stage+=1;}}
        Ok(None)
    }
}

pub fn import_preview(path:&std::path::Path)->Result<Vec<Value>,String>{
    if !path.is_absolute(){return Err("Import requires an absolute session.json or profile-export path".into());}
    use std::io::Read;
    const LIMIT:u64=2*1024*1024;
    if !std::fs::metadata(path).map_err(|e|format!("Cannot inspect profile source: {e}"))?.is_file(){return Err("Profile source must be a regular file".into());}
    let mut options=std::fs::OpenOptions::new();options.read(true);
    // A source changed to a FIFO between metadata/open must never block the UI.
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.custom_flags(libc::O_NONBLOCK);}
    let file=options.open(path).map_err(|e|format!("Cannot read profile source: {e}"))?;
    let metadata=file.metadata().map_err(|e|e.to_string())?;
    if !metadata.is_file(){return Err("Profile source must be a regular file".into());}
    if metadata.len()>LIMIT{return Err("Profile source exceeds 2 MiB".into());}
    let mut bytes=Vec::new();file.take(LIMIT+1).read_to_end(&mut bytes).map_err(|e|format!("Cannot read profile source: {e}"))?;
    if bytes.len() as u64>LIMIT{return Err("Profile source exceeds 2 MiB".into());}
    let value:Value=serde_json::from_slice(&bytes).map_err(|e|format!("Invalid profile source: {e}"))?;
    let profiles=value["profiles"].as_array().ok_or("Source must contain a profiles array")?;
    let mut result=Vec::new();
    for p in profiles {
        let parsed:apex_core::ParticipantConfig=match serde_json::from_value(p.clone()){Ok(p)=>p,Err(_)=>continue};
        let provider=match parsed.backend{apex_core::Backend::Agent{tool:apex_core::AgentTool::Codex,..}=>"codex",apex_core::Backend::Agent{tool:apex_core::AgentTool::ClaudeCode,..}=>"claude",_=>continue};
        let input=json!({"handle":apex_core::mention_for(&parsed),"name":parsed.display_name,"provider":provider,"model":p["backend"]["model"],"instructions":parsed.persona,"access":"ask","expectedRevision":0,"replace":false});
        let safe:apex_host::agent_profiles::SaveProfile=serde_json::from_value(input.clone()).map_err(|e|e.to_string())?;
        safe.profile()?;result.push(input);
    }
    Ok(result)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn editing_a_desktop_agent_sends_its_original_profile_identity(){
        let mut w=Wizard::new("codex".into(),7);
        w.replace=true;w.handle=Some("null".into());w.profile_id=Some("desktop-profile-uuid".into());
        for field in ["Null","default","Updated instructions","ask"] {w.advance(field).unwrap();}
        let input=w.advance("save").unwrap().unwrap();
        assert_eq!(input["handle"],"null");assert_eq!(input["profileId"],"desktop-profile-uuid");
    }
    #[test] fn creates_jigga_with_multiline_instructions_and_explicit_confirmation(){
        let mut w=Wizard::new("claude".into(),7);
        for field in ["Jigga","jigga","default","Design\nReview","ask"]{assert!(w.advance(field).unwrap().is_none());}
        assert!(w.advance("yes").is_err());
        let value=w.advance("save").unwrap().unwrap();
        assert_eq!(value["instructions"],"Design\nReview");assert!(value["model"].is_null());assert_eq!(value["expectedRevision"],7);
    }
    #[test] fn wizard_rejects_broadcast_handle_and_full_access(){
        let mut w=Wizard::new("codex".into(),0);w.advance("Null").unwrap();assert!(w.advance("all").is_err());
        for field in ["null","default","none"]{w.advance(field).unwrap();}assert!(w.advance("full").is_err());
    }
    #[test] fn imports_only_supported_profiles_and_drops_grants_and_overrides(){
        let path=std::path::PathBuf::from(format!("/tmp/apex-import-{}.json",uuid::Uuid::new_v4()));
        std::fs::write(&path,json!({"profiles":[{"id":"original-null","display_name":"Null","backend":{"kind":"agent","tool":"codex","model":null},"persona":"Keep actual instructions","access":"full","program":"evil","secret":"excluded"},{"id":"shell","display_name":"Shell","backend":{"kind":"cli","program":"evil"}}]}).to_string()).unwrap();
        let preview=import_preview(&path).unwrap();assert_eq!(preview.len(),1);assert_eq!(preview[0]["instructions"],"Keep actual instructions");assert_eq!(preview[0]["access"],"ask");assert!(preview[0].get("program").is_none());assert!(preview[0].get("secret").is_none());
        std::fs::remove_file(path).unwrap();
    }
    #[cfg(unix)]
    #[test] fn import_rejects_special_files_before_reading() {
        assert!(import_preview(std::path::Path::new("/dev/null")).unwrap_err().contains("regular file"));
    }
    #[test] fn edited_name_must_keep_existing_handle_before_advancing() {
        let mut wizard=Wizard::new("codex".into(),0);wizard.handle=Some("null".into());wizard.replace=true;
        assert!(wizard.advance("Jigga").is_err());assert_eq!(wizard.stage,0);
        assert!(wizard.advance("Null").is_ok());assert_eq!(wizard.stage,2);
    }

}
