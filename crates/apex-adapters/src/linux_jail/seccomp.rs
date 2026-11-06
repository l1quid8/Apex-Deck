//! The fixed BPF program that stops a jailed process making Unix sockets. It
//! is inherited by every descendant and can't be removed. Read-only mounts
//! don't stop `connect()`, and a network namespace only separates abstract
//! sockets, so the socket has to be refused when it's made.
//!
//! `socket()` is an allowlist, so a family nobody thought of is refused. So
//! is `socketpair()`, once the two flag bits are masked off.

const LOAD: u16 = 0x20;
const JUMP_EQ: u16 = 0x15;
const JUMP_SET: u16 = 0x45;
const RETURN: u16 = 0x06;
const AND: u16 = 0x54;

const ALLOW: u32 = 0x7fff_0000;
const fn errno(value: u32) -> u32 { 0x0005_0000 | value }
const EPERM: u32 = 1;
const ENOSYS: u32 = 38;
const EAFNOSUPPORT: u32 = 97;

const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
const AUDIT_ARCH_AARCH64: u32 = 0xc000_00b7;
/// x32 calls share `AUDIT_ARCH_X86_64`, and only this bit tells them apart.
const X32_BIT: u32 = 0x4000_0000;

const AF_INET: u32 = 2;
const AF_INET6: u32 = 10;
const AF_NETLINK: u32 = 16;
const SOCK_STREAM: u32 = 1;
/// Everything except `SOCK_CLOEXEC` and `SOCK_NONBLOCK`.
const TYPE_MASK: u32 = !0x0008_0800;

const IO_URING_SETUP: u32 = 425;

// Offsets into `struct seccomp_data`.
const NR: u32 = 0;
const ARCH: u32 = 4;
const ARG0: u32 = 16;
const ARG1: u32 = 24;

struct Program {
    steps: Vec<(u16, Option<&'static str>, u32)>,
    labels: Vec<(&'static str, usize)>,
}

impl Program {
    fn step(&mut self, code: u16, value: u32) { self.steps.push((code, None, value)); }
    fn jump(&mut self, code: u16, value: u32, to: &'static str) { self.steps.push((code, Some(to), value)); }
    fn label(&mut self, name: &'static str) { self.labels.push((name, self.steps.len())); }

    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.steps.len() * 8);
        for (index, (code, to, value)) in self.steps.iter().enumerate() {
            let hop = to.map_or(0, |name| {
                let target = self.labels.iter().find(|(label, _)| *label == name).expect("label exists").1;
                u8::try_from(target - index - 1).expect("the filter is short")
            });
            out.extend_from_slice(&code.to_le_bytes());
            out.push(hop);
            out.push(0);
            out.extend_from_slice(&value.to_le_bytes());
        }
        out
    }
}

/// The program as bwrap's `--seccomp` reads it.
pub fn filter() -> Vec<u8> {
    let mut p = Program { steps: Vec::new(), labels: Vec::new() };
    p.step(LOAD, ARCH);
    p.jump(JUMP_EQ, AUDIT_ARCH_X86_64, "x86");
    p.jump(JUMP_EQ, AUDIT_ARCH_AARCH64, "arm");
    p.step(RETURN, errno(ENOSYS));

    p.label("x86");
    p.step(LOAD, NR);
    p.jump(JUMP_SET, X32_BIT, "no_call");
    p.jump(JUMP_EQ, 41, "socket");
    p.jump(JUMP_EQ, 53, "pair");
    p.jump(JUMP_EQ, 101, "no_perm");
    p.jump(JUMP_EQ, IO_URING_SETUP, "no_call");
    p.step(RETURN, ALLOW);

    p.label("arm");
    p.step(LOAD, NR);
    p.jump(JUMP_EQ, 198, "socket");
    p.jump(JUMP_EQ, 199, "pair");
    p.jump(JUMP_EQ, 117, "no_perm");
    p.jump(JUMP_EQ, IO_URING_SETUP, "no_call");
    p.step(RETURN, ALLOW);

    p.label("socket");
    p.step(LOAD, ARG0);
    p.jump(JUMP_EQ, AF_INET, "allow");
    p.jump(JUMP_EQ, AF_INET6, "allow");
    p.jump(JUMP_EQ, AF_NETLINK, "allow");
    p.step(RETURN, errno(EAFNOSUPPORT));

    p.label("pair");
    p.step(LOAD, ARG1);
    p.step(AND, TYPE_MASK);
    p.jump(JUMP_EQ, SOCK_STREAM, "allow");
    p.label("no_perm");
    p.step(RETURN, errno(EPERM));

    p.label("allow");
    p.step(RETURN, ALLOW);
    p.label("no_call");
    p.step(RETURN, errno(ENOSYS));
    p.bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real bytes the way the kernel would, for the five opcodes used.
    fn run(arch: u32, nr: u32, args: [u32; 2]) -> u32 {
        let program = filter();
        let (mut pc, mut acc) = (0usize, 0u32);
        loop {
            let at = &program[pc * 8..pc * 8 + 8];
            let code = u16::from_le_bytes([at[0], at[1]]);
            let (jt, jf) = (at[2] as usize, at[3] as usize);
            let k = u32::from_le_bytes([at[4], at[5], at[6], at[7]]);
            pc += 1;
            match code {
                LOAD => acc = match k { NR => nr, ARCH => arch, ARG0 => args[0], ARG1 => args[1], _ => panic!("load {k}") },
                JUMP_EQ => pc += if acc == k { jt } else { jf },
                JUMP_SET => pc += if acc & k != 0 { jt } else { jf },
                AND => acc &= k,
                RETURN => return k,
                _ => panic!("opcode {code:#x}"),
            }
        }
    }

    const CLOEXEC: u32 = 0x80000;
    const NONBLOCK: u32 = 0x800;
    const AF_UNIX: u32 = 1;
    const AF_VSOCK: u32 = 40;
    const AF_ALG: u32 = 38;
    const DGRAM: u32 = 2;
    const SEQPACKET: u32 = 5;

    fn each_arch(check: impl Fn(u32, u32, u32)) {
        check(AUDIT_ARCH_X86_64, 41, 53);
        check(AUDIT_ARCH_AARCH64, 198, 199);
    }

    #[test]
    fn socket_is_an_allowlist() {
        each_arch(|arch, socket, _| {
            for family in [AF_INET, AF_INET6, AF_NETLINK] {
                assert_eq!(run(arch, socket, [family, 1]), ALLOW);
            }
            for family in [AF_UNIX, AF_VSOCK, AF_ALG, 0, 17] {
                assert_eq!(run(arch, socket, [family, 1]), errno(EAFNOSUPPORT), "family {family}");
            }
        });
    }

    #[test]
    fn only_stream_pairs_pass_whatever_the_flags() {
        each_arch(|arch, _, pair| {
            for flags in [0, CLOEXEC, NONBLOCK, CLOEXEC | NONBLOCK] {
                assert_eq!(run(arch, pair, [AF_UNIX, SOCK_STREAM | flags]), ALLOW);
                assert_eq!(run(arch, pair, [AF_UNIX, DGRAM | flags]), errno(EPERM));
                assert_eq!(run(arch, pair, [AF_UNIX, SEQPACKET | flags]), errno(EPERM));
            }
            assert_eq!(run(arch, pair, [AF_UNIX, SOCK_STREAM | 0x100]), errno(EPERM), "an unknown bit isn't a flag");
        });
    }

    #[test]
    fn io_uring_and_other_abis_are_refused() {
        each_arch(|arch, _, _| assert_eq!(run(arch, IO_URING_SETUP, [0, 0]), errno(ENOSYS)));
        assert_eq!(run(0x4000_0003, 102, [0, 0]), errno(ENOSYS), "32-bit socketcall");
        assert_eq!(run(0x4000_0028, 1, [0, 0]), errno(ENOSYS), "32-bit Arm");
        assert_eq!(run(AUDIT_ARCH_X86_64, X32_BIT | 41, [AF_UNIX, 1]), errno(ENOSYS), "x32 socket");
    }

    #[test]
    fn ptrace_is_refused() {
        assert_eq!(run(AUDIT_ARCH_X86_64, 101, [0, 0]), errno(EPERM));
        assert_eq!(run(AUDIT_ARCH_AARCH64, 117, [0, 0]), errno(EPERM));
    }

    #[test]
    fn ordinary_calls_pass() {
        each_arch(|arch, _, _| for nr in [0, 1, 2, 56, 63, 64, 221, 435] {
            assert_eq!(run(arch, nr, [0, 0]), ALLOW);
        });
    }

    #[test]
    fn program_length_is_whole_instructions() {
        assert_eq!(filter().len() % 8, 0);
        assert!(filter().len() / 8 < 40);
    }
}
