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
            let phone = add(&daemon, 70, Tier::Full, Threads::ALL);
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
        let phone = add(&daemon, 71, Tier::Full, Threads::ALL);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        let reply = client.hello().await;
        assert!(reply["err"].as_str().is_some_and(|e| e.contains("sandbox probe failed")), "{reply}");
        assert_eq!(saved_access(&daemon), json!("read"));
        let _ = (bot, folder);
    }

    #[tokio::test]
    async fn linux_device_voice_is_refused_when_confinement_failed() {
        let (daemon, _data, _bot, _folder) = fixture(true, Err("sandbox probe failed".into()));
        let phone = add(&daemon, 74, Tier::Full, Threads::ALL);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        let hello = client.hello().await;
        assert!(hello["err"].as_str().is_some_and(|e| e.contains("sandbox probe failed")), "a failed probe must refuse device admission before voice or events: {hello}");
        assert_eq!(saved_access(&daemon), json!("read"));
    }

    #[tokio::test]
    async fn linux_full_device_can_lower_access_within_its_granted_thread() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        let phone = add(&daemon, 75, Tier::Full, Threads::ALL);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        client.send(update(&bot, Some("read"), Some(&folder))).await;
        let full = client.until_reply(1).await.pop().unwrap()["ok"].clone();
        assert_eq!(full["access"], "full");
        daemon.devices.set_threads(&phone, Threads::Only(vec!["access".into()])).unwrap();
        let mut lower = full.clone();
        lower["access"] = json!("edits");
        client.send(json!({"id":2,"cmd":"room_update_participant","args":{"id":"access","participant":lower,"base":full,"old_level":"full"}})).await;
        let reply = client.until_reply(2).await.pop().unwrap();
        assert!(reply.get("ok").is_some(), "lowering needs Full in this thread: {reply}");
        assert_eq!(saved_access(&daemon), json!("edits"));
    }

    #[tokio::test]
    async fn linux_local_socket_and_token_cannot_authorize_access_changes() {
        for trust in [Trust::Local, Trust::Token] {
            let (daemon, _data, bot, folder) = fixture(true, Ok(()));
            let mut client = connect_to(&daemon, trust);
            client.send(json!({"id":0,"cmd":"hello","args":{"protocol":1,"token":"secret"}})).await;
            assert!(client.next().await.unwrap().get("ok").is_some());
            client.send(update(&bot, Some("read"), Some(&folder))).await;
            assert!(client.until_reply(1).await.pop().unwrap().get("err").is_some());
            assert_eq!(saved_access(&daemon), json!("read"));
        }
    }

    #[tokio::test]
    async fn current_confined_linux_device_can_raise_with_bound_old_level_and_folder() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        let phone = add(&daemon, 72, Tier::Full, Threads::ALL);
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
        let phone = add(&daemon, 73, Tier::Full, Threads::ALL);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        client.send(update(&bot, None, None)).await;
        let reply = client.until_reply(1).await.pop().unwrap();
        assert!(reply.get("ok").is_some(), "{reply}");
        assert_eq!(saved_access(&daemon), json!("full"));
    }

    #[tokio::test]
    async fn a_forged_high_old_level_cannot_raise_from_a_thread_limited_device() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        let phone = add(&daemon, 76, Tier::Full, Threads::Only(vec!["access".into()]));
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        client.send(update(&bot, Some("full"), Some(&folder))).await;
        let reply = client.until_reply(1).await.pop().unwrap();
        assert!(reply.get("err").is_some(), "{reply}");
        assert_eq!(saved_access(&daemon), json!("read"));
    }

    #[tokio::test]
    async fn concurrent_device_raises_commit_only_one_matching_old_level() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        let phone = add(&daemon, 77, Tier::Full, Threads::ALL);
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

    #[tokio::test]
    async fn limited_devices_execute_every_command_fixture_without_raising_any_saved_level() {
        let (daemon, _data, bot, folder) = fixture(true, Ok(()));
        daemon.host.room_create("mine".into(), vec![serde_json::from_value(bot.clone()).unwrap()], Default::default(), Some(folder)).unwrap();
        let phone = add(&daemon, 78, Tier::Chat, Threads::Only(vec!["mine".into()]));
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        for (index, (name, _need, mut args)) in authority::tests::table().into_iter().enumerate() {
            fn inject_levels(value: &mut Value) {
                match value {
                    Value::Array(values) => values.iter_mut().for_each(inject_levels),
                    Value::Object(object) => {
                        for value in object.values_mut() { inject_levels(value); }
                        if object.contains_key("backend") { object.insert("access".into(), json!("full")); }
                    }
                    _ => {},
                }
            }
            inject_levels(&mut args);
            if let Some(object) = args.as_object_mut() {
                object.entry("access").or_insert(json!("full"));
            }
            let request = index as u64 + 1;
            client.send(json!({"id":request,"cmd":name,"args":args})).await;
            tokio::time::timeout(Duration::from_secs(15), client.until_reply(request)).await.expect(name);
            for room in ["mine", "access"] {
                let state = daemon.host.room_state(room.into()).unwrap();
                for participant in state["snapshot"]["participants"].as_array().unwrap() {
                    assert_eq!(participant["access"], json!("read"), "{name} raised {room}: {state}");
                }
            }
        }
    }
}
