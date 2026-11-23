import { portableTollPin } from './generated/portableTollPin.ts';
// Immutable code-identity inputs; paths are content addressed. Each decoder owns its exact shape.
export const portablePins=[
  {name:'r0-toll',sid:0,bytes:portableTollPin.byteLength,sha256:portableTollPin.sha256},
  {name:'sr0-toll',sid:150,bytes:713685,sha256:'4392c1e92f2946bdb6bbd85520a5d46abd5a086b725041c94a0b5e11aeaa5413'},
  {name:'r11-yellow',sid:110,bytes:264960,sha256:'88a8b1124318e325cfc3457cddc1bc26e3ce623b84a0516878d1db2202143015'},
] as const;
export type PortablePin=typeof portablePins[number];
export function portablePath(pin:PortablePin){return `proofs/${pin.name}-${pin.sha256}.bin`;}
export function portablePin(sid:number,stock:readonly number[]){
  if(stock.length!==3||!stock.every(x=>Number.isSafeInteger(x)&&x>=0))return null;
  if(sid===110)return stock[0]===0&&stock[1]===0&&stock[2]!>=10&&stock[2]!<=80?portablePins[2]:null;
  if((sid!==0&&sid!==150)||!portableTollPin.maxUnits.every((max,k)=>stock[k]!%10===0&&stock[k]!<=10*max))return null;
  return sid===0?portablePins[0]:portablePins[1];
}
