// Read-only adjunct to the protected Site workflow. This cannot approve an upload or alter a release.
import assert from 'node:assert/strict';
import {hash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {verifyRootRelease} from './site-release.mjs';
import {assertSiteUploadApproved} from './deploy-site.ts';
const [role,packet,canary,dir,sha,digest,run,attempt,...rest]=process.argv.slice(2);
assert(['forward','rollback'].includes(role)&&attempt&&!rest.length);
const bytes=await readFile(packet),pair=JSON.parse(bytes),proof=JSON.parse(await readFile(canary));
assert.equal(pair.profile,'private-production-root-v1');assert.equal(pair.productionDeployable,false);assert.equal(pair.publicationApproved,false);assert.equal(pair.review.source,sha);assert.equal(pair.files.retained,66);
assert.equal(proof.profile,'private-root-tab-canary-v1');assert.equal(proof.packetSha256,hash('sha256',bytes));assert.deepEqual(proof.results.map(x=>[x.before,x.after]),[['rollback','forward'],['forward','rollback']]);
const root=resolve(import.meta.dirname,'..'),release=resolve(dir);verifyRootRelease(root,release,sha,digest,run,attempt);
const files=JSON.parse(await readFile(join(release,'manifest.json'))).files;
const actual=Object.fromEntries(Object.entries(files).filter(([p])=>p.startsWith('dist/')&&!p.startsWith('dist/.vite/')&&!['dist/.assetsignore','dist/_headers'].includes(p)).map(([p,v])=>[p.slice(4),v]));
assert.deepEqual(actual,pair.files[role],'sealed served tree differs from private run');assert.equal(files['dist/_headers']?.sha256,pair.files.headersSha256);assert.equal(files['dist/.assetsignore']?.sha256,hash('sha256','/.vite/\n'));
assert.equal(files['worker/worker.js']?.sha256,'17190d4c25d655580813944ae79821d898e4c6ed3b5774dbaee82ac87d4f916f','sealed Site module changed');assertSiteUploadApproved(join(release,'dist'));
console.log(JSON.stringify({role,sha,digest,run,attempt,bytesMatch:true,uploadAuthorized:false}));
