/** Self-hosted encrypted credential storage, AES-256-GCM. Master key is never stored here. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync,mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const REF=/^vault:\/\/[a-zA-Z0-9/_-]{3,180}$/;
const ensure=(condition,msg)=>{if(!condition)throw Error(msg)};
export function parseMasterKey(input) {
  if(!input)return null;
  if(typeof input!=='string'||!/^[a-f0-9]{64}$/i.test(input))throw Error('OPS_AGENT_MASTER_KEY must be 64 hexadecimal characters (32 bytes)');
  return Buffer.from(input,'hex');
}
export class LocalVault {
  #key;
  constructor({path,tenant,key}){
    ensure(typeof tenant==='string'&&/^[a-z0-9_-]+$/i.test(tenant),'Invalid vault tenant');
    ensure(Buffer.isBuffer(key)&&key.length===32,'A 32-byte master key is required for persistent credentials');
    this.#key=Buffer.from(key);this.tenant=tenant;
    mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS vault_items(tenant TEXT NOT NULL, ref TEXT NOT NULL, cipher BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, updated_at TEXT NOT NULL,PRIMARY KEY(tenant,ref))`);
    try{chmodSync(path,0o600)}catch{}
  }
  set(ref,value){
    ensure(typeof ref==='string'&&REF.test(ref),'Invalid vault:// reference');
    ensure(typeof value==='string'&&value.trim()&&value.length<16000,'Invalid secret');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);
    cipher.setAAD(Buffer.from(`${this.tenant}:${ref}`));
    const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]),tag=cipher.getAuthTag();
    this.db.prepare(`INSERT INTO vault_items VALUES (?,?,?,?,?,?) ON CONFLICT(tenant,ref) DO UPDATE SET cipher=excluded.cipher,iv=excluded.iv,tag=excluded.tag,updated_at=excluded.updated_at`)
      .run(this.tenant,ref,encrypted,iv,tag,new Date().toISOString());
    return {ref,stored:true};
  }
  get(ref){
    ensure(typeof ref==='string'&&REF.test(ref),'Invalid vault:// reference');
    const row=this.db.prepare('SELECT * FROM vault_items WHERE tenant=? AND ref=?').get(this.tenant,ref);
    if(!row)throw Error('Credential reference not configured');
    const dec=createDecipheriv('aes-256-gcm',this.#key,row.iv);
    dec.setAAD(Buffer.from(`${this.tenant}:${ref}`));dec.setAuthTag(row.tag);
    return Buffer.concat([dec.update(row.cipher),dec.final()]).toString('utf8');
  }
  has(ref){return !!this.db.prepare('SELECT 1 FROM vault_items WHERE tenant=? AND ref=?').get(this.tenant,ref)}
  delete(ref){return this.db.prepare('DELETE FROM vault_items WHERE tenant=? AND ref=?').run(this.tenant,ref).changes===1}
  close(){this.#key.fill(0);this.db.close()}
}
export function makeCredentialResolver({vault=null,env=process.env}={}){
  return async ref=>{
    if(typeof ref!=='string')throw Error('Secret reference required');
    if(ref.startsWith('vault://')){
      if(!vault)throw Error('Encrypted vault is not configured');return vault.get(ref);
    }
    if(/^env:\/\/[A-Z][A-Z0-9_]{2,79}$/.test(ref)){
      const value=env[ref.slice(6)];if(!value)throw Error('Environment credential missing');return value;
    }
    throw Error('Unsupported secret reference');
  };
}
