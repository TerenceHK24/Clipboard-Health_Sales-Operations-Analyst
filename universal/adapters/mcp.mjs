/** Safely expose company-authorized MCP tools as namespaced capabilities.
 * Works with a trusted MCP SDK client (listTools/callTool) supplied by the host.
 * Tool annotations alone never grant write permission.
 */
export async function registerMcpCapabilities({registry,client,namespace,policies={}}) {
  if(!/^[a-z][a-z0-9_-]+$/.test(namespace)) throw new Error('Invalid MCP connector namespace');
  const listing=await client.listTools();
  if(!Array.isArray(listing?.tools)) throw new Error('MCP client must return a tools array');
  const installed=[];
  for(const item of listing.tools){
    const policy=policies[item.name];
    if(!policy?.enabled) continue; // fail closed; listTools does not authorize use
    const mode=policy.mode;
    if(!['read','write','notify'].includes(mode) || typeof policy.validate !== 'function') throw new Error(`Missing explicit policy for MCP tool ${item.name}`);
    if(mode!=='read' && typeof policy.verify !== 'function') throw new Error('MCP writes require independently implemented read-back verification');
    const id=`mcp.${namespace}.${item.name.replace(/[^a-zA-Z0-9_-]/g,'_').toLowerCase()}`;
    registry.register({id,description:String(item.description||item.name).slice(0,500),mode,requiredScopes:policy.scopes||[],
      validate:policy.validate,
      execute:async args=>client.callTool({name:item.name,arguments:args}),verify:policy.verify});
    installed.push(id);
  }
  return installed;
}
