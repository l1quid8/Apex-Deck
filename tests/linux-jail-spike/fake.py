#!/usr/bin/env python3
"""Scripted model: first reply asks for a shell command, second says done."""
import json,sys
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
CMD='echo from-tool > tool-wrote.txt; id -u; ls /run 2>&1 | head -1; cat /home/tester/.ssh/id 2>&1 | head -1'
L=open('/tmp/fake.log','a',buffering=1)
class H(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(s,*a): pass
    def do_GET(s):
        s.send_response(404); s.send_header('content-length','0'); s.end_headers()
    def sse(s,evs):
        b=''.join(f'event: {e}\ndata: {json.dumps(d)}\n\n' for e,d in evs).encode()
        s.send_response(200); s.send_header('content-type','text/event-stream'); s.send_header('content-length',str(len(b))); s.end_headers(); s.wfile.write(b)
    def do_POST(s):
        n=int(s.headers.get('content-length',0)); raw=s.rfile.read(n); 
        try: q=json.loads(raw)
        except Exception: q={}
        L.write(f'{s.path} {len(raw)}\n')
        if 'count_tokens' in s.path:
            b=b'{"input_tokens":1}'; s.send_response(200); s.send_header('content-length',str(len(b))); s.end_headers(); s.wfile.write(b); return
        if 'messages' in s.path: return s.anth(q,raw)
        if 'responses' in s.path: return s.oai(q,raw)
        s.send_response(404); s.send_header('content-length','0'); s.end_headers()
    def anth(s,q,raw):
        if not q.get('stream'):
            b=json.dumps({'id':'m','type':'message','role':'assistant','model':'x','content':[{'type':'text','text':'t'}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':1}}).encode()
            s.send_response(200); s.send_header('content-type','application/json'); s.send_header('content-length',str(len(b))); s.end_headers(); s.wfile.write(b); return
        seen=b'tool_result' in raw
        L.write(f'result-seen={seen} tail={raw[-300:]!r}\n' if seen else 'first\n')
        st={'id':'m','type':'message','role':'assistant','model':'x','content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':1}}
        ev=[('message_start',{'type':'message_start','message':st})]
        if seen:
            ev+=[('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),
                 ('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'done'}})]; stop='end_turn'
        else:
            ev+=[('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'tool_use','id':'toolu_1','name':'Bash','input':{}}}),
                 ('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps({'command':CMD,'description':'x'})}})]; stop='tool_use'
        ev+=[('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':stop,'stop_sequence':None},'usage':{'output_tokens':1}}),('message_stop',{'type':'message_stop'})]
        s.sse(ev)
    def oai(s,q,raw):
        seen=b'function_call_output' in raw
        L.write('tools '+str([t.get('name') or t.get('type') for t in q.get('tools',[])])+'\n')
        L.write(f'oai result-seen={seen}' + (f' tail={raw[-400:]!r}\n' if seen else '\n'))
        r={'id':'r','object':'response','status':'in_progress','output':[]}
        if seen: it={'type':'message','id':'i','role':'assistant','status':'completed','content':[{'type':'output_text','text':'done','annotations':[]}]}
        else: it={'type':'function_call','id':'i','call_id':'c1','name':'exec_command' if any(t.get('name')=='exec_command' for t in q.get('tools',[])) else 'shell','arguments':json.dumps({'cmd':CMD,'command':['bash','-lc',CMD]})}
        done=dict(r,status='completed',output=[it],usage={'input_tokens':1,'output_tokens':1,'total_tokens':2,'input_tokens_details':{'cached_tokens':0},'output_tokens_details':{'reasoning_tokens':0}})
        s.sse([('response.created',{'type':'response.created','response':r}),('response.output_item.done',{'type':'response.output_item.done','output_index':0,'item':it}),('response.completed',{'type':'response.completed','response':done})])
ThreadingHTTPServer(('127.0.0.1',19000),H).serve_forever()
