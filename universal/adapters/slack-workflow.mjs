/** Rich Slack workflows (Block Kit, native confirm, evidence modal, ask-agent modal).
 * The gateway is provider-agnostic about the plan's business action; it only approves
 * immutable plan IDs. Slack callbacks NEVER directly modify a CRM.
 * A host is responsible for HTTPS, OAuth installation, the worker queue and execution.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { verifySlackRequest } from './slack.mjs';

const ID=/^[a-f0-9]{48}$/;
const clean = (text, max=500) => {
  const value=String(text??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
  // Do not expose obvious token strings even if an untrusted model provided them.
  return value.replace(/\bbh_[A-Za-z0-9_-]{12,}\b/g,'[REDACTED]')
    .replace(/\b(?:sk-proj-|ghp_|github_pat_)[a-zA-Z0-9_-]{12,}\b/g,'[REDACTED]');
};
const escapeMrkdwn = text => clean(text,700).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const plain = text => ({type:'plain_text',text:clean(text,150) || '—',emoji:false});
function assert(x,msg){if(!x)throw Error(msg)}

export class SlackApprovalStore {
  constructor(path) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS slack_approval_requests (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, team_id TEXT NOT NULL,
      channel TEXT NOT NULL, finding TEXT NOT NULL, plan_id TEXT NOT NULL,
      plan_digest TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL,
      message_ts TEXT, actor TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_qa_events (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    try{chmodSync(path,0o600)}catch{/* Windows ACLs */}
  }
  close(){this.db.close()}
  create({tenant,teamId,channel,findingId,planId,planDigest,ttlMs=900000}){
    assert([tenant,teamId,channel,findingId,planId,planDigest].every(x=>typeof x==='string' && x.trim()),'Missing approval identity');
    assert(ttlMs>0 && ttlMs<=3600000,'Approval expiry must be within one hour');
    const id=randomBytes(24).toString('hex');
    this.db.prepare('INSERT INTO slack_approval_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,tenant,teamId,channel,findingId,planId,planDigest,'pending',Date.now()+ttlMs,null,null,new Date().toISOString());
    return this.get(id);
  }
  get(id){ if(typeof id!=='string' || !ID.test(id))return null;
    return this.db.prepare('SELECT * FROM slack_approval_requests WHERE id=?').get(id)||null;
  }
  status(id,status,actor=null) {
    assert(['delivered','delivery_failed','pending','approved','rejected','blocked'].includes(status),'Invalid status');
    this.db.prepare('UPDATE slack_approval_requests SET status=?,actor=?,updated_at=? WHERE id=?').run(status,actor,new Date().toISOString(),id);
  }
  markDelivered(id,ts) {this.db.prepare('UPDATE slack_approval_requests SET message_ts=?,updated_at=? WHERE id=?')
    .run(ts,new Date().toISOString(),id)}
  /** Atomic reservation guards double-clicks and simultaneous callbacks across processes. */
  claim(id,actor){
    const result=this.db.prepare(`UPDATE slack_approval_requests SET status='processing',actor=?,updated_at=?
      WHERE id=? AND status='pending' AND expires>?`).run(actor,new Date().toISOString(),id,Date.now());
    return result.changes===1;
  }
  complete(id,action){assert(['approved','rejected','blocked'].includes(action),'Invalid final status');
    this.db.prepare("UPDATE slack_approval_requests SET status=?,updated_at=? WHERE id=? AND status='processing'")
      .run(action,new Date().toISOString(),id);
  }
  claimQuestion({id,requestId,teamId}){
    const eventKey=createHash('sha256').update(id).digest('hex');
    const req=this.get(requestId);
    if(!req || req.team_id!==teamId || req.expires<Date.now())return false;
    return this.db.prepare('INSERT OR IGNORE INTO slack_qa_events VALUES(?,?,?)')
      .run(eventKey,requestId,new Date().toISOString()).changes===1;
  }
}

export function buildApprovalBlocks({requestId,finding,plan,risk='Needs review',affected=1,summary=''}) {
  assert(typeof requestId==='string' && ID.test(requestId),'Invalid approval request');
  const affectedText=Number.isInteger(affected)&&affected>0?String(affected):'Unknown';
  const steps=plan.steps.slice(0,6).map((s,i)=>`${i+1}. ${escapeMrkdwn(s.tool)} — ${escapeMrkdwn(s.reason).slice(0,90)}`);
  const confirm = decision => ({title:plain(decision==='approve'?'Confirm approval':'Confirm rejection'),
    text:plain(decision==='approve'?'Approve the exact reviewed plan? This authorizes the backend to carry out its listed actions.':'Reject this plan? No tools will be executed.'),
    confirm:plain(decision==='approve'?'Confirm approval':'Confirm rejection'),deny:plain('Cancel'),
    ...(decision==='approve'?{style:'primary'}:{style:'danger'})});
  return [
    {type:'header',text:plain('Operations Agent · Action Review')},
    {type:'section',text:{type:'mrkdwn',text:`*${escapeMrkdwn(finding.type||'Business anomaly')}*\n${escapeMrkdwn(summary||finding.summary||'Review required')}`}},
    {type:'section',fields:[
      {type:'mrkdwn',text:`*Risk*\n${escapeMrkdwn(risk)}`},
      {type:'mrkdwn',text:`*Affected*\n${affectedText}`},
      {type:'mrkdwn',text:`*Proposed plan*\n${escapeMrkdwn(plan.title)}`},
      {type:'mrkdwn',text:`*Steps*\n${plan.steps.length}`},
    ]},
    {type:'section',text:{type:'mrkdwn',text:`*What the agent proposes*\n${steps.join('\n')||'No steps'}`}},
    {type:'context',elements:[{type:'mrkdwn',text:'Approval is limited to this plan. Your backend rechecks scopes and verifies results.'}]},
    {type:'actions',elements:[
      {type:'button',action_id:'ua.approve',value:requestId,style:'primary',text:plain('Approve'),confirm:confirm('approve')},
      {type:'button',action_id:'ua.reject',value:requestId,style:'danger',text:plain('Reject'),confirm:confirm('reject')},
      {type:'button',action_id:'ua.details',value:requestId,text:plain('View evidence')},
      {type:'button',action_id:'ua.ask',value:requestId,text:plain('Ask Agent')},
    ]},
  ];
}

export class RichSlackApprovalGateway {
  constructor({signingSecret,botToken,teamId,tenantId,approvalStore,policyStore,registry,
    fetchImpl=fetch,apiBase='https://slack.com/api/',answerQuestion=null,onApproved=null,allowedChannels=[],queue=null}){
    assert(signingSecret&&botToken&&teamId&&tenantId&&approvalStore&&policyStore&&registry,'Missing Slack gateway dependencies');
    assert(apiBase==='https://slack.com/api/' || new URL(apiBase).hostname==='127.0.0.1','Only Slack API or explicit local test API allowed');
    Object.assign(this,{signingSecret,botToken,teamId,tenantId,approvalStore,policyStore,registry,
      fetchImpl,apiBase,answerQuestion,onApproved,queue,allowedChannels:new Set(allowedChannels)});
  }
  async api(method,params){
    const response=await this.fetchImpl(new URL(method,this.apiBase),{method:'POST',redirect:'error',headers:
      {'Authorization':`Bearer ${this.botToken}`,'Content-Type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.timeout(2100)});
    if(!response.ok)throw Error(`Slack API ${method} returned HTTP ${response.status}`);
    const data=await response.json();
    if(!data.ok)throw Error(`Slack API ${method} failed: ${clean(data.error,80)}`);
    return data;
  }
  async publish({channel,findingId,planId,runtime,summary,risk,affected}){
    assert(this.allowedChannels.has(channel),'Slack channel not approved by IT admin');
    const finding=runtime.journal.get(findingId);
    assert(finding?.tenant===this.tenantId && finding.state==='investigating','Finding unavailable or no longer under review');
    const plan=finding.data.plans.find(p=>p.id===planId);
    assert(plan?.digest && plan.steps?.length,'Unknown or stale plan');
    const req=this.approvalStore.create({tenant:this.tenantId,teamId:this.teamId,channel,findingId,planId,planDigest:plan.digest});
    const blocks=buildApprovalBlocks({requestId:req.id,finding:finding.data,plan,summary,risk,affected});
    try{
      const result=await this.api('chat.postMessage',{channel,text:`Action approval: ${clean(plan.title,100)}`,blocks});
      this.approvalStore.markDelivered(req.id,result.ts);
      return {id:req.id,ts:result.ts,channel};
    }catch(error){this.approvalStore.status(req.id,'delivery_failed');throw error}
  }
  #verify({headers,rawBody}){
    const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
    assert(typeof rawBody==='string'&&rawBody.length<100000,'Invalid Slack body');
    assert(verifySlackRequest({rawBody,timestamp:h['x-slack-request-timestamp'],signature:h['x-slack-signature'],signingSecret:this.signingSecret}),
      'Invalid Slack signature');
    const payload=JSON.parse(new URLSearchParams(rawBody).get('payload')||'null');
    assert(payload?.team?.id===this.teamId,'Wrong Slack workspace');
    assert(typeof payload.user?.id==='string','Slack user missing');
    return payload;
  }
  #linked({payload,requestId,runtime}){
    const req=this.approvalStore.get(requestId);
    assert(req && req.team_id===this.teamId&&req.tenant===this.tenantId&&req.expires>Date.now(),'Unknown or expired approval request');
    const principal=this.policyStore.principal(this.teamId,payload.user.id);
    assert(principal,'Slack user not mapped by IT admin');
    const finding=runtime.journal.get(req.finding);
    assert(finding?.tenant===req.tenant,'Finding not in tenant');
    const plan=finding.data.plans.find(p=>p.id===req.plan_id);
    assert(plan?.digest===req.plan_digest,'The plan changed; request a new approval');
    return {req,principal,finding,plan};
  }
  async handle({headers,rawBody,runtime}){
    const payload=this.#verify({headers,rawBody});
    if(payload.type==='block_actions'){
      const action=payload.actions?.[0],actionId=action?.action_id,requestId=action?.value;
      assert(['ua.approve','ua.reject','ua.details','ua.ask'].includes(actionId),'Unknown Slack action');
      const {req,principal,finding,plan}=this.#linked({payload,requestId,runtime});
      assert(this.policyStore.canApprove({actor:principal.actor,plan,registry:this.registry}),'Not authorized for this plan');
      if(actionId==='ua.details'||actionId==='ua.ask'){
        assert(payload.trigger_id,'Slack modal trigger missing');
        const view=actionId==='ua.details'?this.#detailModal(req,finding,plan):this.#questionModal(req);
        await this.api('views.open',{trigger_id:payload.trigger_id,view});
        return {ack:{},afterAck:null,kind:'modal'};
      }
      const decision=actionId==='ua.approve'?'approve':'reject';
      if(this.queue){
        // Persist intent BEFORE the HTTP 200 ACK. A restarted worker can finish it.
        const job=this.queue.enqueue({tenant:this.tenantId,kind:'slack-decision',
          payload:{requestId:req.id,actor:principal.actor,decision},dedupeKey:req.id});
        return {ack:{response_type:'ephemeral',text:`${decision==='approve'?'Approval':'Rejection'} queued for secure processing.`},
          afterAck:null,kind:'queued',jobId:job.id};
      }
      // Slack's native button confirmation happens *before* this action arrives.
      // Do all effects after the HTTP 200 ACK to avoid Slack's three-second deadline.
      return {ack:{response_type:'ephemeral',text:`${decision==='approve'?'Approval':'Rejection'} received. Verifying authorization and current plan…`},
        afterAck:async()=>{
          // Recheck even if IT revoked access between the button ACK and worker dispatch.
          if(!this.policyStore.canApprove({actor:principal.actor,plan,registry:this.registry}))throw Error('Approval permission was revoked');
          if(!this.approvalStore.claim(req.id,principal.actor))return {status:'ignored',reason:'already processed'};
          try{
            await runtime.decidePlan(req.finding,{planId:req.plan_id,decision,actor:principal.actor,context:{scopes:principal.scopes}});
            this.approvalStore.complete(req.id,decision==='approve'?'approved':'rejected');
            if(decision==='approve' && this.onApproved) await this.onApproved({runtime,findingId:req.finding,planId:req.plan_id,principal});
            await this.api('chat.update',{channel:req.channel,ts:req.message_ts,text:`${clean(plan.title)}: ${decision}`,
              blocks:[{type:'section',text:{type:'mrkdwn',text:`*${escapeMrkdwn(plan.title)}*\nDecision: *${decision.toUpperCase()}* by an authorized reviewer. Execution status is tracked separately.`}}]});
            return {status:decision};
          }catch(error){
            this.approvalStore.complete(req.id,'blocked');
            throw error;
          }
        },kind:'decision'};
    }
    if(payload.type==='view_submission' && payload.view?.callback_id==='ua.question'){
      const requestId=payload.view.private_metadata;
      const {req,principal,finding,plan}=this.#linked({payload,requestId,runtime});
      assert(this.policyStore.canApprove({actor:principal.actor,plan,registry:this.registry}),'Not authorized to view evidence');
      const question=payload.view.state?.values?.question?.entry?.value;
      assert(typeof question==='string'&&question.trim().length>=3&&question.length<=1000,'Invalid question');
      const eventId=`${payload.view.id||''}:${payload.view.hash||''}:${payload.user.id}`;
      return {ack:{response_action:'clear'},kind:'question',afterAck:async()=>{
        if(!this.approvalStore.claimQuestion({id:eventId,requestId:req.id,teamId:this.teamId}))return {status:'duplicate'};
        let answer='AI follow-up is not connected. Contact the system administrator or open the review dashboard.';
        if(this.answerQuestion){
          answer=await this.answerQuestion({question,finding:finding.data,plan,actor:principal.actor,tenant:this.tenantId});
        }
        await this.api('chat.postEphemeral',{channel:req.channel,user:payload.user.id,
          text:`*Question:* ${escapeMrkdwn(question)}\n*Agent:* ${escapeMrkdwn(answer).slice(0,1700)}`});
        return {status:'answered'};
      }};
    }
    throw Error('Unsupported Slack interaction');
  }
  /** Durable job handler. Re-check approver permissions at execution time. */
  async processQueuedDecision(job,runtime){
    if(job.tenant!==this.tenantId||job.kind!=='slack-decision')throw Error('Wrong tenant or job kind');
    const {requestId,actor,decision}=job.payload;
    const req=this.approvalStore.get(requestId);
    if(!req || req.tenant!==this.tenantId || req.team_id!==this.teamId || req.expires<Date.now())throw Error('Approval request expired or absent');
    const [,team,user]=/^slack:([^:]+):([^:]+)$/.exec(actor)||[];
    if(!team||!user||team!==this.teamId)throw Error('Invalid Slack principal');
    const principal=this.policyStore.principal(team,user);
    if(!principal||principal.actor!==actor)throw Error('Manager is no longer authorized');
    const finding=runtime.journal.get(req.finding);
    const plan=finding?.data.plans.find(p=>p.id===req.plan_id);
    if(!finding||finding.tenant!==req.tenant||!plan||plan.digest!==req.plan_digest)throw Error('Plan changed or no longer exists');
    if(!this.policyStore.canApprove({actor,plan,registry:this.registry}))throw Error('Approval scope was revoked');
    if(!this.approvalStore.claim(req.id,actor))throw Error('Already handled or no longer pending');
    try{
      await runtime.decidePlan(req.finding,{planId:req.plan_id,decision,actor,context:{scopes:principal.scopes}});
      this.approvalStore.complete(req.id,decision==='approve'?'approved':'rejected');
      if(decision==='approve')this.queue.enqueue({tenant:this.tenantId,kind:'execute-plan',
        payload:{findingId:req.finding,planId:req.plan_id},dedupeKey:`execute:${req.finding}:${req.plan_id}`});
    }catch(error){this.approvalStore.complete(req.id,'blocked');throw error}
    try{if(req.message_ts)await this.api('chat.update',{channel:req.channel,ts:req.message_ts,
      text:`${clean(plan.title)}: ${decision}`,blocks:[{type:'section',text:{type:'mrkdwn',text:`*${escapeMrkdwn(plan.title)}*\nDecision: *${decision.toUpperCase()}*. Backend execution is tracked separately.`}}]});
    }catch{/* Message status is not authority for the verified business decision. */}
    return {status:decision,findingId:req.finding};
  }
  #detailModal(req,finding,plan){
    const sections=[`*Issue*\n${escapeMrkdwn(finding.data.summary)}`,
      `*Evidence references*\n${(finding.data.evidenceRefs||[]).length} item(s) — available in the organization's secured audit dashboard.`,
      `*Proposed steps*\n${plan.steps.map((s,i)=>`${i+1}. ${escapeMrkdwn(s.tool)}: ${escapeMrkdwn(s.reason)}`).join('\n').slice(0,2500)}`];
    return {type:'modal',callback_id:'ua.details',private_metadata:req.id,title:plain('Review evidence'),close:plain('Close'),
      blocks:sections.map(text=>({type:'section',text:{type:'mrkdwn',text:text.slice(0,2800)}}))};
  }
  #questionModal(req){
    return {type:'modal',callback_id:'ua.question',private_metadata:req.id,title:plain('Ask the Agent'),submit:plain('Ask'),close:plain('Cancel'),
      blocks:[{type:'input',block_id:'question',label:plain('What do you want to know?'),element:{type:'plain_text_input',action_id:'entry',multiline:true,max_length:1000,placeholder:plain('Why is this change recommended?')}}]};
  }
}
