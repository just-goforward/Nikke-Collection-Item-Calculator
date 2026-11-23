import {useEffect,useState} from 'react';
import {createProductionDecision} from './analytics/decisionProduction';
import App from './App';

/** The original consent/catalog boundary. Conditional solver receipts never enter its acquisition map. */
export default function RootCandidateApp() {
  const [decision,setDecision]=useState<Awaited<ReturnType<typeof createProductionDecision>>>();
  useEffect(()=>{
    let retired=false, port:Awaited<ReturnType<typeof createProductionDecision>>;
    void createProductionDecision().then(next=>{if(retired)next?.disable();else{port=next;setDecision(next);}});
    return ()=>{retired=true;port?.disable();};
  },[]);
  return <App decision={decision}/>;
}
