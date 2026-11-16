fn main() {
    #[cfg(feature = "remote")]
    if std::env::args().nth(1).as_deref() == Some("remote-client") {
        if let Err(error) = remote_client::run() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    // Only the shipped daemon jails Linux bots below Full. The test fixture
    // binary shares entry::run but leaves the jail off, so integration tests
    // don't need a working bubblewrap; jail tests switch it on themselves.
    #[cfg(unix)]
    apex_adapters::linux_jail::this_program_is_the_jail_init();
    apex_daemon::entry::run();
}

#[cfg(feature = "remote")]
mod remote_client;
