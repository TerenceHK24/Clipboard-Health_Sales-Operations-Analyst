/** Service-specific read-only probes; no probe sends a message or changes data. */
import {loadRestDataset} from '../platform/sources.mjs';
const clean=x=>String(x?.message||x).slice(0,160).replace(/(?:bh_|sk-|ghp_)[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
const paths={
  hubspot:'/crm/v3/objects/companies?limit=1',
  gmail:'/gmail/v1/users/me/profile',
  googlecalendar:'/calendar/v3/users/me/calendarList?maxResults=1',
  outlook:'/v1.0/me',
  salesforce:'/services/data/',
  slack:'/api/auth.test',
};
const defaultBases={
  hubspot:'https://api.hubapi.com',gmail:'https://gmail.googleapis.com',googlecalendar:'https://www.googleapis.com',
  outlook:'https://graph.microsoft.com',slack:'https://slack.com',
};
export async function probeConnection(conn,resolveCredential,{fetchImpl=fetch}={}){
  const provider=conn.provider;
  if(provider==='demo')return true;
  if(!conn.settings?.baseUrl && !defaultBases[provider])throw Error('A verified baseUrl is required for this provider');
  const url=new URL(conn.settings?.baseUrl||defaultBases[provider]);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Invalid probe base URL');
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Probes must use HTTPS');
  const chosen=conn.settings?.testPath||paths[provider]||'/';
  if(!chosen.startsWith('/')||chosen.startsWith('//')||chosen.includes('..')||chosen.includes('#'))throw Error('Invalid read-only health endpoint');
  const endpoint=new URL(chosen,url);
  if(endpoint.origin!==url.origin)throw Error('Probe cannot leave configured origin');
  const token=conn.secret_ref?await resolveCredential(conn.secret_ref):null;
  const r=await fetchImpl(endpoint,{method:'GET',redirect:'error',headers:{Accept:'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},signal:AbortSignal.timeout(14000)});
  if(!r.ok)throw Error(`Provider probe returned HTTP ${r.status}`);
  const text=await r.text();if(text.length>200000)throw Error('Provider probe output too large');
  // Slack uses HTTP 200 even on OAuth failures. Must check payload.ok.
  if(provider==='slack'){
    const data=JSON.parse(text);if(data.ok!==true)throw Error('Slack auth.test failed');
  }
  return true;
}
export const defaultsForProvider=id=>({baseUrl:{hubspot:'https://api.hubapi.com',gmail:'https://gmail.googleapis.com',
  googlecalendar:'https://www.googleapis.com',outlook:'https://graph.microsoft.com',slack:'https://slack.com'}[id]||'',
  testPath:paths[id]||'/'});
