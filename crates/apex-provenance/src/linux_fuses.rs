//! Fail-closed installed Electron fuse policy. The separately authenticated
//! manifest pins the entire executable and ASAR; a wire is not publisher trust.
//! Wire format: https://github.com/electron/fuses/tree/main/src .
use std::io::{Read, Seek, SeekFrom};

pub fn verify(image: &mut (impl Read + Seek)) -> Result<(), String> {
    const SENTINEL: &[u8] = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
    image.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut magic = [0; 4];
    image.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != b"\x7fELF" {
        return Err("Installed UI must be a native ELF Electron executable".into());
    }
    image.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut tail = Vec::new();
    let mut offset = 0u64;
    let mut positions = std::collections::BTreeSet::new();
    loop {
        let mut chunk = [0; 65536];
        let n = image.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let start = offset - tail.len() as u64;
        tail.extend_from_slice(&chunk[..n]);
        for (index, window) in tail.windows(SENTINEL.len()).enumerate() {
            if window == SENTINEL {
                positions.insert(start + index as u64);
            }
        }
        if positions.len() > 1 {
            return Err("Ambiguous installed Electron fuse wires".into());
        }
        offset += n as u64;
        if offset > crate::linux_install::PAYLOAD_LIMIT {
            return Err("UI executable exceeds manifest bounds".into());
        }
        tail = tail[tail.len().saturating_sub(SENTINEL.len() - 1)..].to_vec();
    }
    let at = positions
        .into_iter()
        .next()
        .ok_or("Missing installed Electron fuse wire")?;
    image
        .seek(SeekFrom::Start(at + SENTINEL.len() as u64))
        .map_err(|e| e.to_string())?;
    let mut header = [0; 2];
    image.read_exact(&mut header).map_err(|e| e.to_string())?;
    if header[0] != 1 || header[1] < 8 {
        return Err("Unsupported installed Electron fuse policy version".into());
    }
    let mut wire = vec![0; header[1] as usize];
    image.read_exact(&mut wire).map_err(|e| e.to_string())?;
    if wire.iter().any(|b| !matches!(b, b'0' | b'1' | b'r'))
        || [0, 2, 3, 7].into_iter().any(|i| wire[i] != b'0')
        || wire[5] != b'1'
    {
        return Err(
            "Installed Electron permits debugger, external code or unsafe file privileges".into(),
        );
    }
    Ok(())
}

pub fn installed(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    crate::linux_install::protected_path(path)?;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| e.to_string())?;
    verify(&mut file)
}
