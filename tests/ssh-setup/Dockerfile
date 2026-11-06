# A plain Linux server for Add a machine: systemd, sshd, a sudo user and one without.
FROM ubuntu:24.04
ENV container=docker
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    systemd systemd-sysv dbus dbus-user-session openssh-server sudo curl ca-certificates libpam-systemd procps cron >/dev/null \
 && useradd -m -s /bin/bash -G sudo admin && useradd -m -s /bin/bash plain \
 && echo 'admin:admin-pass' | chpasswd && echo 'plain:plain-pass' | chpasswd \
 && mkdir -p /run/sshd && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
