import { EDGES } from '../certified/game.ts';
import { portableSha256 } from './portableLaw.ts';
import { portableTollPin as pin } from './generated/portableTollPin.ts';
import { portablePins, portablePin, type PortablePin } from './portablePins.ts';
import { srSurface,yellowSurface } from './portableSurfaces.ts';

export type PortableBounds={upper:number;lower:number}|{nowUpper:number;waitLower:number};
export type PortableQuery=(sid:number,stock:readonly number[],k:number,n:number,check:()=>void,lowerOnly?:boolean)=>PortableBounds|null;
export async function openPortableToll(response:Response|null,check:()=>void,asset:PortablePin=portablePins[0]):Promise<PortableQuery|null> {
  if(!response?.ok||!response.body)return null;
  const reader=response.body.getReader(),bytes=new Uint8Array(asset.bytes);let at=0;
  try{
    while(true){
      check();
      const part=await reader.read().catch(()=>null);if(!part)return null;if(part.done)break;
      if(part.value.length>bytes.length-at)return null;bytes.set(part.value,at);at+=part.value.length;
    }
  }finally{try{await reader.cancel();}catch{/* An interrupted optional read is not a proof. */}reader.releaseLock();}
  if(at!==bytes.length||await portableSha256(bytes)!==asset.sha256)return null;
  check();const view=new DataView(bytes.buffer);let pos=0;
  if(asset.sid===150)return srSurface(view);
  if(asset.sid===110)return yellowSurface(view);
  const int=()=>{const n=view.getInt32(pos,true);pos+=4;return n;};
  const val=(start:number,i:number)=>view.getFloat64(start+i*8,true);
  const [I,J,K]=pin.dimensions,[X,Y,Z]=pin.prefixDimensions,H=X*Y*Z,S=I*J*K;
  if(int()!==I||int()!==J||int()!==K)return null;
  for(const row of EDGES)for(const edge of row)for(const x of edge)if(int()!==x)return null;
  const days=pos;pos+=15*H*8;const states=int(),v=new Map<number,number>();
  if(states!==14)return null;
  for(let j=0;j<states;j++){const sid=int();if(v.has(sid)||sid<0||sid>600)return null;v.set(sid,pos);pos+=8*S;}
  const gates=pos;if(gates+13*S*8!==bytes.length||!v.has(0))return null;
  return (sid:number,stock:readonly number[],k:number,n:number,check:()=>void,lowerOnly=false)=>{
    if(portablePin(sid,stock)?.sid!==0||!Number.isInteger(k)||k<0||k>2||!Number.isSafeInteger(n)||n<1||n>stock[k]!/10)return null;
    const color=k as 0|1|2,base=(stock[0]!+I*(stock[1]!+J*stock[2]!))/10,stride=[1,I,I*J][k]!;
    let s=0,off=base,m=1;const leaves:{start:number;off:number;mass:number}[]=[];
    for(let j=0;j<n&&m&&s!==600;j++){
      const [p,g,normal]=EDGES[s]![color];off-=stride;
      if(p){const start=v.get(g);if(start===undefined)return null;leaves.push({start,off,mass:m*p/1000});}
      m*=1-p/1000;s=normal;
    }
    if(m){const start=v.get(s);if(start===undefined)return null;leaves.push({start,off,mass:m});}
    // Feasible fixed action, then D14 optimal continuation. Early success is still charged all 14 days.
    let lower=-14/400,upper=-14/400;
    for(let d=lowerOnly?14:1;d<=14;d++){
      const start=d===14?v.get(0)!:gates+(d-1)*S*8;let mass=0,redeem=0;
      for(let j=0;j<H;j++){
        if((j&255)===0)check();const w=val(days+d*H*8,j);if(!w)continue;
        const i=j%X+I*(Math.floor(j/X)%Y+J*Math.floor(j/(X*Y)));
        mass+=w;if(!lowerOnly)redeem+=w*val(start,base+i);
        if(d===14)for(const l of leaves)lower+=w*l.mass*val(l.start,l.off+i);
      }
      if(!(mass>.999&&mass<=1+1e-12))return null;
      upper+=Math.min(1,redeem+1-mass+pin.integralGuard)/(d===14?1:400);
    }
    check();return {upper:lowerOnly?1:upper+2*pin.integralGuard,lower:lower-pin.integralGuard};
  };
}
