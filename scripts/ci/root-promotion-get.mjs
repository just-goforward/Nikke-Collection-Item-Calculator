// GET-only transport retry. A complete response always goes to the normal verifier;
// never retry malformed bytes, wrong identities, authorization errors or failed browser assertions.
import {setTimeout as delay} from 'node:timers/promises';

export async function rootGet(url,options={},send=fetch,pause=delay){
  for(const ms of [0,250,1000]){
    if(ms)await pause(ms);
    let r;
    try {r=await send(url,{...options,method:'GET',redirect:'error',signal:AbortSignal.timeout(12000)});}
    catch(e){if(ms===1000)throw e;continue;}
    if(ms===1000 || ![408,429,500,502,503,504].includes(r.status))return r;
    await r.body?.cancel();
  }
}
