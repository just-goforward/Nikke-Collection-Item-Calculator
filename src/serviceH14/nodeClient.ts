import { Worker } from 'node:worker_threads';
import { ServiceH14Client, type ServiceH14WorkerPort } from './client.ts';

/** workerUrl is an actual bundled ESM service Worker, never a numerical test double. */
export function createNodeServiceH14Client(workerUrl:URL,options:{idleTimeoutMs?:number}={}):ServiceH14Client{
  return new ServiceH14Client({...options,createWorker(){
    const worker=new Worker(workerUrl);
    const port:ServiceH14WorkerPort={runtime:'node',postMessage:message=>worker.postMessage(message),terminate:()=>worker.terminate(),
      listen(message,error){
        const exit=(code:number)=>error(new Error('Service H14 Worker exited ('+code+').'));
        worker.on('message',message);worker.on('error',error);worker.on('messageerror',error);worker.on('exit',exit);
        return ()=>{worker.off('message',message);worker.off('error',error);worker.off('messageerror',error);worker.off('exit',exit);};
      }};
    return port;
  }});
}
