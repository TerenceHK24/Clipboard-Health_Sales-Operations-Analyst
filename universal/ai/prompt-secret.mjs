import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
/** No CLI flags, no environment fallback, no disk writes. */
export async function promptSecret(label='Enter your AI provider API key (hidden): ', {input=process.stdin,output=process.stderr}={}) {
  if(!input.isTTY || !output.isTTY)throw new Error('Interactive terminal required for sensitive keys');
  const mute=new Writable({write(_chunk,_enc,next){next();}});
  const rl=createInterface({input,output:mute,terminal:true});
  output.write(label);
  try{const value=await rl.question('');
    if(!value.trim() || /\s/.test(value))throw new Error('Invalid key');
    return value;
  }finally{rl.close();output.write('\n');}
}
