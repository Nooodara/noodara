#!/usr/bin/env python3
"""Existing-admin HTTP login/sign-out only; private input and cookie never printed."""
import json,subprocess,sys,uuid
from pathlib import Path
vm=['limactl','shell','noodara-uat']
cookie='/tmp/noodara-stable-auth-'+uuid.uuid4().hex
base='http://localhost:3000'
def call(path,body):
 args=['curl','-fsS','--connect-timeout','5','--max-time','20','--max-filesize','262144','-b',cookie,'-c',cookie,'-H','Origin: '+base,'-H','content-type: application/json','-X','POST','--data-binary','@-',base+path]
 r=subprocess.run(vm+args,input=json.dumps(body).encode(),capture_output=True,timeout=30)
 assert r.returncode==0 and 0<len(r.stdout)<=262144,'bounded-auth-http-failed'
 return json.loads(r.stdout)
try:
 r=subprocess.run(vm+['sh','-c','umask 077; : > "$1"','sh',cookie],capture_output=True,timeout=15);assert r.returncode==0
 result=call('/api/auth/sign-in/email',json.loads(Path(sys.argv[1]).read_text()))
 assert result.get('user') and result['user'].get('id'),'existing-admin-login-failed'
 result=call('/api/auth/sign-out',{})
 assert result.get('success') is True,'sign-out-failed'
 print(json.dumps({'existingAdminLogin':True,'signOut':True,'providerCalls':0,'result':'PASS'}))
finally:
 r=subprocess.run(vm+['rm','-f',cookie],capture_output=True,timeout=15);assert r.returncode==0,'owned-cookie-cleanup-failed'
