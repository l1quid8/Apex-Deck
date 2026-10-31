#!/usr/bin/env python3
"""Inside the jail: TCP on loopback <-> fresh fds. Never calls socket(AF_UNIX)."""
import os,socket,sys,threading
ctl=socket.socket(fileno=int(sys.argv[1])); lock=threading.Lock()
def fresh():
    with lock:
        ctl.send(b'n'); _,fds,_,_=socket.recv_fds(ctl,1,1)
    return socket.socket(fileno=fds[0])
def pump(a,b):
    def go(x,y):
        try:
            while (d:=x.recv(65536)): y.sendall(d)
        except OSError: pass
        for s in (x,y):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
    threading.Thread(target=go,args=(a,b),daemon=True).start(); go(b,a)
def run(port,kind):
    l=socket.socket(socket.AF_INET); l.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); l.bind(('127.0.0.1',port)); l.listen(64)
    def h(c):
        u=fresh(); u.sendall(kind); pump(c,u)
    while True:
        c,_=l.accept(); threading.Thread(target=h,args=(c,),daemon=True).start()
threading.Thread(target=run,args=(18081,b'fake\n\n'),daemon=True).start()
run(18080,b'proxy\n')
