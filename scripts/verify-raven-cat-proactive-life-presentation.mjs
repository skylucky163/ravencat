/** 日期输入、夏令时边界及稳定的碎片身份是产品行为，不锁定组件源码。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';

const calendar = loadTypeScriptModule('src/features/companion/presentation/proactiveLifeCalendar.ts');
const vm = loadTypeScriptModule('src/features/companion/presentation/proactiveLifeViewModel.ts');
const day = calendar.calendarDay(new Date(2026,10,1));
assert.equal(calendar.calendarDayKey(day),'2026-11-01');
assert.equal(calendar.calendarDayKey(calendar.parseCalendarDay('2028-02-29')),'2028-02-29');
for(const invalid of ['2026-02-29','2026-02-30','2026-13-01','2026-00-01','2026-11-00','tomorrow','2026-1-1']) assert.equal(calendar.parseCalendarDay(invalid),null);
assert.equal(calendar.calendarDayKey(calendar.parseCalendarDay('2026-12-31')+1),'2027-01-01');
const window = calendar.calendarWindow(day);
assert.equal(window.length,9);
assert.equal(window[4].key,'2026-11-01');
assert.equal(new Date(window[4].from).getHours(),0);
assert.equal(new Date(window[4].until).getHours(),0);
for(let offset=-1000;offset<1000;offset++){
  const choices=Array.from({length:9},(_,i)=>calendar.fragmentMaterialIndex(day+offset+i,14));
  assert.equal(new Set(choices).size,9,'任意九个相邻日期不得重复素材');
  for(const index of choices)assert.ok(index>=0 && index<14);
}
assert.equal(calendar.fragmentMaterialIndex(day,14),calendar.fragmentMaterialIndex(calendar.parseCalendarDay('2026-11-01'),14));
assert.equal(vm.proactiveLifeCompletionDispositionLabel('completed'),'已执行');
assert.equal(vm.proactiveLifeCompletionDispositionLabel('unexecuted'),'未执行');
assert.equal(vm.proactiveLifeCompletionDispositionLabel('interrupted',true),'AI 已响应 · 执行因故障中断');
assert.equal(vm.proactiveLifeCompletionDispositionLabel('failed'),'执行失误');
const local=new Date(2026,10,1,8,5);
assert.equal(vm.formatProactiveLifeClock(local.toISOString()),'08:05');
assert.equal(vm.formatProactiveLifeFullDateTime(local.toISOString()),'2026年11月1日 08:05');
assert.equal(vm.canCancelAISchedule({status:'scheduled',remindAt:'2026-11-02T00:00:00Z'},new Date('2026-11-01T00:00:00Z')),true);
assert.equal(vm.canCancelAISchedule({status:'consumed',remindAt:'2026-11-02T00:00:00Z'},new Date('2026-11-01T00:00:00Z')),false);
assert.notEqual(vm.resolveAIScheduleCommandErrorMessage('already_past'),vm.resolveAIScheduleCommandErrorMessage('not_found'));

const originalTZ=process.env.TZ;
process.env.TZ='America/New_York';
const spring=calendar.calendarDayRange(calendar.calendarDay(new Date(2026,2,8)));
const autumn=calendar.calendarDayRange(calendar.calendarDay(new Date(2026,10,1)));
assert.equal(Date.parse(spring.until)-Date.parse(spring.from),23*3600000);
assert.equal(Date.parse(autumn.until)-Date.parse(autumn.from),25*3600000);
if(originalTZ===undefined)delete process.env.TZ;else process.env.TZ=originalTZ;
console.log('时间碎片展示验证通过：输入、跨年、闰日、夏令时与相邻日期素材去重。');

const require = createRequire(import.meta.url);
const React = require('react');
const {act,create} = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function loadUI(file,dependencies){
  const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',code)(name=>{
    if(name==='react' || name==='react/jsx-runtime')return require(name);
    assert.ok(Object.hasOwn(dependencies,name),`未提供测试依赖 ${name}`);
    const value=dependencies[name];return Object.hasOwn(value,'default')?{__esModule:true,...value}:value;
  },module,module.exports);
  return module.exports;
}

const gestures={};
const activeLoops=new Set();
const animations={
  default:{View:'AnimatedView'},
  cancelAnimation:value=>activeLoops.delete(value),
  runOnJS:fn=>fn,
  Easing:{linear:value=>value},
  useSharedValue:initial=>{
    const ref=React.useRef(null);
    if(ref.current===null){
      let current=initial;
      const cell={};
      Object.defineProperty(cell,'value',{get:()=>current,set:next=>{
        if(next && typeof next==='object' && Object.hasOwn(next,'loopTarget')){activeLoops.add(cell);current=next.loopTarget;}
        else{activeLoops.delete(cell);current=next;}
      }});
      ref.current=cell;
    }
    return ref.current;
  },
  useAnimatedStyle:fn=>fn(),
  withTiming:(value,options,done)=>{if(done)queueMicrotask(()=>done(true));return value;},
  withRepeat:value=>({loopTarget:value}),
  withSequence:(...values)=>values.at(-1),
};
const geometry=loadTypeScriptModule('src/features/companion/presentation/proactiveLifeArcGeometry.ts');
const {default:ArcLights}=loadUI('src/features/companion/presentation/ProactiveLifeArcLights.tsx',{
  'react-native':{View:'View'},'react-native-reanimated':animations,
  '@shared/theme':{useThemedStyles:()=>({})},
  './proactiveLifeArcGeometry':geometry,'./ProactiveLifeCalendarArc.styles':{},
});
let materialInstance=0;
function MaterialSurface({texture}){
  const instance=React.useRef(null);
  if(instance.current===null)instance.current=++materialInstance;
  return React.createElement('FragmentMaterial',{material:texture.id,instance:instance.current});
}
const {default:Arc}=loadUI('src/features/companion/presentation/ProactiveLifeCalendarArc.tsx',{
  'react-native':{Pressable:'Pressable',Text:'Text',View:'View'},
  'lucide-react-native':{ChevronLeft:'ChevronLeft',ChevronRight:'ChevronRight'},
  'react-native-gesture-handler':{
    GestureDetector:'GestureDetector',Gesture:{Pan:()=>{
      const gesture={};for(const name of ['enabled','activeOffsetX','failOffsetY','onStart','onUpdate','onEnd'])gesture[name]=value=>{gesture[name+'Value']=value;return gesture;};
      Object.assign(gestures,{current:gesture});return gesture;
    }},
  },
  'react-native-reanimated':animations,
  'react-native-svg':{default:'Svg',Defs:'Defs',LinearGradient:'LinearGradient',Path:'Path',Stop:'Stop'},
  '@shared/theme':{getThemeById:()=>({colors:{text:{primary:'#fff'}}}),useThemedStyles:()=>({})},
  './proactiveLifeCalendar':calendar,
  './proactiveLifeArcGeometry':geometry,'./ProactiveLifeArcLights':{default:ArcLights},
  './fragmentTextures':{FRAGMENT_TEXTURES:Array.from({length:14},(_,i)=>({id:String(i)}))},
  './FragmentMaterial':{default:MaterialSurface},'./ProactiveLifeCalendarArc.styles':{},
});
const selections=[];
let renderer;
await act(async()=>{renderer=create(React.createElement(Arc,{selectedDay:day,today:day,counts:[],onSelect:value=>selections.push(value),enabled:true,inViewport:true,reducedMotion:false}));});
await act(async()=>{renderer.root.findAllByType('View').find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:400}}});});
assert.ok(activeLoops.size>0 && activeLoops.size<=6,'只允许可见碎片与光点运行有界动画');
const decoration=renderer.root.findAllByType('View').find(node=>node.props.importantForAccessibility==='no-hide-descendants');
assert.equal(decoration.props.pointerEvents,'none','光点不遮挡日期手势');
assert.ok(decoration.findAllByType('AnimatedView').length<=20,'装饰图元保持固定预算');
function surfacesByDate(){
  return new Map(renderer.root.findAllByType('Pressable').flatMap(node=>{
    const surface=node.findAllByType('FragmentMaterial')[0];
    return surface?[[node.props.accessibilityLabel,{instance:surface.props.instance,material:surface.props.material}]]:[];
  }));
}
const beforePan=surfacesByDate();
await act(async()=>{gestures.current.onStartValue();gestures.current.onUpdateValue({translationX:-3*84});});
assert.deepEqual(selections,[],'拖动过程中不提交日期或读取日程');
const afterPan=surfacesByDate();
for(const [date,surface] of beforePan){
  if(afterPan.has(date))assert.deepEqual(afterPan.get(date),surface,'跨日时仍在窗口内的照片不得换源或重建蒙版');
}
await act(async()=>{gestures.current.onEndValue();});
assert.deepEqual(selections,[day+3],'停稳后提交目标日期');
assert.equal(renderer.root.findAllByType('FragmentMaterial').length,9);
const arcProps={selectedDay:day+3,today:day,counts:[],onSelect:value=>selections.push(value),enabled:true,inViewport:true,reducedMotion:true};
await act(async()=>{renderer.update(React.createElement(Arc,arcProps));});
assert.equal(activeLoops.size,0,'减少动态效果时停止装饰时钟');
for(const [date,surface] of afterPan)assert.deepEqual(surfacesByDate().get(date),surface,'停止光效不能重建日期照片');
await act(async()=>{renderer.update(React.createElement(Arc,{...arcProps,reducedMotion:false}));});
assert.ok(activeLoops.size>0 && activeLoops.size<=6);
await act(async()=>{renderer.update(React.createElement(Arc,{...arcProps,reducedMotion:false,inViewport:false}));});
assert.equal(activeLoops.size,0,'屏幕外停止装饰动画');
assert.equal(gestures.current.enabledValue,true,'可见范围只控制动效，不禁用日期手势');
await act(async()=>{renderer.update(React.createElement(Arc,{...arcProps,reducedMotion:false,enabled:false}));});
assert.equal(activeLoops.size,0,'失焦、后台或弹层停用弧线时停止光效');
await act(async()=>{renderer.unmount();});
assert.equal(activeLoops.size,0,'离开页面不留下装饰动画');

const pending=[];
const {default:useCalendar}=loadUI('src/features/companion/presentation/useProactiveLifeCalendar.ts',{
  '../application/CompanionSettingsFacade':{loadCompanionProductState:async()=>({hostAI:{id:'owner'},state:{desiredEnabled:true}})},
  '../application/ProactiveLifeReadQueries':{loadProactiveLifeCalendar:input=>new Promise(resolve=>pending.push({input,resolve})),listProactiveLifeDay:async()=>({items:[],nextCursor:null})},
  './proactiveLifeCalendar':calendar,
});
let reading;
function Harness({selected,active=true}){reading=useCalendar(selected,active);return null;}
await act(async()=>{renderer=create(React.createElement(Harness,{selected:day}));});
await act(async()=>{renderer.update(React.createElement(Harness,{selected:day+1}));});
const old=pending.find(request=>request.input.day.key===calendar.calendarDayKey(day));
const current=pending.find(request=>request.input.day.key===calendar.calendarDayKey(day+1));
const result={counts:[],page:{items:[],nextCursor:null}};
await act(async()=>{current.resolve(result);});
assert.equal(reading.snapshot.day,day+1);
await act(async()=>{old.resolve(result);});
assert.equal(reading.snapshot.day,day+1,'迟到的旧日期不能覆盖当前日期');
await act(async()=>{renderer.update(React.createElement(Harness,{selected:day+2}));});
const interrupted=pending.find(request=>request.input.day.key===calendar.calendarDayKey(day+2));
await act(async()=>{renderer.update(React.createElement(Harness,{selected:day+2,active:false}));});
await act(async()=>{interrupted.resolve(result);});
assert.equal(reading.snapshot,null,'失焦后不提交未完成的读取结果');
await act(async()=>{renderer.unmount();});
console.log('日期交互验证通过：手势停稳提交、固定节点、快速切换与失焦请求隔离。');

// 整页文字不进入玻璃的背景源；两个弹层复用同一纯星空场景。
let appStateListener;
const ScreenNative={
  ActivityIndicator:'ActivityIndicator',Pressable:'Pressable',RefreshControl:'RefreshControl',Text:'Text',View:'View',
  AppState:{currentState:'active',addEventListener:(event,listener)=>{appStateListener=listener;return{remove(){}};}},
  StyleSheet:{absoluteFill:{position:'absolute',inset:0}},
  FlatList:props=>React.createElement('FlatList',props,props.ListHeaderComponent,...props.data.map((item,index)=>React.createElement(React.Fragment,{key:item.item.sourceId},props.renderItem({item,index}))),props.ListFooterComponent),
};
const {default:Screen}=loadUI('src/features/companion/presentation/ProactiveLifeScreen.tsx',{
  'react-native':ScreenNative,'react-native-safe-area-context':{SafeAreaView:'SafeAreaView',useSafeAreaInsets:()=>({bottom:0})},
  'expo-router':{useFocusEffect:callback=>React.useEffect(callback,[callback])},
  'lucide-react-native':{CalendarDays:'CalendarDays',ChevronLeft:'ChevronLeft'},
  'react-native-reanimated':{useReducedMotion:()=>false},
  '@shared/theme':{GlassBackdrop:'GlassBackdrop',GlassSceneProvider:'GlassSceneProvider',getThemeById:()=>({colors:{text:{primary:'#fff'}}}),useTheme:()=>({effects:{glass:{enabled:true}}}),useThemedStyles:()=>({})},
  '@shared/ui':{Button:'Button',InputField:'InputField',ModalSheet:props=>props.visible?React.createElement('ModalSheet',props,props.children):null},
  '@shared/ui/space':{GalaxyBackground:'GalaxyBackground',ShootingStars:'ShootingStars'},
  './proactiveLifeCalendar':calendar,'./proactiveLifeViewModel':vm,'./ProactiveLifeScreen.styles':{},
  './ProactiveLifeCalendarArc':{default:'CalendarArc'},'./AIScheduleDetailContent':{default:'ScheduleDetail'},
  './useProactiveLifeCalendar':{default:()=>({snapshot:{ownerAIId:'owner',enabled:true,items:[{kind:'future',item:{sourceId:'schedule',plannedAt:'2026-11-01T20:30:00Z',summary:'测试日程'}}],cursor:null},counts:[],loading:false,loadingMore:false,error:null,refresh(){},loadMore(){}})},
});
try{
  await act(async()=>{renderer=create(React.createElement(Screen,{onBack(){}}));});
  await act(async()=>{renderer.root.findAllByType('View').find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:400,height:800}}});});
  const source=renderer.root.findByType('GlassBackdrop');
  source.findByType('GalaxyBackground');
  assert.equal(source.findAllByType('Text').length,0,'背景采样源不包含任何页面正文');
  const arcGroup=renderer.root.findAllByType('View').find(node=>node.children.some(child=>child.type==='CalendarArc'));
  const listViewport=renderer.root.findAllByType('View').find(node=>node.children.some(child=>child.type===ScreenNative.FlatList));
  await act(async()=>{arcGroup.props.onLayout({nativeEvent:{layout:{y:150,height:350}}});listViewport.props.onLayout({nativeEvent:{layout:{height:716}}});});
  assert.equal(renderer.root.findByType('CalendarArc').props.enabled,true);
  assert.equal(renderer.root.findByType('CalendarArc').props.inViewport,true,'采用刷新容器外的真实视口高度');
  // Android 刷新容器内的 ScrollView 可能仍报告旧的 Yoga 高度，不能影响真实可见范围。
  await act(async()=>{renderer.root.findByType('FlatList').props.onLayout?.({nativeEvent:{layout:{height:57}}});});
  assert.equal(renderer.root.findByType('CalendarArc').props.inViewport,true);
  await act(async()=>{renderer.root.findByType('FlatList').props.onScroll({nativeEvent:{contentOffset:{y:700}}});});
  assert.equal(renderer.root.findByType('CalendarArc').props.inViewport,false,'日期区域滚出屏幕后停止动画');
  assert.equal(renderer.root.findByType('CalendarArc').props.enabled,true,'屏幕外暂停不应关闭日期交互');
  await act(async()=>{renderer.root.findByType('FlatList').props.onScroll({nativeEvent:{contentOffset:{y:0}}});});
  assert.equal(renderer.root.findByType('CalendarArc').props.inViewport,true);
  const openJump=()=>renderer.root.findAllByType('Pressable').find(node=>node.findAllByType('Text').some(text=>text.props.children==='跳转日期')).props.onPress();
  await act(async()=>{openJump();});
  assert.equal(renderer.root.findByType('ModalSheet').props.title,'跳转日期');
  assert.equal(source.findAllByType('InputField').length,0);
  assert.equal(renderer.root.findByType('ShootingStars').props.active,false,'打开弹层停止流星');
  await act(async()=>{renderer.root.findByType('ModalSheet').props.onClose();});
  await act(async()=>{renderer.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel?.includes('查看日程详情')).props.onPress();});
  assert.equal(renderer.root.findByType('ModalSheet').props.title,'日程');
  assert.equal(source.findAllByType('ScheduleDetail').length,0);
  await act(async()=>{renderer.root.findByType('ModalSheet').props.onClose();appStateListener('background');});
  assert.equal(renderer.root.findByType('ShootingStars').props.active,false,'应用进入后台后停止流星');
}finally{await act(async()=>{renderer.unmount();});}

// 共享流星最多一个；暂停既清除下一次生成，也取消当前飞行。
const timers=new Map();let nextTimer=0,flightCancelled=0;
const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval,originalRandom=Math.random;
const {default:ShootingStars}=loadUI('src/shared/ui/space/ShootingStars.tsx',{
  'react-native':{StyleSheet:{create:styles=>styles}},
  '@shared/theme':{getThemeById:()=>({colors:{text:{primary:'#fff'}}})},
  'react-native-reanimated':{...animations,cancelAnimation:()=>{flightCancelled++;},withTiming:value=>value},
});
try{
  globalThis.setInterval=callback=>{const id=++nextTimer;timers.set(id,callback);return id;};
  globalThis.clearInterval=id=>timers.delete(id);
  Math.random=()=>0.9;
  await act(async()=>{renderer=create(React.createElement(ShootingStars,{width:400,height:800,active:true}));});
  assert.equal(timers.size,1);
  await act(async()=>{[...timers.values()][0]();});
  assert.equal(renderer.root.findAllByType('AnimatedView').length,1);
  await act(async()=>{[...timers.values()][0]();});
  assert.equal(renderer.root.findAllByType('AnimatedView').length,1,'不能叠加多条流星');
  await act(async()=>{renderer.update(React.createElement(ShootingStars,{width:400,height:800,active:false}));});
  assert.equal(timers.size,0);
  assert.equal(renderer.root.findAllByType('AnimatedView').length,0);
  assert.ok(flightCancelled>0);
}finally{
  await act(async()=>{renderer.unmount();});
  globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;Math.random=originalRandom;
}
console.log('宇宙页面验证通过：可见区域旋转、流星生命周期与两个弹层的正文采样隔离。');
