import {chromium} from "@playwright/test";
import {preview} from "vite";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {registerHooks} from "node:module";
registerHooks({resolve(s,c,n){return n(s.startsWith(".")&&!/\.[a-z]+$/i.test(s)?s+".ts":s,c);}});
const {enMessages:en}=await import("../../src/i18n/messages.en.ts");
const {certifiedMessages}=await import("../../src/certifiedUi/messages.ts");
const dir=".tmp/hp1-1bb0518d7cb045b6bdc81ee8f867cc19";
const adbPath="C:/Users/PC/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const adb=(...args)=>execFileSync(adbPath,["-s","R3CN90M590A",...args],{encoding:"utf8",timeout:10000});
let server,browser,page;
let sampling=false,sampler=null;
const rows=[],metadata={};
try{
 metadata.model=adb("shell","getprop","ro.product.model");
 metadata.android=adb("shell","getprop","ro.build.version.release");
 metadata.chrome=adb("shell","dumpsys","package","com.android.chrome").match(/versionName=.*$/m)?.[0];
 metadata.battery=adb("shell","dumpsys","battery");
 metadata.thermal=adb("shell","dumpsys","thermalservice");
 server=await preview({configFile:false,build:{outDir:dir+"/dist"},preview:{host:"127.0.0.1",port:4273,strictPort:true}});
 adb("shell","input","keyevent","KEYCODE_WAKEUP");
 adb("reverse","tcp:4273","tcp:4273");adb("forward","tcp:9333","localabstract:chrome_devtools_remote");
 adb("shell","am","start","-n","com.android.chrome/com.google.android.apps.chrome.Main");
 browser=await chromium.connectOverCDP("http://127.0.0.1:9333");
 const context=browser.contexts()[0];
 for(const [id,grade,stock] of [["today-r200","R",[200,100,50]],["today-sr200","SR",[200,100,50]],["today-r150","R",[150,80,40]]]){
 for(let repeat=0;repeat<3;repeat++){
 adb("shell","input","keyevent","KEYCODE_WAKEUP");
 page=await context.newPage();page.setDefaultTimeout(20000);
 const errors=[];let crashed=false;let navs=0;
 page.on("crash",()=>crashed=true);page.on("pageerror",e=>errors.push(e.message));
 page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
 page.on("framenavigated",f=>{if(f===page.mainFrame())navs++;});
 await page.route(url=>!["127.0.0.1","localhost","[::1]"].includes(url.hostname),r=>r.abort());
 await page.addInitScript(()=>{
 const events=[];window.hpEvents=events;const Native=window.Worker;
 window.Worker=class extends Native{constructor(...args){super(...args);events.push({type:"created",at:performance.now()});this.addEventListener("message",e=>events.push({type:e.data.type,at:performance.now(),message:e.data}));}terminate(){events.push({type:"terminated",at:performance.now()});return super.terminate();}};
 });
 const cdp=await context.newCDPSession(page);await cdp.send("Performance.enable");
 await page.goto("http://localhost:4273/?statsEnv=staging&engine=certified");
 await page.locator("#language-menu-trigger").click();await page.getByRole("menuitemradio",{name:"English",exact:true}).click();
 await page.getByRole("group",{name:en["state.gradeAria"]}).getByRole("button",{name:grade,exact:true}).click();
 await page.getByRole("button",{name:en["common.phase"].replace("{phase}","0"),exact:true}).click();
 await page.locator("#currentExp").fill("");await page.locator("#currentExp").blur();
 for(const [i,kit] of ["blue","purple","yellow"].entries())await page.locator("#"+kit+"Stock").fill(String(stock[i]));
 await page.locator("#yellowStock").blur();
 const already=page.getByRole("button",{name:certifiedMessages.en.already,exact:true});
 while(await already.count())await already.first().click();
 for(const mode of ["cold","warm"]){
 if(mode==="warm"){await page.getByRole("tab",{name:en["tab.input"],exact:true}).click();await page.locator("#blueStock").fill(String(stock[0]+1));await page.locator("#blueStock").fill(String(stock[0]));await page.locator("#blueStock").blur();}
 const samples=[];sampling=true;
 sampler=(async()=>{while(sampling){
 adb("shell","input","keyevent","KEYCODE_WAKEUP");
 const metrics=(await cdp.send("Performance.getMetrics")).metrics;
 const ps=adb("shell","ps","-A","-o","PID,NAME");
 const renderers=ps.split(/\r?\n/).filter(l=>/com\.android\.chrome:sandboxed_process/.test(l)).map(l=>l.trim().split(/\s+/)[0]);
 const pss=renderers.map(pid=>{const text=adb("shell","dumpsys","meminfo",pid);const m=text.match(/TOTAL PSS:\s*(\d+)/)||text.match(/^\s*TOTAL\s+(\d+)/m);return {pid,pssKiB:m?Number(m[1]):null};});
 samples.push({at:Date.now(),metrics:metrics.filter(m=>/JSHeap/.test(m.name)),pss});
 await new Promise(r=>setTimeout(r,500));
 }})();
 await page.evaluate(()=>{window.hpStart=null;window.hpEnd=null;window.hpCurrent=null;document.addEventListener("click",()=>{window.hpStart=performance.now();},{once:true,capture:true});window.hpObserver=new MutationObserver(()=>{if(window.hpStart===null)return;if(window.hpCurrent===null&&document.querySelector(".cert-probability"))window.hpCurrent=performance.now();const wait=document.querySelector('[data-testid="certified-waiting"]');if(!document.querySelector("#calculateButton")?.disabled&&(wait?.querySelector(".cert-wait-day")||wait?.querySelector('[data-waiting-status="unresolved"]')))window.hpEnd??=performance.now();});window.hpObserver.observe(document.body,{childList:true,subtree:true,attributes:true});});
 await page.locator(".mobile-action-bar").getByRole("button",{name:en["common.calculateLong"],exact:true}).click();
 await page.locator("#calculateButton").filter({hasText:en["common.calculate"]}).waitFor({state:"attached",timeout:30000});
 await page.waitForFunction(()=>!document.querySelector("#calculateButton")?.disabled,{timeout:30000});
 const result=await page.evaluate(()=>{window.hpObserver.disconnect();const wait=document.querySelector('[data-testid="certified-waiting"]');return {wallMs:window.hpEnd===null?null:window.hpEnd-window.hpStart,currentRenderMs:window.hpCurrent===null?null:window.hpCurrent-window.hpStart,status:wait?.querySelector(".cert-wait-day")?"certified":wait?.querySelector("[data-waiting-status]")?.getAttribute("data-waiting-status"),events:window.hpEvents,text:wait?.textContent};});
 sampling=false;await sampler;
 const pss=samples.flatMap(s=>s.pss.map(p=>p.pssKiB)).filter(p=>p!==null);
 const peakRendererPssKiB=pss.length?Math.max(...pss):null;
 rows.push({id,repeat,mode,...result,crashed,navs,errors,samples,peakRendererPssKiB,timePass:result.status==="certified"&&result.wallMs!==null&&result.wallMs<=15000,memoryPass:!crashed&&navs===1&&peakRendererPssKiB!==null&&peakRendererPssKiB<1048576,memoryScope:"all Chrome sandbox renderer processes; conservative per-process maximum, not tab-attributed"});
 writeFileSync(dir+"/device-awake2-results.json",JSON.stringify({metadata,rows},null,2));
 }
 await page.close();page=null;
 }
 }
}catch(e){metadata.failure=e.stack;process.exitCode=1;}
finally{
 sampling=false;if(sampler)await sampler;
 if(page)await page.close();
 if(browser)await browser.close();
 metadata.batteryEnd=adb("shell","dumpsys","battery");
 metadata.thermalEnd=adb("shell","dumpsys","thermalservice");
 metadata.cleanup={reverse:adb("reverse","--remove","tcp:4273"),forward:adb("forward","--remove","tcp:9333")};
 if(server)await new Promise((r,j)=>server.httpServer.close(e=>e?j(e):r()));
 writeFileSync(dir+"/device-awake2-results.json",JSON.stringify({metadata,rows},null,2));console.log(JSON.stringify({metadata,calculations:rows.length}));
}
