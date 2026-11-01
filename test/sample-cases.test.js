import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, nameKey, careKey, identityScore } from '../src/reconcile.js';
import { ReviewService } from '../src/service.js';
import { Store } from '../src/store.js';
import { account, parent, website, config, clone, MockClient } from '../fixtures/example.js';

const amberly = { record_type:'facility', name:'Amberly Manor', address:'4390 Darrow Rd', city:'Hudson', state:'OH',
  zip:'44236', care_offerings:'Assisted Living', administrator:'Tom Trent', phone:'(330) 228-4392',
  source_url:config.siteUrl+'/communities/amberly-manor' };
const arbors = { record_type:'facility', name:'The Arbors at Bellhaven - Dayton', address:'2210 Salem Ave', city:'Dayton', state:'OH',
  zip:'45406', care_offerings:'Memory Support', administrator:'Ray Novak', phone:'(260) 254-7592',
  source_url:config.siteUrl+'/communities/the-arbors-at-bellhaven-dayton' };
const createSite = (...locations) => {const site=website();site.locations=locations;return site;};
const contact = (overrides={}) => ({id:'c1',account_id:'facility-1',name:'Old Administrator',title:'Administrator',
  email:'old@example.invalid',phone:'(555) 111-1111',status:'Active',...overrides});

function context(t, rows, site, contacts=[]) {
  const dir=mkdtempSync(join(tmpdir(),'sample-cases-'));
  let store = new Store(dir, 'sample-scope');
  const client = new MockClient(rows,contacts);
  const make=()=>new ReviewService({config,store,client,readWebsite:async()=>clone(site)});
  let service=make();
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  return {client, site,dir,get store(){return store},get service(){return service},
    restart(){store.close();store=new Store(dir,'sample-scope');service=make();}};
}
const approve = item => ({ decision:'approve',revision:item.revision,reviewer:'Reviewer A' });

test('Dayton articles and punctuation normalize for identity, but canonical name difference is proposed',()=>{
  const row=account({name:'Arbors at Bellhaven Dayton',billing_street:arbors.address,billing_city:arbors.city,
    billing_state:arbors.state,billing_zip:arbors.zip,phone:arbors.phone,care_type:'Memory Care'});
  const site=createSite({...arbors,administrator:''});
  const result=plan({website:site,accounts:[parent(),row],contacts:[]},config);
  assert.equal(nameKey(arbors.name),nameKey(row.name));
  assert.equal(careKey('Memory Care',config),careKey('Memory Support',config));
  const item=result.proposals.find(p=>p.kind==='update');
  assert.deepEqual(item.steps[0].body,{name:arbors.name});
  assert.ok(!Object.hasOwn(item.steps[0].body,'care_type'));
});
test('memory care / support equivalence also works across lists and permutations',()=>{
  assert.equal(careKey('Memory Care | Assisted Living',config),careKey('Assisted Living, Memory Support',config));
});
test('Amberly name remains a global candidate when street city phone and parent changed',()=>{
  const old=account({name:'Amberly Manor',billing_street:'42 Former St',billing_city:'Another Town',billing_state:'MI',
    billing_zip:'49000', phone:'(555) 210-0000',care_type:'Assisted Living',parent_id:'former-parent'});
  assert.ok(identityScore(amberly,old,config)>=85);
  const item=plan({website:createSite({...amberly,administrator:''}),accounts:[parent(),old],contacts:[]},config).proposals[0];
  assert.equal(item.kind,'reparent');
  assert.equal(item.steps[0].id,old.id);
  assert.equal(item.steps[0].body.parent_id,parent().id);
});
test('all changed except care type is NOT considered enough to infer identity',()=>{
  const old=account({name:'Former Operator Lodge',billing_street:'1 Former St',billing_city:'Other Town',billing_state:'MI',
    phone:'(555) 333-9999',parent_id:'former-parent',care_type:'Assisted Living'});
  const site=createSite({...amberly,administrator:''});
  const first=plan({website:site,accounts:[parent(),old],contacts:[]},config);
  assert.equal(first.proposals[0].kind,'create');
  const second=plan({website:site,accounts:[parent(),old],contacts:[]},config,{manualLinks:{[amberly.source_url]:old.id}});
  assert.equal(second.proposals[0].kind,'reparent');
  assert.equal(second.proposals[0].steps[0].id,old.id);
});
test('manual matching persists across restarts and turns off misleading create proposals',async t=>{
  const old=account({name:'Former Operator Lodge',billing_street:'1 Former St',billing_city:'Other Town',billing_state:'MI',
    phone:'(555) 333-9999',parent_id:'former-parent',care_type:'Assisted Living'});
  const c=context(t,[parent(),old],createSite({...amberly,administrator:''}));
  await c.service.scan();
  assert.equal(c.store.list().find(p=>p.status==='pending').kind,'create');
  await c.service.manualMatch({action:'link',siteUrl:amberly.source_url,accountId:old.id,reviewer:'Reviewer A'});
  assert.equal(c.store.manualLinks()[amberly.source_url],old.id);
  assert.equal(c.store.list().filter(p=>p.kind==='create'&&p.status==='pending').length,0);
  assert.equal(c.store.list().filter(p=>p.kind==='reparent'&&p.status==='pending').length,1);
  assert.equal(c.client.writes.length,0);
  c.restart(); await c.service.scan();
  assert.equal(c.store.list().filter(p=>p.kind==='reparent'&&p.status==='pending').length,1);
  assert.equal(c.client.writes.length,0);
});
test('Amberly billing history + outstanding AR force CHOW after verified manual link',()=>{
  const old=account({name:'Former Operator Lodge',billing_street:'1 Former St',billing_city:'Other Town',billing_state:'MI',
    phone:'(555) 333-9999',parent_id:'former-parent',care_type:'Assisted Living',lifetime_revenue:1000,outstanding_ar:90});
  const result=plan({website:createSite(amberly),accounts:[parent(),old],contacts:[]},config,
    {manualLinks:{[amberly.source_url]:old.id}});
  assert.equal(result.proposals[0].kind,'chow');
  assert.deepEqual(result.proposals[0].steps[1].body,{chow_current_account:'$created_id'});
  assert.ok(!result.proposals.some(p=>p.kind==='admin_contact')); // administrators follow CHOW
});
test('matching administrator contact produces no changes, unknown administrator generates a review proposal',()=>{
  const site=createSite(amberly), row=account({ name:amberly.name,billing_street:amberly.address,billing_city:amberly.city,
    billing_state:amberly.state,billing_zip:amberly.zip,phone:amberly.phone,care_type:'Assisted Living'});
  const clean=plan({website:site,accounts:[parent(),row],contacts:[contact({name:'Tom Trent'})]},config);
  assert.equal(clean.proposals.length,0);
  const stale=plan({website:site,accounts:[parent(),row],contacts:[contact()]},config);
  const item=stale.proposals.find(p=>p.kind==='admin_contact');
  assert.equal(item.steps[0].resource,'contacts');
  assert.equal(item.steps[0].method,'POST');
  assert.deepEqual(item.steps[0].body,{account_id:row.id,name:'Tom Trent',title:'Administrator',status:'Active'});
  assert.deepEqual(item.steps[1].body,{status:'Inactive'});
  assert.ok(!Object.hasOwn(item.steps[1].body,'email'));
});
test('approved admin replacement creates a new contact, inactivates former one, never renames or rewrites email',async t=>{
  const row=account({name:amberly.name,billing_street:amberly.address,billing_city:amberly.city,
    billing_state:amberly.state,billing_zip:amberly.zip,phone:amberly.phone});
  const c=context(t,[parent(),row],createSite(amberly),[contact()]);
  await c.service.scan(); const item=c.store.list().find(p=>p.kind==='admin_contact');
  assert.ok(item);
  assert.equal(c.client.writes.length,0);
  await c.service.decide(item.id,approve(item));
  assert.equal((await c.client.getContact('c1')).name,'Old Administrator');
  assert.equal((await c.client.getContact('c1')).email,'old@example.invalid');
  assert.equal((await c.client.getContact('c1')).status,'Inactive');
  assert.equal((await c.client.list('contacts')).filter(p=>p.name==='Tom Trent'&&p.status==='Active').length,1);
  c.restart(); await c.service.scan();
  assert.equal(c.store.list().filter(p=>p.status==='pending').length,0);
  assert.equal(c.client.writes.length,2);
});
test('uncertain contact POST cannot be retried if not visible; an already-created contact is recovered without duplicate POST',async t=>{
  const row=account({name:amberly.name,billing_street:amberly.address,billing_city:amberly.city,
    billing_state:amberly.state,billing_zip:amberly.zip,phone:amberly.phone});
  const c=context(t,[parent(),row],createSite(amberly),[contact()]);
  c.client.failAfterContactCreate=true;
  await c.service.scan(); const item=c.store.list().find(p=>p.kind==='admin_contact');
  await assert.rejects(c.service.decide(item.id,approve(item)),/response lost/);
  c.restart(); await c.service.decide(item.id,{...approve(item),decision:'retry'});
  assert.equal(c.client.writes.filter(w=>w.resource==='contacts'&&w.method==='POST').length,1);
});
test('repeated name-only corrections share one group and reject all with zero writes',async t=>{
  const site=createSite({ ...arbors,administrator:''},{...amberly,administrator:''});
  const a=account({id:'a',name:'Arbors at Bellhaven Dayton',billing_street:arbors.address,
    billing_city:arbors.city,billing_state:arbors.state,billing_zip:arbors.zip,phone:arbors.phone,care_type:'Memory Care'});
  const b=account({id:'b',name:'The Amberly Manor',billing_street:amberly.address,
    billing_city:amberly.city,billing_state:amberly.state,billing_zip:amberly.zip,phone:amberly.phone,care_type:'Assisted Living'});
  const c=context(t,[parent(),a,b],site);
  await c.service.scan(); const group=c.store.list().filter(p=>p.kind==='update'&&p.status==='pending');
  assert.equal(group.length,2); assert.equal(group[0].groupKey,group[1].groupKey);
  const result=await c.service.decideGroup({groupKey:group[0].groupKey,members:group.map(p=>({id:p.id,revision:p.revision})),
    decision:'reject',reviewer:'Reviewer A'});
  assert.equal(result.rejected,2);assert.equal(c.client.writes.length,0);
  c.restart();await c.service.scan();assert.equal(c.store.list().filter(p=>p.status==='pending').length,0);
});
test('group approval requires exact complete membership and persists individual decisions',async t=>{
  const site=createSite({ ...arbors,administrator:''},{...amberly,administrator:''});
  const a=account({id:'a',name:'Arbors at Bellhaven Dayton',billing_street:arbors.address,
    billing_city:arbors.city,billing_state:arbors.state,billing_zip:arbors.zip,phone:arbors.phone,care_type:'Memory Care'});
  const b=account({id:'b',name:'The Amberly Manor',billing_street:amberly.address,
    billing_city:amberly.city,billing_state:amberly.state,billing_zip:amberly.zip,phone:amberly.phone,care_type:'Assisted Living'});
  const c=context(t,[parent(),a,b],site);
  await c.service.scan(); const group=c.store.list().filter(p=>p.kind==='update'&&p.status==='pending');
  const members=group.map(p=>({id:p.id,revision:p.revision}));
  await assert.rejects(c.service.decideGroup({groupKey:group[0].groupKey,members:members.slice(0,1),decision:'approve',reviewer:'Reviewer A'}),/group changed/);
  assert.equal(c.client.writes.length,0);
  const result=await c.service.decideGroup({groupKey:group[0].groupKey,members,decision:'approve',reviewer:'Reviewer A'});
  assert.equal(result.applied,2);
  assert.equal(c.client.writes.length,2);
  assert.ok(c.store.audit().filter(row=>row.decision==='approve-group').length===2);
  c.restart();await c.service.scan();assert.equal(c.store.list().filter(p=>p.status==='pending').length,0);
});

test('the app refuses stale create approval once a reviewer has identified the old account manually',async t=>{
  const old=account({name:'Former Operator Lodge',billing_street:'1 Former St',billing_city:'Other Town',billing_state:'MI',
    phone:'(555) 333-9999',parent_id:'former-parent',care_type:'Assisted Living'});
  const c=context(t,[parent(),old],createSite({...amberly,administrator:''}));
  await c.service.scan(); const create=c.store.list().find(p=>p.kind==='create');
  await c.service.manualMatch({action:'link',siteUrl:amberly.source_url,accountId:old.id,reviewer:'Reviewer A'});
  await assert.rejects(c.service.decide(create.id,approve(create)),/pending/);
  assert.equal(c.client.writes.length,0);
});
test('a changed manual mapping blocks resuming an earlier approved re-parent',async t=>{
  const old=account({name:'Former Operator Lodge',billing_street:'1 Former St',billing_city:'Other Town',billing_state:'MI',
    phone:'(555) 333-9999',parent_id:'former-parent',care_type:'Assisted Living'});
  const c=context(t,[parent(),old],createSite({...amberly,administrator:''}));
  await c.service.scan();
  await c.service.manualMatch({action:'link',siteUrl:amberly.source_url,accountId:old.id,reviewer:'Reviewer A'});
  const selected=c.store.list().find(p=>p.kind==='reparent'&&p.status==='pending');
  c.store.unlink(amberly.source_url,'Reviewer A');
  await assert.rejects(c.service.decide(selected.id,approve(selected)),/manual identity mapping changed/);
  assert.equal(c.client.writes.length,0);
});
