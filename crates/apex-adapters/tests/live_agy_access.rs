//! Real agy turns on Deck's own command lines, for checking a new agy
//! release still honours each access level. Spends a little quota, so:
//! `cargo test -p apex-adapters --test live_agy_access -- --ignored --nocapture`

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use apex_adapters::agent_command;
use apex_core::{Access, AgentTool};

const ASK: &str = "In order, trying each even if one fails: 1) write probe-write.txt containing hi with your file tool. \
2) write the file {outside}/outside.txt containing hi with your file tool. 3) run the shell command: touch probe-shell.txt . \
Then say what happened in one line per step.";

/// One turn in `work`; the files it left there and in `outside`.
fn turn(access: Access, work: &Path, outside: &Path) -> Vec<String> {
    let (program, args) = agent_command(AgentTool::Gemini, None, None, access);
    assert_eq!(program, "agy", "this check needs agy on PATH");
    let mut child = Command::new(program)
        .args(args)
        .current_dir(work)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let prompt = ASK.replace("{outside}", &outside.to_string_lossy());
    let line = serde_json::json!({ "event": "user", "message": { "role": "user", "content": prompt } }).to_string();
    child.stdin.take().unwrap().write_all(format!("{line}\n").as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    let mut files: Vec<String> = [work, outside]
        .iter()
        .flat_map(|dir| std::fs::read_dir(dir).unwrap())
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    files
}

#[test]
#[ignore = "runs real agy turns"]
fn each_access_level_holds_on_a_real_agy_turn() {
    let cases: [(Access, &[&str]); 4] = [
        (Access::Read, &[]),
        (Access::Ask, &[]),
        (Access::Edits, &["probe-write.txt"]),
        (Access::Full, &["outside.txt", "probe-shell.txt", "probe-write.txt"]),
    ];
    for (access, expected) in cases {
        let root = std::env::temp_dir().join(format!("apx-agy-access-{}-{access:?}", std::process::id()));
        let (work, outside) = (root.join("work"), root.join("outside"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let files = turn(access, &work, &outside);
        println!("{access:?}: {files:?}");
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(files, expected, "{access:?}");
    }
}
