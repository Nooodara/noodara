#!/usr/bin/env python3
"""Run from repository root. Only sanitized results escape; private canaries stay in memory.
Creates a scoped DB service + encrypted current secrets + disposable auth user, and a
real Docker stdout/stderr emitter on the discovered installed UAT host. Always cleans
only its own container/rows, including interrupt/error. No injected readers/redactors.
"""
import base64,json,re,secrets,signal,subprocess,time,uuid,urllib.parse
from pathlib import Path
ROOT=Path(__file__).resolve().parent
VM=['limactl','shell','noodara-uat','sudo']
COMPOSE=['docker','compose','-f','/opt/noodara/docker-compose.yml','--project-directory','/opt/noodara']
def run(args,data=None,timeout=60):
 p=subprocess.run(VM+args,input=data,capture_output=True,timeout=timeout)
 if p.returncode:
  for line in p.stderr.splitlines():
   try:
    error=json.loads(line)
    check=error.get('check','')
    if error.get('result')=='FAIL' and re.fullmatch(r'[a-z-]+',check): raise RuntimeError(check+('-'+error['boundedCode'].lower().replace('_','-') if error.get('boundedCode') else ''))
   except (ValueError,AttributeError): pass
  raise RuntimeError('owned-command-failed')
 return p.stdout
cfg={'marker':'rc-http-'+uuid.uuid4().hex,'serviceId':str(uuid.uuid4()),'userId':str(uuid.uuid4()),'accountId':str(uuid.uuid4()),'password':secrets.token_hex(24)}
cfg['email']=cfg['marker']+'@example.invalid'
a='ordinary-'+secrets.token_hex(18)+'/+=value'
b='multiline-'+secrets.token_hex(16)+'\ncomponent-'+secrets.token_hex(16)
cfg['values']=[a,b]
cfg['variants']=list(dict.fromkeys([a,b,*b.splitlines(),*[base64.b64encode(v.encode()).decode() for v in [a,b]],*[urllib.parse.quote(v,safe="~()*!.'-") for v in [a,b]]]))
name='noodara-'+cfg['serviceId']
def node(file,action=None):
 cfg['action']=action
 source='const cfg='+json.dumps(cfg)+';\n'
 if file=='http-capture.mjs': source+='const {capture}=await import('+json.dumps('data:text/javascript;base64,'+base64.b64encode((ROOT/'bounded-http.mjs').read_bytes()).decode())+');\n'
 source+=(ROOT/file).read_text()
 return run(COMPOSE+['exec','-T','api','node','--input-type=module'],source.encode(),90)
def stop(*_): raise KeyboardInterrupt()
for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]: signal.signal(sig,stop)
created=False;report={};failure=None
workspaceBefore=run(['sh','-c','find /home/paas/.noodara/deploy -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort'])
listenersBefore=run(['sh','-c',"ss -H -lnt | awk '{print $4}' | sort"])
containersBefore=run(['docker','ps','--format','{{.ID}} {{.Names}}'])
try:
 cfg.update(json.loads(node('http-fixture.mjs','setup')));created=True
 # No ports, mounts, restart policy or provider configuration are added.
 # Source Docker logs are checked privately and destroyed with this owned container.
 script='const p='+json.dumps({'marker':cfg['marker'],'variants':cfg['variants']})+r'; for(const stream of [process.stdout,process.stderr]) { stream.write(p.marker+" ordinary readable text\n"); for(const v of p.variants)stream.write(v+"\n"); } let n=0; const t=setInterval(()=>{for(const stream of [process.stdout,process.stderr])stream.write(p.marker+" later output "+n+"\n");++n; if(n===18){clearInterval(t);process.exit(0)}},1000);'
 run(['docker','run','-d','--name',name,'--label','noodara.managed=true','--label','noodara.service='+cfg['serviceId'],'--entrypoint','node','ghcr.io/nooodara/noodara-control-plane:0.5.2-rc.1','-e',script])
 time.sleep(1)
 raw=run(['docker','logs',name])
 # docker stderr must be inspected separately; run() otherwise only returns stdout.
 source=subprocess.run(VM+['docker','logs',name],capture_output=True,timeout=10)
 assert source.returncode==0
 for value in cfg['variants']:
  assert value.encode() in source.stdout and value.encode() in source.stderr
 assert cfg['marker'].encode() in source.stdout and cfg['marker'].encode() in source.stderr
 report['emission']={'expectedRepresentations':len(cfg['variants']),'allEmittedStdout':True,'allEmittedStderr':True,'freshMarker':True}
 report['http']=json.loads(node('http-capture.mjs'))
 # Check actual installed API/worker logs privately; no source logs are saved/published.
 logs=subprocess.run(VM+COMPOSE+['logs','--since','3m','api','worker'],capture_output=True,timeout=15)
 assert logs.returncode==0
 for value in cfg['variants']: assert value.encode() not in logs.stdout+logs.stderr
 report['apiWorkerLogPlaintextMatches']=0
except BaseException as e:
 failure=type(e).__name__
 if isinstance(e,RuntimeError): report['check']=str(e)
finally:
 # Container may have been created immediately before an interruption; inspect our exact name.
 subprocess.run(VM+['docker','rm','-f',name],capture_output=True,timeout=20)
 try:
  report['cleanup']=json.loads(node('http-fixture.mjs','cleanup'))
  own=subprocess.run(VM+['docker','ps','-aq','--filter','name=^/'+name+'$'],capture_output=True,timeout=10)
  assert own.returncode==0 and not own.stdout.strip()
  for _ in range(30):
   workspaces=run(['sh','-c','find /home/paas/.noodara/deploy -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort'])
   processes=run(['ps','-eo','args'])
   if workspaces==workspaceBefore and not any(name.encode() in l and b'docker logs' in l for l in processes.splitlines()): break
   time.sleep(.5)
  assert workspaces==workspaceBefore
  assert not any(name.encode() in l and b'docker logs' in l for l in processes.splitlines())
  assert listenersBefore==run(['sh','-c',"ss -H -lnt | awk '{print $4}' | sort"])
  assert containersBefore==run(['docker','ps','--format','{{.ID}} {{.Names}}'])
  report['workspaceSetPreserved']=True;report['ownedLogProcesses']=0;report['listenersPreserved']=True;report['existingContainerIdsPreserved']=True
  report['ownedContainers']=0
 except BaseException:
  failure='cleanup-failed'
report['result']='FAIL' if failure else 'PASS'
if failure:report['errorClass']=failure
print(json.dumps(report,sort_keys=True))
raise SystemExit(1 if failure else 0)
