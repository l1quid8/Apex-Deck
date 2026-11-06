#!/usr/bin/env python3
"""Disposable production-binary startup/terminal checks. Never installs authority.
Build apex + apex-daemon first. Existing subscriptions are only status-probed.
"""
import fcntl,json,os,pathlib,pty,re,select,socket,struct,subprocess,sys,tempfile,termios,time

ROOT=pathlib.Path(__file__).resolve().parent.parent
DATA=pathlib.Path(tempfile.mkdtemp(prefix='apex-standalone-',dir='/tmp'))
BIN=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT/'target/debug/apex'
checks=[]

def wait(test,message,seconds=15):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if test():return
        time.sleep(.05)
    raise AssertionError(message)

class Terminal:
    def __init__(self,data):
        self.master,self.slave=pty.openpty();self.buffer=bytearray()
        fcntl.ioctl(self.slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
        self.before=termios.tcgetattr(self.slave)
        env={k:v for k,v in os.environ.items() if not k.startswith(('APEX_','DYLD_','ELECTRON_')) and k not in ('NODE_OPTIONS','LD_PRELOAD','LD_LIBRARY_PATH','CODEX_HOME','CLAUDE_CONFIG_DIR')}
        env['TERM']='xterm-256color';env['APEX_DECK_DATA_DIR']='/tmp/must-never-use-deck'
        self.child=subprocess.Popen([str(BIN),'--data-dir',str(data)],stdin=self.slave,stdout=self.slave,stderr=self.slave,env=env)
    def read(self):
        while select.select([self.master],[],[],.02)[0]:
            try:self.buffer.extend(os.read(self.master,65536))
            except OSError:break
    def screen(self):
        self.read();grid=[[' ']*120 for _ in range(40)];x=y=0
        for token in re.finditer(r'\x1b\[([0-?]*)([ -/]*)([@-~])|([^\x1b])',self.buffer.decode(errors='replace')):
            if token.group(4) is None:
                raw,_,cmd=token.group(1,2,3)
                if raw.startswith(('?','>','<')):continue
                nums=[int(v) if v else 0 for v in raw.split(';')];n=nums[0] or 1
                if cmd in ('H','f'):y=max(0,min(39,n-1));x=max(0,min(119,(nums[1] if len(nums)>1 and nums[1] else 1)-1))
                elif cmd=='A':y=max(0,y-n)
                elif cmd=='B':y=min(39,y+n)
                elif cmd=='C':x=min(119,x+n)
                elif cmd=='D':x=max(0,x-n)
                elif cmd=='G':x=max(0,min(119,n-1))
                elif cmd=='J' and nums[0] in (2,3):grid=[[' ']*120 for _ in range(40)]
                elif cmd=='K':
                    lo,hi=(0,120) if nums[0]==2 else ((0,x+1) if nums[0]==1 else (x,120))
                    for i in range(lo,hi):grid[y][i]=' '
                continue
            c=token.group(4)
            if c=='\r':x=0;continue
            if c=='\n':y=min(39,y+1);continue
            if ord(c)<32:continue
            if x>=120:x=0;y=min(39,y+1)
            grid[y][x]=c;x+=1
        return '\n'.join(''.join(row) for row in grid)
    def expect(self,text):wait(lambda:text in self.screen(),'Terminal did not show '+text+'\n'+self.screen())
    def send(self,text):os.write(self.master,text.encode());time.sleep(.15);self.read()
    def close(self):
        self.send('\x03');self.child.wait(timeout=10)
        assert self.child.returncode==0
        assert termios.tcgetattr(self.slave)==self.before,'terminal attributes were not restored'
        self.read();os.close(self.master);os.close(self.slave)

class RPC:
    def __init__(self,data):
        self.s=socket.socket(socket.AF_UNIX);self.s.settimeout(10);self.s.connect(str(data/'daemon.sock'));self.f=self.s.makefile('rb');self.id=0;self.call('hello',{'protocol':1})
    def call(self,cmd,args):
        self.id+=1;self.s.sendall((json.dumps({'id':self.id,'cmd':cmd,'args':args})+'\n').encode())
        while True:
            v=json.loads(self.f.readline())
            if v.get('id')==self.id:
                if 'err' in v:raise RuntimeError(str(v['err']))
                return v['ok']

terminals=[];info=None
try:
    a=Terminal(DATA);terminals.append(a)
    b=Terminal(DATA);terminals.append(b)
    wait(lambda:(DATA/'daemon.json').exists(),'standalone backend did not autostart')
    info=json.loads((DATA/'daemon.json').read_text())
    assert info['localOnly'] and info['port'] is None and info['remote'] is None and not info['gateway']['enabled']
    a.expect('Recent threads');a.expect('Message')
    checks.append('production CLI autostarts IPC-only backend without desktop transport')
    b.expect('Recent threads')
    assert json.loads((DATA/'daemon.json').read_text())['boot_id']==info['boot_id']
    checks.append('two terminal launches share one backend boot')
    rpc=RPC(DATA)
    assert rpc.call('agent_profile_list',{})=={'profiles':[],'revision':0}
    for cmd,args in [('provider_setup_begin',{'provider':'codex','method':'reuse'}),('agent_profile_save',{'name':'Null','handle':'null','provider':'codex','model':None,'instructions':'test','access':'ask','expectedRevision':0})]:
        try:rpc.call(cmd,args)
        except RuntimeError as e:assert 'provenance' in str(e).lower()
        else:raise AssertionError('raw IPC was allowed to run protected '+cmd)
    checks.append('raw IPC cannot initiate login or save profiles')
    a.send('/login\r');a.expect('Attach a provider');a.expect('Codex');a.expect('Claude')
    a.send('\x1b');time.sleep(.2)
    a.send('/agents create codex\r');a.expect('Standalone setup');a.send('\r');a.expect('Agent name')
    for text,expected in [('Null','Unique handle'),('null','Model:'),('default','Instructions:'),('Verify changes','Default Work access'),('ask','type save or /cancel')]:
        a.send(text+'\r');a.expect(expected)
    a.send('\x1b');a.expect('Agent creation canceled')
    assert rpc.call('agent_profile_list',{})['profiles']==[]
    checks.append('agent wizard fields, confirmation, and Escape cancellation leave no profile')
    for terminal in terminals:terminal.close()
    terminals=[]
    assert (DATA/'daemon.json').exists()
    checks.append('terminal attributes restore; backend survives both terminal exits')
    print(json.dumps({'data':str(DATA),'checks':checks,'installedAcceptance':False},indent=2))
finally:
    for t in terminals:
        try:t.close()
        except Exception:t.child.terminate()
    if info:
        try:
            s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(str(DATA/'ctl.sock'));s.sendall((json.dumps({'op':'stop','bootId':info['boot_id']})+'\n').encode());s.recv(1000);s.close()
        except OSError:pass
        # This PID was created by the CLI in our fresh private test directory.
        # Test cleanup owns it; the product's stop path still requires a receipt.
        try:os.kill(info['pid'],15)
        except ProcessLookupError:pass
    (DATA/'checks.json').write_text(json.dumps(checks,indent=2))
