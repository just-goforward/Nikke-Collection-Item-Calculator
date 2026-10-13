import {test,expect} from "@playwright/test";
import {preview} from "vite";
import {writeFileSync} from "node:fs";
import {enMessages as en} from "../../src/i18n/messages.en.ts";
import {certifiedMessages} from "../../src/certifiedUi/messages.ts";
let server;
test.beforeAll(async()=>{server=await preview({configFile:false,build:{outDir:".tmp/hp1-1bb0518d7cb045b6bdc81ee8f867cc19/dist"},preview:{host:"127.0.0.1",port:4273,strictPort:true}});});
test.afterAll(async()=>{await new Promise<void>((r,j)=>server.httpServer.close(e=>e?j(e):r()));});
for(const [id,grade,stock] of [["today-r200","R",[200,100,50]],["today-sr200","SR",[200,100,50]],["today-r150","R",[150,80,40]]]){
test(id,async({page,context,browser},info)=>{
 page.setDefaultTimeout(15000);
 await context.route(url=>!["127.0.0.1","localhost","[::1]"].includes(url.hostname),route=>route.abort());
 const errors=[];page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});page.on("pageerror",e=>errors.push(e.message));
 await page.addInitScript(()=>{
 const events=[];Object.assign(window,{hpEvents:events});
 const Native=window.Worker;
 window.Worker=class extends Native{
 constructor(...args){super(...args);events.push({type:"created",at:performance.now()});this.addEventListener("message",e=>events.push({type:e.data.type,at:performance.now(),message:e.data}));}
 terminate(){events.push({type:"terminated",at:performance.now()});return super.terminate();}
 };
 });
 const cdp=await context.newCDPSession(page);
 await cdp.send("Emulation.setCPUThrottlingRate",{rate:info.project.name==="mobile4"?4:info.project.name==="mobile6"?6:1});
 await page.goto("/?statsEnv=staging&engine=certified");
 await page.locator("#language-menu-trigger").click();
 await page.getByRole("menuitemradio",{name:"English",exact:true}).click();
 await expect(page.locator("#calculateButton")).toBeEnabled();
 await page.getByRole("group",{name:en["state.gradeAria"]}).getByRole("button",{name:grade,exact:true}).click();
 await page.getByRole("button",{name:en["common.phase"].replace("{phase}","0"),exact:true}).click();
 await page.locator("#currentExp").fill("");await page.locator("#currentExp").blur();
 for(const [i,kit] of ["blue","purple","yellow"].entries())await page.locator("#"+kit+"Stock").fill(String(stock[i]));
 const already=page.getByRole("button",{name:certifiedMessages.en.already,exact:true});
 while(await already.count()){await already.first().click();console.log("acknowledged",id,info.project.name);}
 const rows=[];
 for(const mode of ["cold","warm"]){
 console.log("calculation",id,info.project.name,mode);
 if(mode==="warm"){if(info.project.name!=="desktop")await page.getByRole("tab",{name:en["tab.input"],exact:true}).click();await page.locator("#blueStock").fill(String(stock[0]+1));await page.locator("#blueStock").fill(String(stock[0]));await page.locator("#blueStock").blur();}
 await page.evaluate(()=>{window.hpStart=performance.now();window.hpCurrent=null;const observer=new MutationObserver(()=>{if(window.hpCurrent===null&&document.querySelector(".cert-probability"))window.hpCurrent=performance.now();});observer.observe(document.body,{childList:true,subtree:true});window.hpObserver=observer;});
 const calculate=page.getByRole("button",{name:info.project.name==="desktop"?en["common.calculate"]:en["common.calculateLong"],exact:true});
 await calculate.click();
 await expect(page.locator("#calculateButton")).toHaveText(en["common.calculate"],{timeout:30000});
 await expect(page.locator("#calculateButton")).toBeEnabled({timeout:30000});
 const metrics=await page.evaluate(()=>{window.hpObserver.disconnect();const wait=document.querySelector('[data-testid="certified-waiting"]');return {wallMs:performance.now()-window.hpStart,currentRenderMs:window.hpCurrent===null?null:window.hpCurrent-window.hpStart,status:wait?.querySelector(".cert-wait-day")?"certified":wait?.querySelector("[data-waiting-status]")?.getAttribute("data-waiting-status"),text:wait?.textContent,events:window.hpEvents};});
 const memory=await cdp.send("Runtime.getHeapUsage");
 rows.push({mode,...metrics,memory,errors});
 writeFileSync(info.outputPath("measurements.json"),JSON.stringify({id,profile:info.project.name,repeat:info.repeatEachIndex,rows},null,2));
 }
 await page.close();
 writeFileSync(info.outputPath("measurements.json"),JSON.stringify({id,profile:info.project.name,repeat:info.repeatEachIndex,rows},null,2));
 for(const row of rows){expect(["certified","unresolved"]).toContain(row.status);}
});
}
