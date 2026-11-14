use apex_cli::args::{parse, Launch};

#[test]
fn standalone_defaults_to_the_same_store_as_desktop() {
    let Launch::Interactive(args) = parse(Vec::<String>::new()).unwrap() else { panic!() };
    assert_eq!(args.data, apex_daemon::paths::host_paths(None).unwrap().data);
    assert!(!args.connect_deck);
}

#[test]
fn explicit_path_and_attach_are_independent() {
    let Launch::Interactive(args) = parse(["--data-dir", "/tmp/apex-test", "--connect-deck"].map(str::to_string)).unwrap() else { panic!() };
    assert_eq!(args.data.to_str(), Some("/tmp/apex-test"));
    assert!(args.connect_deck);
    assert!(parse(["--data-dir", "relative"].map(str::to_string)).is_err());
}

#[test]
fn backend_lifecycle_commands_parse_without_terminal() {
    assert!(matches!(parse(["backend", "status"].map(str::to_string)).unwrap(), Launch::Backend { .. }));
    assert!(parse(["backend", "destroy"].map(str::to_string)).is_err());
}

#[test]
fn daemon_local_only_refuses_network_flags(){
    use apex_daemon::cli::{parse,Action};
    let cli=parse(&["serve","--local-only"].map(str::to_string)).unwrap();
    assert!(matches!(cli.action,Action::Serve(options) if options.local_only));
    for flag in [vec!["--remote"],vec!["--gateway-port","9999"],vec!["--port","9999"]] {
        let mut args=vec!["serve".to_string(),"--local-only".into()];args.extend(flag.into_iter().map(str::to_string));assert!(parse(&args).is_err());
    }
}

#[test]
fn version_names_the_build_commit_so_packagers_can_check_it() {
    let line = apex_cli::args::version_line();
    assert!(line.starts_with(&format!("apex {} (", env!("CARGO_PKG_VERSION"))), "{line}");
    assert!(line.contains(apex_daemon::build_info::commit()), "{line}");
}
