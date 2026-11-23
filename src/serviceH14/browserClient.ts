import { ServiceH14Client } from './client.ts';
import type { ServiceH14RuntimeMessage } from './workerHandler.ts';
import { SERVICE_H14_PROFILE } from './profile.ts';
export { ServiceH14Client, ServiceH14RuntimeError, isServiceH14Interruption } from './client.ts';

export function createServiceH14Client(): ServiceH14Client {
  return new ServiceH14Client({ createWorker() {
    const worker = new Worker(new URL('./browserWorker.ts',import.meta.url),{type:'module',name:SERVICE_H14_PROFILE.id});
    return { runtime:'browser',postMessage:message=>worker.postMessage(message),terminate:()=>worker.terminate(),
      listen(message,error) {
        const onMessage=(event:MessageEvent<ServiceH14RuntimeMessage>)=>message(event.data);
        const onError=(event:ErrorEvent)=>error(event.error??event.message);
        const onMessageError=()=>error(new Error('service_h14_response_clone_failed'));
        worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.addEventListener('messageerror',onMessageError);
        return ()=>{worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);worker.removeEventListener('messageerror',onMessageError);};
      }
    };
  }});
}
