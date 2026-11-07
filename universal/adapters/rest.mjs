/** Generic company-owned REST connector. Secrets are resolved only at invocation. */
export function registerRestCapability({registry,id,baseUrl,method='GET',path,description,validate,credentialResolver,verify,scopes=[],fetchImpl=fetch}) {
  const origin=new URL(baseUrl);
  if(origin.protocol!=='https:' && !(origin.protocol==='http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) throw new Error('REST connectors must use HTTPS (or localhost for tests)');
  if(origin.username||origin.password||origin.search||origin.hash)throw new Error('Endpoint credentials/query are forbidden');
  if(!['GET','POST','PATCH'].includes(method))throw new Error('Unsupported REST method');
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('..')||path.includes('?'))throw new Error('Invalid fixed REST path template');
  if(typeof validate!=='function'||typeof credentialResolver!=='function')throw new Error('REST connectors require validation and a runtime credential resolver');
  const mode=method==='GET'?'read':'write';
  if(mode==='write' && typeof verify!=='function')throw new Error('Writes require independent read-back verification');
  const root=origin.origin;
  registry.register({id,description,mode,requiredScopes:scopes,validate,verify,
    execute:async (args,context)=>{
      const route=path.replace(/\{([a-zA-Z0-9_]+)\}/g,(_match,key)=>{
        if(typeof args[key]!=='string'||!args[key].trim()) throw new Error('Missing REST path parameter');
        return encodeURIComponent(args[key]);
      });
      const url=new URL(route,root);
      if(url.origin!==root)throw new Error('REST request origin changed');
      const token=await credentialResolver(context);
      if(typeof token!=='string'||!token)throw new Error('Missing runtime token');
      const init={method,redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)};
      if(method!=='GET')init.body=JSON.stringify(args.body??{});
      const response=await fetchImpl(url,init);
      if(!response.ok)throw new Error(`Remote REST action failed with HTTP ${response.status}`);
      return response.status===204?{}:response.json();
    }});
  return id;
}
