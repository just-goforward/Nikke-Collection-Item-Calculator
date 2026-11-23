import { createServiceH14WorkerHandler, type ServiceH14RuntimeRequest } from './workerHandler.ts';
const handler=createServiceH14WorkerHandler(message=>self.postMessage(message));
self.addEventListener('message',(event:MessageEvent<ServiceH14RuntimeRequest>)=>{void handler.handle(event.data);});
