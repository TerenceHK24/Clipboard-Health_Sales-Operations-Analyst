/** Browser-level acceptance of the actual Studio UI against isolated, synthetic data. */
import { chromium } from 'playwright';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CapabilityRegistry,SqliteJournal,GovernedAgentRuntime} from '../universal/core.mjs';
import {CompanyPolicyStore} from '../universal/admin/policy-store.mjs';
import {ConnectorTemplateStore} from '../universal/connectors/templates.mjs';
import {SourceCatalog} from '../universal/platform/sources.mjs';
import {DurableQueue} from '../universal/platform/queue.mjs';
import {startOperationsStudio} from '../universal/studio/server.mjs';
import {strict as assert} from 'node:assert';
const dir=mkdtempSync(join(tmpdir(),'ops-browser-')),tenant='synthetic';
const registry=new CapabilityRegistry(),writes=[];
registry.register({id:'demo.update',description:'Synthetic CRM write',mode:'write',requiredScopes:['demo:write'],
  validate:a=>typeof a.id==='string'&&typeof a.status==='string',execute:async a=>{writes.push(a);return {ok:true}},verify:async()=>true});
const file=name=>join(dir,name+'.sqlite');
const policyStore=new CompanyPolicyStore(file('policy'),tenant),sourceCatalog=new SourceCatalog({path:file('sources'),tenant}),
  queue=new DurableQueue(file('queue')),templates=new ConnectorTemplateStore(file('templates'),tenant),journal=new SqliteJournal(file('journal'));
policyStore.upsertCapability({id:'demo.update',enabled:true,roles:['admin'],registry,actor:'test-admin'});
sourceCatalog.put({id:'crm',title:'Synthetic CRM',kind:'demo',rows:[{id:'001',status:'Inactive',name:'Test customer'}]});
sourceCatalog.put({id:'erp',title:'Synthetic ERP',kind:'demo',rows:[{id:'001',status:'Active',name:'Test customer'}]});
const runtime=new GovernedAgentRuntime({registry,journal,tenantId:tenant,canApprove:()=>true,canExecute:()=>true});
let server,browser;
try{
  server=await startOperationsStudio({runtime,registry,policyStore,sourceCatalog,queue,templates,tenantId:tenant,port:0,
    credentialResolver:async()=>{throw Error('test only')},adminScopes:['demo:write']});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url,{waitUntil:'networkidle'});
  await page.getByText('Find the unusual.').waitFor({timeout:15000});
  await page.locator('#source-list').getByText('Synthetic CRM').waitFor({state:'attached'});
  mkdirSync('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/ops-studio-overview.png',fullPage:true});
  await page.getByRole('button',{name:'Data sources'}).click();
  await page.locator('#source-a').selectOption('crm');await page.locator('#source-b').selectOption('erp');
  await page.locator('#field-pairs').fill('status:status');
  await page.getByRole('button',{name:'Compare sources'}).click();
  await page.locator('#findings-list').getByText('status differs from status').waitFor();
  await page.screenshot({path:'artifacts/ops-studio-findings.png',fullPage:true});
  await page.locator('#findings-list').getByText('status differs from status').click();
  await page.getByRole('button',{name:'Investigate'}).click();
  await page.getByRole('button',{name:'Add custom plan'}).click();
  await page.locator('#plan-editor input').fill('Correct synthetic CRM status');
  await page.locator('#plan-editor textarea').fill(JSON.stringify([{tool:'demo.update',args:{id:'001',status:'Active'},reason:'Human checked synthetic source evidence'}]));
  await page.getByRole('button',{name:'Save proposed plan'}).click();
  await page.getByRole('button',{name:'Review plan'}).click();
  await page.getByRole('button',{name:'Approve…'}).click();
  await page.getByRole('button',{name:'Confirm & execute'}).click();
  await page.getByRole('button',{name:'Activity log'}).click();
  await page.getByRole('button',{name:'Process queued jobs'}).click();
  await page.getByText('execute-plan').first().waitFor();
  assert.equal(writes.length,1,'Browser approval must execute exactly one authorized synthetic write');
  await page.getByRole('button',{name:'Integrations'}).click();
  await page.getByText('Integration catalog').waitFor();
  await page.screenshot({path:'artifacts/ops-studio-integrations.png',fullPage:true});
  assert.deepEqual(errors,[],'No uncaught browser JS error');
  console.log('Operations Studio full real-Chromium acceptance passed; screenshots in artifacts/.');
}finally{
  if(browser)await browser.close();if(server)await server.close();
  queue.close();templates.close();sourceCatalog.close();policyStore.close();journal.db.close();rmSync(dir,{recursive:true,force:true});
}
