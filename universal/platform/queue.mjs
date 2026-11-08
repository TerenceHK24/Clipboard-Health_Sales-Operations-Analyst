/** Durable single-attempt queue; all side effects require a recorded approval. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class DurableQueue {
  constructor(path){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS queue_jobs(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT);
    CREATE INDEX IF NOT EXISTS queue_state ON queue_jobs(state,created_at)`);
    try{chmodSync(path,0o600)}catch{}
  }
  enqueue({tenant,kind,payload,dedupeKey=null}){
    if(!tenant||!['slack-decision','execute-plan','slack-question'].includes(kind)||!payload||typeof payload!=='object')throw Error('Invalid job');
    const id=dedupeKey?hash({tenant,kind,dedupeKey}):randomUUID();
    const now=new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO queue_jobs VALUES(?,?,?,?,?,?,?,NULL)').run(id,tenant,kind,JSON.stringify(payload),'queued',now,now);
    return this.get(id);
  }
  get(id){const r=this.db.prepare('SELECT * FROM queue_jobs WHERE id=?').get(id);return r?{...r,payload:JSON.parse(r.payload)}:null}
  list(tenant){return this.db.prepare('SELECT * FROM queue_jobs WHERE tenant=? ORDER BY created_at DESC LIMIT 300').all(tenant).map(r=>({...r,payload:JSON.parse(r.payload)}))}
  claim(){
    const row=this.db.prepare("SELECT id FROM queue_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1").get();if(!row)return null;
    const n=this.db.prepare("UPDATE queue_jobs SET state='running',updated_at=? WHERE id=? AND state='queued'").run(new Date().toISOString(),row.id);
    return n.changes?this.get(row.id):null;
  }
  complete(id,state,error=''){
    if(!['done','blocked'].includes(state))throw Error('Bad state');
    const r=this.db.prepare('UPDATE queue_jobs SET state=?,error=?,updated_at=? WHERE id=? AND state=\'running\'')
      .run(state,String(error).slice(0,200),new Date().toISOString(),id);
    if(!r.changes)throw Error('Job was not running');
  }
  /** Never retry a previously running write after a crash; require manual reconciliation. */
  quarantineInterrupted(){return this.db.prepare("UPDATE queue_jobs SET state='blocked',error='Interrupted worker: inspect before resubmission',updated_at=? WHERE state='running'").run(new Date().toISOString()).changes}
  async drain(handlers,{max=20}={}){
    let processed=0;for(let i=0;i<max;i++){
      const job=this.claim();if(!job)break;processed++;
      try{if(typeof handlers[job.kind]!=='function')throw Error('Job handler not installed');
        await handlers[job.kind](job);this.complete(job.id,'done');
      }catch(e){this.complete(job.id,'blocked',e.message)}
    }return processed;
  }
  close(){this.db.close()}
}
