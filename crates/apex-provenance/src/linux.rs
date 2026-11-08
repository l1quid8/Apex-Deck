//! Linux kernel peer identity primitives. Identity alone NEVER grants authority.

fn process_start(stat: &str) -> Result<u64, String> {
    stat.rsplit_once(')')
        .and_then(|(_, tail)| tail.split_whitespace().nth(19))
        .ok_or("Incomplete Linux process identity")?
        .parse()
        .map_err(|_| "Invalid Linux process generation".into())
}

#[cfg(target_os = "linux")]
mod kernel {
    use super::process_start;
    use std::{
        fs::File,
        io::Read,
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        os::unix::{
            fs::{MetadataExt, OpenOptionsExt},
            net::UnixStream,
        },
    };

    pub fn enable_credentials(fd: i32) -> Result<(), String> {
        let enabled: libc::c_int = 1;
        let result = unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PASSCRED,
                (&enabled as *const libc::c_int).cast(),
                std::mem::size_of_val(&enabled) as libc::socklen_t,
            )
        };
        if result != 0 {
            return Err(format!(
                "Cannot require kernel message credentials: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    /// A live kernel process reference, not a UID/path authorization decision.
    pub struct KernelPeer {
        pid: libc::pid_t,
        uid: libc::uid_t,
        gid: libc::gid_t,
        pidfd: OwnedFd,
        proc: File,
        start: u64,
    }
    impl KernelPeer {
        pub fn identity(&self) -> (libc::pid_t, libc::uid_t, libc::gid_t) {
            (self.pid, self.uid, self.gid)
        }
        pub fn capture(stream: &UnixStream) -> Result<Self, String> {
            let fd = stream.as_raw_fd();
            enable_credentials(fd)?;
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut size,
                )
            } != 0
                || size as usize != std::mem::size_of_val(&credentials)
                || credentials.pid <= 0
            {
                return Err("No kernel peer credentials".into());
            }
            let mut descriptor: libc::c_int = -1;
            size = std::mem::size_of_val(&descriptor) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_PEERPIDFD,
                    (&mut descriptor as *mut libc::c_int).cast(),
                    &mut size,
                )
            } != 0
            {
                return Err(
                    "Kernel cannot bind socket to process generation (SO_PEERPIDFD required)"
                        .into(),
                );
            }
            if descriptor < 0 {
                return Err("Invalid kernel peer descriptor".into());
            }
            let pidfd = unsafe { OwnedFd::from_raw_fd(descriptor) };
            if size as usize != std::mem::size_of_val(&descriptor)
                || unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } != 0
            {
                return Err("Invalid kernel peer descriptor flags".into());
            }
            let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{descriptor}"))
                .map_err(|e| e.to_string())?;
            let held_pid = fdinfo
                .lines()
                .find_map(|line| line.strip_prefix("Pid:"))
                .and_then(|p| p.trim().parse::<i32>().ok());
            if held_pid != Some(credentials.pid) {
                return Err("Socket peer generation changed".into());
            }
            let proc = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(format!("/proc/{}", credentials.pid))
                .map_err(|e| e.to_string())?;
            let mut peer = Self {
                pid: credentials.pid,
                uid: credentials.uid,
                gid: credentials.gid,
                pidfd,
                proc,
                start: 0,
            };
            peer.alive()?;
            peer.start = process_start(&peer.read_proc("stat", 8192)?)?;
            peer.validate()?;
            Ok(peer)
        }
        pub fn alive(&self) -> Result<(), String> {
            let mut poll = libc::pollfd {
                fd: self.pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut poll, 1, 0) } != 0 {
                return Err("Socket peer exited or changed generation".into());
            }
            Ok(())
        }
        pub fn read_proc(&self, name: &str, limit: usize) -> Result<String, String> {
            if !matches!(
                name,
                "stat" | "status" | "cmdline" | "environ" | "maps" | "cgroup"
            ) {
                return Err("Unsupported process metadata".into());
            }
            self.alive()?;
            let name = std::ffi::CString::new(name).map_err(|e| e.to_string())?;
            let fd = unsafe {
                libc::openat(
                    self.proc.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                )
            };
            if fd < 0 {
                return Err("Cannot inspect held peer process".into());
            }
            let file = unsafe { File::from_raw_fd(fd) };
            let mut bytes = Vec::new();
            file.take(limit as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > limit {
                return Err("Process metadata exceeds inspection limit".into());
            }
            self.alive()?;
            String::from_utf8(bytes).map_err(|_| "Process metadata is not UTF-8".into())
        }
        pub fn validate(&self) -> Result<(), String> {
            self.alive()?;
            if process_start(&self.read_proc("stat", 8192)?)? != self.start {
                return Err("Process generation mismatch".into());
            }
            // Set-ID transitions and namespace/proc inspection failures do not
            // retain a peer identity captured in another security context.
            let status = self.read_proc("status", 65536)?;
            for (name, expected) in [("Uid:", self.uid), ("Gid:", self.gid)] {
                let values = status
                    .lines()
                    .find_map(|l| l.strip_prefix(name))
                    .ok_or("Missing peer identity fields")?
                    .split_whitespace()
                    .map(str::parse::<u32>)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| "Invalid peer identity fields")?;
                if values.len() != 4 || values.iter().any(|n| *n != expected) {
                    return Err("Peer changed user/group identity".into());
                }
            }
            for namespace in ["user", "pid", "mnt"] {
                let own = std::fs::metadata(format!("/proc/self/ns/{namespace}"))
                    .map_err(|e| e.to_string())?;
                let other = std::fs::metadata(format!("/proc/{}/ns/{namespace}", self.pid))
                    .map_err(|e| e.to_string())?;
                if (own.dev(), own.ino()) != (other.dev(), other.ino()) {
                    return Err("Peer namespace differs from broker".into());
                }
            }
            self.alive()
        }
        pub fn read_request(&self, stream: &UnixStream) -> Result<serde_json::Value, String> {
            self.validate()?;
            let mut frame = Vec::new();
            loop {
                let mut bytes = [0u8; 4096];
                let mut control = [0u64; 32];
                let mut vector = libc::iovec {
                    iov_base: bytes.as_mut_ptr().cast(),
                    iov_len: bytes.len(),
                };
                let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
                message.msg_iov = &mut vector;
                message.msg_iovlen = 1;
                message.msg_control = control.as_mut_ptr().cast();
                message.msg_controllen = std::mem::size_of_val(&control);
                let n = unsafe {
                    libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC)
                };
                if n <= 0 {
                    return Err("Peer request ended before a complete frame".into());
                }
                let mut sender = None;
                let mut unexpected = false;
                unsafe {
                    let mut header = libc::CMSG_FIRSTHDR(&message);
                    while !header.is_null() {
                        if (*header).cmsg_level == libc::SOL_SOCKET
                            && (*header).cmsg_type == libc::SCM_CREDENTIALS
                            && (*header).cmsg_len
                                == libc::CMSG_LEN(std::mem::size_of::<libc::ucred>() as u32)
                                    as usize
                        {
                            if sender.is_some() {
                                unexpected = true;
                            }
                            sender = Some(std::ptr::read_unaligned(
                                libc::CMSG_DATA(header).cast::<libc::ucred>(),
                            ));
                        } else {
                            unexpected = true;
                            if (*header).cmsg_level == libc::SOL_SOCKET
                                && (*header).cmsg_type == libc::SCM_RIGHTS
                            {
                                let size = (*header)
                                    .cmsg_len
                                    .saturating_sub(libc::CMSG_LEN(0) as usize)
                                    / std::mem::size_of::<i32>();
                                for i in 0..size {
                                    libc::close(std::ptr::read_unaligned(
                                        libc::CMSG_DATA(header).cast::<i32>().add(i),
                                    ));
                                }
                            }
                        }
                        header = libc::CMSG_NXTHDR(&message, header);
                    }
                }
                if unexpected || message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 {
                    return Err("Unexpected or truncated peer ancillary data".into());
                }
                let sender = sender.ok_or("Missing per-message sender identity")?;
                if (sender.pid, sender.uid, sender.gid) != (self.pid, self.uid, self.gid) {
                    return Err("Socket inherited or transferred to another sender".into());
                }
                frame.extend_from_slice(&bytes[..n as usize]);
                if frame.len() > crate::MAX_BYTES {
                    return Err("Peer request exceeds limit".into());
                }
                if frame.contains(&b'\n') {
                    if frame.last() != Some(&b'\n') || frame[..frame.len() - 1].contains(&b'\n') {
                        return Err("Multiple peer frames are forbidden".into());
                    }
                    self.validate()?;
                    return serde_json::from_slice(&frame).map_err(|e| e.to_string());
                }
            }
        }
    }
}
#[cfg(target_os = "linux")]
pub use kernel::{enable_credentials, KernelPeer};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_generation_parser_handles_spaces_and_parentheses_in_names() {
        let mut fields = vec!["0"; 20];
        fields[0] = "S";
        fields[19] = "123456";
        let text = format!("42 (name ) with spaces) {}", fields.join(" "));
        assert_eq!(process_start(&text).unwrap(), 123456);
        assert!(process_start("42 (missing fields) S 1").is_err());
        fields[19] = "invalid";
        assert!(process_start(&format!("42 (test) {}", fields.join(" "))).is_err());
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn live_kernel_peer_and_each_message_are_bound_to_the_sender() {
        use std::{io::Write, os::fd::AsRawFd, os::unix::net::UnixStream};
        let (receiver, mut sender) = UnixStream::pair().unwrap();
        enable_credentials(receiver.as_raw_fd()).unwrap();
        let peer = KernelPeer::capture(&receiver).unwrap();
        assert_eq!(peer.identity().0, std::process::id() as i32);
        sender.write_all(b"{\"op\":\"test\"}\n").unwrap();
        assert_eq!(peer.read_request(&receiver).unwrap()["op"], "test");
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn inherited_socket_cannot_transfer_process_identity() {
        use std::{os::fd::AsRawFd, os::unix::net::UnixStream};
        let (receiver, sender) = UnixStream::pair().unwrap();
        enable_credentials(receiver.as_raw_fd()).unwrap();
        let peer = KernelPeer::capture(&receiver).unwrap();
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            unsafe {
                libc::write(sender.as_raw_fd(), b"{}\n".as_ptr().cast(), 3);
                libc::_exit(0);
            }
        }
        let error = peer.read_request(&receiver).unwrap_err();
        unsafe {
            libc::waitpid(child, std::ptr::null_mut(), 0);
        }
        assert!(error.contains("another sender"), "{error}");
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn socket_child_fixture() {
        use std::{
            io::{Read, Write},
            os::unix::net::UnixStream,
        };
        let Some(path) = std::env::var_os("APEX_TEST_PEER_SOCKET") else {
            return;
        };
        let mut stream = UnixStream::connect(path).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        stream.write_all(b"{}\n").unwrap();
        stream.read_exact(&mut [0u8; 1]).unwrap();
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn exited_process_never_retains_a_live_kernel_identity() {
        use std::{
            os::{fd::AsRawFd, unix::net::UnixListener},
            process::Command,
        };
        let path = std::env::temp_dir().join(format!("apex-peer-{}.sock", std::process::id()));
        let listener = UnixListener::bind(&path).unwrap();
        enable_credentials(listener.as_raw_fd()).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "linux::tests::socket_child_fixture"])
            .env("APEX_TEST_PEER_SOCKET", &path)
            .spawn()
            .unwrap();
        let (stream, _) = listener.accept().unwrap();
        let peer = KernelPeer::capture(&stream).unwrap();
        assert_ne!(peer.identity().0, std::process::id() as i32);
        std::io::Write::write_all(&mut &stream, b"x").unwrap();
        assert!(child.wait().unwrap().success());
        let error = peer.validate().unwrap_err();
        std::fs::remove_file(&path).unwrap();
        assert!(error.contains("exited"), "{error}");
    }
}
