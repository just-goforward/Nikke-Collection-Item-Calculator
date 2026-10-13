import assert from "node:assert/strict";
import {classify} from "./protocol.mjs";
// Pure fake-close inputs. No child process, evaluator or product import.
const good={code:0,signal:null,stderr:"",stdout:'{"status":"PASS","reason":"controls"}\n'};
const cases=[
  [good,"PASS","controls"],
  [{...good,stdout:'{"status":"NOTRUN","reason":"row_budget"}\n'},"NOTRUN","row_budget"],
  [{...good,code:1,stderr:"FATAL ERROR: Allocation failed - JavaScript heap out of memory"},"NOTRUN","v8_oom"],
  [{...good,code:134,stderr:"FATAL ERROR: JavaScript heap out of memory"},"NOTRUN","v8_oom"],
  [{...good,code:134,stderr:"x".repeat(301)+"JavaScript heap out of memory"},"NOTRUN","v8_oom"],
  [{...good,code:134,stderr:"GC trace\n".repeat(31)+"    JavaScript heap out of memory"},"NOTRUN","v8_oom"],
  [{...good,deadline:true,stderr:"unexpected warning"},"FAIL","child_stderr"],
  [{...good,deadline:true,signal:"SIGTERM",code:null},"NOTRUN","wall_deadline"],
  [{...good,code:2},"FAIL","abnormal_exit"],
  [{...good,stderr:"warning"},"FAIL","child_stderr"],
  [{...good,stdout:'{"status":"PASS","reason":"x","extra":1}\n'},"FAIL","invalid_frame"],
  [{...good,stdout:good.stdout+good.stdout},"FAIL","invalid_frame"],
  [{...good,overflow:true},"FAIL","transport_integrity"],
];
for(const [input,status,reason] of cases) assert.deepEqual(classify(input),{status,reason});
console.log(JSON.stringify({status:"PASS",reason:`${cases.length}_fake_close_cases`}));
