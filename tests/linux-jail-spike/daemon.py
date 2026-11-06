#!/usr/bin/env python3
"""Outside the jail: serves fresh fds over the control channel, runs the CONNECT proxy."""
import array,ipaddress,os,select,socket,sys,threading
LOG=open(os.environ.get('PROXY_LOG','/tmp/proxy.log'),'a',buffering=1)
FAKE=os.environ.get('FAKE_UPSTREAM')  # host:port for the scripted-model test only
def bad(ip):
    a=ipaddress.ip_address(ip)
    if getattr(a,'ipv4_mapped',None): a=a.ipv4_mapped
    if a in ipaddress.ip_network('100.64.0.0/10') or a in ipaddress.ip_network('169.254.0.0/16'): return True
    return a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified
def pump(a,b):
    for s in (a,b): s.setblocking(True)
    def go(x,y):
        try:
            while (d:=x.recv(65536)): y.sendall(d)
        except OSError: pass
        for s in (x,y):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
    t=threading.Thread(target=go,args=(a,b),daemon=True); t.start(); go(b,a)
def proxy(c):
    d=b''
    while b'\r\n\r\n' not in d and len(d)<65536:
        x=c.recv(4096)
        if not x: return
        d+=x
    line=d.split(b'\r\n')[0].decode('latin1'); p=line.split()
    if len(p)<3 or p[0]!='CONNECT' or not p[1].endswith(':443'):
        LOG.write(f'REFUSE {line}\n'); c.sendall(b'HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'); return
    host=p[1].rsplit(':',1)[0].strip('[]')
    try: addrs=[i[4][0] for i in socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)]
    except OSError as e:
        LOG.write(f'DNSFAIL {host}\n'); c.sendall(b'HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n'); return
    good=[a for a in addrs if not bad(a)]
    if not good:
        LOG.write(f'REFUSE {line} -> {addrs}\n'); c.sendall(b'HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'); return
    u=socket.create_connection((good[0],443),timeout=15); u.settimeout(None)
    LOG.write(f'OK {host}\n'); c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n'); pump(c,u)
def serve(c):
    try:
        kind=c.recv(6)
        if kind==b'proxy\n': proxy(c)
        elif kind==b'fake\n\n' and FAKE:
            h,pt=FAKE.split(':'); pump(c,socket.create_connection((h,int(pt))))
    except OSError as e: LOG.write(f'ERR {e}\n')
    finally: c.close()
ctl=socket.socket(fileno=int(sys.argv[1]))
while True:
    if not ctl.recv(1): break
    a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
    socket.send_fds(ctl,[b'f'],[b.fileno()]); b.close()
    threading.Thread(target=serve,args=(a,),daemon=True).start()
