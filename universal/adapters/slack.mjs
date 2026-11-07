/** Slack Block Kit approval adapter. Requires a deployed HTTPS interaction URL.
 * It does not accept free-form chat text as authorization.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export function verifySlackRequest({ rawBody, timestamp, signature, signingSecret, now = Date.now() }) {
  if (typeof rawBody !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string' || !signingSecret) return false;
  const epoch = Number(timestamp);
  if (!Number.isInteger(epoch) || Math.abs(now / 1000 - epoch) > 300) return false;
  const digest = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(signature), b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a,b);
}

export class SlackApprovalBridge {
  #requests = new Map();
  constructor({ signingSecret, botToken, expectedTeamId, apiUrl = 'https://slack.com/api/chat.postMessage', fetchImpl = fetch }) {
    if (!signingSecret || !botToken || !expectedTeamId) throw new Error('Slack authorization, team and signing secret must be supplied by the company at runtime');
    Object.assign(this, { signingSecret, botToken, expectedTeamId, apiUrl, fetchImpl });
  }
  async requestApproval({channel,findingId,planId,summary}) {
    const requestId=randomBytes(24).toString('hex');
    this.#requests.set(requestId,{findingId,planId,expires:Date.now()+15*60*1000,consumed:false});
    const blocks=[
      {type:'section',text:{type:'mrkdwn',text:`*Business action approval requested*\n${String(summary).slice(0,500)}`}},
      {type:'actions',elements:[
        {type:'button',text:{type:'plain_text',text:'Approve'},style:'primary',action_id:'universal_approve',value:requestId},
        {type:'button',text:{type:'plain_text',text:'Reject'},style:'danger',action_id:'universal_reject',value:requestId},
      ]}
    ];
    const response=await this.fetchImpl(this.apiUrl,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${this.botToken}`,'Content-Type':'application/json'},body:JSON.stringify({channel,text:'Business action approval requested',blocks})});
    if (!response.ok) throw new Error(`Slack notification transport failed: ${response.status}`);
    const body=await response.json();
    if (!body.ok) throw new Error(`Slack rejected approval request`);
    return {requestId,messageTs:body.ts};
  }
  /** Route authenticated Slack callbacks to the backend; caller ACKs immediately and starts a worker. */
  async acceptAction({headers,rawBody,runtime,scopes=[]}) {
    if (!verifySlackRequest({rawBody,timestamp:headers['x-slack-request-timestamp'],signature:headers['x-slack-signature'],signingSecret:this.signingSecret})) throw new Error('Invalid Slack signature or stale request');
    const params = new URLSearchParams(rawBody);
    const payload = JSON.parse(params.get('payload') || '{}');
    if (payload.team?.id !== this.expectedTeamId) throw new Error('Slack workspace mismatch');
    const actor=payload.user?.id;
    const action=payload.actions?.[0];
    if (typeof actor!=='string' || !['universal_approve','universal_reject'].includes(action?.action_id)) throw new Error('Invalid actor or action');
    const request=this.#requests.get(action.value);
    if(!request || request.consumed || Date.now()>request.expires) throw new Error('Approval request already used or expired');
    const decision=action.action_id==='universal_approve'?'approve':'reject';
    // Keep the nonce valid on failed authorization, so the actual manager can still approve.
    const result=await runtime.decidePlan(request.findingId,{planId:request.planId,decision,actor,context:{scopes}});
    request.consumed=true;
    return {findingId:request.findingId,decision,status:result.state};
  }
}
