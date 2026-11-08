/** Tenant-scoped source snapshots. Imported business records never hit disk unencrypted. */
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {profileDataset} from '../discovery/engine.mjs';
const ID=/^[a-z][a-z0-9_-]{1,59}$/;
const assert=(v,m)=>{if(!v)throw Error(m)};
const fp=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class SourceCatalog {
  #memory=new Map();#key;
  constructor({path,tenant,key=null}) {
    assert(ID.test(tenant),'Invalid source tenant');this.tenant=tenant;
    if(key && (!Buffer.isBuffer(key)||key.length!==32))throw Error('Invalid 32-byte encryption key');
    this.#key=key?Buffer.from(key):null;
    if(this.#key){
      mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);
      this.db.exec(`CREATE TABLE IF NOT EXISTS source_snapshots(
        tenant TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,
        encrypted BLOB NOT NULL,iv BLOB NOT NULL,tag BLOB NOT NULL,
        profile TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant,id))`);
      try{chmodSync(path,0o600)}catch{}
    }
  }
  #enc(id,raw){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.#key,iv);c.setAAD(Buffer.from(`${this.tenant}:${id}`));return {iv,encrypted:Buffer.concat([c.update(raw,'utf8'),c.final()]),tag:c.getAuthTag()}}
  #dec(id,r){const d=createDecipheriv('aes-256-gcm',this.#key,r.iv);d.setAAD(Buffer.from(`${this.tenant}:${id}`));d.setAuthTag(r.tag);return Buffer.concat([d.update(r.encrypted),d.final()]).toString('utf8')}
  put({id,title,rows,kind='import'}) {
    assert(typeof id==='string'&&ID.test(id),'Invalid source ID');assert(typeof title==='string'&&title.trim()&&title.length<=120,'Invalid source name');
    assert(['import','rest','demo','mcp','database'].includes(kind),'Invalid source type');
    const profiled=profileDataset(rows),digest=fp(rows),profile={...profiled,dataDigest:digest,fields:profiled.fields.map(({examples,...metadata})=>metadata)},at=new Date().toISOString(),safe=structuredClone(rows);
    if(this.db){const cipher=this.#enc(id,JSON.stringify(safe));
      this.db.prepare(`INSERT INTO source_snapshots VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET title=excluded.title,kind=excluded.kind,encrypted=excluded.encrypted,iv=excluded.iv,tag=excluded.tag,profile=excluded.profile,updated_at=excluded.updated_at`)
        .run(this.tenant,id,title,kind,cipher.encrypted,cipher.iv,cipher.tag,JSON.stringify(profile),at);
    }else this.#memory.set(id,{id,title,kind,rows:safe,profile,updated_at:at});
    return {id,title,kind,profile,digest,updated_at:at,persistent:!!this.db};
  }
  get(id){if(this.db){const row=this.db.prepare('SELECT * FROM source_snapshots WHERE tenant=? AND id=?').get(this.tenant,id);if(!row)return null;
      return {id:row.id,title:row.title,kind:row.kind,rows:JSON.parse(this.#dec(id,row)),profile:JSON.parse(row.profile),updated_at:row.updated_at};
    }return this.#memory.has(id)?structuredClone(this.#memory.get(id)):null;
  }
  list(){if(this.db)return this.db.prepare('SELECT id,title,kind,profile,updated_at FROM source_snapshots WHERE tenant=? ORDER BY id').all(this.tenant).map(r=>({id:r.id,title:r.title,kind:r.kind,profile:JSON.parse(r.profile),updated_at:r.updated_at}));
    return [...this.#memory.values()].map(({rows,...data})=>structuredClone(data));
  }
  delete(id){if(this.db)return this.db.prepare('DELETE FROM source_snapshots WHERE tenant=? AND id=?').run(this.tenant,id).changes===1;return this.#memory.delete(id)}
  close(){if(this.#key)this.#key.fill(0);this.db?.close()}
}
/** Bounded HTTPS/loopback JSON read. IT controls the complete URL. No arbitrary URL from the model. */
export async function loadRestDataset({url,secretRef=null,credentialResolver=null,fetchImpl=fetch,headers={},extract='rows',limit=3000}){
  const u=new URL(url);
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash)throw Error('Invalid REST source URL');
  if(u.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('HTTP only allowed for local tests');
  if(!Number.isInteger(limit)||limit<1||limit>3000)throw Error('Invalid limit');
  // Provider endpoints are configured by IT, never by AI or dataset rows.
  const requestHeaders={Accept:'application/json'};
  for(const [name,value] of Object.entries(headers)){
    if(!/^x-[a-z0-9-]+$/i.test(name)||typeof value!=='string'||value.length>200)throw Error('Only fixed X-* headers allowed');
    requestHeaders[name]=value;
  }
  if(secretRef){if(typeof credentialResolver!=='function')throw Error('Credential resolver is unavailable');requestHeaders.Authorization=`Bearer ${await credentialResolver(secretRef)}`;}
  const r=await fetchImpl(u,{method:'GET',redirect:'error',headers:requestHeaders,signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`REST source returned HTTP ${r.status}`);
  const type=r.headers?.get?.('content-type')||'application/json';if(!type.includes('json'))throw Error('Expected JSON source');
  const text=await r.text();if(text.length>2_000_000)throw Error('REST response exceeds 2MB limit');
  const data=JSON.parse(text);
  const path=extract==='rows'?[]:extract.split('.');
  if(path.some(x=>!/^[a-zA-Z0-9_-]+$/.test(x)))throw Error('Invalid extraction path');
  let extracted=data;if(path.length){for(const field of path)extracted=extracted?.[field];}
  else if(!Array.isArray(extracted)) extracted=extracted?.results||extracted?.items||extracted?.data;
  if(!Array.isArray(extracted))throw Error('Cannot locate row array: choose an extraction path');
  if(extracted.length>limit)throw Error('Response too large for this connector; configure explicit pagination');
  profileDataset(extracted);return extracted;
}
