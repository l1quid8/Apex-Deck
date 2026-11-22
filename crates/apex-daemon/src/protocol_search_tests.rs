/// Search grants at the wire: one per connection, gone with the connection.
///
/// These daemons use the isolated fixture host, which stands in for a checked
/// receipt, so "granted" here means the route reached the host with this
/// connection's id. The receipt refusals themselves are tested on a
/// production-gated host in `apex-host/src/search/admission_tests.rs`.
mod search_sessions {
    use super::*;

    const REFUSED: &str = apex_host::search::SEARCH_REFUSED;

    async fn ask(client: &mut Client, id: u64, cmd: &str, args: Value) -> Value {
        client.send(json!({"id": id, "cmd": cmd, "args": args})).await;
        client.until_reply(id).await.pop().unwrap()
    }
    fn query() -> Value {
        json!({"lane": "content", "query": "installer"})
    }
    async fn grants_reach(daemon: &Daemon, want: usize) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while daemon.host.search().grants() != want {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap_or_else(|_| panic!("expected {want} grants, have {}", daemon.host.search().grants()));
    }
    fn linux(daemon: &mut Arc<Daemon>, data: &TempDir) {
        Arc::get_mut(daemon).unwrap().linux_device_policy = Some(true);
        assert!(daemon.confinement.set(Ok(())).is_ok());
        std::fs::create_dir_all(&data.0).unwrap();
        std::fs::write(data.0.join(crate::trust_host::FILE), json!({"trusted":true,"epoch":"current-epoch","boot_id":"test-boot"}).to_string()).unwrap();
    }

    #[tokio::test]
    async fn a_second_connection_cannot_use_or_cancel_the_first_ones_grant() {
        let (daemon, _data) = daemon();
        let mut first = connect_to(&daemon, Trust::Local);
        first.hello().await;
        let mut second = connect_to(&daemon, Trust::Local);
        second.hello().await;
        // Nothing opened yet: both are refused.
        assert_eq!(ask(&mut first, 1, "search", query()).await["err"], REFUSED);
        let opened = ask(&mut first, 2, "search_open", json!({})).await;
        assert_eq!(opened["ok"]["ttlMs"], json!(30 * 60 * 1000), "{opened}");
        assert!(ask(&mut first, 3, "search", query()).await.get("ok").is_some());
        // The second connection has nothing to present.
        assert_eq!(ask(&mut second, 1, "search", query()).await["err"], REFUSED);
        assert_eq!(ask(&mut second, 2, "search_cancel", json!({"lane": "content"})).await["err"], REFUSED);
        // A session id in the arguments is not a thing: unknown fields are just not the connection.
        assert_eq!(ask(&mut second, 3, "search", json!({"lane": "content", "query": "installer", "session": "x", "grant": "x"})).await["err"], REFUSED);
        // Its own grant works, and is its own.
        assert!(ask(&mut second, 4, "search_open", json!({})).await.get("ok").is_some());
        assert!(ask(&mut second, 5, "search", query()).await.get("ok").is_some());
        assert_eq!(daemon.host.search().grants(), 2);
    }

    /// The WebSocket token route is not the installed app: on a production-gated
    /// host it gets no grant, and it can never ride on a local connection's.
    #[tokio::test]
    async fn the_token_route_cannot_borrow_a_local_grant() {
        let (daemon, _data) = daemon();
        let mut local = connect_to(&daemon, Trust::Local);
        local.hello().await;
        assert!(ask(&mut local, 1, "search_open", json!({})).await.get("ok").is_some());
        let mut token = connect_to(&daemon, Trust::Token);
        token.send(json!({"id":0,"cmd":"hello","args":{"protocol":1,"token":"secret"}})).await;
        assert!(token.next().await.unwrap().get("ok").is_some());
        assert_eq!(ask(&mut token, 1, "search", query()).await["err"], REFUSED);
        assert_eq!(ask(&mut token, 2, "search_cancel", json!({"lane": "content"})).await["err"], REFUSED);
        assert_eq!(daemon.host.search().grants(), 1);
    }

    #[tokio::test]
    async fn a_closed_connection_takes_its_grant_with_it() {
        let (daemon, _data) = daemon();
        let mut staying = connect_to(&daemon, Trust::Local);
        staying.hello().await;
        assert!(ask(&mut staying, 1, "search_open", json!({})).await.get("ok").is_some());
        let mut leaving = connect_to(&daemon, Trust::Local);
        leaving.hello().await;
        assert!(ask(&mut leaving, 1, "search_open", json!({})).await.get("ok").is_some());
        assert_eq!(daemon.host.search().grants(), 2);
        drop(leaving);
        grants_reach(&daemon, 1).await;
        assert!(ask(&mut staying, 2, "search", query()).await.get("ok").is_some(), "the other connection is untouched");
    }

    #[tokio::test]
    async fn paired_devices_may_search_but_do_not_share_grants() {
        let (daemon, _data) = daemon();
        let full = add(&daemon, 81);
        let (mut client, _session) = connect_device(&daemon, &full, 1 << 16);
        client.hello().await;
        assert!(ask(&mut client, 1, "search_open", json!({})).await.get("ok").is_some());
        assert!(ask(&mut client, 2, "search", query()).await.get("ok").is_some());
        assert!(ask(&mut client, 3, "search_cancel", json!({"lane": "content"})).await.get("ok").is_some());
        for n in [82, 83, 84] {
            let device = add(&daemon, n);
            let (mut client, _session) = connect_device(&daemon, &device, 1 << 16);
            client.hello().await;
            assert_eq!(ask(&mut client, 0, "search", query()).await["err"], REFUSED);
            for (id, cmd, args) in [(1, "search_open", json!({})), (2, "search", query()), (3, "search_cancel", json!({"lane": "content"}))] {
                let reply = ask(&mut client, id, cmd, args).await;
                assert!(reply.get("ok").is_some(), "paired device {n} {cmd}: {reply}");
            }
        }
        grants_reach(&daemon, 1).await;
    }

    #[tokio::test]
    async fn a_paired_device_on_the_linux_policy_may_search() {
        let (mut daemon, data) = daemon();
        linux(&mut daemon, &data);
        let phone = add(&daemon, 85);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        let opened = ask(&mut client, 1, "search_open", json!({})).await;
        assert!(opened.get("ok").is_some(), "{opened}");
        assert!(ask(&mut client, 2, "search", query()).await.get("ok").is_some());
        assert_eq!(daemon.host.search().grants(), 1);
    }

    #[tokio::test]
    async fn a_second_device_cannot_use_the_first_devices_grant() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 87);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        assert!(ask(&mut client, 1, "search_open", json!({})).await.get("ok").is_some());
        let second = add(&daemon, 89);
        let (mut other, _session) = connect_device(&daemon, &second, 1 << 16);
        other.hello().await;
        assert_eq!(ask(&mut other, 1, "search", query()).await["err"], REFUSED);
        assert_eq!(ask(&mut other, 2, "search_cancel", json!({"lane": "content"})).await["err"], REFUSED);
        assert!(ask(&mut client, 2, "search", query()).await.get("ok").is_some());
    }

    #[tokio::test]
    async fn a_revoked_device_loses_its_grant() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 88);
        let (mut client, session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        assert!(ask(&mut client, 1, "search_open", json!({})).await.get("ok").is_some());
        assert_eq!(daemon.host.search().grants(), 1);
        daemon.devices.revoke(&phone).unwrap();
        assert_eq!(ended_within(session, Duration::from_secs(5)).await, Ended::Revoked);
        grants_reach(&daemon, 0).await;
    }
}
