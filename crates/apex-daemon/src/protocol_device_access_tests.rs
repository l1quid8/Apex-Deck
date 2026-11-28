mod device_access_updates {
    use super::*;

    fn fixture(linux: bool, confined: Result<(), String>) -> (Arc<Daemon>, TempDir, Value, String) {
        let (mut daemon, data) = daemon();
        Arc::get_mut(&mut daemon).unwrap().linux_device_policy = Some(linux);
        assert!(daemon.confinement.set(confined).is_ok());
        if linux {
            std::fs::create_dir_all(&data.0).unwrap();
            std::fs::write(data.0.join(crate::trust_host::FILE), json!({
                "trusted":true,"epoch":"current-epoch","boot_id":"test-boot"
            }).to_string()).unwrap();
        }
        let folder = data.0.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let folder = std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned();
        let bot = json!({"id":"bot","display_name":"Bot","backend":{"kind":"scripted","lines":[]},"access":"read"});
        daemon.host.room_create("access".into(), vec![serde_json::from_value(bot.clone()).unwrap()], Default::default(), Some(folder.clone())).unwrap();
        (daemon, data, bot, folder)
    }

    fn update(bot: &Value, old: Option<&str>, folder: Option<&str>) -> Value {
        let mut participant = bot.clone();
        participant["access"] = json!("full");
        let mut args = json!({"id":"access","participant":participant,"base":bot});
        if let Some(old) = old { args["old_level"] = json!(old); }
        if let Some(folder) = folder { args["folder"] = json!(folder); }
        json!({"id":1,"cmd":"room_update_participant","args":args})
    }

    fn saved_access(daemon: &Daemon) -> Value {
        daemon.host.room_state("access".into()).unwrap()["snapshot"]["participants"][0]["access"].clone()
    }

    #[tokio::test]
    async fn linux_device_rejects_missing_stale_or_wrong_folder_bindings_before_saving() {
        for case in ["missing-old", "stale-old", "missing-folder", "wrong-folder"] {
            let (daemon, _data, bot, folder) = fixture(true, Ok(()));
            let phone = add(&daemon, 70);
            let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
            assert!(client.hello().await.get("ok").is_some());
            let old = if case == "missing-old" { None } else if case == "stale-old" { Some("edits") } else { Some("read") };
            let requested = if case == "missing-folder" { None } else if case == "wrong-folder" { Some("/some-other-folder") } else { Some(folder.as_str()) };
            client.send(update(&bot, old, requested)).await;
            let reply = client.until_reply(1).await.pop().unwrap();
            assert!(reply.get("err").is_some(), "{case}: {reply}");
            assert_eq!(saved_access(&daemon), json!("read"), "{case}: no saved mutation");
        }
    }

    #[tokio::test]
    async fn linux_device_raise_refuses_failed_confinement_without_saving() {
        let (daemon, _data, bot, folder) = fixture(true, Err("sandbox probe failed".into()));
        let phone = add(&daemon, 71);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        let reply = client.hello().await;
        assert!(reply["err"].as_str().is_some_and(|e| e.contains("sandbox probe failed")), "{reply}");
        assert_eq!(saved_access(&daemon), json!("read"));
        let _ = (bot, folder);
    }

    #[tokio::test]
    async fn linux_device_voice_is_refused_when_confinement_failed() {
        let (daemon, _data, _bot, _folder) = fixture(true, Err("sandbox probe failed".into()));
        let phone = add(&daemon, 74);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        let hello = client.hello().await;
        assert!(hello["err"].as_str().is_some_and(|e| e.contains("sandbox probe failed")), "a failed probe must refuse device admission before voice or events: {hello}");
        assert_eq!(saved_access(&daemon), json!("read"));
    }

    #[tokio::test]
    async fn paired_linux_phone_can_create_and_reopen_its_assistant() {
        let (mut daemon, data, _bot, folder) = fixture(true, Ok(()));
        let host_id = crate::identity::host_id(&data.0).unwrap();
        Arc::get_mut(&mut daemon).unwrap().host_id = host_id.clone();
        let phone = add(&daemon, 76);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        let hello = client.hello().await;
        assert!(hello.get("ok").is_some(), "{hello}");
        let profile = json!({"id":"alfred","display_name":"Alfred","access":"read",
            "backend":{"kind":"agent","tool":"codex","model":null}});
        client.send(json!({"id":1,"cmd":"personal_create","args":{
            "name":"Alfred","folder":folder,"profile":profile
        }})).await;
        let created = client.until_reply(1).await.pop().unwrap();
        assert_eq!(created["ok"]["name"], "Alfred", "{created}");
        let id = &created["ok"]["id"];
        let (mut reopened, _next_session) = connect_device(&daemon, &phone, 1 << 16);
        assert!(reopened.hello().await.get("ok").is_some());
        reopened.send(json!({"id":2,"cmd":"personal_get","args":{"assistantId":id}})).await;
        let saved = reopened.until_reply(2).await.pop().unwrap();
        assert_eq!(saved["ok"]["id"], *id, "{saved}");
        assert_eq!(saved["ok"]["hostId"], host_id);
    }

    #[tokio::test]
    async fn linux_device_can_lower_access() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        let phone = add(&daemon, 75);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        client.send(update(&bot, Some("read"), Some(&folder))).await;
        let full = client.until_reply(1).await.pop().unwrap()["ok"].clone();
        assert_eq!(full["access"], "full");
        let mut lower = full.clone();
        lower["access"] = json!("edits");
        client.send(json!({"id":2,"cmd":"room_update_participant","args":{"id":"access","participant":lower,"base":full,"old_level":"full"}})).await;
        let reply = client.until_reply(2).await.pop().unwrap();
        assert!(reply.get("ok").is_some(), "lowering is allowed for a paired device: {reply}");
        assert_eq!(saved_access(&daemon), json!("edits"));
    }

    #[tokio::test]
    async fn linux_token_cannot_authorize_access_changes() {
        // A same-user local peer is governed by the recorded jail probe; see
        // linux_local_update_cannot_bypass_raise_gate_with_a_forged_old_level.
        for trust in [Trust::Token] {
            let (daemon, _data, bot, folder) = fixture(true, Ok(()));
            let mut client = connect_to(&daemon, trust);
            client.send(json!({"id":0,"cmd":"hello","args":{"protocol":1,"token":"secret"}})).await;
            assert!(client.next().await.unwrap().get("ok").is_some());
            client.send(update(&bot, Some("read"), Some(&folder))).await;
            assert!(client.until_reply(1).await.pop().unwrap().get("err").is_some());
            assert_eq!(saved_access(&daemon), json!("read"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linux_local_update_cannot_bypass_raise_gate_with_a_forged_old_level() {
        use apex_adapters::linux_jail::{self, JailState};
        let _lock = linux_jail::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // A token peer never raises. A same-user local peer (the terminal app)
        // is refused whenever the recorded jail probe isn't Works.
        for (trust, probe, expected) in [
            (Trust::Token, Some(JailState::Works), "only allowed from a paired device"),
            (Trust::Local, Some(JailState::Fails("probe failed".into())), "failed its startup check"),
            (Trust::Local, None, "hasn't finished its startup check"),
        ] {
            let (daemon, _data, bot, folder) = fixture(true, Ok(()));
            linux_jail::set_state_for_test(probe);
            let mut client = connect_to(&daemon, trust);
            client.send(json!({"id":0,"cmd":"hello","args":{"protocol":1,"token":"secret"}})).await;
            assert!(client.next().await.unwrap().get("ok").is_some());
            // This claims Full -> Full, but the saved participant is Read.
            client.send(update(&bot, Some("full"), Some(&folder))).await;
            let reply = client.until_reply(1).await.pop().unwrap();
            assert!(reply["err"].as_str().is_some_and(|why| why.contains(expected)), "raise must fail at the Linux gate: {reply}");
            assert_eq!(saved_access(&daemon), json!("read"));
        }
        linux_jail::set_state_for_test(None);
    }

    #[tokio::test]
    async fn current_confined_linux_device_can_raise_with_bound_old_level_and_folder() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        let phone = add(&daemon, 72);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        client.send(update(&bot, Some("read"), Some(&folder))).await;
        let reply = client.until_reply(1).await.pop().unwrap();
        assert!(reply.get("ok").is_some(), "{reply}");
        assert_eq!(saved_access(&daemon), json!("full"));
        // The first write invalidates the same old-level binding.
        let mut again = update(&bot, Some("read"), Some(&folder));
        again["id"] = json!(2);
        again["args"]["participant"]["access"] = json!("edits");
        client.send(again).await;
        assert!(client.until_reply(2).await.pop().unwrap().get("err").is_some());
        assert_eq!(saved_access(&daemon), json!("full"));
    }

    #[tokio::test]
    async fn mac_windows_device_updates_do_not_require_a_linux_trust_record() {
        let (daemon, data, bot, _folder) = fixture(false, Ok(()));
        assert!(!data.0.join(crate::trust_host::FILE).exists());
        let phone = add(&daemon, 73);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        client.send(update(&bot, None, None)).await;
        let reply = client.until_reply(1).await.pop().unwrap();
        assert!(reply.get("ok").is_some(), "{reply}");
        assert_eq!(saved_access(&daemon), json!("full"));
    }

    #[tokio::test]
    async fn concurrent_device_raises_commit_only_one_matching_old_level() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        let phone = add(&daemon, 77);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        client.send(update(&bot, Some("read"), Some(&folder))).await;
        let mut second = update(&bot, Some("read"), Some(&folder));
        second["id"] = json!(2);
        second["args"]["participant"]["access"] = json!("edits");
        client.send(second).await;
        let mut replies = Vec::new();
        while replies.len() < 2 {
            let frame = client.next().await.unwrap();
            if frame["id"] == 1 || frame["id"] == 2 { replies.push(frame); }
        }
        let successful: Vec<_> = replies.iter().filter(|frame| frame.get("ok").is_some()).collect();
        assert_eq!(successful.len(), 1, "{replies:?}");
        assert_eq!(saved_access(&daemon), successful[0]["ok"]["access"]);
    }
}
