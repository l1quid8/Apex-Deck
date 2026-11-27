use super::*;
use crate::personal::FactKind;
use crate::personal_workspace::ProjectRef;
use apex_core::{ParticipantConfig, RoomKind, RoomOptions};

macro_rules! arguments {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(JsonSchema, Deserialize)]
        #[serde(rename_all="camelCase", deny_unknown_fields)]
        #[allow(dead_code)]
        struct $name { $( $field: $ty ),* }
    };
}
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)]
enum Agent {
    Handle(String),
    Profile(ParticipantConfig),
}
arguments!(Empty {});
arguments!(Id { id: String });
arguments!(Profile {
    profile: ParticipantConfig
});
arguments!(Create{id:Option<String>,title:Option<String>,cwd:Option<String>,kind:Option<RoomKind>,agents:Option<Vec<Agent>>,options:Option<RoomOptions>,initial_message:Option<String>,open_in_ui:Option<bool>});
arguments!(Options {
    id: String,
    options: RoomOptions
});
arguments!(Title {
    id: String,
    title: String
});
arguments!(Pin {
    id: String,
    pinned: bool
});
arguments!(Archive{id:String,archived:Option<bool>});
arguments!(Send {
    id: String,
    text: String,
    targets: Option<Vec<apex_core::ParticipantId>>
});
arguments!(AddAgent {
    id: String,
    agent: Agent
});
arguments!(RemoveAgent {
    id: String,
    agent_id: String
});
arguments!(Path { path: String });
arguments!(ProjectAdd{path:String,name:Option<String>});
arguments!(ProjectRename {
    path: String,
    name: String
});
arguments!(MemoryList {
    project: ProjectRef
});
arguments!(MemorySave{project:ProjectRef,id:Option<String>,expected_version:Option<u64>,text:String,kind:FactKind,expires_at:Option<u64>});
arguments!(MemoryForget {
    project: ProjectRef,
    id: String,
    expected_version: u64
});
arguments!(Assistant{assistant_id:Option<String>});
arguments!(Pause{assistant_id:Option<String>,paused:bool});
arguments!(Cancel{assistant_id:Option<String>,schedule_id:String});
arguments!(Patch{patch:serde_json::Map<String,Value>});
arguments!(CodeMode { enabled: bool });
arguments!(Suggestions {
    mode: crate::reply_suggestions::Mode
});
arguments!(Hub{hub:Option<String>});

macro_rules! catalog {
    ($($name:literal: $risk:ident($args:ty)),* $(,)?)=>{
        pub fn tool_risk(name:&str)->Option<AdminToolRisk>{
            match name { $( $name=>Some(AdminToolRisk::$risk), )* _=>None }
        }
        pub fn admin_tool_schemas()->Vec<Value>{
            vec![$(json!({"name":$name,"risk":AdminToolRisk::$risk,"parameters":schemars::schema_for!($args)})),*]
        }
        pub(crate) fn validate_call(call:&AdminToolCall)->Result<(),String>{
            match call.tool.as_str(){
                $( $name=>serde_json::from_value::<$args>(call.args.clone()).map(|_|()).map_err(|e|e.to_string()), )*
                _=>Err("Unknown admin tool".into()),
            }
        }
    }
}
catalog! {
    "app.agent.list":Read(Empty), "app.agent.create":Write(Profile), "app.agent.update":Write(Profile), "app.agent.delete":Destructive(Id),
    "app.thread.list":Read(Empty), "app.thread.read":Read(Id), "app.thread.create":Write(Create), "app.thread.configure":Write(Options),
    "app.thread.rename":Write(Title), "app.thread.pin":Write(Pin), "app.thread.archive":Write(Archive), "app.thread.restore":Write(Id),
    "app.thread.send":Write(Send), "app.thread.stop":Write(Id), "app.thread.add_agent":Write(AddAgent), "app.thread.remove_agent":Write(RemoveAgent),
    "app.thread.trash":Destructive(Id), "app.thread.delete":Destructive(Id),
    "app.project.list":Read(Empty), "app.project.add":Write(ProjectAdd), "app.project.rename":Write(ProjectRename), "app.project.remove":Destructive(Path),
    "app.project.memory_list":Read(MemoryList), "app.project.memory_save":Write(MemorySave), "app.project.memory_forget":Destructive(MemoryForget),
    "app.assistant.list":Read(Empty), "app.assistant.schedule_list":Read(Assistant), "app.assistant.pause":Write(Pause), "app.assistant.schedule_cancel":Write(Cancel),
    "app.settings.get":Read(Empty), "app.settings.update":Write(Patch), "app.settings.code_mode":Write(CodeMode), "app.settings.reply_suggestions":Write(Suggestions),
    "app.ui.focus_thread":Write(Id), "app.ui.open_project":Write(Path), "app.ui.open_settings":Write(Hub)
}
