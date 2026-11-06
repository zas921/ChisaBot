import { expect, test } from "bun:test";
import { createUsagePanelRefresh, formatTokens, tokenScale, USAGE_PANEL_SOURCE, usagePanelConfig, usagePanelSpec } from "../src/model-usage/panel";
import { createLivePanelService } from "../src/live-panels/service";
import type { LivePanelRow, LivePanelStore } from "../src/live-panels/store";

const spec = () => JSON.stringify({ root: "main", elements: {
  main: {type:"Stack",props:{direction:"vertical",gap:"md"},children:["metric","chart"]},
  metric: {type:"Metric",props:{label:"今天用量",value:{$state:"/today"},caption:"11/04"},children:[]},
  chart: {type:"Chart",props:{kind:"bar",labels:{$state:"/labels"},data:{$state:"/series"},unit:"万"},children:[]},
}, state: {usageSource:{type:USAGE_PANEL_SOURCE,days:7,timeZone:"Asia/Shanghai"}} });
const day = (date: string, totalTokens: number, calls=1) => ({date,totalTokens,calls,inputTokens:totalTokens,outputTokens:0,cachedInputTokens:0,models:[]});
const summary = { today:"2026-11-05",days:[day("2026-11-05",12030325,179),day("2026-11-04",38477202)] };
const row = () => ({id:"panel",ownerUserId:"owner-a",botId:"bot",spec:spec(),removed:false,failures:5,updatedAt:new Date(),refreshedAt:null,error:"old failure"}) as LivePanelRow;

test("refresh converts raw tokens once, keeps layout, and rolls the date caption forward", () => {
  const result=JSON.parse(usagePanelSpec(spec(),summary));
  expect(result.state.today).toBe("12.03M");
  expect(result.state.calls).toBe(179);
  expect(result.state.labels).toEqual(["11/04","11/05"]);
  expect(result.state.series).toEqual([38.48,12.03]);
  expect(result.elements.chart.props.unit).toBe("M");
  expect(result.elements.metric.props.caption).toBe("11/05");
  expect(result.elements.main).toEqual(JSON.parse(spec()).elements.main);
  expect(JSON.parse(usagePanelSpec(JSON.stringify(result),summary)).state).toEqual(result.state);
});
test("a new day without usage displays zero rather than yesterday's value", () => {
  const result=JSON.parse(usagePanelSpec(spec(),{today:"2026-11-06",days:[day("2026-11-05",100)]}));
  expect(result.state.today).toBe("0");expect(result.state.calls).toBe(0);
  expect(result.elements.metric.props.caption).toBe("11/06");
});
test("only explicitly bound panels use this data source", () => {
  expect(usagePanelConfig(null)).toBeNull(); expect(usagePanelConfig('{"state":{}}')).toBeNull();
  const invalid=JSON.parse(spec());invalid.state.usageSource.days=999;
  expect(()=>usagePanelConfig(JSON.stringify(invalid))).toThrow();
});
test("reads only the owner's ledger and respects cancellation before writing", async () => {
  let updates=0;
  const controller=new AbortController();
  const refresh=createUsagePanelRefresh({summary:async(owner,config)=>{
    expect(owner).toBe("owner-a");expect(config).toEqual({days:7,timeZone:"Asia/Shanghai"});
    controller.abort();return summary;
  },update:async()=>{updates++;}});
  await expect(refresh(row(),controller.signal)).rejects.toThrow();expect(updates).toBe(0);
});
test("manual and scheduled refresh flow succeeds without invoking a model and clears the stale error", async () => {
  const panel=row(); let modelCalls=0;
  const store={get:async()=>panel,claim:async()=>true,release:async()=>{},
    update:async(_owner:string,_id:string,input:{spec:string})=>{
      Object.assign(panel,{spec:input.spec,refreshedAt:new Date(),error:null,failures:0});return panel;
    },fail:async()=>{throw new Error("unexpected failure")},
  } as unknown as LivePanelStore;
  const service=createLivePanelService({store,refreshData:createUsagePanelRefresh({summary:async()=>summary,update:store.update}),runHeadless:async()=>{modelCalls++;throw new Error("model offline")},log:()=>{}});
  expect((await service.refreshAndWait("owner-a","panel")).ok).toBe(true);
  expect((await service.refreshAndWait("owner-a","panel")).ok).toBe(true);
  expect(modelCalls).toBe(0);expect(panel.error).toBeNull();expect(panel.failures).toBe(0);
});
test("ledger failures surface as failed refreshes without switching to a model", async()=>{
  const panel=row();let calls=0;
  const store={get:async()=>panel,claim:async()=>true,release:async()=>{},fail:async(_o:string,_id:string,error:string)=>{panel.error=error;return panel;}} as unknown as LivePanelStore;
  const service=createLivePanelService({store,refreshData:createUsagePanelRefresh({summary:async()=>{throw new Error("ledger unavailable")},update:store.update}),runHeadless:async()=>{calls++},log:()=>{}});
  expect((await service.refreshAndWait("owner-a","panel")).ok).toBe(false);
  expect(panel.error).toContain("ledger unavailable");expect(calls).toBe(0);
});

test('K/M/B thresholds use decimal token units and select B before M', () => {
  for (const [value,unit] of [[0,''],[999,''],[1000,'K'],[999999,'K'],[1000000,'M'],[999999999,'M'],[1000000000,'B'],[2500000000,'B']] as const)
    expect(tokenScale(value).unit).toBe(unit);
  expect(formatTokens(1000)).toBe('1K');
  expect(formatTokens(1000000)).toBe('1M');
  expect(formatTokens(1250000000)).toBe('1.25B');
  const result=JSON.parse(usagePanelSpec(spec(),{today:'2026-11-05',days:[day('2026-11-05',12000000),day('2026-11-04',1500000000)]}));
  expect(result.state.today).toBe('12M');
  expect(result.elements.chart.props.unit).toBe('B');
  expect(result.state.series).toEqual([1.5,0.01]);
});
