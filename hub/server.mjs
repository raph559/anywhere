import http from 'node:http';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, realpathSync} from 'node:fs';
import {resolve, dirname, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const eq=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);};
const opaque=()=>randomBytes(32).toString('base64url');
const now=()=>Date.now();
const MAX_BODY=256*1024;
const validClaudeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='claude.ai'&&!u.username&&!u.password&&(u.pathname==='/code'||u.pathname.startsWith('/code/'));}catch{return false;}};
const safeText=(value,max=4096)=>typeof value==='string'?value.slice(0,max):'';

export function createLauncher({config,statePath,publicDir=resolve(HERE,'../public'),clock=now}={}){
  if(!config?.loginTokenHash||!Array.isArray(config.devices))throw Error('Missing launcher configuration');
  const configured=new Map(config.devices.map(d=>[d.id,d]));
  let state={sessions:[],browserSessions:{},devices:{},commands:[],prefs:{deviceOrder:[],hiddenDevices:[]},enrolled:[],enrollCodes:{}};
  if(statePath&&existsSync(statePath))state={...state,...JSON.parse(readFileSync(statePath,'utf8'))};
  state.commands=state.commands.filter(c=>c.type!=='browse');
  // Devices added from the app ("Add a device") live in the state file next to the configured ones.
  if(!Array.isArray(state.enrolled))state.enrolled=[];if(!state.enrollCodes||typeof state.enrollCodes!=='object')state.enrollCodes={};
  for(const d of state.enrolled)if(!configured.has(d.id))configured.set(d.id,{...d,roots:[],defaultPath:'',enrolled:true});
  state.prefs={deviceOrder:Array.isArray(state.prefs?.deviceOrder)?state.prefs.deviceOrder:[],hiddenDevices:Array.isArray(state.prefs?.hiddenDevices)?state.prefs.hiddenDevices:[]};
  // Device order and visibility are shared by every signed-in browser.
  function orderedDevices(){const order=state.prefs.deviceOrder,rank=id=>{const i=order.indexOf(id);return i<0?order.length:i;};return [...configured.values()].map((d,i)=>[d,i]).sort((a,b)=>rank(a[0].id)-rank(b[0].id)||a[1]-b[1]).map(([d])=>({...deviceView(d),hidden:state.prefs.hiddenDevices.includes(d.id)}));}
  // Latest signed agent version, advertised to agents so they can self-update.
  let agentManifest={mtime:-1,version:null};
  function latestAgentVersion(){try{const file=resolve(publicDir,'install/agent-manifest.json'),mtime=statSync(file).mtimeMs;if(mtime!==agentManifest.mtime){const version=JSON.parse(JSON.parse(readFileSync(file,'utf8')).payload).version;agentManifest={mtime,version:Number.isInteger(version)?version:null};}return agentManifest.version;}catch{return null;}}
  const pendingBrowse=new Map(),pollWaiters=new Map(),loginAttempts=new Map();
  let saveTimer;
  function save(immediate=false){
    if(!statePath)return;
    const perform=()=>{saveTimer=undefined;mkdirSync(dirname(statePath),{recursive:true,mode:0o700});const temp=statePath+'.tmp';writeFileSync(temp,JSON.stringify(state),{mode:0o600});renameSync(temp,statePath);};
    if(immediate){clearTimeout(saveTimer);perform();}else if(!saveTimer)saveTimer=setTimeout(perform,100);
  }
  function headers(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");if(config.publicOrigin?.startsWith('https:'))res.setHeader('Strict-Transport-Security','max-age=31536000');}
  function json(res,status,value){if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
  async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(Error('Request is too large'),{status:413});chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Object.assign(Error('Invalid JSON'),{status:400});}}
  function browserSession(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('anywhere_session='))?.slice(17);const entry=token&&state.browserSessions[hash(token)];return entry&&entry.expiresAt>clock()?entry:null;}
  // Behind a reverse proxy on this machine, rate limits follow the forwarded client address.
  function clientAddress(req){const remote=req.socket.remoteAddress||'unknown';const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)&&forwarded?forwarded:remote;}
  function checkOrigin(req){const expected=config.publicOrigin||`http://${req.headers.host}`;return !req.headers.origin||req.headers.origin===expected;}
  function requireAuth(req,res,mutating=false){const session=browserSession(req);if(!session){json(res,401,{error:'Please sign in to your launcher.'});return null;}if(mutating&&(!checkOrigin(req)||!eq(req.headers['x-csrf-token'],session.csrf))){json(res,403,{error:'Refresh the page and try again.'});return null;}return session;}
  const OSES=['linux','wsl','windows'];
  function enrollCommands(code){const origin=(config.publicOrigin||'').replace(/\/$/,'');return {unix:`curl -fsSL ${origin}/install/agent.sh | sh -s -- ${origin} ${code}`,windows:`& { $h='${origin}'; $c='${code}'; irm "$h/install/agent.ps1" | iex }`};}
  function newDeviceId(name){const base=(name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'device').slice(0,40);let id=base,n=2;while(configured.has(id)||Object.values(state.enrollCodes).some(e=>e.id===id))id=`${base}-${n++}`;return id;}
  function deviceView(d){const live=state.devices[d.id]||{};return {id:d.id,name:d.name,os:d.os,enrolled:!!d.enrolled,description:d.description||'',online:clock()-(live.lastSeen||0)<45000,lastSeen:live.lastSeen||null,roots:live.roots||d.roots||[],defaultPath:live.defaultPath||d.defaultPath||'',version:live.version||'',agentVersion:live.agentVersion||'',capabilities:live.capabilities||[],latestAgentVersion:latestAgentVersion()};}
  const ACTIVE=['ready','starting'],MODES=['default','acceptEdits','bypassPermissions'];
  function sessionView(s){const d=configured.get(s.deviceId),view=d?deviceView(d):null;const {requestId,...rest}=s;return {...rest,deviceName:d?.name||s.deviceId,deviceOnline:!!view?.online,canStop:!!view?.capabilities.includes('stop'),stopping:state.commands.some(c=>c.type==='stop'&&c.args.sessionId===s.id)};}
  function command(deviceId,type,args){const item={id:randomUUID(),deviceId,type,args,createdAt:clock(),lastSent:0};state.commands.push(item);save(true);const wake=pollWaiters.get(deviceId);if(wake){pollWaiters.delete(deviceId);wake();}return item;}
  function readCommands(deviceId){const timestamp=clock();const list=state.commands.filter(c=>c.deviceId===deviceId&&(!c.lastSent||timestamp-c.lastSent>120000));for(const c of list)c.lastSent=timestamp;if(list.length)save();return list.map(({id,type,args})=>({id,type,args}));}
  function applySessionResult(s,result){
    // A stopped session is final: a later launch in that folder gets its own entry.
    if(s.status==='stopped')return;
    if(result.status==='stopped'){s.status='stopped';s.stoppedAt=s.stoppedAt||new Date(clock()).toISOString();s.updatedAt=clock();delete s.error;delete s.stopError;delete s.trustPending;delete s.confirmingNonce;return;}
    const errorMessage=safeText(typeof result.error==='string'?result.error:result.error?.message,1200);
    if(result.path)s.path=safeText(result.path);
    const candidate=result.url||result.environmentUrl||result.environment_url||result.sessionUrl||result.session_url;
    const hasValidUrl=typeof candidate==='string'&&validClaudeUrl(candidate);
    if(hasValidUrl)s.url=candidate;
    const sessionUrl=result.sessionUrl||result.session_url;
    if(sessionUrl&&validClaudeUrl(sessionUrl))s.sessionUrl=sessionUrl;
    if(result.pid)s.pid=result.pid;
    if(result.startedAt)s.startedAt=result.startedAt;
    if(Object.hasOwn(result,'trustPending')){
      const p=result.trustPending;
      if(p&&typeof p.path==='string'&&typeof p.nonce==='string'&&p.nonce.length>=16)s.trustPending={path:safeText(p.path),nonce:safeText(p.nonce,200),message:safeText(p.message,2000),kind:p.kind==='remote-control'?'remote-control':'folder'};
      else {delete s.trustPending;delete s.confirmingNonce;}
    }
    if(['error','failed','setup_required'].includes(result.status)||(result.error&&!['starting','ready','offline'].includes(result.status))){
      s.status='failed';
      s.error=errorMessage||'Claude could not start in this folder.';
    }else if(result.status==='ready'&&!hasValidUrl){
      s.status='failed';
      s.error='The device reported that Claude was ready, but did not provide a valid Claude session link. Check the device connection and try again.';
    }else if(result.status==='offline'){
      s.status='offline';
      s.error=errorMessage||'The Claude connection is offline. Check this device and try again.';
    }else if(result.status==='starting'){
      s.status='starting';
      delete s.error;
    }else if(s.url){
      s.status='ready';
      delete s.error;
    }
    s.updatedAt=clock();
    if(s.status!=='starting'){delete s.trustPending;delete s.confirmingNonce;}
  }
  // While a session starts on a device, answer its long-poll quickly so status reaches the browser within seconds.
  const launchingOn=deviceId=>state.sessions.some(s=>s.deviceId===deviceId&&s.status==='starting');
  async function agentPoll(req,res,deviceId){
    const definition=configured.get(deviceId);const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if(!definition||!bearer||!eq(hash(bearer),definition.tokenHash)){json(res,401,{error:'Invalid device credentials'});return;}
    const input=await body(req);const advertised=input.device||{};
    state.devices[deviceId]={lastSeen:clock(),version:safeText(input.version?.toString(),50),roots:Array.isArray(advertised.roots)?advertised.roots.slice(0,64).map(r=>({name:safeText(r.name,100),path:safeText(r.path)})):[],defaultPath:safeText(advertised.defaultPath),agentVersion:safeText(advertised.version?.toString(),100),capabilities:Array.isArray(advertised.capabilities)?advertised.capabilities.filter(c=>typeof c==='string').slice(0,16).map(c=>c.slice(0,32)):[]};
    const ack=[];
    for(const item of Array.isArray(input.results)?input.results.slice(0,100):[]){
      const cmd=state.commands.find(c=>c.id===item.id&&c.deviceId===deviceId);ack.push(item.id);if(!cmd)continue;
      if(cmd.type==='browse'){const callback=pendingBrowse.get(cmd.id);if(callback){pendingBrowse.delete(cmd.id);callback(item);}}
      if(cmd.type==='stop'){const session=state.sessions.find(s=>s.id===cmd.args.sessionId&&s.deviceId===deviceId);if(session){if(item.ok){applySessionResult(session,item.result||{});if(ACTIVE.includes(session.status))session.stopError='Claude is still running on this device. Try again, or stop it on the device.';}else session.stopError=safeText(typeof item.error==='string'?item.error:item.error?.message||'Claude could not be stopped.',1200);session.updatedAt=clock();}}
      if(cmd.type==='launch'||cmd.type==='confirm'){const session=state.sessions.find(s=>s.id===cmd.args.sessionId&&s.deviceId===deviceId);if(session){if(item.ok)applySessionResult(session,item.result||{});else{session.status='failed';session.error=safeText(typeof item.error==='string'?item.error:item.error?.message||'Claude could not start.',1200);session.updatedAt=clock();delete session.trustPending;delete session.confirmingNonce;}}}
      state.commands=state.commands.filter(c=>c.id!==cmd.id);
    }
    for(const update of Array.isArray(input.sessions)?input.sessions.slice(0,200):[]){const s=state.sessions.find(s=>s.deviceId===deviceId&&s.id===update.id);if(s)applySessionResult(s,update);}
    save();let commands=readCommands(deviceId);
    if(!commands.length&&!res.writableEnded&&!res.destroyed){await new Promise(resolveWait=>{let timer;const wake=()=>{clearTimeout(timer);res.off('close',wake);if(pollWaiters.get(deviceId)===wake)pollWaiters.delete(deviceId);resolveWait();};timer=setTimeout(wake,launchingOn(deviceId)?1500:15000);const old=pollWaiters.get(deviceId);if(old)old();pollWaiters.set(deviceId,wake);res.once('close',wake);});if(res.destroyed)return;commands=readCommands(deviceId);}
    json(res,200,{commands,acknowledged:ack,pollAfterMs:1000,agentVersion:latestAgentVersion()});
  }
  const server=http.createServer(async(req,res)=>{
    headers(res);
    try{
      const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);const route=url.pathname;
      if(route==='/health'){json(res,200,{ok:true});return;}
      const agentMatch=route.match(/^\/api\/agents\/([a-z0-9-]{1,64})\/poll$/);if(agentMatch&&req.method==='POST'){await agentPoll(req,res,agentMatch[1]);return;}
      if(route==='/api/status'&&req.method==='GET'){const session=browserSession(req);json(res,200,{authenticated:!!session,appName:'Anywhere',...(session?{csrfToken:session.csrf,ownerName:safeText(config.ownerName,40)}:{})});return;}
      if(route==='/api/agents/enroll'&&req.method==='POST'){
        const attempts=(loginAttempts.get('enroll')||[]).filter(t=>clock()-t<15*60000);if(attempts.length>=20){json(res,429,{error:'Too many attempts. Try again in 15 minutes.'});return;}
        const input=await body(req);const key=hash(String(input.code||'').trim().toUpperCase());const pending=state.enrollCodes[key];
        for(const [k,e] of Object.entries(state.enrollCodes))if(e.expiresAt<clock())delete state.enrollCodes[k];
        if(!pending||pending.expiresAt<clock()){attempts.push(clock());loginAttempts.set('enroll',attempts);save();json(res,404,{error:'This code is invalid or has expired. Create a new one in Anywhere.'});return;}
        delete state.enrollCodes[key];const secret=opaque();const device={id:pending.id,name:pending.name,os:pending.os,tokenHash:hash(secret),createdAt:new Date(clock()).toISOString()};
        state.enrolled.push(device);configured.set(device.id,{...device,roots:[],defaultPath:'',enrolled:true});save(true);
        json(res,200,{deviceId:device.id,deviceSecret:secret,label:device.name,hubUrl:(config.publicOrigin||'').replace(/\/$/,''),updatePublicKey:safeText(config.updatePublicKey,100)});return;
      }
      if(route==='/api/login'&&req.method==='POST'){
        if(!checkOrigin(req)){json(res,403,{error:'Invalid request origin'});return;}
        const ip=clientAddress(req);const attempts=(loginAttempts.get(ip)||[]).filter(t=>clock()-t<15*60000);if(attempts.length>=12){json(res,429,{error:'Too many sign-in attempts. Try again in 15 minutes.'});return;}
        const input=await body(req);if(!eq(hash(input.token||''),config.loginTokenHash)){attempts.push(clock());loginAttempts.set(ip,attempts);json(res,401,{error:'That access key is not correct.'});return;}
        loginAttempts.delete(ip);const token=opaque(),csrf=opaque();state.browserSessions[hash(token)]={csrf,expiresAt:clock()+30*86400000};save(true);
        res.setHeader('Set-Cookie',`anywhere_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${config.publicOrigin?.startsWith('https:')?'; Secure':''}`);json(res,200,{ok:true,csrfToken:csrf});return;
      }
      if(route.startsWith('/api/')){
        const mutation=!['GET','HEAD'].includes(req.method);if(!requireAuth(req,res,mutation))return;
        if(route==='/api/logout'&&req.method==='POST'){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('anywhere_session='))?.slice(17);if(token)delete state.browserSessions[hash(token)];save(true);res.setHeader('Set-Cookie','anywhere_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');json(res,200,{ok:true});return;}
        if(route==='/api/devices'&&req.method==='GET'){json(res,200,{devices:orderedDevices()});return;}
        if(route==='/api/enrollments'&&req.method==='POST'){
          const input=await body(req);const name=typeof input.name==='string'?input.name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,40):'';
          if(!name||!OSES.includes(input.os)){json(res,400,{error:'Give the device a name and pick its system.'});return;}
          if(!config.publicOrigin){json(res,409,{error:'Set publicOrigin in the hub configuration first.'});return;}
          const code=randomBytes(8).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g,'$1-');const id=newDeviceId(name);const expiresAt=clock()+30*60000;
          state.enrollCodes[hash(code)]={id,name,os:input.os,expiresAt};save(true);json(res,201,{deviceId:id,code,expiresAt,commands:enrollCommands(code)});return;
        }
        const forgetMatch=route.match(/^\/api\/devices\/([a-z0-9-]{1,64})$/);
        if(forgetMatch&&req.method==='DELETE'){
          const id=forgetMatch[1];const index=state.enrolled.findIndex(d=>d.id===id);if(index<0){json(res,409,{error:'Only devices added from the app can be removed here; edit the hub configuration for the others.'});return;}
          state.enrolled.splice(index,1);configured.delete(id);delete state.devices[id];state.commands=state.commands.filter(c=>c.deviceId!==id);
          state.prefs.deviceOrder=state.prefs.deviceOrder.filter(x=>x!==id);state.prefs.hiddenDevices=state.prefs.hiddenDevices.filter(x=>x!==id);save(true);json(res,200,{devices:orderedDevices()});return;
        }
        if(route==='/api/prefs'&&req.method==='PUT'){const input=await body(req);const ids=v=>Array.isArray(v)?[...new Set(v.filter(id=>typeof id==='string'&&configured.has(id)))]:null;const order=ids(input.deviceOrder),hidden=ids(input.hiddenDevices);if(order)state.prefs.deviceOrder=order;if(hidden)state.prefs.hiddenDevices=hidden;save(true);json(res,200,{devices:orderedDevices()});return;}
        if(route==='/api/browse'&&req.method==='GET'){
          const device=configured.get(url.searchParams.get('device'));if(!device){json(res,404,{error:'Unknown device'});return;}const view=deviceView(device);if(!view.online){json(res,409,{error:'This device is offline. Wake it and start its launcher connection.'});return;}
          const path=url.searchParams.get('path')||view.defaultPath;if(!path){json(res,200,{deviceId:device.id,path:'',parentPath:null,entries:[],roots:view.roots});return;}
          if(path.length>4096||path.includes('\0')){json(res,400,{error:'Invalid folder path'});return;}
          if([...pendingBrowse.values()].length>50){json(res,429,{error:'Please wait for the current folder requests.'});return;}
          const cmd=command(device.id,'browse',{path});const cleanup=()=>{pendingBrowse.delete(cmd.id);state.commands=state.commands.filter(c=>c.id!==cmd.id);save();};const result=await new Promise(resolveBrowse=>{const timer=setTimeout(()=>{cleanup();resolveBrowse({ok:false,error:'The device took too long to list this folder. Try again.'});},25000);pendingBrowse.set(cmd.id,value=>{clearTimeout(timer);resolveBrowse(value);});res.once('close',()=>{clearTimeout(timer);cleanup();resolveBrowse(null);});});
          if(result)json(res,result.ok?200:400,result.ok?{deviceId:device.id,...result.result}:{error:safeText(typeof result.error==='string'?result.error:result.error?.message||'Cannot open this folder',1200)});return;
        }
        if(route==='/api/sessions'&&req.method==='GET'){json(res,200,{sessions:state.sessions.slice(-200).reverse().map(sessionView)});return;}
        if(route==='/api/sessions'&&req.method==='POST'){
          const input=await body(req),device=configured.get(input.deviceId);if(!device){json(res,404,{error:'Unknown device'});return;}if(!deviceView(device).online){json(res,409,{error:'This device is offline.'});return;}
          if(typeof input.path!=='string'||!input.path.trim()||input.path.length>4096||input.path.includes('\0')||input.trustConfirmed!==true){json(res,400,{error:'Select and confirm a folder first.'});return;}
          if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)){json(res,400,{error:'Invalid launch request. Refresh and try again.'});return;}
          const existing=state.sessions.find(s=>s.requestId===input.requestId);if(existing){if(existing.deviceId!==input.deviceId||existing.path!==input.path){json(res,409,{error:'That request was already used for another folder.'});return;}json(res,200,{session:sessionView(existing)});return;}
          const mode=input.permissionMode===undefined?'default':input.permissionMode;if(!MODES.includes(mode)){json(res,400,{error:'Unknown permission mode.'});return;}
          if(mode!=='default'&&!deviceView(device).capabilities.includes('permission-mode')){json(res,409,{error:`The Anywhere agent on ${device.name} doesn't support permission choices yet. Use Ask, or update that agent.`});return;}
          const running=state.sessions.findLast(s=>s.deviceId===device.id&&s.path===input.path&&ACTIVE.includes(s.status));if(running){if((running.permissionMode||'default')!==mode){json(res,409,{error:'Claude is already running in this folder with other permissions. Stop it first, then start again.'});return;}json(res,200,{session:sessionView(running),reused:true});return;}
          if(state.sessions.filter(s=>s.deviceId===device.id&&s.status==='starting').length>=4){json(res,429,{error:'Wait for the other sessions to finish starting.'});return;}
          const s={id:randomUUID(),requestId:input.requestId,deviceId:device.id,path:input.path,status:'starting',permissionMode:mode,createdAt:new Date(clock()).toISOString(),updatedAt:clock()};state.sessions.push(s);if(state.sessions.length>500)state.sessions=state.sessions.slice(-500);command(device.id,'launch',{path:input.path,folderApproval:{path:input.path,approved:true},sessionId:s.id,...(mode==='default'?{}:{permissionMode:mode})});json(res,202,{session:sessionView(s)});return;
        }
        const confirmMatch=route.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/confirm$/);
        if(confirmMatch&&req.method==='POST'){
          const s=state.sessions.find(x=>x.id===confirmMatch[1]);if(!s){json(res,404,{error:'Session not found'});return;}
          const device=configured.get(s.deviceId);if(!device){json(res,404,{error:'This device is no longer configured.'});return;}
          const input=await body(req),pending=s.trustPending;
          if(s.status!=='starting'||!pending||input.trustConfirmed!==true||!eq(input.nonce,pending.nonce)){json(res,409,{error:'This confirmation has changed. Refresh the session and try again.'});return;}
          if(!deviceView(device).online){json(res,409,{error:'This device is offline.'});return;}
          if(s.confirmingNonce!==pending.nonce){s.confirmingNonce=pending.nonce;command(s.deviceId,'confirm',{sessionId:s.id,path:pending.path,nonce:pending.nonce,approved:true});}
          json(res,200,{ok:true});return;
        }
        const stopMatch=route.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/stop$/);
        if(stopMatch&&req.method==='POST'){
          const s=state.sessions.find(x=>x.id===stopMatch[1]);if(!s){json(res,404,{error:'Session not found'});return;}
          if(s.status==='stopped'){json(res,200,{session:sessionView(s)});return;}
          if(s.status==='failed'){json(res,409,{error:'This session is not running.'});return;}
          const device=configured.get(s.deviceId),view=device&&deviceView(device);if(!view){json(res,404,{error:'This device is no longer configured.'});return;}
          if(!view.online){json(res,409,{error:`${view.name} is offline, so Anywhere cannot reach it to stop Claude.`});return;}
          if(!view.capabilities.includes('stop')){json(res,409,{error:`The Anywhere agent on ${view.name} is an older version that cannot stop sessions. Update that agent, then try again.`});return;}
          delete s.stopError;if(!state.commands.some(c=>c.type==='stop'&&c.args.sessionId===s.id))command(s.deviceId,'stop',{sessionId:s.id});
          json(res,202,{session:sessionView(s)});return;
        }
        if(route==='/api/sessions/clear'&&req.method==='POST'){
          const before=state.sessions.length;state.sessions=state.sessions.filter(s=>ACTIVE.includes(s.status)||s.pinned);save(true);
          json(res,200,{removed:before-state.sessions.length});return;
        }
        const sessionMatch=route.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)$/);
        if(sessionMatch&&req.method==='PATCH'){
          const s=state.sessions.find(x=>x.id===sessionMatch[1]);if(!s){json(res,404,{error:'Session not found'});return;}
          const input=await body(req);
          if(Object.hasOwn(input,'label')){if(typeof input.label!=='string'){json(res,400,{error:'Invalid name.'});return;}const label=input.label.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60);if(label)s.label=label;else delete s.label;}
          if(Object.hasOwn(input,'pinned')){if(input.pinned===true)s.pinned=true;else delete s.pinned;}
          save(true);json(res,200,{session:sessionView(s)});return;
        }
        if(sessionMatch&&req.method==='DELETE'){
          const s=state.sessions.find(x=>x.id===sessionMatch[1]);if(!s){json(res,200,{ok:true});return;}
          const device=configured.get(s.deviceId);if(ACTIVE.includes(s.status)&&device&&deviceView(device).online){json(res,409,{error:'Stop this session before removing it.'});return;}
          state.sessions=state.sessions.filter(x=>x!==s);state.commands=state.commands.filter(c=>c.args?.sessionId!==s.id);save(true);json(res,200,{ok:true});return;
        }
        if(sessionMatch&&req.method==='GET'){const s=state.sessions.find(x=>x.id===sessionMatch[1]);json(res,s?200:404,s?{session:sessionView(s)}:{error:'Session not found'});return;}
        json(res,404,{error:'Not found'});return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){json(res,405,{error:'Method not allowed'});return;}
      let decoded;try{decoded=decodeURIComponent(route);}catch{json(res,400,{error:'Invalid path'});return;}
      const target=resolve(publicDir,'.'+(decoded==='/'?'/index.html':decoded));if(!target.startsWith(resolve(publicDir)+sep)){json(res,403,{error:'Not found'});return;}
      if(!existsSync(target)||!statSync(target).isFile()){json(res,404,{error:'Not found'});return;}
      const realRoot=realpathSync(publicDir),realTarget=realpathSync(target);if(!realTarget.startsWith(realRoot+sep)){json(res,403,{error:'Not found'});return;}
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.sh':'text/plain; charset=utf-8','.ps1':'text/plain; charset=utf-8','.py':'text/plain; charset=utf-8'};
      res.writeHead(200,{'Content-Type':types[extname(target)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(target));
    }catch(error){if(!res.writableEnded)json(res,error.status||500,{error:error.status?error.message:'The launcher could not complete this request.'});console.error(new Date().toISOString(),req.method,req.url?.split('?')[0],error.message);}
  });
  server.requestTimeout=35000;server.headersTimeout=15000;
  server.on('close',()=>{for(const wake of pollWaiters.values())wake();clearTimeout(saveTimer);save(true);});
  return {server,state,getConfig:()=>config};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const configPath=process.env.LAUNCHER_CONFIG||resolve(HERE,'../private/config.json');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  const {server}=createLauncher({config,statePath:process.env.LAUNCHER_STATE||resolve(dirname(configPath),'state.json')});
  server.listen(Number(process.env.PORT||config.port||8765),process.env.HOST||'127.0.0.1',()=>console.log('Anywhere launcher listening'));
  let stopping=false;
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
    if(stopping)return;stopping=true;
    server.close(()=>process.exit(0));
    server.closeIdleConnections();
    // Long polls and proxy keep-alives must not hold a deployment open forever.
    setTimeout(()=>server.closeAllConnections(),3000).unref();
  });
}
