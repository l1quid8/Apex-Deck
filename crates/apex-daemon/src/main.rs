fn main() {
    // Only the shipped daemon jails Linux bots below Full. The test fixture
    // binary shares entry::run but leaves the jail off, so integration tests
    // don't need a working bubblewrap; jail tests switch it on themselves.
    #[cfg(unix)]
    apex_adapters::linux_jail::this_program_is_the_jail_init();
    apex_daemon::entry::run();
}
