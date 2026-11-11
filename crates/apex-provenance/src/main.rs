#[cfg(unix)]
include!("main_unix.rs");
#[cfg(windows)]
mod windows_service;
#[cfg(any(windows, test))]
mod blocking_verification;
#[cfg(windows)]
fn main() {
    if let Err(error) = windows_service::run() {
        eprintln!("apex-provenance: {error}");
        std::process::exit(1);
    }
}
