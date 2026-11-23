"""Rebuild the reviewed rectangular DP and seal its mathematical input (not case results).
Usage: python3 scripts/seal-portable-toll.py PATH/TO/r0-envelope/review
The portable query has no dependency on the research directory or its signatures.
"""
import hashlib, json, subprocess, sys
from pathlib import Path

review = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[1]
out = root/'src/serviceH14/generated'
hash256 = lambda b: hashlib.sha256(b).hexdigest()
build = review/'build_slabs.py'
if hash256(build.read_bytes()) != '4b32a2dfddc63c145a20063fc2b31e3b3ffba487662339cde94d77233fc0485f': raise ValueError('unreviewed producer')
subprocess.run([sys.executable, str(build)], check=True)
asset = (review/'slabs.bin').read_bytes()
fixture = review.parents[2]/'wait-policy-20261119-preview/paired/input.txt'
lines = fixture.read_text().splitlines()
# Counted graph, board classes, two counted box laws, 15 epoch histograms and counted prior.
j = 1 + int(lines[0]); j += 1 + int(lines[j]);
for _ in range(2): j += 1 + int(lines[j])
j += 15; j += 1 + int(lines[j]);
physical = ('\n'.join(lines[:j])+'\n').encode()
if len(asset)!=1949868 or hash256(asset)!='105ebf3b1945693b4598fdda518bf9ba92e5290031d2f5d8b2bbd55e48eeec65': raise ValueError('unreviewed slab')
manifest = dict(schema=1, model='documented-physical-supply-v2', epoch='game-reset', semantics='independent_given_cohort-v1', claims='all-claimable-only', cohortRerolls=[0,1,2], horizon=14, lambdaFraction=[1,400], sid=0, dimensions=[45,16,10], prefixDimensions=[37,12,7], maxUnits=[8,4,3], residue=[0,0,0], dpGuard=1e-9, integralGuard=1e-8, byteLength=len(asset), sha256=hash256(asset), physicalSha256=hash256(physical), producerSha256=hash256(build.read_bytes()))
(out/'portableTollPin.ts').write_text('export const portableTollPin = '+json.dumps(manifest,separators=(',',':'))+' as const;\n')
target = root/'public/proofs'/('r0-toll-'+hash256(asset)+'.bin')
target.parent.mkdir(exist_ok=True)
target.write_bytes(asset)
