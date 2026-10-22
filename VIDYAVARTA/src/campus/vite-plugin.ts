import type { Plugin } from 'vite';
import { ZodError } from 'zod';
import { resolve } from 'node:path';
import { createBridge, type Bridge } from './server';
import { loadLocalEnv, envReport } from './env';
/** Live-only developer UI. The bridge binds to loopback and never to a public host. */
const runtime=globalThis as typeof globalThis & {__vidyaBridge?:Bridge};
export function campusPlugin():Plugin{let bridge:Bridge|undefined;return {name:'vidyavarta-campus',async closeBundle(){await bridge?.close();if(runtime.__vidyaBridge===bridge)delete runtime.__vidyaBridge;bridge=undefined;},async configureServer(server){
  loadLocalEnv();
  // Vite constructs the replacement server before closing the old plugin container.
  // A process-wide handoff avoids leaking a loopback listener during hot restart.
  await runtime.__vidyaBridge?.close();
  delete runtime.__vidyaBridge;
  const exposed=!['127.0.0.1','localhost','::1'].includes(String(server.config.server.host));
  if(exposed)throw new Error('Live mode must use --host 127.0.0.1. Never expose faculty controls publicly.');
  const envInfo=loadLocalEnv();
  const active=await createBridge({directory:resolve(process.env.CAMPUS_DATA_DIR??'.campus-live'),port:Number(process.env.CAMPUS_PORT??4318)});
  bridge=active;runtime.__vidyaBridge=active;
  console.log(`[VidyaVarta] v1.0.0 | mode: LIVE${envInfo.loaded?` | .env loaded (${envInfo.keys.length} keys)`:envReport().loaded?'':' | no .env file found'}`);
  console.log(`[VidyaVarta] email: ${active.service.integrations.smtpReady?'configured':'NOT configured (need SMTP_HOST, SMTP_FROM, SMTP_ALLOWLIST in .env)'} | classroom: ${active.service.integrations.classroomReady?'configured':'NOT configured (need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)'}`);
  console.log(`[VidyaVarta] bridge at 127.0.0.1:${active.port}; SQLite + audit ready`);
  server.middlewares.use(async(req,res,next)=>{
    if(!req.url?.startsWith('/api/')&&req.url!=='/board')return next();
    {
      const host=req.headers.host??'';
      let name='';try{name=new URL('http://'+host).hostname;}catch{}
      if(!['127.0.0.1','localhost','[::1]'].includes(name)|| (req.headers.origin && new URL(req.headers.origin).host!==host)){res.statusCode=403;res.end('Untrusted live UI host/origin.');return;}
    }
    if(req.headers['sec-fetch-site']==='cross-site'){res.statusCode=403;res.end('Cross-site request denied.');return;}
    if(req.url==='/board'){const {html}=await active.request('GET','/api/board',undefined,{agent:'System',behalf:'operator',human:true}) as {html:string};res.setHeader('Content-Type','text/html');res.end(html);return;}
    const reply=(status:number,data:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));};
    const readBody=async()=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100_000){reply(413,{error:'Request too large.'});return undefined;}}return raw?JSON.parse(raw):{};};
    const cookies=Object.fromEntries((req.headers.cookie??'').split(';').map(c=>{const i=c.indexOf('=');return i<0?[c.trim(),'']:[c.slice(0,i).trim(),decodeURIComponent(c.slice(i+1).trim())];}).filter(([k])=>k));
    const token=cookies['campus_session']??'';const method=req.method??'GET';
    try{
      if(req.url==='/api/auth/login'&&method==='POST'){const body=await readBody();if(body===undefined)return;const result=active.auth.login(body,req.socket.remoteAddress??'unknown');res.setHeader('Set-Cookie',`campus_session=${result.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${active.auth.sessionHours*3600}`);reply(200,{user:result.user,expiresAt:result.expiresAt});return;}
      if(req.url==='/api/auth/me'){reply(200,{user:active.auth.userForToken(token)});return;}
      if(req.url==='/api/auth/list'){const lu=active.auth.userForToken(token);if(!lu){reply(401,{error:'Sign in to continue.'});return;}reply(200,{users:active.auth.listUsers(lu)});return;}
      if(req.url==='/api/auth/logout'&&method==='POST'){if(token)active.auth.logout(token);res.setHeader('Set-Cookie','campus_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');reply(200,{ok:true});return;}
      if(req.url==='/api/auth/create'&&method==='POST'){const user=active.auth.userForToken(token);if(!user){reply(401,{error:'Sign in to continue.'});return;}const body=await readBody();if(body===undefined)return;reply(200,{user:active.auth.createUser(user,body)});return;}
      if(req.url==='/api/auth/password'&&method==='POST'){const user=active.auth.userForToken(token);if(!user){reply(401,{error:'Sign in to continue.'});return;}const body=await readBody();if(body===undefined)return;active.auth.changePassword(user,body);reply(200,{ok:true,signedOut:true});return;}
      if(req.url==='/api/health'){reply(200,await active.request('GET','/api/health',undefined,{agent:'System',behalf:'status'}));return;}
      const user=active.auth.userForToken(token);
      if(!user){reply(401,{error:'Sign in to continue.'});return;}
      if(user.role==='viewer'&&method==='POST'){active.service.store.audit({agent:'System',behalf:'auth'},'auth.access_denied',req.url??'unknown','Write denied for the read-only guest account.');reply(403,{error:'This is a read-only account.'});return;}
      const body=method==='GET'?undefined:await readBody();if(body===undefined&&method!=='GET')return;
      reply(200,await active.request(method,req.url??'/',body,active.auth.actorFor(user)));
    }catch(e){const status=e && typeof e==='object'&&'status'in e?Number((e as {status:number}).status):400;const msg=e instanceof ZodError?e.issues.map(i=>`${i.path.length?i.path.join('.')+': ':''}${i.message}`).join('; '):(e as Error).message;reply(status,{error:msg});}
  });

}};}
