import assert from 'node:assert/strict';
import { hash } from 'node:crypto';

import {rootGet} from './root-promotion-get.mjs';

const account='15be33fd20ea78eb3d60b719be831148', zone='2ed78e90cd4834066e079282aea4acb2', host='nikkecollection.com';
const uuid=/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
function rules(v) {
  const known=(obj,fields)=>assert(Object.keys(obj).every(k=>fields.includes(k)),'unreviewed RUM constraint');
  known(v.ruleset,['id','enabled','zone_name','zone_tag','lite']);
  const r=v.ruleset; assert.match(r.id,uuid); assert.equal(r.zone_name,host); assert.equal(r.zone_tag,zone); assert.equal(r.enabled,true);
  assert.equal(v.rules.length,1,'unknown or overlapping RUM rules'); const [rule]=v.rules;
  known(rule,['id','created','host','paths','priority','inclusive','is_paused']);
  assert.match(rule.id,uuid); assert.equal(rule.host,'*'); assert.deepEqual(rule.paths,['*']); assert.equal(rule.priority,1000);
  assert.equal(rule.inclusive,true); assert.equal(rule.is_paused,false);
  return {ruleset:r.id,rule:rule.id};
}
export async function observeRum(token, expectedDigest, send=fetch) {
  assert(token); assert.match(expectedDigest,/^[a-f0-9]{64}$/);
  const get=async path=>{
    const start=Date.now();
    const r=await rootGet('https://api.cloudflare.com/client/v4'+path,{headers:{authorization:'Bearer '+token,'cache-control':'no-cache'},cache:'no-store'},send);
    const at=Date.parse(r.headers.get('date'));assert(at>=start-30000 && at<=Date.now()+30000 && [null,'0'].includes(r.headers.get('age')),'stale authenticated RUM response');
    assert.equal(r.status,200,'RUM inventory denied'); const v=await r.json(); assert.equal(v.success,true); assert.deepEqual(v.errors,[]); return v;
  };
  const base='/accounts/'+account+'/rum', [z,inventory]=await Promise.all([get('/zones/'+zone),get(base+'/site_info/list?page=1&per_page=50')]);
  assert.equal(z.result.id,zone); assert.equal(z.result.account.id,account); assert.equal(z.result.name,host); assert.equal(z.result.status,'active');
  const page=inventory.result_info; assert(page.page===1 && page.total_pages===1 && page.count===1 && page.total_count===1 && inventory.result.length===1,'incomplete or ambiguous site inventory');
  const [site]=inventory.result; assert.match(site.site_tag,/^[a-f0-9]{32}$/); assert.equal(site.site_token,'af412f42bf1145eea47507d378249625'); assert.equal(site.auto_install,true);
  const ids=rules(site); const [detail,list]=await Promise.all([get(base+'/site_info/'+site.site_tag),get(base+'/v2/'+ids.ruleset+'/rules')]);
  assert.equal(detail.result.site_tag,site.site_tag); assert.equal(detail.result.site_token,site.site_token); assert.equal(detail.result.auto_install,true);
  for(const entry of [site,detail.result,list.result]) {
    assert.deepEqual(rules(entry),ids);
    for(const [field,expected] of [['zone_tag',zone],['zone_name',host],['auto_install',true],['site_token',site.site_token]]) {
      if(Object.hasOwn(entry,field))assert.equal(entry[field],expected);
    }
    // The effective lite bit must be returned, never inferred from the defaults or absence of EU traffic.
    const bits=[entry.lite,entry.ruleset.lite].filter(x=>x!==undefined);
    assert(bits.every(x=>x===true) && (entry===list.result || bits.length>0),'effective EU exclusion missing or contradictory');
  }
  const config={account,zone,host,site:site.site_tag,token:site.site_token,...ids,enabled:true,auto_install:true,lite:true,hostPattern:'*',paths:['*'],priority:1000,inclusive:true,is_paused:false};
  const configSha256=hash('sha256',JSON.stringify(config)); assert.equal(configSha256,expectedDigest,'RUM control changed since owner review');
  return {config,configSha256,observedAt:Date.now()};
}
