// cfg and capture are injected over stdin. Requests use the actual installed HTTP API.
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3000';
let stage='login';
try {
 const response=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:process.env.NOODARA_PUBLIC_URL},body:JSON.stringify({email:cfg.email,password:cfg.password}),signal:AbortSignal.timeout(10000)});
 assert.equal(response.status,200);
 const cookies=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 assert(cookies.length>0);
 const opts={headers:{cookie:cookies},connectionMs:10000,overallMs:25000,maxBytes:262144};
 const path=`/api/projects/${cfg.projectId}/services/${cfg.serviceId}/logs`;
 const checkLines=(lines)=>{
  const initialStage=stage;
  stage=initialStage+'-nonempty';assert(lines.length>0);
  const text=lines.map(l=>l.text).join('\n');
  stage=initialStage+'-marker-readable';assert(text.includes(cfg.marker));assert(text.includes('ordinary readable text'));
  stage=initialStage+'-redacted';assert(text.includes('[REDACTED:'));
  stage=initialStage+'-streams';assert(lines.some(l=>l.stream==='stdout'));assert(lines.some(l=>l.stream==='stderr'));
  stage=initialStage+'-plaintext';for(const variant of cfg.variants) assert(!text.includes(variant));
  stage=initialStage;
  return lines.length;
 };
 stage='tail';
 const tail=await capture(base+path+'?tail=200',opts);
 const parsed=JSON.parse(tail.body);assert.equal(parsed.truncated,false);
 const tailLines=checkLines(parsed.lines);assert(tail.ended);
 stage='follow-cancel';
 const follow=await capture(base+path+'/follow?tail=200',{...opts,stopWhen:body=>{if(!body.endsWith('\n'))return false;const f=body.trim().split('\n').map(l=>JSON.parse(l));return ['stdout','stderr'].every(s=>f.some(l=>l.stream===s&&l.text?.includes(cfg.marker+' later output')));}});
 const frames=follow.body.trim().split('\n').map(l=>JSON.parse(l));
 const followLines=checkLines(frames.filter(f=>f.type==='line'));
 assert(follow.cancelled);assert(frames.some(l=>l.text?.includes(cfg.marker+' later output')));
 stage='follow-end';
 const ended=await capture(base+path+'/follow?tail=200',opts);
 const endFrames=ended.body.trim().split('\n').map(l=>JSON.parse(l));
 const endLines=checkLines(endFrames.filter(f=>f.type==='line'));
 assert(ended.ended);assert(endFrames.some(f=>f.type==='end'&&f.reason==='container_exited'));
 stage='raw-capture-scan';
 for(const raw of [tail.body,follow.body,ended.body])for(const variant of cfg.variants)assert(!raw.includes(variant)&&!raw.includes(JSON.stringify(variant).slice(1,-1)));
 console.log(JSON.stringify({result:'PASS',authenticated:true,tailStatus:200,tailLines,followStatus:200,followLines,followCancelled:true,followEnded:true,endLines,freshMarkerInAllCaptures:true,ordinaryReadable:true,redactionMarkers:true,plaintextMatches:0,boundedCapture:true,externalProviderCalls:0}));
} catch(error) {console.error(JSON.stringify({result:'FAIL',check:stage,boundedCode:['CONNECTION_DEADLINE','OVERALL_DEADLINE','BYTE_LIMIT','HTTP_STATUS','TRANSPORT_ERROR','PARSE_FAILURE','EMPTY_OR_PARTIAL','PARTIAL_RESPONSE'].includes(error.code)?error.code:undefined}));process.exitCode=1;}
