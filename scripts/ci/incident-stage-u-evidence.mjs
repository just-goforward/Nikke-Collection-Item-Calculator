// Read-only bridge from the completed upload to the independent Stage A and Site decisions.
import assert from 'node:assert/strict';
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {control,schedule} from './incident-canary-control.mjs';
import {newBuild,predecessor,readPredecessor} from './incident-mobile-successor.mjs';
import {publicBindings,publicHash,uploadReadbacks} from './incident-owner-upload-only.mjs';
import {digest} from './incident-provider.mjs';

export const stageU=Object.freeze({source:'b84443033056b28a5f23594f90c4171863015e57',version:'3ffefebc-3a91-424c-b8d0-b4d5aa0a0218',build:newBuild,module:publicHash,
  bindingsSha256:'e1fcf8966ac122ed77a8eed0eb3748f57641b5c6675fb5f911515c2be2255a87',
  intentSha256:'6f659360595515445f79aed7f418d6a795825b9d58c27a92bc0a1eec91386182',
  ackSha256:'f1fd6d13362ab2e8afa833f0cdaca9cdbfab2c645df4bd5044572d5eb681a1b9',
  verifiedSha256:'19aa8cce5fbae0ce6be0db2f3ff5dfb3fcc2cd1d1fbe340a5aa006cd7fba8338'});

export function readStageU(dir) {
  readPredecessor(dir); // Historical marker/ACK are required but cannot stand in for the successor.
  const slot=join(dir,'successor-of-'+predecessor),s=lstatSync(slot);
  assert(s.isDirectory() && realpathSync(slot)===slot && s.uid===process.getuid() && !(s.mode&0o077),'unsafe Stage U slot');
  const original=(file,sha)=>{
    const fd=openSync(join(slot,file),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {const st=fstatSync(fd);assert(st.isFile() && st.nlink===1 && st.uid===process.getuid() && !(st.mode&0o077) && st.size<=4096);
      const bytes=readFileSync(fd);assert.equal(digest(bytes),sha,`wrong Stage U ${file}`);return JSON.parse(bytes);}
    finally {closeSync(fd);}
  };
  const {scope,approval}=original('intent.json',stageU.intentSha256);
  const {source,build,module,bindingsSha256,version:id}=stageU;
  assert.deepEqual(original('ack.json',stageU.ackSha256),{id,source,predecessor,build,module,bindingsSha256});
  const verified=original('verified.json',stageU.verifiedSha256);
  assert.deepEqual(verified,{state:'verified-inactive-only',id,scope,approval,verifiedAt:verified.verifiedAt,activationAuthorized:false});
  assert.equal(scope.source,source);assert.equal(scope.build,build);assert.equal(scope.bindingsSha256,bindingsSha256);
  return stageU;
}

export async function checkReceiverVersion(read,build) {
  assert.equal(build,stageU.build,'receiver not enrolled for this service build');
  const settings=publicBindings(build);assert.equal(digest(JSON.stringify(settings)),stageU.bindingsSha256);
  await uploadReadbacks(read).exact(stageU.version,stageU.module,['ADMIN_ID','BOT_TOKEN'],'worker.js',settings);
}

// A matching inactive version, receiver route, or build setting on another version is not live proof.
export async function observeIncident(read,build) {
  const live=await control(read);
  assert.equal(live.version,stageU.version,'Stage U receiver is not the sole active incident version');
  assert.deepEqual(live.crons,[schedule]);await checkReceiverVersion(read,build);
  return {deployment:live.deployment,version:live.version,build};
}
