'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  Activity, ArrowDown, ArrowRight, CalendarDays, CheckCircle2, CloudSun,
  Database, Droplets, FlaskConical, Gauge, Layers3, MapPin, ShieldAlert,
  Sparkles, Target, Waves,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Slider } from '@/components/ui/slider';
import { ImageryWorkspace } from './imagery-workspace';

type Strategy = '不补水' | '面积比例' | '初始缺水比例' | '七天指标优化';
type WindowKey = '2025-06-01' | '2025-06-08' | '2025-06-15' | '2025-06-22';
const strategies: Strategy[] = ['不补水', '面积比例', '初始缺水比例', '七天指标优化'];
const budgets = [0, 1000, 2000, 3000, 4000, 5000];
const lossMatrix: Record<WindowKey, number[][]> = {
  '2025-06-01': [[58.628,58.628,58.628,58.628],[58.628,52.116,50.979,49.509],[58.628,45.335,40.716,39.88],[58.628,38.231,30.06,30.06],[58.628,31.224,25.047,22.603],[58.628,24.624,25.047,17.733]],
  '2025-06-08': [[63.708,63.708,63.708,63.708],[63.708,57.283,56.969,55.513],[63.708,50.695,47.607,45.329],[63.708,43.469,36.514,36.396],[63.708,36.514,30.829,28.162],[63.708,29.489,30.829,22.421]],
  '2025-06-15': [[35.792,35.792,35.792,35.792],[35.792,29.969,26.417,25.334],[35.792,23.744,16.381,16.381],[35.792,17.907,9.344,9.344],[35.792,13.355,6.355,4.755],[35.792,9.552,6.355,3.148]],
  '2025-06-22': [[47.037,47.037,47.037,47.037],[47.037,39.421,36.441,35.402],[47.037,32.429,24.806,24.345],[47.037,26.272,13.839,13.814],[47.037,20.542,9.106,6.973],[47.037,14.811,9.106,4.561]],
};
const windowLabels: Record<WindowKey, string> = {
  '2025-06-01': '6月1日—7日', '2025-06-08': '6月8日—14日',
  '2025-06-15': '6月15日—21日', '2025-06-22': '6月22日—28日',
};
const barColors = ['#a9b6b2', '#82a69b', '#d7a63f', '#0f766e'];
const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

declare global {
  interface Document {
    readonly modelContext?: {
      registerTool: (tool: {
        name: string;
        title?: string;
        description: string;
        inputSchema: object;
        annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
        execute: (input: unknown) => unknown;
      }, options?: { signal?: AbortSignal }) => void | Promise<void>;
    };
  }
}

export default function Home() {
  const [windowKey, setWindowKey] = useState<WindowKey>('2025-06-01');
  const [budgetIndex, setBudgetIndex] = useState(3);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy>('七天指标优化');
  const scores = lossMatrix[windowKey][budgetIndex];
  const noWater = scores[0];
  const best = Math.min(...scores);
  const reduction = ((noWater - best) / noWater) * 100;
  const selectedScore = scores[strategies.indexOf(selectedStrategy)];
  const maxScore = Math.max(...scores) * 1.08;
  const ranked = useMemo(() => strategies.map((name,index)=>({name,value:scores[index]})).sort((a,b)=>a.value-b.value), [scores]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const windowKeys = Object.keys(windowLabels) as WindowKey[];
    void Promise.resolve(context.registerTool({
      name: 'configure_water_scenario',
      title: '配置生态补水情景',
      description: '切换水脉智调页面的历史气象窗口和补水预算，并返回该情景下的最优模型策略。',
      inputSchema: {
        type: 'object',
        properties: {
          start_date: { type: 'string', enum: windowKeys },
          budget_m3: { type: 'integer', enum: budgets },
        },
        required: ['start_date', 'budget_m3'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const value = input as { start_date?: string; budget_m3?: number };
        if (!windowKeys.includes(value.start_date as WindowKey) || !budgets.includes(value.budget_m3 ?? -1)) {
          throw new Error('无效情景：请选择页面提供的日期窗口与预算档位。');
        }
        const nextWindow = value.start_date as WindowKey;
        const nextBudgetIndex = budgets.indexOf(value.budget_m3 as number);
        const nextScores = lossMatrix[nextWindow][nextBudgetIndex];
        const nextBest = Math.min(...nextScores);
        const bestStrategy = strategies[nextScores.indexOf(nextBest)];
        setWindowKey(nextWindow);
        setBudgetIndex(nextBudgetIndex);
        setSelectedStrategy(bestStrategy);
        return {
          window: windowLabels[nextWindow],
          budget_m3: value.budget_m3,
          best_strategy: bestStrategy,
          loss_index: nextBest,
        };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  return (
    <main className="min-h-screen bg-[#f2f0e8] text-[#17332f]">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0c312d]/95 text-white backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 lg:px-8">
          <button className="flex items-center gap-3" onClick={()=>scrollTo({top:0,behavior:'smooth'})} aria-label="返回顶部">
            <span className="grid size-9 place-items-center rounded-md bg-[#d5a43b] text-[#102d29]"><Waves className="size-5"/></span>
            <span className="text-left"><span className="block text-base font-semibold tracking-[.12em]">水脉智调</span><span className="block text-[10px] tracking-[.18em] text-[#b9d2cb]">WETLAND WATER LAB</span></span>
          </button>
          <nav className="hidden items-center gap-7 text-sm text-[#d9e8e4] md:flex" aria-label="主导航">
            <button onClick={()=>jumpTo('decision')}>情景推演</button><button onClick={()=>jumpTo('region')}>候选区域</button><button onClick={()=>jumpTo('imagery')}>遥感分析</button><button onClick={()=>jumpTo('method')}>技术路径</button><button onClick={()=>jumpTo('roadmap')}>72小时落地</button>
          </nav>
          <Badge className="border border-[#d5a43b]/50 bg-[#d5a43b]/15 text-[#f3d58f]">赛道 8.2</Badge>
        </div>
      </header>

      <section id="decision" className="relative overflow-hidden bg-[#0c312d] pb-10 pt-10 text-white lg:pb-14 lg:pt-14">
        <div className="absolute inset-0 opacity-[.08] [background-image:linear-gradient(#d6eee8_1px,transparent_1px),linear-gradient(90deg,#d6eee8_1px,transparent_1px)] [background-size:42px_42px]"/>
        <div className="relative mx-auto max-w-7xl px-5 lg:px-8">
          <div className="mb-8 grid gap-7 lg:grid-cols-[1.2fr_.8fr] lg:items-end">
            <div><div className="mb-4 flex items-center gap-2 text-xs tracking-wide text-[#b9d2cb]"><span className="h-px w-9 bg-[#d5a43b]"/>黄河郑州段 · 湿地气候韧性研究原型</div>
              <h1 className="max-w-4xl text-4xl font-semibold leading-[1.12] tracking-tight sm:text-5xl lg:text-6xl">让有限的生态水，<br/><span className="text-[#e0b957]">优先流向更缺水的地方。</span></h1>
            </div>
            <div className="border-l border-white/20 pl-5 text-sm leading-7 text-[#c6d9d4]">连接公开历史气象、GEE遥感与离散动态规划，用可解释的多情景比较，为湿地补水次序提供研究型依据。<div className="mt-3 flex items-center gap-2 text-xs text-[#f0cf83]"><ShieldAlert className="size-4"/>当前为模型内演示，不替代现场调度决策</div></div>
          </div>

          <div className="grid overflow-hidden rounded-xl border border-white/15 bg-[#123d38] shadow-2xl shadow-black/20 lg:grid-cols-[320px_1fr]">
            <aside className="border-b border-white/10 bg-[#0f3732] p-6 lg:border-b-0 lg:border-r">
              <div className="mb-6 flex items-center justify-between"><span className="text-sm font-semibold">情景控制台</span><Activity className="size-4 text-[#d5a43b]"/></div>
              <label className="mb-2 block text-xs text-[#a9c5be]" htmlFor="window">历史气象窗口</label>
              <NativeSelect className="mb-7 w-full text-[#17332f]" id="window" value={windowKey} onChange={e=>setWindowKey(e.target.value as WindowKey)}>
                {(Object.keys(windowLabels) as WindowKey[]).map(key=><NativeSelectOption key={key} value={key}>{windowLabels[key]}</NativeSelectOption>)}
              </NativeSelect>
              <div className="mb-3 flex items-end justify-between"><label className="text-xs text-[#a9c5be]" htmlFor="budget">一次性补水预算</label><strong className="font-mono text-2xl">{budgets[budgetIndex].toLocaleString()}<small className="ml-1 text-xs font-normal text-[#a9c5be]">m³</small></strong></div>
              <Slider id="budget" aria-label="补水预算" min={0} max={5} step={1} value={[budgetIndex]} onValueChange={v=>setBudgetIndex(Array.isArray(v) ? v[0] : v)} className="[&_[data-slot=slider-range]]:bg-[#d5a43b] [&_[data-slot=slider-thumb]]:border-[#d5a43b]"/>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-[#86a9a0]"><span>0</span><span>5,000 m³</span></div>
              <div className="mt-8 border-t border-white/10 pt-5"><div className="mb-3 text-xs text-[#a9c5be]">选中策略</div><div className="space-y-2">
                {strategies.map(strategy=><Button key={strategy} variant="ghost" onClick={()=>setSelectedStrategy(strategy)} className={`w-full justify-between px-3 ${selectedStrategy===strategy?'bg-white/10 text-white':'text-[#b9d2cb] hover:bg-white/5 hover:text-white'}`}><span>{strategy}</span><span className="font-mono text-xs">{scores[strategies.indexOf(strategy)].toFixed(2)}</span></Button>)}
              </div></div>
            </aside>
            <div className="p-6 lg:p-8">
              <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
                <div><div className="text-xs text-[#9ebbb4]">模型输出 · 累计缺水损失（越低越好）</div><div className="mt-1 flex items-baseline gap-2"><strong className="font-mono text-4xl">{selectedScore.toFixed(2)}</strong><span className="text-xs text-[#9ebbb4]">index</span></div></div>
                <div className="rounded-lg border border-[#d5a43b]/30 bg-[#d5a43b]/10 px-4 py-3 text-right"><div className="text-[11px] text-[#e6cb91]">最优方案较不补水</div><strong className="font-mono text-2xl text-[#f1ce7f]">−{reduction.toFixed(1)}%</strong></div>
              </div>
              <div className="space-y-5" aria-label="策略损失比较图">
                {strategies.map((strategy,index)=>{const isBest=scores[index]===best; return <button key={strategy} className="group grid w-full grid-cols-[100px_1fr_58px] items-center gap-3 text-left sm:grid-cols-[128px_1fr_68px]" onClick={()=>setSelectedStrategy(strategy)} aria-label={`选择${strategy}`}><span className={`text-xs ${selectedStrategy===strategy?'text-white':'text-[#aec8c1]'}`}>{strategy}</span><span className="h-8 overflow-hidden rounded-sm bg-black/15"><span className="flex h-full min-w-[4px] items-center justify-end transition-all duration-500" style={{width:`${scores[index]/maxScore*100}%`,backgroundColor:barColors[index]}}>{isBest&&<Sparkles className="mr-2 size-3 text-white"/>}</span></span><span className={`font-mono text-sm ${isBest?'text-[#f1ce7f]':'text-white'}`}>{scores[index].toFixed(2)}</span></button>})}
              </div>
              <div className="mt-8 grid gap-px overflow-hidden rounded-lg bg-white/10 sm:grid-cols-3">
                <InfoCell label="当前最优" value={ranked[0].name} accent/><InfoCell label="参考分配（3,000m³基准）" value="A 1,700 · B 0 · C 1,300"/><InfoCell label="计算方法" value="100m³步长离散动态规划"/>
              </div>
            </div>
          </div>
          <button onClick={()=>jumpTo('region')} className="mx-auto mt-7 flex items-center gap-2 text-xs text-[#9ebbb4]">继续查看候选区域 <ArrowDown className="size-3"/></button>
        </div>
      </section>

      <section id="region" className="mx-auto max-w-7xl px-5 py-16 lg:px-8 lg:py-24">
        <SectionHeading eyebrow="01 / 空间入口" title="从大范围筛选，到可验证的试验单元" text="边界仅用于空间筛选；下一步需用GEE遥感时序与管理部门资料确认真实湿地、水源连通性及土地权属。"/>
        <div className="mt-10 grid gap-8 lg:grid-cols-[1.25fr_.75fr]">
          <figure className="overflow-hidden rounded-xl border border-[#c9c4b6] bg-white shadow-sm"><Image src="/boundary-screening.png" width={1400} height={875} alt="郑州滩区、惠济候选区与H1、H2候选窗口的边界筛选图" className="aspect-[16/10] w-full bg-[#e8e7df] object-contain"/><figcaption className="flex flex-wrap justify-between gap-2 border-t px-5 py-4 text-xs text-[#65736f]"><span>边界筛选图 · 项目现有成果</span><span>空间候选 ≠ 已核实湿地</span></figcaption></figure>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1"><MetricCard icon={<Layers3/>} label="郑州滩区边界" value="140.01 km²" note="作为区域背景与遥感检索范围"/><MetricCard icon={<MapPin/>} label="惠济候选范围" value="31.03 km²" note="优先开展数据可得性核查"/>
            <div className="rounded-xl bg-[#d9aa45] p-6"><div className="mb-5 flex items-center justify-between"><strong>两个1 km²验证窗口</strong><Target className="size-5"/></div><div className="space-y-4 font-mono text-sm"><div><span className="mr-3 inline-grid size-7 place-items-center rounded bg-[#17332f] text-white">H1</span>113.54467°E / 34.92490°N</div><div><span className="mr-3 inline-grid size-7 place-items-center rounded bg-[#17332f] text-white">H2</span>113.72818°E / 34.89379°N</div></div></div>
          </div>
        </div>
      </section>

      <ImageryWorkspace />

      <section id="method" className="border-y bg-[#e9e5da] py-16 lg:py-24"><div className="mx-auto max-w-7xl px-5 lg:px-8">
        <SectionHeading eyebrow="02 / 技术路径" title="公开数据可启动，三天内可讲清闭环" text="以GEE完成地表状态识别，以ERA5描述区域气象驱动，再将湿地单元状态输入可解释的水量平衡与优化模型。"/>
        <div className="mt-12 grid gap-3 md:grid-cols-4"><FlowCard number="01" icon={<Database/>} title="公开数据接入" text="Sentinel-2、Landsat、ERA5与行政/河道公开边界"/><FlowCard number="02" icon={<CloudSun/>} title="GEE状态识别" text="提取NDWI、NDVI、湿润度与水体频率时序"/><FlowCard number="03" icon={<Gauge/>} title="模型内推演" text="水量平衡、阈值缺水指标与四类策略对照"/><FlowCard number="04" icon={<Droplets/>} title="补水优先序" text="输出地块、时段、水量及风险提示清单"/></div>
        <div className="mt-10 grid gap-6 lg:grid-cols-2"><EvidenceBox title="已完成的模型证据" icon={<FlaskConical/>} items={['4个不重叠历史窗口 × 6档预算 × 3档作物系数，共72个情景','四类策略同一模型、同一气象、同一预算条件下可复现比较','默认窗口3,000m³时，累计缺水损失由58.63降至30.06']}/><EvidenceBox warning title="必须保留的证据边界" icon={<ShieldAlert/>} items={['ERA5约25km网格，只能表示区域气象，不能代替地块土壤湿度','A/B/C地块参数为情景假设，尚未用实测或文献完成约束','候选窗口尚未核实为可实施试验区，不能直接形成工程指令']}/></div>
      </div></section>

      <section className="mx-auto max-w-7xl px-5 py-16 lg:px-8 lg:py-24">
        <SectionHeading eyebrow="03 / 稳健性检查" title="四个窗口，同一预算下的策略表现" text="下表固定预算3,000m³、Kc=1.0。数值为模型累计缺水损失指标，越低越好。"/>
        <div className="mt-10 overflow-x-auto rounded-xl border bg-white"><table className="w-full min-w-[720px] border-collapse text-left text-sm"><thead className="bg-[#173d38] text-white"><tr>{['历史窗口','不补水','面积比例','初始缺水比例','七天指标优化','最优降幅'].map(x=><th key={x} className="px-5 py-4 font-medium">{x}</th>)}</tr></thead><tbody>{(Object.keys(windowLabels) as WindowKey[]).map(key=>{const row=lossMatrix[key][3], rowBest=Math.min(...row); return <tr key={key} className="border-t even:bg-[#f6f4ee]"><td className="px-5 py-4 font-medium">{windowLabels[key]}</td>{row.map((v,i)=><td key={i} className={`px-5 py-4 font-mono ${v===rowBest?'font-bold text-[#0f766e]':'text-[#53635f]'}`}>{v.toFixed(2)}</td>)}<td className="px-5 py-4 font-mono font-bold text-[#a46d0a]">−{((row[0]-rowBest)/row[0]*100).toFixed(1)}%</td></tr>})}</tbody></table></div>
      </section>

      <section id="roadmap" className="bg-[#153f39] py-16 text-white lg:py-24"><div className="mx-auto max-w-7xl px-5 lg:px-8">
        <SectionHeading light eyebrow="04 / 参赛落地" title="三个人，72小时，把原型变成可答辩成果" text="目标不是三天内做完科研，而是交付一条可运行、可复现、可信度边界清楚的最小闭环。"/>
        <div className="mt-12 grid gap-4 lg:grid-cols-3"><DayCard day="DAY 1" title="数据与区域闭环" owner="成员 A · 遥感/GEE" tasks={['上传并核验边界','生成NDWI/NDVI与水体频率图','确定H1/H2优先验证窗口']}/><DayCard day="DAY 2" title="模型与结果闭环" owner="成员 B · Python/建模" tasks={['替换候选窗口参数','跑完核心情景与敏感性分析','导出关键表格和可复现日志']}/><DayCard day="DAY 3" title="叙事与答辩闭环" owner="成员 C · 产品/表达" tasks={['录制2分钟原型演示','统一申报书、网站与PPT口径','准备局限性和现场验证问答']}/></div>
        <div className="mt-8 flex flex-col items-start justify-between gap-5 border-t border-white/15 pt-7 sm:flex-row sm:items-center"><div><div className="text-sm font-semibold text-[#efd08a]">最终交付包</div><p className="mt-1 text-sm text-[#b9d2cb]">GEE结果图 + Python模型 + 情景矩阵 + 项目网站 + 申报书/PPT + 演示视频</p></div><Button className="bg-[#d9aa45] px-5 text-[#17332f] hover:bg-[#e5ba5c]" onClick={()=>jumpTo('decision')}>回到情景推演 <ArrowRight/></Button></div>
      </div></section>
      <footer className="bg-[#0b2c28] px-5 py-8 text-xs text-[#88aaa2]"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-3 sm:flex-row"><span>水脉智调 · 湿地生态补水决策研究原型</span><span>公开历史数据 + 假设参数｜仅用于研究与参赛展示</span></div></footer>
    </main>
  );
}

function SectionHeading({eyebrow,title,text,light=false}:{eyebrow:string;title:string;text:string;light?:boolean}){return <div className="grid gap-5 lg:grid-cols-[1fr_.75fr] lg:items-end"><div><div className={`mb-3 flex items-center gap-2 text-xs font-medium tracking-[.16em] ${light?'text-[#e0b957]':'text-[#9b6a12]'}`}><span className="h-px w-8 bg-current"/>{eyebrow}</div><h2 className={`max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl ${light?'text-white':'text-[#17332f]'}`}>{title}</h2></div><p className={`max-w-xl text-sm leading-7 ${light?'text-[#b9d2cb]':'text-[#5c6b67]'}`}>{text}</p></div>}
function InfoCell({label,value,accent=false}:{label:string;value:string;accent?:boolean}){return <div className="bg-[#17453f] p-4"><div className="text-[11px] text-[#9ebbb4]">{label}</div><strong className={`mt-1 block text-sm ${accent?'text-[#f1ce7f]':''}`}>{value}</strong></div>}
function MetricCard({icon,label,value,note}:{icon:React.ReactNode;label:string;value:string;note:string}){return <div className="rounded-xl border bg-[#f9f8f3] p-6"><div className="mb-7 flex items-center justify-between text-[#0f766e]"><span className="[&>svg]:size-5">{icon}</span><span className="text-[11px] tracking-wider text-[#7c8985]">SPATIAL UNIT</span></div><div className="text-xs text-[#697773]">{label}</div><strong className="mt-1 block font-mono text-2xl">{value}</strong><p className="mt-3 text-xs leading-5 text-[#697773]">{note}</p></div>}
function FlowCard({number,icon,title,text}:{number:string;icon:React.ReactNode;title:string;text:string}){return <div className="group min-h-56 border bg-[#f7f5ef] p-6 transition-transform hover:-translate-y-1"><div className="flex items-center justify-between"><span className="font-mono text-xs text-[#8b7b59]">{number}</span><span className="text-[#0f766e] [&>svg]:size-5">{icon}</span></div><h3 className="mt-16 text-lg font-semibold">{title}</h3><p className="mt-3 text-sm leading-6 text-[#63716d]">{text}</p></div>}
function EvidenceBox({title,icon,items,warning=false}:{title:string;icon:React.ReactNode;items:string[];warning?:boolean}){return <div className={`rounded-xl border p-6 lg:p-8 ${warning?'border-[#c99b3c]/50 bg-[#fff7df]':'bg-[#f7f5ef]'}`}><div className="mb-5 flex items-center gap-3"><span className={`[&>svg]:size-5 ${warning?'text-[#9a6507]':'text-[#0f766e]'}`}>{icon}</span><h3 className="font-semibold">{title}</h3></div><ul className={`space-y-4 text-sm leading-6 ${warning?'text-[#6e5a31]':'text-[#50625e]'}`}>{items.map(x=><li key={x} className="flex gap-3"><CheckCircle2 className="mt-1 size-4 shrink-0 text-[#0f766e]"/><span>{x}</span></li>)}</ul></div>}
function DayCard({day,title,owner,tasks}:{day:string;title:string;owner:string;tasks:string[]}){return <div className="border border-white/15 bg-white/[.04] p-6"><div className="mb-8 flex items-center justify-between"><span className="font-mono text-xs text-[#e0b957]">{day}</span><CalendarDays className="size-4 text-[#8fb2aa]"/></div><h3 className="text-xl font-semibold">{title}</h3><p className="mt-2 text-xs text-[#e2c57f]">{owner}</p><ol className="mt-7 space-y-3 text-sm text-[#c5d8d3]">{tasks.map((task,i)=><li key={task} className="flex gap-3"><span className="font-mono text-[#739990]">0{i+1}</span>{task}</li>)}</ol></div>}
