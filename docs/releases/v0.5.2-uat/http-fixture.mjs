// cfg is injected privately over stdin by installed-http.py; no synthetic value is printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('/app/apps/control-plane/package.json');
const {eq} = await import(require.resolve('drizzle-orm'));
const {secretValue} = await import(require.resolve('@noodara/domain/security'));
const {createDb} = await import('/app/apps/control-plane/dist/db/client.js');
const {services,secrets,users,accounts,sessions} = await import('/app/apps/control-plane/dist/db/schema/index.js');
const {masterKeysFromEnvironment} = await import('/app/apps/control-plane/dist/services/service-credentials.js');
const {currentKeyVersion} = await import('/app/apps/control-plane/dist/services/credential-store.js');
const {encodeSecret} = await import('/app/apps/control-plane/dist/secrets/secret-store.js');
const {hashPassword} = await import('/app/apps/control-plane/dist/auth/password-hasher.js');
const {db,pool} = createDb(process.env.DATABASE_URL);
try {
 if(cfg.action==='setup') {
  const [source]=await db.select().from(services).where(eq(services.name,'node-api')).limit(1);
  assert(source);
  // Existing hosted target was discovered as this very VM's Docker daemon; no source fixture is changed.
  await db.transaction(async tx=>{
   await tx.insert(users).values({id:cfg.userId,name:'Disposable RC HTTP UAT',email:cfg.email,emailVerified:true});
   await tx.insert(accounts).values({id:cfg.accountId,userId:cfg.userId,accountId:cfg.userId,providerId:'credential',password:await hashPassword(cfg.password)});
   await tx.insert(services).values({id:cfg.serviceId,name:cfg.marker,projectId:source.projectId,environmentId:source.environmentId,serverId:source.serverId,sourceType:'image',imageRef:'ghcr.io/nooodara/noodara-control-plane:0.5.2-rc.1',internalPort:3000});
   const keys=await masterKeysFromEnvironment()();
   for(const [i,value] of cfg.values.entries()) await tx.insert(secrets).values({scope:'service',projectId:source.projectId,serviceId:cfg.serviceId,name:'uat_http_'+i,...encodeSecret(secretValue(value,'app_secret'),{key:keys.current,version:await currentKeyVersion(tx)})});
  });
  console.log(JSON.stringify({projectId:source.projectId,serverId:source.serverId}));
 } else {
  await db.delete(services).where(eq(services.id,cfg.serviceId));
  await db.delete(users).where(eq(users.id,cfg.userId));
  for(const [table,column,id] of [[services,services.id,cfg.serviceId],[secrets,secrets.serviceId,cfg.serviceId],[users,users.id,cfg.userId],[accounts,accounts.userId,cfg.userId],[sessions,sessions.userId,cfg.userId]]) assert.equal((await db.select().from(table).where(eq(column,id))).length,0);
  console.log(JSON.stringify({ownedFixtureRows:0,fixturesRestored:true}));
 }
} catch {console.error(JSON.stringify({result:'FAIL',check:'fixture-'+cfg.action}));process.exitCode=1;}
finally {await pool.end();}
