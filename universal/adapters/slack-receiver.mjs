/** Mount this request handler behind an organization's HTTPS endpoint.
 * ACK is written before executing plans or doing AI follow-up work.
 */
export function createSlackInteractionHandler({gateway,runtime,onBackgroundError=error=>console.error('Slack background operation failed:',error.message)}){
  if(!gateway || !runtime)throw Error('Gateway and runtime required');
  return async (req,res)=>{
    if(req.method!=='POST' || req.url?.split('?')[0]!=='/slack/interactions'){
      res.writeHead(404);res.end('Not found');return;
    }
    if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded'){
      res.writeHead(415);res.end('Expected Slack form payload');return;
    }
    const chunks=[];let bytes=0;
    try{
      for await(const chunk of req){bytes+=chunk.length;if(bytes>95000)throw Error('Slack request too large');chunks.push(chunk)}
      const rawBody=Buffer.concat(chunks).toString('utf8');
      const {ack,afterAck}=await gateway.handle({headers:req.headers,rawBody,runtime});
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify(ack));
      if(afterAck){setImmediate(()=>Promise.resolve().then(afterAck).catch(onBackgroundError));}
    }catch(error){
      if(!res.headersSent){
        res.writeHead(error.message==='Invalid Slack signature'?401:400,
          {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
        res.end(JSON.stringify({error:'Invalid or unauthorized Slack interaction'}));
      }
    }
  };
}
