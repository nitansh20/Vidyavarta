import { createServer, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createBridge } from '../server';
import { AuthError } from '../auth';
import { loadLocalEnv, envReport } from '../env';
import type { Actor } from '../types';
const home=resolve(__dirname);
const directory=resolve(process.env.CAMPUS_DATA_DIR??join(home,'data'));
const web=join(home,'web');
const preview=process.env.CAMPUS_PREVIEW==='1';
const host=preview?'0.0.0.0':'127.0.0.1';
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon'};
async function main(){
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('This ready package needs Node.js 24 or newer. Your version: '+process.version);
  if(!existsSync(join(web,'index.html')))throw new Error('The web folder is missing. Extract the WHOLE ZIP before starting, not just the launcher.');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const lock=join(directory,'running.json');
  if(existsSync(lock)){
    try { const previous=JSON.parse(readFileSync(lock,'utf8'));if(previous.pid){try{process.kill(previous.pid,0);console.log('\nVidyaVarta is already running. Open: '+previous.url+'\n');openBrowser(previous.url);return;}catch{ /* old process ended */ }} }catch{/* stale lock */}
  }
  // Live portable runtime: same full product as `npm run dev:live`, zero npm install.
  // Configure .env (next to the launcher) for email/Classroom; CAMPUS_ADMIN_PASSWORD
  // chooses the initial admin password, otherwise a random one is generated once.
  loadLocalEnv(home);
  const bridge=await createBridge({directory,port:0,scheduled:true});
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url??'/','http://127.0.0.1');
      const requestHost=req.headers.host??'';
      const hostname=new URL('http://'+requestHost).hostname;
      if(!preview&&!['127.0.0.1','localhost','[::1]'].includes(hostname)){json(res,403,{error:'This app is a private local control room.'});return;}
      if(req.headers['sec-fetch-site']==='cross-site' || (!preview&&req.headers.origin&&new URL(req.headers.origin).host!==requestHost)){json(res,403,{error:'Cross-origin requests are not allowed.'});return;}
      if(url.pathname==='/api/runtime'){json(res,200,{readyPackage:true,node:process.version,mode:'live',version:'1.0.0',offlineReady:true,database:'Node built-in SQLite',installationRequired:false});return;}
      if(url.pathname.startsWith('/api/')){
        const method=req.method??'GET';if(!['GET','POST'].includes(method)){json(res,405,{error:'Method not allowed.'});return;}
        const readBody=async()=>{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>100_000){json(res,413,{error:'Request exceeds 100 KB.'});return undefined;}}return raw?JSON.parse(raw):{};};
        const cookies=Object.fromEntries((req.headers.cookie??'').split(';').map(c=>{const i=c.indexOf('=');return i<0?[c.trim(),'']:[c.slice(0,i).trim(),decodeURIComponent(c.slice(i+1).trim())];}).filter(([k])=>k));
        const token=cookies['campus_session']??'';const ip=req.socket.remoteAddress??'unknown';
        const fail=(e:unknown)=>{const msg=e instanceof ZodError?e.issues.map(i=>`${i.path.length?i.path.join('.')+': ':''}${i.message}`).join('; '):(e as Error).message;json(res,e instanceof AuthError?e.status:400,{error:msg});};
        if(url.pathname==='/api/auth/login'&&method==='POST'){const body=await readBody();if(body===undefined)return;try{const result=bridge.auth.login(body,ip);res.setHeader('Set-Cookie',`campus_session=${result.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${bridge.auth.sessionHours*3600}`);json(res,200,{user:result.user,expiresAt:result.expiresAt});}catch(e){fail(e);}return;}
        if(url.pathname==='/api/auth/me'&&method==='GET'){const user=bridge.auth.userForToken(token);json(res,200,{user});return;}
        if(url.pathname==='/api/auth/list'&&method==='GET'){const lu=bridge.auth.userForToken(token);if(!lu){json(res,401,{error:'Sign in to continue.'});return;}try{json(res,200,{users:bridge.auth.listUsers(lu)});}catch(e){fail(e);}return;}
        if(url.pathname==='/api/auth/logout'&&method==='POST'){if(token)bridge.auth.logout(token);res.setHeader('Set-Cookie','campus_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');json(res,200,{ok:true});return;}
        if(url.pathname==='/api/auth/create'&&method==='POST'){const user=bridge.auth.userForToken(token);if(!user){json(res,401,{error:'Sign in to continue.'});return;}const body=await readBody();if(body===undefined)return;try{json(res,200,{user:bridge.auth.createUser(user,body)});}catch(e){fail(e);}return;}
        if(url.pathname==='/api/auth/password'&&method==='POST'){const user=bridge.auth.userForToken(token);if(!user){json(res,401,{error:'Sign in to continue.'});return;}const body=await readBody();if(body===undefined)return;try{bridge.auth.changePassword(user,body);json(res,200,{ok:true,signedOut:true});}catch(e){fail(e);}return;}
        if(url.pathname==='/api/health'){json(res,200,await bridge.request('GET','/api/health',undefined,{agent:'System',behalf:'status'}));return;}
        const user=bridge.auth.userForToken(token);
        if(!user){json(res,401,{error:'Sign in to continue.'});return;}
        if(user.role==='viewer'&&method==='POST'){bridge.service.store.audit({agent:'System',behalf:'auth'},'auth.access_denied',url.pathname,'Write denied for the read-only guest account.');json(res,403,{error:'This is a read-only account.'});return;}
        const actor:Actor=bridge.auth.actorFor(user);
        const body=await readBody();if(body===undefined)return;
        const result=await bridge.request(method,url.pathname+url.search,body,actor);json(res,200,result);return;
      }
      if(url.pathname==='/board') {const result=await bridge.request('GET','/api/board',undefined,{agent:'System',behalf:'operator'}) as {html:string};res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(result.html);return;}
      if(!['GET','HEAD'].includes(req.method??'')){json(res,405,{error:'Method not allowed.'});return;}
      const file=resolve(web,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!file.startsWith(web+sep)||!existsSync(file)||!statSync(file).isFile()){json(res,404,{error:'File not found.'});return;}
      res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      res.end(req.method==='HEAD'?undefined:readFileSync(file));
    } catch(e){json(res,400,{error:(e as Error).message});}
  });
  server.requestTimeout=30_000;
  let port=Number(process.env.CAMPUS_UI_PORT??5173);
  if(!Number.isInteger(port)||port<1024||port>65000)throw new Error('CAMPUS_UI_PORT must be an integer between 1024 and 65000.');
  // Another application already on 5173? Pick the next free port instead of crashing.
  for(let attempt=0;attempt<20;attempt++){
    try{await new Promise<void>((yes,no)=>{const error=(e:Error)=>{server.off('listening',success);no(e);};const success=()=>{server.off('error',error);yes();};server.once('error',error);server.once('listening',success);server.listen(port,host);});break;}
    catch(e){if((e as NodeJS.ErrnoException).code==='EADDRINUSE'&&attempt<19){port++;continue;}await bridge.close();throw e;}
  }
  const url=`http://127.0.0.1:${port}/`;
  writeFileSync(lock,JSON.stringify({pid:process.pid,url}),{mode:0o600});
  const envInfo=envReport();
  console.log(`\n============================================================\n  VIDYAVARTA  |  LIVE MODE\n============================================================\n  Open:       ${url}\n  Runtime:    Node ${process.versions.node}\n  Storage:    Built-in SQLite (no native module installation)\n  Mode:       LIVE - real sign-ins, real delivery when configured\n  Data:       ${directory}${envInfo.loaded?`\n  Config:     .env loaded (${envInfo.keys.length} keys)`:''}\n\n  First sign-in:  admin / <initial password> (see admin-password.txt in Data)\n  ${bridge.service.integrations.smtpReady?'Email: configured':'Email: NOT configured (SMTP_HOST, SMTP_FROM, SMTP_ALLOWLIST in .env)'}\n  ${bridge.service.integrations.classroomReady?'Classroom: configured':'Classroom: NOT configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET in .env)'}\n  Public website scans need internet. Ctrl+C stops the app.\n============================================================\n`);
  if(process.env.CAMPUS_NO_OPEN!=='1'&&!preview)openBrowser(url);
  let closing=false;const close=async()=>{if(closing)return;closing=true;await new Promise<void>(r=>server.close(()=>r()));await bridge.close();try{unlinkSync(lock);}catch{}process.exit(0);};
  process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
}
function openBrowser(url:string){
  if(!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))return;
  const args=process.platform==='win32'?['cmd',['/c','start','',url]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
  const child=spawn(args[0] as string,args[1] as string[],{stdio:'ignore',detached:true,windowsHide:true});child.on('error',()=>{});child.unref();
}
main().catch(e=>{console.error('\nCould not start VidyaVarta: '+(e as Error).message+'\n');process.exitCode=1;});
