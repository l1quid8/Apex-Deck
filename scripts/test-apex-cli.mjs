// Disposable terminal/daemon acceptance. Never reads the installed data folder.
// node scripts/test-apex-cli.mjs [--no-build]
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.some(a=>a!=='--no-build'))throw new Error('Usage: node scripts/test-apex-cli.mjs [--no-build]');
function run(command,args,options={}){
 const result=spawnSync(command,args,{cwd:root,stdio:'inherit',...options});
 if(result.error)throw result.error;
 if(result.status!==0)throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
if(!args.includes('--no-build')){
 run('cargo',['build','-p','apex-daemon','--features','test-support','--bin','apex-daemon-fixture']);
 run('cargo',['build','-p','apex-cli','--bin','apex']);
}
const evidence=mkdtempSync('/tmp/apex-cli-acceptance-');
console.log(`Terminal evidence: ${evidence}`);
const python=String.raw`
import os,sys,json,time,socket,subprocess,tempfile,pathlib,pty,termios,fcntl,struct,signal,select,shutil,traceback,re,unicodedata,atexit
cli,fixture,evidence=map(pathlib.Path,sys.argv[1:])
results=[]
class RPC:
 def __init__(self,data):
  self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(10);self.sock.connect(str(data/'daemon.sock'));self.file=self.sock.makefile('rb');self.id=0
  self.call('hello',{'protocol':1})
 def call(self,cmd,args):
  self.id+=1;number=self.id;self.sock.sendall((json.dumps({'id':number,'cmd':cmd,'args':args})+'\n').encode())
  while True:
   line=self.file.readline()
   if not line:raise RuntimeError('fixture socket closed')
   frame=json.loads(line)
   if frame.get('id')==number:
    if 'err' in frame:raise RuntimeError(str(frame['err']))
    return frame['ok']
 def close(self):self.sock.close();self.file.close()
def wait_for(test,message,timeout=12):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  value=test()
  if value:return value
  time.sleep(.05)
 raise AssertionError(message)
def check(value,message):
 if not value:raise AssertionError(message)
def chat_rows(rpc):
 value=rpc.call('chat_list',{})
 if isinstance(value,list):return value
 for key in ('rooms','chats','threads','items'):
  if isinstance(value.get(key),list):return value[key]
 raise AssertionError('Unexpected chat_list shape: '+str(value))
def messages(rpc,room):return rpc.call('room_state',{'id':room})['snapshot']['transcript']
class Terminal:
 def __init__(self,data,cols,rows):
  self.master,self.slave=pty.openpty();self.before=termios.tcgetattr(self.slave);self.capture=bytearray();self.resize(cols,rows)
  env={k:v for k,v in os.environ.items() if not(k.startswith(('APEX_','DYLD_','ELECTRON_')) or k in ('NODE_OPTIONS','LD_PRELOAD','LD_LIBRARY_PATH'))};env['TERM']='xterm-256color'
  def session():
   os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
  # Keep a controlling-session supervisor alive through the app's exit. On
  # macOS the slave is revoked when its session leader exits, so reading its
  # termios from this outer process afterward would produce ENOTTY.
  self.report=data/'terminal-report.json'
  supervisor="import os,sys,json,subprocess,termios;from pathlib import Path;report=Path(sys.argv[3]);before=termios.tcgetattr(0);child=subprocess.Popen([sys.argv[1],'--data-dir',sys.argv[2]]);report.write_text(json.dumps({'pid':child.pid}));code=child.wait();after=termios.tcgetattr(0);report.write_text(json.dumps({'pid':child.pid,'exitCode':code,'attributesRestored':before==after,'lflagBefore':before[3],'lflagAfter':after[3]}));sys.exit(0 if code==0 else 1)"
  self.process=subprocess.Popen([sys.executable,'-I','-c',supervisor,str(cli),str(data),str(self.report)],stdin=self.slave,stdout=self.slave,stderr=self.slave,env=env,preexec_fn=session,close_fds=True)
  wait_for(lambda:self.report.exists(),'terminal supervisor did not start')
  self.app_pid=json.loads(self.report.read_text())['pid']
 def resize(self,cols,rows):
  self.cols,self.rows=cols,rows
  fcntl.ioctl(self.slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
  if hasattr(self,'process'):self.process.send_signal(signal.SIGWINCH)
 def drain(self,seconds=.2):
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   ready,_,_=select.select([self.master],[],[],min(.05,max(0,deadline-time.monotonic())))
   if ready:
    try:self.capture.extend(os.read(self.master,65536))
    except OSError:break
 def send(self,value):os.write(self.master,value);self.drain()
 def screen(self):
  # Ratatui emits cursor-addressed diffs, so raw substring matching cannot
  # reliably observe a title that reuses cells from the previous frame.
  grid=[[' ']*self.cols for _ in range(self.rows)];x=y=0
  for token in re.finditer(r'\x1b\[([0-?]*)([ -/]*)([@-~])|([^\x1b])',self.capture.decode(errors='replace')):
   if token.group(4) is None:
    raw,_,command=token.group(1,2,3)
    if raw.startswith(('?','>','<')):continue
    nums=[int(v) if v else 0 for v in raw.split(';')];n=nums[0] or 1
    if command in ('H','f'):y=max(0,min(self.rows-1,(nums[0] or 1)-1));x=max(0,min(self.cols-1,(nums[1] if len(nums)>1 and nums[1] else 1)-1))
    elif command=='A':y=max(0,y-n)
    elif command=='B':y=min(self.rows-1,y+n)
    elif command=='C':x=min(self.cols-1,x+n)
    elif command=='D':x=max(0,x-n)
    elif command=='G':x=max(0,min(self.cols-1,n-1))
    elif command=='J' and nums[0] in (2,3):grid=[[' ']*self.cols for _ in range(self.rows)]
    elif command=='K':
     start,end=(0,self.cols) if nums[0]==2 else ((0,x+1) if nums[0]==1 else (x,self.cols))
     for i in range(start,end):grid[y][i]=' '
    continue
   char=token.group(4)
   if char=='\r':x=0;continue
   if char=='\n':y=min(self.rows-1,y+1);continue
   if ord(char)<32 or ord(char)==127:continue
   if unicodedata.combining(char):
    if x:grid[y][x-1]+=char
    continue
   width=2 if unicodedata.east_asian_width(char) in ('W','F') else 1
   if x>=self.cols:x=0;y=min(self.rows-1,y+1)
   grid[y][x]=char
   if width==2 and x+1<self.cols:grid[y][x+1]=''
   x+=width
  return '\n'.join(''.join(row) for row in grid)
 def wait_text(self,text,after=0):
  def visible():
   self.drain(.05)
   if self.process.poll() is not None:raise AssertionError('CLI exited early: '+self.capture.decode(errors='replace')[-2000:])
   return text in self.screen()
  return wait_for(visible,'terminal never displayed '+text)
 def wait_title(self,text):
  def selected():
   self.drain(.05)
   return text in self.screen().split('\n')[0] and ' Message' in self.screen()
  return wait_for(selected,'terminal did not select '+text)
 def finish(self,kind):
  if kind=='ctrl-c':self.send(b'\x03')
  else:os.kill(self.app_pid,signal.SIGTERM)
  deadline=time.monotonic()+8
  while self.process.poll() is None and time.monotonic()<deadline:self.drain(.1)
  check(self.process.poll() is not None,'CLI did not exit after '+kind)
  self.drain();check(self.process.returncode==0,'CLI exit was not clean: '+str(self.process.returncode))
  report=json.loads(self.report.read_text());check(report.get('attributesRestored'),'terminal attributes were not restored: '+str(report))
  trace=bytes(self.capture)
  for enabled,disabled,name in [(b'\x1b[?1049h',b'\x1b[?1049l','alternate screen'),(b'\x1b[?2004h',b'\x1b[?2004l','bracketed paste'),(b'\x1b[?1000h',b'\x1b[?1000l','mouse capture')]:
   if enabled in trace:check(disabled in trace,'missing '+name+' restoration')
 def close(self):
  if self.process.poll() is None:
   try:os.kill(self.app_pid,signal.SIGKILL)
   except ProcessLookupError:pass
   try:self.process.wait(timeout=3)
   except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
  # Flush output before closing an unsuccessful raw-mode PTY on macOS.
  try:termios.tcflush(self.slave,termios.TCIOFLUSH)
  except termios.error:pass
  os.close(self.slave);os.close(self.master)
# Run the local SSE provider in a separate process. The PTY supervisor's
# preexec session setup must not fork a Python process that already has threads.
provider_port=evidence/'provider-port.txt'
provider_source=r"""
import sys,json,time,http.server,pathlib
class SlowProvider(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
  try:
   for text,delay in [('stream begin ',0),('UNIQUE_OLD_ROOM_DELTA',2)]:
    time.sleep(delay);self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'content':text},'finish_reason':None}]})+'\n\n').encode());self.wfile.flush()
   self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),SlowProvider);server.daemon_threads=True
pathlib.Path(sys.argv[1]).write_text(str(server.server_port));server.serve_forever()
"""
provider=subprocess.Popen([sys.executable,'-I','-c',provider_source,str(provider_port)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
atexit.register(lambda:provider.terminate() if provider.poll() is None else None)
wait_for(lambda:provider_port.exists(),'local streaming provider failed to start');provider_port=int(provider_port.read_text())
for cols,rows,ending in [(80,24,'ctrl-c'),(120,40,'sigterm')]:
 data=pathlib.Path(tempfile.mkdtemp(prefix='acl-',dir='/tmp'));daemon=None;rpc=None;terminal=None;name=str(cols)+'x'+str(rows)
 try:
  with (evidence/(name+'-daemon.log')).open('wb') as log:
   daemon=subprocess.Popen([str(fixture),'serve','--data-dir',str(data)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=log,env=dict(os.environ,TMPDIR='/tmp'))
   wait_for(lambda:(data/'daemon.sock').exists() or (daemon.poll() is not None and (_ for _ in ()).throw(RuntimeError('fixture exited'))),'fixture did not start')
   rpc=RPC(data);check(chat_rows(rpc)==[],'disposable fixture should have no chats')
   terminal=Terminal(data,cols,rows);terminal.wait_text('Welcome')
   position=len(terminal.capture);terminal.send(b'/new\r')
   chats=wait_for(lambda:chat_rows(rpc),'CLI /new did not create a chat');check(len(chats)==1,'/new created extra chats');room=chats[0]['id']
   state=rpc.call('room_state',{'id':room});check(state['snapshot']['participants']==[],'/new was not an empty team');check(messages(rpc,room)==[],'/new inserted sample messages')
   terminal.wait_text('Message',position);terminal.drain(.3)
   rpc.call('session_save',{'session':{'version':1,'profiles':[{'id':'fixture','display_name':'Fixture','persona':'','access':'read','backend':{'kind':'scripted','lines':['fixture reply']}},{'id':'slow','display_name':'Slow','persona':'','access':'read','backend':{'kind':'open_ai_compatible','base_url':'http://127.0.0.1:'+str(provider_port)+'/v1','model':'fixture'}}]}})
   terminal.send(b'/add fixture\r')
   wait_for(lambda:len(rpc.call('room_state',{'id':room})['snapshot']['participants'])==1,'CLI /add failed')
   terminal.drain(.4)
   paste=b'line one\n/clear\nline three\nline four\nline five'
   terminal.send(b'\x1b[200~'+paste+b'\x1b[201~');terminal.drain(.4)
   check(messages(rpc,room)==[],'bracketed paste submitted before Enter')
   terminal.send(b'\r')
   posted=wait_for(lambda:messages(rpc,room),'pasted message was not submitted')
   human=[m for m in posted if m.get('speaker',{}).get('kind')=='human']
   check(len(human)==1 and human[0]['text']==paste.decode(),'five-line paste was split, altered or executed')
   terminal.drain(.4);before_clear=len(messages(rpc,room))
   terminal.send(b'/clear\r');terminal.drain(.2);check(len(messages(rpc,room))==before_clear,'/clear deleted without a decision')
   terminal.send(b'\r');terminal.drain(.2);check(len(messages(rpc,room))==before_clear,'clear default was not Cancel')
   terminal.send(b'/clear\r');terminal.send(b'\x1b[B\r')
   wait_for(lambda:len(messages(rpc,room))==0,'explicit clear did not remove shared messages')
   terminal.send(b'/rename Original\r');wait_for(lambda:any(c.get('title')=='Original' for c in chat_rows(rpc)),'rename failed');terminal.drain(.3)
   rpc.call('chat_create',{'id':'secondary','title':'Secondary','participants':[{'profile':'slow'}],'options':{'policy':'mention','max_bot_hops':0}})
   # F3 opens navigation without replacing the composer. Each thread restores
   # its own unfinished draft when selected again.
   draft_original=b'DRAFT_ORIGINAL';draft_secondary=b'DRAFT_SECONDARY'
   terminal.send(draft_original);terminal.send(b'\x1bOR');terminal.wait_text('Threads')
   check(draft_original.decode() in terminal.screen(),'F3 replaced the current draft')
   terminal.send(b'\r');terminal.wait_title('Secondary')
   terminal.send(draft_secondary);terminal.send(b'\x1bOR');terminal.send(b'\x1b[B\r');terminal.wait_title('Original')
   check(draft_original.decode() in terminal.screen(),'original thread draft was not restored')
   check(messages(rpc,room)==[] and messages(rpc,'secondary')==[],'navigation submitted an unfinished draft')
   terminal.send(b'\x7f'*len(draft_original))
   position=len(terminal.capture);terminal.send(b'/threads Secondary\r');terminal.wait_title('Secondary');terminal.drain(.4)
   check(draft_secondary.decode() in terminal.screen(),'secondary thread draft was not restored')
   terminal.send(b'\x7f'*len(draft_secondary))
   terminal.send(b'@sl\t');terminal.send(b'streaming switch test\r')
   wait_for(lambda:rpc.call('room_state',{'id':'secondary'})['active'],'streaming provider never became active')
   position=len(terminal.capture);terminal.send(b'/threads Original\r');terminal.wait_title('Original');position=len(terminal.capture)
   wait_for(lambda:any('UNIQUE_OLD_ROOM_DELTA' in m.get('text','') for m in messages(rpc,'secondary')),'streamed reply did not persist')
   terminal.drain(.5)
   check(messages(rpc,room)==[],'old-room event corrupted selected transcript')
   check(b'UNIQUE_OLD_ROOM_DELTA' not in terminal.capture[position:],'old-room delta rendered in selected thread')
   # Restart this same disposable daemon and wait for the CLI to load a fresh
   # snapshot before requesting another mutation.
   rpc.close();rpc=None;daemon.terminate();daemon.wait(timeout=10);terminal.drain(.6)
   offline_draft=b'OFFLINE_DRAFT';terminal.send(offline_draft);terminal.send(b'\x1bOR')
   check(offline_draft.decode() in terminal.screen(),'F3 replaced disconnected draft')
   position=len(terminal.capture)
   daemon=subprocess.Popen([str(fixture),'serve','--data-dir',str(data)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=log,env=dict(os.environ,TMPDIR='/tmp'))
   def reconnect_rpc():
    try:return RPC(data)
    except (OSError,RuntimeError):return None
   rpc=wait_for(reconnect_rpc,'restarted fixture did not accept connections')
   terminal.wait_text('Message',position);terminal.drain(.5)
   check(offline_draft.decode() in terminal.screen(),'reconnection replaced disconnected draft')
   terminal.send(b'\x7f'*len(offline_draft))
   terminal.send(b'/rename Reconnected\r')
   wait_for(lambda:any(c.get('title')=='Reconnected' for c in chat_rows(rpc)),'CLI mutation after reconnect failed')
   terminal.resize(40,12);terminal.drain();terminal.resize(cols,rows);terminal.drain()
   terminal.finish(ending)
   record={'size':name,'exit':ending,'newEmptyTeam':True,'fiveLinePasteSingleMessage':True,'clearCancelAndConfirm':True,'mentionTabCompletion':True,'threadSwitchDuringStreaming':True,'oldRoomDeltaExcluded':True,'daemonRestartAndMutation':True,'f3DraftPreserved':True,'perThreadDraftsPreserved':True,'offlineF3DraftPreserved':True,'resize':True,'terminalAttributesRestored':True,'exitCode':terminal.process.returncode}
   results.append(record);print(json.dumps(record),flush=True)
 except Exception as error:
  results.append({'size':name,'failed':str(error)});raise
 finally:
  if terminal:
   (evidence/(name+'.ansi')).write_bytes(terminal.capture);terminal.close()
  if rpc:rpc.close()
  if daemon and daemon.poll() is None:daemon.terminate();daemon.wait(timeout=10)
  shutil.rmtree(data)
  (evidence/'results.json').write_text(json.dumps(results,indent=2)+'\n')
`;
run('/usr/bin/python3',['-I','-',path.join(root,'target/debug/apex'),path.join(root,'target/debug/apex-daemon-fixture'),evidence],{input:python,stdio:['pipe','inherit','inherit']});
console.log(`Passed real fixture/PTY acceptance. Evidence: ${evidence}`);
