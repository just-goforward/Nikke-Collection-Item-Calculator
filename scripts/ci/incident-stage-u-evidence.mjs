// Read-only bridge from the completed upload to the independent Stage A and Site decisions.
import assert from 'node:assert/strict';
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {control,schedule} from './incident-canary-control.mjs';
import {original} from './incident-recovery-id.mjs';
import {closed,publicBindings,publicHash,uploadReadbacks} from './incident-owner-upload-only.mjs';
import {digest,immutable} from './incident-provider.mjs';

export const stageUPredecessor='00323557-9e9f-470f-b491-3906316f5d69';
const markerSha='e16afc3b992035149f42000b5984ac654acbaf8d5db7329ee411c03e31240068',ackSha='6e132d263351ea1ca1312a8d202c7ec6ea8e06e96ecb6dd52c26068a2ca1ae14';
export const stageU=Object.freeze({source:'b84443033056b28a5f23594f90c4171863015e57',version:'3ffefebc-3a91-424c-b8d0-b4d5aa0a0218',build:'24d65a8263bf42e0205f4ee49c5451344c7c35c4c645cb849c4e88a47bb55f83',module:publicHash,
  bindingsSha256:'e1fcf8966ac122ed77a8eed0eb3748f57641b5c6675fb5f911515c2be2255a87',
  intentSha256:'6f659360595515445f79aed7f418d6a795825b9d58c27a92bc0a1eec91386182',
  ackSha256:'f1fd6d13362ab2e8afa833f0cdaca9cdbfab2c645df4bd5044572d5eb681a1b9',
  verifiedSha256:'19aa8cce5fbae0ce6be0db2f3ff5dfb3fcc2cd1d1fbe340a5aa006cd7fba8338'});
// The predecessor remains the only receipt accepted by the historical upload path.
export const layoutU=Object.freeze({source:'5649b7f942c1892100a40b782f9716015d89fdc5',version:'e0fd1e38-5f7b-4777-9d96-681c6bb45038',build:'2bfe30a171be2e58243bcf3c6b05961c3b031a1d4ddbc114e650a928605c90d0',module:publicHash,
  bindingsSha256:'8db7effc4f4f7f0bf97c536e4960f642692806689c83a871dd4f1b870ef383bd',
  intentSha256:'f31ab715c04987481102b79d9ce8ae681f71d42fed7125fb40f35d4c93a2f1a4',
  ackSha256:'b202d53695046099c2c98c66581a66a0a99ba4c4800d5d12aea88c4daaccf168',
  verifiedSha256:'94c3d58540cf841d4926282e7bf4caca0937fd06c66d2090e5f5ac7ec085a987'});

export function checkOwnerDirectory(dir) {
  const s=lstatSync(dir);assert(s.isDirectory() && realpathSync(dir)===dir && s.uid===process.getuid() && !(s.mode&0o077),'unsafe owner directory');
}
function receipt(dir,file,sha) {
  const fd=openSync(join(dir,file),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const st=fstatSync(fd);assert(st.isFile() && st.nlink===1 && st.uid===process.getuid() && !(st.mode&0o077) && st.size<=4096);
    const bytes=readFileSync(fd);assert.equal(digest(bytes),sha,`wrong original ${file}`);return JSON.parse(bytes);}
  finally {closeSync(fd);}
}
export function readStageU(dir) {
  checkOwnerDirectory(dir);
  const file=original.workerId+'.json',m=receipt(dir,file,markerSha);
  assert.equal(m.phase,'attempt-consumed');assert.equal(m.reviewedMain,'ca2904054baf83ddc2a59166f9436776966a01d8');assert.equal(m.hash,publicHash);assert.equal(m.deployment,closed.deployment);
  assert.deepEqual(receipt(dir,file+'.ack',ackSha),{candidate:stageUPredecessor});
  return readSuccessor(dir,stageUPredecessor,stageU);
}
function readSuccessor(dir,predecessor,enrolled) {
  const slot=join(dir,'successor-of-'+predecessor);checkOwnerDirectory(slot);
  const {scope,approval}=receipt(slot,'intent.json',enrolled.intentSha256);
  const {source,build,module,bindingsSha256,version:id}=enrolled;
  assert.deepEqual(receipt(slot,'ack.json',enrolled.ackSha256),{id,source,predecessor,build,module,bindingsSha256});
  const verified=receipt(slot,'verified.json',enrolled.verifiedSha256);
  assert.deepEqual(verified,{state:'verified-inactive-only',id,scope,approval,verifiedAt:verified.verifiedAt,activationAuthorized:false});
  assert.equal(scope.source,source);assert.equal(scope.build,build);assert.equal(scope.bindingsSha256,bindingsSha256);
  assert(Number.isSafeInteger(verified.verifiedAt));assert.match(scope.editorId,immutable);
  return verified;
}
export function readLayoutU(dir) {
  readStageU(dir);
  const verified=readSuccessor(dir,stageU.version,layoutU),{scope}=verified;
  assert.equal(scope.operation,'layout-successor-inactive-upload-v1');assert.deepEqual(scope.predecessorReceipt,stageU);
  assert.equal(scope.predecessor,stageU.version);assert.equal(scope.module,layoutU.module);
  assert.equal(scope.worker,original.workerId);assert.equal(scope.inertDeployment,closed.deployment);
  return verified;
}

async function exactReceiver(read,build,enrolled) {
  assert.equal(build,enrolled.build,'receiver not enrolled for this service build');
  const settings=publicBindings(build);assert.equal(digest(JSON.stringify(settings)),enrolled.bindingsSha256);
  await uploadReadbacks(read).exact(enrolled.version,enrolled.module,['ADMIN_ID','BOT_TOKEN'],'worker.js',settings);
}
export const checkReceiverVersion=(read,build)=>exactReceiver(read,build,stageU);
export const checkLayoutVersion=(read,build)=>exactReceiver(read,build,layoutU);

// A matching inactive version, receiver route, or build setting on another version is not live proof.
export async function observeIncident(read,build) {
  const live=await control(read);
  assert.equal(live.version,layoutU.version,'layout receiver is not the sole active incident version');
  assert.deepEqual(live.crons,[schedule]);await checkLayoutVersion(read,build);
  return {deployment:live.deployment,version:live.version,build};
}
