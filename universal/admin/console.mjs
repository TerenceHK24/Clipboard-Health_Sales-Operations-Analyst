/** Loopback-only IT admin console. Configures manifests / RBAC, not API keys.
 * The access key is ephemeral and only supplied via URL fragment (never server logs).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const originHost=/^127\.0\.0\.1:\d{1,5}$/;
const staticFiles=new Map([
  ['/',['index.html','text/html; charset=utf-8']],
  ['/admin.js',['admin.js','text/javascript; charset=utf-8']],
  ['/admin.css',['admin.css','text/css; charset=utf-8']],
]);
function auth(raw,expected){const x=Buffer.from(typeof raw==='string'?raw:'');const y=Buffer.from(expected);return x.length===y.length && timingSafeEqual(x,y)}
export async function startCompanyAdminConsole({registry,policyStore,connectionProbes={},port=0,host='127.0.0.1',adminActor='it-admin'}){
  if(host!=='127.0.0.1' || !registry || !policyStore)throw Error('Admin console only permits local host with a policy store');
  const key=randomBytes(24).toString('hex');
  const server=createServer(async (req,res)=>{
    const send=(code,payload)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload))};
    try{
      const requestHost=req.headers.host || '';
      if(!originHost.test(requestHost))return send(403,{error:'Invalid host'});
      const requestOrigin=`http://${requestHost}`;
      const route=req.url?.split('?')[0];
      if(req.method==='GET' && staticFiles.has(route)){
        const [filename,mime]=staticFiles.get(route);
        const raw=await readFile(new URL('./'+filename,import.meta.url));
        res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"});
        res.end(raw);return;
      }
      if(!auth(req.headers['x-admin-key'],key))return send(401,{error:'Unauthorized'});
      if(req.method==='GET' && route==='/api/config')return send(200,policyStore.snapshot(registry));
      if(req.method!=='POST' || !['/api/connection','/api/capability','/api/approver','/api/test'].includes(route))return send(404,{error:'Unknown action'});
      if(req.headers.origin!==requestOrigin)return send(403,{error:'Invalid origin'});
      if(req.headers['content-type']?.split(';')[0]!=='application/json')return send(415,{error:'JSON required'});
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>16000)throw Error('Request too large');chunks.push(chunk)}
      const args=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!args || typeof args!=='object' || Array.isArray(args))throw Error('Expected JSON object');
      // Credential strings are not accepted anywhere, even by an honest IT user.
      if(JSON.stringify(args).match(/"(?:token|apiKey|password|secret|authorization)"\s*:/i))throw Error('Never paste an API key. Use a vault:// reference.');
      let updated;
      if(route==='/api/connection')updated=policyStore.upsertConnection({...args,actor:adminActor});
      if(route==='/api/capability')updated=policyStore.upsertCapability({...args,actor:adminActor,registry});
      if(route==='/api/approver'){policyStore.setSlackUser({...args,actor:adminActor});updated={ok:true};}
      if(route==='/api/test'){
        const conn=policyStore.connection(args.id);
        if(!conn)throw Error('Unknown connector');
        const probe=connectionProbes[conn.provider];
        if(typeof probe!=='function')throw Error('Provider probe not configured; connection remains unverified');
        // Network probe gets only non-secret metadata + host-resolved credentials.
        try{if(await probe({...conn,secret_ref:conn.secret_ref})!==true)throw Error('Probe failed');
          policyStore.setConnectionState(conn.connector_id,'verified',adminActor);
        }catch(e){policyStore.setConnectionState(conn.connector_id,'needs_attention',adminActor);throw e}
        updated=policyStore.connection(conn.connector_id);
      }
      return send(200,{saved:true,updated});
    }catch(error){return send(400,{error:String(error.message).slice(0,220)})}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});
  const url=`http://127.0.0.1:${server.address().port}/`;
  return {url:`${url}#${key}`,origin:url.slice(0,-1),key,server,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
