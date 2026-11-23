import { EDGES } from '../certified/game.ts';
import { portablePin } from './portablePins.ts';
import type { PortableQuery } from './portableToll.ts';

/** Already length- and SHA-verified. All yellow first attempts from R11/0 are great. */
export function yellowSurface(view:DataView):PortableQuery|null {
  if(view.byteLength!==16*69*2*15*8||EDGES[110][2][0]!==1000||EDGES[110][2][1]!==300)return null;
  const get=(d:number,z:number,g:number,j:number)=>view.getFloat64(8*((d*69+z)*30+g*15+j),true);
  return (sid,stock,k,n,check)=>{
    if(portablePin(sid,stock)?.sid!==110||k!==2||n!==1)return null;
    let childFailure=0,waitSuccess=0,savings=0;
    for(let z=0;z<69;z++){
      check();const sum=stock[2]!-10+z,j=Math.floor(sum/10),g=Number(sum%10>=5);
      childFailure+=get(14,z,0,j);waitSuccess+=get(15,z,0,j+1);
      for(let d=1;d<14;d++)savings+=get(d,z,g,j);
    }
    return {nowUpper:1-childFailure-savings/400+1e-8,waitLower:waitSuccess-14/400-1e-8};
  };
}

/** SR0 residue/cohort gate panels, upwards byte quantization and downwards u16 terminal V. */
export function srSurface(view:DataView):PortableQuery|null {
  if(view.byteLength!==713685||view.getUint32(0)!==0x53524741||view.getUint32(4)!==0x54453031)return null;
  let pos=8;const int=()=>{const value=view.getUint32(pos,true);pos+=4;return value;};
  const I=int(),J=int(),K=int(),S=I*J*K,H=37*12*7;if(I!==45||J!==16||K!==10)return null;
  for(const row of EDGES)for(const e of row)for(const v of e)if(int()!==v)return null;
  const law=pos;pos+=H*8;const layers=new Map<number,number>();
  for(let n=int();n-->0;){const s=int();if(s>600||layers.has(s))return null;layers.set(s,pos);pos+=S*2;}
  type Panel={n:number;prefix:number;a:number;b:number;h:number;gate:number};const panels:Panel[][]=[];
  for(let d=1;d<14;d++){const entries:Panel[]=[];
    for(let c=0;c<12;c++){const n=int(),prefix=pos;if(!n)continue;pos+=10*n;const a=int(),b=int(),h=int(),gate=pos;pos+=a*b*h;entries.push({n,prefix,a,b,h,gate});}panels.push(entries);}
  if(pos!==view.byteLength)return null;
  return (sid,stock,k,n,check,lowerOnly=false)=>{
    if(portablePin(sid,stock)?.sid!==150||!Number.isInteger(k)||k<0||k>2||!Number.isInteger(n)||n<1||n>stock[k]!/10)return null;
    const x=stock[0]!/10,y=stock[1]!/10,z=stock[2]!/10,base=x+I*(y+J*z),stride=[1,I,I*J][k]!;
    const root=layers.get(150);if(root===undefined)return null;
    const leaves:{start:number;i:number;m:number}[]=[];let s=150,i=base,m=1;
    for(let j=0;j<n&&s!==600&&m;j++){
      const [p,g,normal]=EDGES[s]![k as 0|1|2];i-=stride;
      if(p){const start=layers.get(g);if(start===undefined)return null;leaves.push({start,i,m:m*p/1000});}s=normal;m*=(1000-p)/1000;
    }
    if(m){const start=layers.get(s);if(start===undefined)return null;leaves.push({start,i,m});}
    let mass=0,v=0,q=0,rebates=0;
    for(let t=0;t<H;t++){
      if(!(t&255))check();const w=view.getFloat64(law+8*t,true);if(!w)continue;
      const j=t%37+I*(Math.floor(t/37)%12+J*Math.floor(t/444));mass+=w;
      if(!lowerOnly)v+=w*(view.getUint16(root+2*(base+j),true)/65535);
      for(const l of leaves)q+=w*l.m*(view.getUint16(l.start+2*(l.i+j),true)/65535);
    }
    if(!lowerOnly)for(const entries of panels){let covered=0,ev=0;
      for(const {n,prefix,a,b,h,gate} of entries)for(let j=0;j<n;j++){
        if(!(j&255))check();const o=prefix+10*j,t=view.getUint16(o,true),w=view.getFloat64(o+2,true);
        const ix=x+t%37,iy=y+Math.floor(t/37)%12,iz=z+Math.floor(t/444);
        if(ix>=a||iy>=b||iz>=h)return null;covered+=w;ev+=w*view.getUint8(gate+ix+a*(iy+b*iz))/255;
      }rebates+=Math.min(1,ev+1-covered+1e-8)/400;
    }
    check();return {upper:lowerOnly?1:v+1/65535+1-mass+rebates-14/400+2e-8,lower:q-14/400-1e-8};
  };
}
