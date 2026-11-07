import {createServer} from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const ORIGIN='https://agent.lolcode.fun';
const SCOPES='profile:read profile:write opportunities:read opportunities:write';
const defaultDir=()=>join(process.env.DSH_HOME||join(homedir(),'.dsh'),'credentials','dageban');
const same=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class Auth {
 constructor({dir=defaultDir(),origin=ORIGIN,fetcher=fetch}={}){
  this.dir=dir;this.origin=origin;this.fetcher=fetcher;this.file=join(dir,'oauth.json');this.lock=join(dir,'oauth.lock');
  mkdirSync(dir,{recursive:true,mode:0o700});this.pending=null;
 }
 read(){try{return JSON.parse(readFileSync(this.file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw Error('登录信息无法读取，请退出登录后重新连接。')}}
 save(value){const temp=this.file+'.'+randomBytes(8).toString('hex')+'.tmp';writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});try{renameSync(temp,this.file)}finally{if(existsSync(temp))unlinkSync(temp)}}
 async locked(fn){
  for(let i=0;i<50;i++){let fd;try{fd=openSync(this.lock,'wx',0o600);writeFileSync(fd,String(process.pid))}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(readFileSync(this.lock,'utf8'));if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0)}catch(err){if(err.code==='ESRCH'){try{unlinkSync(this.lock)}catch{};continue}}}await new Promise(r=>setTimeout(r,100));continue}
   try{return await fn()}finally{closeSync(fd);try{unlinkSync(this.lock)}catch{}}
  }throw Error('另一个搭个伴连接正在更新登录，请稍后重试。');
 }
 async request(path,body,json=false){
  const res=await this.fetcher(this.origin+path,{method:'POST',redirect:'error',headers:{'content-type':json?'application/json':'application/x-www-form-urlencoded'},body:json?JSON.stringify(body):new URLSearchParams(body),signal:AbortSignal.timeout(15000)});
  if(!res.ok){const error=new Error('授权服务暂时不可用，请稍后重试。');error.status=res.status;throw error}
  const text=await res.text();return text?JSON.parse(text):{};
 }
 validate(data){if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw Error('授权响应不完整，请重新登录。')}
 async token(){
  return this.locked(async()=>{let saved=this.read();if(!saved)throw Error('请先调用 login，在浏览器中用邮箱登录并允许授权；不要把验证码发给 AI。');
   if(saved.expires_at>Date.now()+60000)return saved.access_token;
   let data;try{data=await this.request('/oauth/token',{grant_type:'refresh_token',refresh_token:saved.refresh_token,client_id:saved.client_id,resource:this.origin+'/mcp'})}
   catch(e){if(e.status===400||e.status===401){try{unlinkSync(this.file)}catch{};throw Error('登录已失效，请重新调用 login。')}throw e}
   this.validate(data);saved={...saved,...data,expires_at:Date.now()+data.expires_in*1000};this.save(saved);return saved.access_token;
  });
 }
 async login(){
  if(this.read())return {connected:true,next:'调用 get_home 查看类别和热帖；如授权已失效，按工具提示重新登录。'};
  if(this.pending)return {authorization_url:this.pending.url,expires_in_seconds:Math.max(0,Math.ceil((this.pending.expires-Date.now())/1000))};
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  let used=false,server;const path='/callback/'+randomBytes(18).toString('hex');
  server=createServer(async(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
   if(req.headers.host!=='127.0.0.1:'+server.address().port||req.method!=='GET'){res.writeHead(403);return res.end('Invalid callback')}
   const u=new URL(req.url,'http://127.0.0.1');
   if(u.pathname!==path||used||!same(u.searchParams.get('state'),state)||u.searchParams.getAll('state').length!==1){res.writeHead(400);return res.end('授权状态无效，请回到 DeepSeek Harness 重新发起。')}
   if(u.searchParams.get('iss')!==this.origin){res.writeHead(400);return res.end('授权来源无效。')}
   used=true;
   try{if(!u.searchParams.get('code')||u.searchParams.get('error'))throw Error('cancelled');
    const data=await this.request('/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,code:u.searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect,resource:this.origin+'/mcp'});this.validate(data);
    await this.locked(async()=>this.save({...data,client_id:client.client_id,expires_at:Date.now()+data.expires_in*1000}));
    res.end('搭个伴已连接。回到 DeepSeek Harness 说：看看热门帖子和类别。');
   }catch{res.writeHead(400);res.end('授权没有完成，请回到 DeepSeek Harness 重新登录。')}
   finally{this.cancel()}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const redirect='http://127.0.0.1:'+server.address().port+path;let client;
  try{client=await this.request('/oauth/register',{client_name:'搭个伴 DeepSeek Harness',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},true);if(typeof client.client_id!=='string')throw Error('Invalid registration')}
  catch{server.close();throw Error('暂时无法发起授权，请稍后重试。')}
  const url=this.origin+'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,scope:SCOPES,resource:this.origin+'/mcp',state,code_challenge:challenge,code_challenge_method:'S256'});
  this.pending={url,server,expires:Date.now()+600000,timer:setTimeout(()=>this.cancel(),600000)};
  return {authorization_url:url,expires_in_seconds:600,instructions:'在运行 DeepSeek Harness 的电脑浏览器打开链接，用邮箱验证码登录并允许授权；返回后调用 get_home。验证码仅填网页。'};
 }
 cancel(){if(this.pending){clearTimeout(this.pending.timer);this.pending.server.close();this.pending=null}}
 async logout(){this.cancel();return this.locked(async()=>{const value=this.read();let revoked=true;if(value){try{await this.request('/oauth/revoke',{token:value.refresh_token,client_id:value.client_id,token_type_hint:'refresh_token'})}catch{revoked=false}unlinkSync(this.file)}return {local_signed_out:true,server_revoked:revoked,instructions:revoked?'已退出搭个伴。':'本机登录已清除。远端撤销暂时失败，可在搭个伴账号页移除授权。'}})}
}

