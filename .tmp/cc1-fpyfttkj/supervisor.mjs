import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {readFileSync} from "node:fs";
import {classify} from "./protocol.mjs";
import {admission,HEAP_CAP_MIB,FRAME_BYTES,CONTROL_MS,NODE_VERSION} from "./contract.mjs";
// stdout is provisional until close. Caller must additionally await THIS
// supervisor's clean close. No standalone stdout line is a certificate.
const mode=process.argv[2];
const repo=fileURLToPath(new URL("../../",import.meta.url));
let denied=admission(mode);
if(process.version!==NODE_VERSION) denied={status:"NOTRUN",reason:"node_version"};
if(process.execArgv.length) denied={status:"NOTRUN",reason:"supervisor_execArgv"};
if(Object.keys(process.env).some(k=>/^(NODE_|UV_)/i.test(k)))
  denied={status:"NOTRUN",reason:"runtime_environment_override"};
const publish=x=>process.stdout.write(JSON.stringify(x)+"\n");
// identity root digest must be supplied by the authenticated outer caller.
// A manifest cannot authenticate its own digest.
if(!denied) {
  try {
    const bytes=readFileSync(new URL("./identity.json",import.meta.url));
    const actual=createHash("sha256").update(bytes).digest();
    const expected=Buffer.from(process.argv[3]||"","hex");
    if(expected.length!==32||!timingSafeEqual(actual,expected)) throw new Error("manifest_pin");
    const identity=JSON.parse(bytes);
    if(identity.status!=="COMPLETE"||!identity.modulePins) throw new Error("identity_incomplete");
    for(const [path,sha] of Object.entries({...identity.sources,...identity.modulePins})) {
      const hash=createHash("sha256").update(readFileSync(resolve(repo,path))).digest("hex");
      if(hash!==sha) throw new Error("source_pin_mismatch");
    }
  } catch(e) {denied={status:"FAIL",reason:String(e.message).slice(0,1000)};}
}
if(denied) publish(denied);
else if(!["controls","main","calibrate"].includes(mode)) publish({status:"FAIL",reason:"invalid_mode"});
else {
  const token=randomBytes(32).toString("hex");
  // Required solely by the pinned helper's TS parameter properties. Suppress
  // this expected experimental-feature warning only, not arbitrary stderr.
  const child=spawn(process.execPath,[`--max-old-space-size=${HEAP_CAP_MIB}`,
    "--experimental-transform-types","--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./worker.mjs",import.meta.url)),token],{stdio:["ignore","pipe","pipe","ipc"]});
  child.send({token,mode});
  let out="",err="",overflow=false,timedOut=false,spawnError=false;
  const wall=mode==="controls"?CONTROL_MS:
    JSON.parse(readFileSync(new URL("./obligations.json",import.meta.url))).resources.jobs
      .filter(j=>j.admitted&&(mode!=="calibrate"||j.id==="B14")).reduce((n,j)=>n+j.wallMs,10000);
  const timer=setTimeout(()=>{timedOut=true;child.kill();},wall);
  child.stdout.on("data",b=>{
    if(Buffer.byteLength(out)+b.length>FRAME_BYTES) {overflow=true;child.kill();}
    else out+=b.toString("utf8");
  });
  child.stderr.on("data",b=>{
    if(Buffer.byteLength(err)+b.length>FRAME_BYTES) {overflow=true;child.kill();}
    else err+=b.toString("utf8");
  });
  child.on("error",()=>{spawnError=true;});
  child.on("close",(code,signal)=>{
    clearTimeout(timer);
    publish(classify({code,signal,stderr:err,stdout:out,deadline:timedOut,overflow,spawnError}));
  });
}
