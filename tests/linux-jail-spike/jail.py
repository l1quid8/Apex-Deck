#!/usr/bin/env python3
"""jail.py <project> <home> -- cmd... : launches the jail the way linux_jail.rs would."""
import os,shutil,socket,subprocess,sys,tempfile,filter as F
sep=sys.argv.index('--'); proj,home=sys.argv[1:3]; cmd=sys.argv[sep+1:]
a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM); os.set_inheritable(b.fileno(),True)
d=subprocess.Popen(['python3','/spike/daemon.py',str(a.fileno())],pass_fds=[a.fileno()]); a.close()
r,w=os.pipe(); os.write(w,F.build()); os.close(w); os.set_inheritable(r,True)
args=['bwrap','--unshare-pid','--unshare-ipc','--unshare-uts','--unshare-cgroup','--unshare-net','--die-with-parent',
 '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--seccomp',str(r),
 '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/sbin','/sbin','--symlink','usr/lib','/lib',
 '--ro-bind','/spike','/spike','--bind',home,home]
if os.path.exists('/lib64'): args+=['--symlink','usr/lib64','/lib64']
for e in ('/etc/ssl','/etc/ca-certificates','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/passwd','/etc/group'):
    args+=['--ro-bind-try',e,e]
args+=['--bind',proj,proj,'--chdir',proj,'--',
 'sh','-c','python3 /spike/forwarder.py %d & sleep 0.5; exec "$@"'%b.fileno(),'sh']+cmd
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':home,'TMPDIR':'/tmp','TERM':'dumb','LANG':'C.UTF-8','NO_COLOR':'1',
 'HTTPS_PROXY':'http://127.0.0.1:18080','https_proxy':'http://127.0.0.1:18080','ALL_PROXY':'http://127.0.0.1:18080',
 'NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost','SSL_CERT_FILE':'/etc/ssl/certs/ca-certificates.crt',
 'NODE_USE_ENV_PROXY':'1'}
for k,v in os.environ.items():
    if k.startswith('JAIL_'): env[k[5:]]=v
p=subprocess.Popen(args,env=env,start_new_session=True,pass_fds=[b.fileno(),r]); b.close(); os.close(r)
rc=p.wait(); d.kill(); sys.exit(rc)
