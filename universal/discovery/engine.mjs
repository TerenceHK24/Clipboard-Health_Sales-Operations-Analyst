/** Schema-adaptive, deterministic evidence discovery; AI may add hypotheses, never writes. */
import { createHash } from 'node:crypto';
const sha = data => createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,18);
const clean = x => String(x ?? '').normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ');
const strip = x => String(x ?? '').trim();
const safeRows = rows => {
  if (!Array.isArray(rows) || rows.length > 3000 || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw Error('Dataset must contain at most 3000 plain object records');
  if (JSON.stringify(rows).length > 1_500_000) throw Error('Dataset exceeds 1.5 MB safety limit');
  return rows;
};
const normLabel = s => clean(s).replace(/\b(billing|shipping|primary|custom|field|crm|account|company)\b/g,'').trim();
const COMMON = {
  id: [/^(?:id|uuid|key|record id|account id|company id|customer id)$/],
  name: [/(?:name|title|legal entity|organization)/],
  email: [/email/], phone: [/phone|telephone|mobile/],
  address: [/street|address line 1|addr/],
  city: [/city|town/], state: [/province|state|region/],
  parent: [/parent|owner ref|holding company/],
  status: [/status|state|lifecycle/],
};
export function profileDataset(rows, {sampleLimit=250} = {}) {
  safeRows(rows);
  const columns=[...new Set(rows.flatMap(r=>Object.keys(r)))].sort();
  const sample=rows.slice(0,sampleLimit);
  const fields=columns.map(key=>{
    const present=rows.filter(r=>r[key]!==null && r[key]!==undefined && String(r[key]).trim()!=='');
    const typeCount={};for(const r of present)typeCount[typeof r[key]]=(typeCount[typeof r[key]]||0)+1;
    const values=new Set(present.map(r=>String(r[key])));
    const semantic=Object.entries(COMMON).filter(([,tests])=>tests.some(re=>re.test(normLabel(key)))).map(([label])=>label);
    const type=Object.entries(typeCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'unknown';
    return {key,type,semantic,nonnull:present.length,nullRate:rows.length?Number((1-present.length/rows.length).toFixed(3)):0,
      unique:values.size,uniqueRatio:present.length?Number((values.size/present.length).toFixed(3)):0,
      examples:[...new Set(sample.map(r=>String(r[key]??'')))].filter(Boolean).slice(0,3).map(x=>x.slice(0,80))};
  });
  const fingerprint=sha({columns,fields:fields.map(f=>[f.key,f.type]),n:rows.length});
  return {rowCount:rows.length,columns,fields,fingerprint};
}
export function suggestMappings(leftProfile,rightProfile) {
  const choices=[];
  for(const a of leftProfile.fields){
    for(const b of rightProfile.fields){
      if(a.key===b.key) choices.push({left:a.key,right:b.key,confidence:'high',reason:'Exact field name'});
      else if(a.semantic.length===1 && b.semantic.includes(a.semantic[0])) choices.push({left:a.key,right:b.key,confidence:'low',reason:`Both may represent ${a.semantic[0]} — confirmation required`});
    }
  }
  return choices.sort((a,b)=>a.confidence===b.confidence?0:a.confidence==='high'?-1:1);
}
function compareValue(x,y){return clean(x)===clean(y)}
const finding=(type,summary,refs,description,confidence='medium', extra={})=>({
  type,summary,explanation:description,evidenceRefs:refs,confidence,id:sha({type,refs}),...extra
});
export function analyzeDataset({sourceId,rows,primaryKey=null}){
  safeRows(rows);
  const profile=profileDataset(rows);
  const result=[];
  const identity=primaryKey || profile.fields.find(f=>f.semantic.includes('id')&&f.uniqueRatio===1)?.key;
  if(identity){
    const observed=new Map();rows.forEach((r,i)=>{
      const k=strip(r[identity]);if(!k)return;
      if(observed.has(k))result.push(finding('duplicate_identity',`Duplicate identity ${sourceId}/${identity}`,[`${sourceId}:row:${observed.get(k)}`,`${sourceId}:row:${i}`],
        `Same nonempty ${identity} appears on multiple records; not proof that records can be merged.`));
      else observed.set(k,i);
    });
  }
  for(const field of profile.fields){
    if(field.nullRate>0.5 && rows.length>=5 && field.nonnull>0)
      result.push(finding('sparse_field',`High missing-data rate for ${sourceId}.${field.key}`,[`${sourceId}:profile:${field.key}`],
        `${Math.round(field.nullRate*100)}% of ${rows.length} rows are blank. Investigate whether the field is optional.`, 'low'));
    if(field.key.toLowerCase().includes('parent')&& identity && rows.length){
      const available=new Set(rows.map(r=>strip(r[identity])).filter(Boolean));
      rows.forEach((r,i)=>{const parent=strip(r[field.key]);if(parent && parent!==strip(r[identity]) && !available.has(parent)){
        result.push(finding('unresolved_relation',`Parent reference is absent from this dataset`,[`${sourceId}:row:${i}`],
          `${field.key} refers to an identity not in the snapshot. It may be in another page or entity.`, 'low'));
      }});
    }
  }
  // Domain-neutral numeric anomalies: a hypothesis, not a business correction.
  for(const field of profile.fields){
    if(field.type!=='number'||rows.length<8)continue;
    const samples=rows.map((row,i)=>({index:i,value:row[field.key]})).filter(x=>typeof x.value==='number'&&Number.isFinite(x.value));
    if(samples.length<8)continue;
    const ordered=samples.map(x=>x.value).sort((a,b)=>a-b);
    const median=a=>a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2;
    const mid=median(ordered),deviations=ordered.map(v=>Math.abs(v-mid)).sort((a,b)=>a-b),mad=median(deviations);
    if(mad===0)continue;
    for(const x of samples){if(Math.abs(x.value-mid)/(1.4826*mad)>8)
      result.push(finding('numeric_outlier',`Unusual numeric value in ${sourceId}.${field.key}`,[`${sourceId}:row:${x.index}`],
        `This value is more than eight robust standard deviations from the median. Check legitimate exceptions and units.`, 'low'));
    }
  }
  // Relationship cycles are suspicious, but parent relations might have legitimate special meanings.
  if(identity){
    const parentFields=profile.fields.filter(f=>f.semantic.includes('parent')||/parent.*(?:id|ref)/i.test(f.key));
    for(const pf of parentFields){
      const index=new Map(rows.map((r,i)=>[strip(r[identity]),{parent:strip(r[pf.key]),row:i}]));
      const seenCycles=new Set();
      for(const [start] of index){
        const path=[],positions=new Map();let node=start;
        while(node&&index.has(node)){
          if(positions.has(node)){
            const members=path.slice(positions.get(node));const signature=[...members].sort().join(':');
            if(members.length>1&&!seenCycles.has(signature)){seenCycles.add(signature);
              result.push(finding('relationship_cycle',`Possible circular hierarchy in ${sourceId}.${pf.key}`,
                members.map(m=>`${sourceId}:row:${index.get(m).row}`),
                `A parent reference chain returns to its starting entity; confirm relationship semantics.`, 'medium'));
            }break;
          }
          positions.set(node,path.length);path.push(node);node=index.get(node).parent;
        }
      }
    }
  }
  return {profile,findings:result};
}
/** No implicit merge: the operator chooses identity columns and exact field-pairs. */
export function reconcileDatasets({left,right,leftId='left',rightId='right',leftKey,rightKey,fields=[]}) {
  safeRows(left);safeRows(right);
  if(!leftKey||!rightKey||!Array.isArray(fields))throw Error('Matching keys and field pairs are required');
  const one=new Map(),two=new Map(),result=[];
  for(const [rows,key,id,map] of [[left,leftKey,leftId,one],[right,rightKey,rightId,two]]){
    rows.forEach((r,i)=>{const value=clean(r[key]);if(!value)return;
      if(!map.has(value))map.set(value,[]);map.get(value).push({row:r,index:i,ref:`${id}:row:${i}`});});
  }
  for(const [key,values] of one){
    const matches=two.get(key)||[];
    if(values.length!==1||matches.length>1){result.push(finding('ambiguous_entity',`Identity collision for ${leftKey}/${rightKey}`,
      [...values,...matches].map(x=>x.ref),'One-to-one match cannot be proven; require manual review.','low'));continue;}
    if(!matches.length){result.push(finding('missing_from_source',`Record exists in ${leftId} but not ${rightId}`,
      values.map(x=>x.ref),`No record with ${rightKey} matching the normalized key. This does not prove deletion.`, 'medium'));continue;}
    for(const pair of fields){
      if(!pair || typeof pair.left!=='string'||typeof pair.right!=='string')throw Error('Invalid explicit field pair');
      const a=values[0].row[pair.left],b=matches[0].row[pair.right];
      if(a===undefined || b===undefined)continue; // schema drift must be surfaced separately
      if(!compareValue(a,b))result.push(finding('cross_source_mismatch',`${pair.left} differs from ${pair.right}`,
        [values[0].ref,matches[0].ref],`Values differ. Neither system is assumed authoritative.`, 'medium',
        {comparison:{leftField:pair.left,rightField:pair.right,leftValue:strip(a).slice(0,120),rightValue:strip(b).slice(0,120)}}));
    }
  }
  for(const [key,values] of two)if(!one.has(key))result.push(finding('missing_from_source',`Record exists in ${rightId} but not ${leftId}`,
    values.map(x=>x.ref),`No record with ${leftKey} matching the normalized key.`, 'medium'));
  const schemaDrift=fields.filter(p=>!left.some(r=>p.left in r)||!right.some(r=>p.right in r));
  for(const pair of schemaDrift)result.push(finding('schema_drift',`Expected mapped field unavailable`,[
    `${leftId}:profile:${pair.left}`,`${rightId}:profile:${pair.right}`],`Cannot verify mapping ${pair.left} → ${pair.right}; no data update should be proposed.`, 'high'));
  return {findings:result,leftProfile:profileDataset(left),rightProfile:profileDataset(right),compared:one.size};
}
export function observationsForAgent(items,limit=100){
  if(!Array.isArray(items))throw Error('Observations must be an array');
  return items.slice(0,limit).map(x=>({ref:String(x.id||x.evidenceRefs?.[0]||'').slice(0,120),summary:String(x.summary||'').slice(0,450)})).filter(x=>x.ref&&x.summary);
}
