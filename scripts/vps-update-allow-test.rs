    #[cfg(target_os = "linux")]
    #[test]
    fn vps_update_allow_compatibility() {
        // This intentionally uses the public API without the isolated-host
        // bypass: the candidate must retain the deployed Linux SSH behavior.
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let data = std::env::temp_dir().join(format!("apex-vps-allow-{}-{unique}", std::process::id()));
        let host = crate::Host::new(crate::HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        runtime.block_on(async {
            let room = "vps-allow-regression";
            let create = serde_json::json!({"cmd":"room_create","args":{"id":room,"participants":[],"options":apex_core::RoomOptions::default(),"cwd":null}});
            let created = host.call(crate::Command::from_json(create).unwrap()).await.unwrap();
            assert_eq!(created["transcript"], serde_json::json!([]));
            let state = host.call(crate::Command::from_json(serde_json::json!({"cmd":"room_state","args":{"id":room}})).unwrap()).await.unwrap();
            assert_eq!(state["snapshot"]["transcript"], serde_json::json!([]));
            let desk = {
                let handle = host.handle(room).unwrap();
                let locked = handle.room.lock().await;
                locked.approvals_handle()
            };
            for (approve, always, expected) in [
                (true, false, apex_core::Decision::Approve),
                (true, true, apex_core::Decision::ApproveAlways),
                (false, false, apex_core::Decision::Reject),
            ] {
                let (request, answer) = desk.open();
                let decision = serde_json::json!({"cmd":"room_decide","args":{"id":room,"request":request,"approve":approve,"always":always}});
                host.call(crate::Command::from_json(decision).unwrap()).await.unwrap();
                assert_eq!(answer.await.unwrap(), expected, "local room_decide must settle a real waiting proposal");
            }
            let (request, mut answer) = desk.open();
            let phone_decision = serde_json::json!({"cmd":"room_decide","args":{"id":room,"request":request,"approve":true,"always":false}});
            let refused = host.call_from_device(phone_decision.clone(), "test-endpoint".into(), "test-session".into(), 1, apex_core::GeneratedUiCapability::Unsupported).await.unwrap_err();
            assert!(refused.contains("protected provenance receipt"), "paired phone routing must keep its gate: {refused}");
            assert!(answer.try_recv().unwrap().is_none(), "refused phone must not settle the approval");
            host.call(crate::Command::from_json(phone_decision).unwrap()).await.unwrap();
            assert_eq!(answer.await.unwrap(), apex_core::Decision::Approve);
            let phone_create = serde_json::json!({"cmd":"room_create","args":{"id":"phone-must-not-create","participants":[],"options":apex_core::RoomOptions::default(),"cwd":null}});
            let refused = host.call_from_device(phone_create, "test-endpoint".into(), "test-session".into(), 2, apex_core::GeneratedUiCapability::Unsupported).await.unwrap_err();
            assert!(refused.contains("protected provenance receipt"), "paired phone create must keep its gate: {refused}");
            assert!(host.handle("phone-must-not-create").is_err());
            let assistant = serde_json::json!({"cmd":"personal_send","args":{"assistantId":"nonexistent","requestId":"r","text":"must remain protected"}});
            let refused = host.call(crate::Command::from_json(assistant).unwrap()).await.unwrap_err();
            assert!(refused.contains("protected provenance receipt"), "assistant admission must stay protected: {refused}");
        });
        host.shutdown();
        drop(host);
        drop(runtime);
        std::fs::remove_dir_all(data).unwrap();
    }
