import test from 'node:test';
import assert from 'node:assert/strict';
import {communityLink,createCsv,discoverLocations,parseCommunity,fetchHtml,scrapeAll} from '../src/scraper.js';
const origin='https://example.test';
const sample=`<main><h1>Bellhaven Healthcare Centre of Ashland</h1><dl class="detail">
<dt>Address</dt><dd>1631 Claremont Ave<br>Ashland, OH 44805</dd>
<dt>Care Offerings</dt><dd><span class="badge">Short-Term Rehabilitation &amp; Nursing</span></dd>
<dt>Administrator</dt><dd>Carla Okafor</dd><dt>Phone</dt><dd>(517) 314-5115</dd></dl></main>`;
test('extracts all fields dynamically by dt labels',()=>{
 const r=parseCommunity(sample,origin+'/communities/ashland');
 assert.equal(r.name,'Bellhaven Healthcare Centre of Ashland');
 assert.equal(r.address,'1631 Claremont Ave');
 assert.equal(r.city,'Ashland');
 assert.equal(r.state,'OH');
 assert.equal(r.zip,'44805');
 assert.equal(r.care_offerings,'Short-Term Rehabilitation & Nursing');
 assert.equal(r.administrator,'Carla Okafor');
 assert.equal(r.phone,'(517) 314-5115');
});
test('collects several badges and handles optional fields and ZIP+4',()=>{
 const r=parseCommunity('<h1>Example</h1><dl><dt>Address</dt><dd>11 Main St<br>Springfield, IL 62704-1234</dd><dt>Care Offerings</dt><dd><span class="badge">Assisted Living</span><span class="badge">Memory Support</span></dd></dl>',origin+'/communities/x');
 assert.equal(r.care_offerings,'Assisted Living | Memory Support');
 assert.equal(r.zip,'62704-1234');
 assert.equal(r.phone,'');
});
test('traverses directory pagination and homepage links',async()=>{
 const pages=new Map([
  [origin+'/communities','3 communities listed <a href="/communities/a">A</a><a href="?page=2">next</a>'],
  [origin+'/communities?page=2','<a href="/communities/b">B</a><a href="?page=3">next</a>'],
  [origin+'/communities?page=3','<a href="/communities/c">C</a>'],
  [origin+'/','<a href="/communities/new">new</a>']
 ]);
 const urls=await discoverLocations({baseUrl:origin,delayMs:0,fetchPage:async u=>pages.get(u)});
 assert.deepEqual(urls,['a','b','c','new'].map(s=>origin+'/communities/'+s));
});
test('rejects incomplete discovery',async()=>{
 await assert.rejects(discoverLocations({baseUrl:origin,delayMs:0,fetchPage:async u=>u.endsWith('/communities')?'3 communities listed <a href="/communities/a">A</a>':''}),/directory lists 3/);
});
test('filters external and CRM links',()=>{
 assert.equal(communityLink('https://evil.test/communities/x',origin,origin),null);
 assert.equal(communityLink('/crm/x',origin,origin),null);
 assert.deepEqual(communityLink('/communities/a#x',origin,origin),{type:'detail',url:origin+'/communities/a'});
});
test('quotes CSV fields and preserves Unicode',()=>{
 const data=createCsv([{name:'Bellhaven "North", Ltd.',address:'One\nTwo'}]);
 assert.ok(data.startsWith('\uFEFF'));
 assert.match(data,/"Bellhaven ""North"", Ltd.","One\nTwo"/);
});
test('retries HTTP 429',async()=>{
 let calls=0;
 const html=await fetchHtml(origin,{sleep:async()=>{},fetchImpl:async()=>++calls===1?{ok:false,status:429,headers:{get:()=>null}}:{ok:true,text:async()=>'<html>ok</html>'}});
 assert.equal(calls,2);
 assert.equal(html,'<html>ok</html>');
});
test('rejects detail pages missing required fields',async()=>{
 const pages=new Map([[origin+'/communities','1 communities listed <a href="/communities/a">A</a>'],[origin+'/',''],[origin+'/communities/a','<h1>A</h1>']]);
 await assert.rejects(scrapeAll({baseUrl:origin,delayMs:0,fetchPage:async u=>pages.get(u)}),/Missing address/);
});
