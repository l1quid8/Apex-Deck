//! Who this daemon is: a host id that stays with the data folder, and a boot
//! id that changes every time the daemon starts.

use std::io::Write;
use std::path::Path;

/// `bytes` random bytes as lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the system has a random number source");
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

/// A new id for this start. Event numbers restart with it.
pub fn boot_id() -> String {
    random_hex(16)
}

/// The id kept in `<data>/host-id`, made the first time it's asked for.
pub fn host_id(data: &Path) -> Result<String, String> {
    let path = data.join("host-id");
    let read = || std::fs::read_to_string(&path).ok().map(|id| id.trim().to_string()).filter(|id| !id.is_empty());
    if let Some(id) = read() {
        return Ok(id);
    }
    std::fs::create_dir_all(data).map_err(|e| format!("could not create {}: {e}", data.display()))?;
    let id = random_hex(16);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => file.write_all(format!("{id}\n").as_bytes()).map(|_| id).map_err(|e| format!("could not write {}: {e}", path.display())),
        // Another process made it first.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read().ok_or_else(|| format!("{} is empty", path.display())),
        Err(e) => Err(format!("could not write {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_ids_are_hex_and_differ() {
        let (a, b) = (boot_id(), boot_id());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn the_host_id_stays_with_its_data_folder() {
        let base = std::env::temp_dir().join(format!("apex-daemon-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (one, two) = (base.join("one"), base.join("two"));
        let id = host_id(&one).unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(host_id(&one).unwrap(), id);
        assert_eq!(std::fs::read_to_string(one.join("host-id")).unwrap().trim(), id);
        assert_ne!(host_id(&two).unwrap(), id);
        let _ = std::fs::remove_dir_all(&base);
    }
}
