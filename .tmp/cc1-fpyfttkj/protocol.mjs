export function response(status,reason) { return {status,reason}; }
export function decode(text) {
  if(!text.endsWith("\n")||text.slice(0,-1).includes("\n")) throw new Error("frame");
  const r=JSON.parse(text);
  if(!r||Array.isArray(r)||!["reason,status","endpoints,reason,status"].includes(Object.keys(r).sort().join(","))||
    !["PASS","FAIL","NOTRUN"].includes(r.status)||typeof r.reason!=="string"||
    r.reason.length>2048) throw new Error("schema");
  if(Object.hasOwn(r,"endpoints")&&(!Array.isArray(r.endpoints)||r.endpoints.length>37||
    r.endpoints.some(e=>!e||Object.keys(e).sort().join(",")!=="id,relaxationTrusted"||
      typeof e.id!=="string"||e.id.length>80||typeof e.relaxationTrusted!=="boolean")))
    throw new Error("endpoint_schema");
  return r;
}
export function classify({code,signal,stderr,stdout,deadline=false,overflow=false,spawnError=false}) {
  const abnormal=code!==0||signal!==null;
  const banner=stderr.includes("JavaScript heap out of memory");
  if(spawnError||overflow) return response("FAIL","transport_integrity");
  if(abnormal&&banner) return response("NOTRUN","v8_oom");
  if(stderr) return response("FAIL","child_stderr");
  if(deadline) return response("NOTRUN","wall_deadline");
  if(abnormal) return response("FAIL","abnormal_exit");
  try { return decode(stdout); } catch {return response("FAIL","invalid_frame");}
}
