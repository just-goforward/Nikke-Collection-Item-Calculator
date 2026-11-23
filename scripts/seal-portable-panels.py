"""Rebuild reviewed SR0 and R11 surfaces. Pass the offline balanced-b-completion directory.
No archive request or case list is an application trust input. Publish nothing.
"""
import gzip, hashlib, subprocess, sys
from pathlib import Path
review = Path(sys.argv[1]).resolve()
out = Path(__file__).resolve().parents[1]/'public/proofs'
out.mkdir(exist_ok=True)
for directory, producer, filename, size, name, digest in [
    ('sr0-transfer','438ef2956bef719507c34ae43a5e2b818a457df74c8eb5ccc25cda812e7831e6','proof.bin.gz',713685,'sr0-toll','4392c1e92f2946bdb6bbd85520a5d46abd5a086b725041c94a0b5e11aeaa5413'),
    ('r11-functional','7ad2911cf6dc76ce968c930a6da48b83f7c8a5cef5c227a99d66ad8e81ea2c4d','yellow.bin',264960,'r11-yellow','88a8b1124318e325cfc3457cddc1bc26e3ce623b84a0516878d1db2202143015'),
]:
    script = review/directory/'build.py'
    if hashlib.sha256(script.read_bytes()).hexdigest()!=producer: raise ValueError('unreviewed producer')
    subprocess.run([sys.executable,str(script)],check=True)
    data = (review/directory/filename).read_bytes()
    if filename.endswith('.gz'): data = gzip.decompress(data)
    if len(data)!=size or hashlib.sha256(data).hexdigest()!=digest: raise ValueError('unreviewed surface')
    (out/(name+'-'+digest+'.bin')).write_bytes(data)
