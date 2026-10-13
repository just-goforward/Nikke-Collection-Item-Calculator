import {admission,FRAME_BYTES,HEAP_CAP_MIB,OBSERVED_HEAP_LIMIT_SLACK_MIB} from "./contract.mjs";
import {getHeapStatistics} from "node:v8";
import {Refusal} from "./evaluator.mjs";
import {controls} from "./controls.mjs";
function publish(result) {
  let frame=JSON.stringify(result)+"\n";
  if(Buffer.byteLength(frame)>FRAME_BYTES) frame='{"status":"FAIL","reason":"frame_budget"}\n';
  process.stdout.write(frame);
}
if(!process.send||!/^[a-f0-9]{64}$/.test(process.argv[2]||""))
  publish({status:"NOTRUN",reason:"runner_launch_required"});
else {
  const timer=setTimeout(()=>{
    publish({status:"NOTRUN",reason:"launch_handshake_timeout"});
    process.disconnect();
  },1000);
  process.once("message",async message=>{
    clearTimeout(timer);
    process.disconnect();
    if(!message||Object.keys(message).sort().join(",")!=="mode,token"||
      message.token!==process.argv[2]||!["controls","main","calibrate"].includes(message.mode))
      return publish({status:"FAIL",reason:"launch_handshake"});
    let result=admission(message.mode);
    if(!result) {
      try {
        if(getHeapStatistics().heap_size_limit!==(HEAP_CAP_MIB+OBSERVED_HEAP_LIMIT_SLACK_MIB)*1024*1024)
          throw new Error("heap_size_limit_mismatch");
        if(message.mode==="controls") {
          const checked=await controls();
          result={status:"PASS",reason:"hand_and_tiny_oracle_controls;throughput="+JSON.stringify(checked.throughput)};
        } else result=await (await import("./main.mjs")).main(message.mode);
      }
      catch(e) {result={status:e instanceof Refusal?"NOTRUN":"FAIL",reason:String(e.message).slice(0,1000)};}
    }
    publish(result);
  });
}
