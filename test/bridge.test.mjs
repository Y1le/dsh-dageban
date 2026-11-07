import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Bridge} from '../bridge.mjs';import {Auth} from '../auth.mjs';
const call=(name,args={})=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
test('catalog available before login; no category admin, messages, or payment tools',async()=>{
 const bridge=new Bridge({token(){throw Error('请先 login')},read(){return null}},()=>{throw Error('must not fetch')});
 const r=await bridge.dispatch({jsonrpc:'2.0',id:1,method:'tools/list'});
 assert.equal(r.result.tools.length,17);assert(r.result.tools.some(t=>t.name==='get_home'));
 for(const t of r.result.tools)assert(!['manage_category','request_category_opening','send_message','publish_opportunity'].includes(t.name));
 assert.equal((await bridge.dispatch(call('get_home'))).result.isError,true);
 assert.equal((await bridge.dispatch(call('manage_category'))).error.code,-32602);
});
test('proxy preserves confirmation, idempotency and argument content',async()=>{
 let sent;const bridge=new Bridge({origin:'https://agent.lolcode.fun',token:async()=>'test-only-secret'},async(url,opts)=>{sent={url,...opts};return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'{"post":"p1"}'}]}}))});
 const args={request_id:'same-key-123',draft_id:'d1',expected_version:3,confirmed:true,policy_version:'x'};
 const r=await bridge.dispatch(call('publish_draft',args));assert.deepEqual(JSON.parse(sent.body).params.arguments,args);assert(!JSON.stringify(r).includes('test-only-secret'));assert.equal(sent.redirect,'error');
});
test('callback rejects bad state and issuer; PKCE succeeds once; logout revokes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-auth-test-'));let exchanges=0,revoked=false,registration;const auth=new Auth({dir,fetcher:async(url,opts)=>{
  if(url.endsWith('/register')){registration=JSON.parse(opts.body);return new Response(JSON.stringify({client_id:'test-client'}))}
  if(url.endsWith('/revoke')){revoked=true;return new Response(null,{status:204})}
  exchanges++;assert(new URLSearchParams(opts.body).get('code_verifier'));return new Response(JSON.stringify({access_token:'access-test',refresh_token:'refresh-test',expires_in:3600}))
 }});
 try{
  const res=await auth.login(),u=new URL(res.authorization_url),redirect=u.searchParams.get('redirect_uri');
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert(!u.searchParams.get('scope').includes('manage'));
  const bad=new URL(redirect);bad.searchParams.set('state','wrong');bad.searchParams.set('iss','https://agent.lolcode.fun');bad.searchParams.set('code','fixture');
  assert.equal((await fetch(bad)).status,400);assert.equal(exchanges,0);
  bad.searchParams.set('state',u.searchParams.get('state'));bad.searchParams.set('iss','https://evil.invalid');assert.equal((await fetch(bad)).status,400);
  bad.searchParams.set('iss','https://agent.lolcode.fun');assert.equal((await fetch(bad)).status,200);assert.equal(exchanges,1);assert.equal(await auth.token(),'access-test');assert.equal((await auth.logout()).server_revoked,true);assert.equal(auth.read(),null);assert(revoked);
 }finally{auth.cancel()}
});
test('concurrent refresh rotates token once and resumes from local storage',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-refresh-test-'));let calls=0;const fetcher=async()=>{calls++;await new Promise(r=>setTimeout(r,20));return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}))};
 const a=new Auth({dir,fetcher}),b=new Auth({dir,fetcher});a.save({client_id:'client',access_token:'expired',refresh_token:'old',expires_at:0});
 const tokens=await Promise.all([a.token(),b.token()]);assert.deepEqual(tokens,['new-access','new-access']);assert.equal(calls,1);assert.equal(new Auth({dir}).read().refresh_token,'new-refresh');
});

