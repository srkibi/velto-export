/* Velto's portable, local-only renderer. No network access or third-party code. */
export const SYNTH_SAMPLES = ['77129402344871', '135010563837686', '88818675315563'];
export const SUPPORTED_FX = new Set(['EQ','Compressor','Multiband','Saturation','Reverb','Amp','Utility','Delay','Chorus','Flanger','Tremolo']);
const num = (v, fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const db = value => 10 ** (num(value)/20);
export const assetId = value => String(value || '').match(/(?:rbxassetid:\/\/)?(\d+)$/)?.[1] || '';
const list = value => Array.isArray(value) ? value : [];
const text = value => String(value || '').slice(0,100);

export function parseProject(input) {
  const envelope = typeof input === 'string' ? JSON.parse(input) : input;
  if (!envelope || typeof envelope !== 'object') throw new Error('O arquivo não contém um projeto JSON.');
  const project = envelope.Project?.Data || envelope.Project || envelope.Data || envelope;
  if (!Array.isArray(project.Tracks) || !project.Clips || typeof project.Clips !== 'object') throw new Error('Formato inválido: Tracks e Clips são necessários.');
  if (project.Tracks.length > 64) throw new Error('Este renderizador aceita até 64 faixas.');
  const bpm = num(project.BPM,120);
  if (bpm < 20 || bpm > 400) throw new Error('O andamento precisa estar entre 20 e 400 BPM.');
  const length = num(project.ArrangementLength,32);
  if (!(length > 0) || length > 4096) throw new Error('Duração do arranjo inválida.');
  if (length * 60/bpm > 300) throw new Error('O limite de renderização local é de cinco minutos por arquivo.');
  const trackIds=new Set();let totalBlocks=0,totalNotes=0;
  for (const track of project.Tracks) {
    if (!track || typeof track !== 'object') throw new Error('Há uma faixa inválida no projeto.');
    if (!track.Id || trackIds.has(track.Id) || track.Id==='master') throw new Error('Há um ID de faixa ausente, duplicado ou reservado.');
    trackIds.add(track.Id);
    if (list(track.Arrangement).length > 1024) throw new Error('Há clips demais em uma faixa.');
    totalBlocks+=list(track.Arrangement).length;
    if(totalBlocks>4096)throw new Error('Há clips demais neste arranjo.');
    const sorted = list(track.Arrangement).slice().sort((a,b) => num(a.Start)-num(b.Start));
    let ending = -Infinity;
    for (const block of sorted) {
      const clip = project.Clips[block.ClipId];
      if (!clip) throw new Error(`Clip ausente em ${text(track.Name)}.`);
      if (!['MIDI','Audio'].includes(clip.Type) || num(clip.Length)<.0625 || num(clip.Length)>4096) throw new Error('Tipo ou duração de clip inválido.');
      if (list(clip.Notes).length > 16384 || list(clip.Segments).length > 512) throw new Error('Este clip excede o limite de notas ou regiões de áudio.');
      const start=num(block.Start), duration=num(block.Length,clip.Length);
      if (!(duration>0) || duration>4096 || start<0 || start>4096 || num(block.Offset)<0 || num(block.Offset)>4096) throw new Error('Há um clip com posição, offset ou duração inválida.');
      if (start < ending - 1e-6) throw new Error(`Clips sobrepostos em ${text(track.Name)}. Separe-os antes de exportar para evitar uma mixagem diferente.`);
      ending=start+duration;
    }
  }
  for(const clip of Object.values(project.Clips)){totalNotes+=list(clip?.Notes).length;if(totalNotes>65536)throw new Error('Há notas demais neste projeto.');}
  const samples = new Map();
  for (const sample of [...list(envelope.Samples),...list(envelope.Library?.Samples)]) {
    const id=assetId(sample.Id || sample.SampleId);
    if (id) samples.set(id,{...sample,Id:id});
  }
  return {envelope,project,samples,bpm,length,seconds:length*60/bpm};
}

function audibleTracks(model) {
  const solo=model.project.Tracks.some(t=>t.Solo);
  return model.project.Tracks.filter(t=>!t.Muted && (!solo || t.Solo));
}
function layers(device) {
  const count=({Analog:1,Prism:2,Vector:3})[device.Kind];
  if (!count) throw new Error(`Synth incompatível: ${text(device.Kind || device.Name)}.`);
  const blend=clamp(num(device.Blend,.5),0,1), unison=clamp(Math.floor(num(device.Unison,1)),1,count),detune=clamp(num(device.Detune),0,40);
  const weights=count===1?[1]:count===2?[1-blend,blend]:[(1-blend)*.65,.35,blend*.65];
  const waves=[device.OscWave,device.OscBWave,device.OscCWave];
  const result=[];
  for (let oscillator=0;oscillator<count;oscillator++) {
    if (weights[oscillator] < .0001) continue;
    const center=count===1?0:(oscillator/(count-1)-.5)*detune;
    for (let voice=0;voice<unison;voice++) {
      const spread=unison===1?0:(voice/(unison-1)-.5)*detune;
      const wave=clamp(Math.floor(num(waves[oscillator],1)),1,3);
      result.push({id:SYNTH_SAMPLES[wave-1],wave,gain:weights[oscillator]/unison,ratio:2**((center+spread)/1200)});
    }
  }
  return result;
}
function sampleForNote(device,pitch) {
  if (device.Type==='DrumRack') return {id:assetId(device.Pads?.[pitch]),rate:2**(num(device.Tune)/12),oneShot:true};
  let root=num(device.RootNote,60),id=assetId(device.SampleId);
  const zones=list(device.Zones).slice().sort((a,b)=>Math.abs(pitch-num(a.Pitch))-Math.abs(pitch-num(b.Pitch)));
  if (zones[0]) {id=assetId(zones[0].SampleId);root=num(zones[0].Pitch)+num(device.RootNote,60)-60;}
  return {id,rate:clamp(2**((pitch-root+num(device.Tune))/12),.0625,16),oneShot:false};
}

export function buildEvents(model) {
  const result=[],spb=60/model.bpm;let visits=0;
  for (const track of audibleTracks(model)) {
    for (const block of list(track.Arrangement)) {
      const clip=model.project.Clips[block.ClipId], period=num(clip.Length), offset=num(block.Offset), begin=num(block.Start);
      const end=Math.min(model.length,begin+num(block.Length,period));
      if (begin>=end) continue;
      const firstCycle=clip.Loop===false?0:Math.floor(offset/period);
      const lastCycle=clip.Loop===false?0:Math.floor((offset+end-begin-1e-7)/period);
      const device=list(track.Devices)[0];
      if (clip.Type==='MIDI' && (!device || device.Enabled===false)) continue;
      for (let cycle=firstCycle;cycle<=lastCycle;cycle++) {
        if(++visits>500000)throw new Error('Este arranjo excede o limite de processamento local.');
        const cycleStart=begin+cycle*period-offset;
        if (clip.Type==='Audio') {
          const parts=Array.isArray(clip.Segments)?clip.Segments:[{At:0,Length:period,SampleId:clip.SampleId,Start:clip.Start,End:clip.End,Gain:0,Transpose:0}];
          for (const part of parts) {
            if(++visits>500000)throw new Error('Este arranjo excede o limite de processamento local.');
            const onset=cycleStart+num(part.At), start=Math.max(begin,onset), ending=Math.min(end,onset+num(part.Length));
            if (ending<=start) continue;
            const rate=clamp(2**((num(clip.Transpose)+num(part.Transpose))/12),.0625,16);
            const sourceStart=num(part.Start)+(start-onset)*spb*rate;
            const sourceEnd=Math.min(num(part.End),sourceStart+(ending-start)*spb*rate);
            if (sourceEnd<=sourceStart) continue;
            result.push({kind:'audio',track,id:assetId(part.SampleId),start:start*spb,end:Math.min(ending*spb,start*spb+(sourceEnd-sourceStart)/rate),offset:sourceStart,sourceEnd,rate,gain:db(num(clip.Gain)+num(part.Gain)),hardEnd:end*spb});
          }
        } else {
          for (const note of list(clip.Notes)) {
            if(++visits>500000)throw new Error('Este arranjo excede o limite de processamento local.');
            if (!(num(note.Start)>=0 && num(note.Start)<period) || !(num(note.Length)>0)) continue;
            const onset=cycleStart+num(note.Start), start=Math.max(begin,onset), gate=Math.min(end,onset+num(note.Length));
            if (gate<=start) continue;
            const pitch=clamp(num(note.Pitch,60),0,127), velocity=clamp(num(note.Velocity,100),1,127), common={track,device,start:start*spb,end:gate*spb,hardEnd:end*spb,pitch,velocity,gain:velocity/127*db(device.Gain)};
            if (device.Type==='Synth') {
              for (const layer of layers(device)) result.push({...common,kind:'synth',...layer,rate:clamp(2**((pitch-60+num(device.Tune))/12)*layer.ratio,.0625,16),gain:common.gain*layer.gain});
            } else if (['Sampler','DrumRack'].includes(device.Type)) result.push({...common,kind:'sample',...sampleForNote(device,pitch)});
            else throw new Error(`Instrumento incompatível: ${text(device.Type)}.`);
          }
        }
        if (result.length>20000) throw new Error('Há vozes demais para renderizar este arranjo no navegador.');
      }
    }
  }
  return result;
}

export function inspect(model,files=new Map(),approximate=false) {
  const events=buildEvents(model),required=new Map(),unsupported=[];
  for (const event of events) {
    if (event.kind==='synth' && approximate) continue;
    if (!event.id) {unsupported.push(`Sample não definido na faixa ${text(event.track.Name)}.`);continue;}
    const meta=model.samples.get(event.id);
    required.set(event.id,{Id:event.id,Name:meta?.Name || (event.kind==='synth'?`Oscilador ${['Sine','Saw','Square'][event.wave-1]}`:`Sample ${event.id}`),ready:files.has(event.id),file:files.get(event.id)?.name});
  }
  const fx=[];
  for (const track of [...audibleTracks(model),model.project.Master || {Name:'Master'}]) {
    for (const effect of list(track.Effects)) {
      if (effect.Enabled===false || num(effect.Mix,1)===0) continue;
      fx.push(`${text(track.Name || 'Master')}: ${text(effect.Name || effect.Type)}`);
      if (!SUPPORTED_FX.has(effect.Type)) unsupported.push(`${text(track.Name || 'Master')}: ${text(effect.Name || effect.Type)} não possui um motor compatível. Desative-o no projeto para renderizar.`);
    }
  }
  return {events,required:[...required.values()],missing:[...required.values()].filter(s=>!s.ready),unsupported:[...new Set(unsupported)],fx,tracks:audibleTracks(model)};
}

function gain(context,value=1){const node=context.createGain();node.gain.value=value;return node;}
function biquad(context,input,type,freq=1000,q=.707,value=0){const node=context.createBiquadFilter();node.type=type;node.frequency.value=clamp(num(freq,1000),10,context.sampleRate*.49);node.Q.value=num(q,.707);node.gain.value=num(value);input.connect(node);return node;}
function compressor(context,input,data,threshold,makeup){const n=context.createDynamicsCompressor();n.threshold.value=clamp(num(threshold??data.Threshold,-18),-100,0);n.ratio.value=clamp(num(data.Ratio,4),1,20);n.attack.value=clamp(num(data.Attack,.01),0,1);n.release.value=clamp(num(data.Release,.15),0,5);n.knee.value=0;input.connect(n);const out=gain(context,db(makeup??data.Makeup));n.connect(out);return out;}
function stereo(context,input,width=1,pan=0,output=1,squareRoot=false){
  const split=context.createChannelSplitter(2),merge=context.createChannelMerger(2);input.connect(split);
  const left=squareRoot?Math.sqrt(1-Math.max(0,pan)):1-Math.max(0,pan),right=squareRoot?Math.sqrt(1+Math.min(0,pan)):1+Math.min(0,pan);
  const direct=(1+width)/2,cross=(1-width)/2;
  for(const [from,to,value] of [[0,0,direct*left],[1,0,cross*left],[0,1,cross*right],[1,1,direct*right]]){const g=gain(context,value);split.connect(g,from);g.connect(merge,0,to);}
  const out=gain(context,output);merge.connect(out);return out;
}
function noise(seed){let value=seed>>>0;return()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296*2-1;};}
function distortion(context,input,drive){const node=context.createWaveShaper(),curve=new Float32Array(16385),amount=1+num(drive)*45;for(let i=0;i<curve.length;i++){const x=i/(curve.length-1)*2-1;curve[i]=Math.tanh(amount*x)/Math.tanh(amount);}node.curve=curve;node.oversample='2x';input.connect(node);return node;}
function reverb(context,input,data){
  const delay=context.createDelay(.5);delay.delayTime.value=clamp(num(data.PreDelay,.015),0,.3);input.connect(delay);
  const seconds=clamp(num(data.Decay,1.8),.1,12),impulse=context.createBuffer(2,Math.ceil(seconds*context.sampleRate),context.sampleRate);
  const density=clamp(num(data.Size,.8),.1,1),diffusion=clamp(num(data.Diffusion,.8),.1,1);
  for(let ch=0;ch<2;ch++){const a=impulse.getChannelData(ch),random=noise(1451+ch*729);for(let i=0;i<a.length;i++){const t=i/context.sampleRate;a[i]=random()*Math.exp(-6.9*t/seconds)*(random()<(density*1.8-1)?1:diffusion*.12);}}
  const convolution=context.createConvolver();convolution.buffer=impulse;delay.connect(convolution);return biquad(context,convolution,'lowpass',num(data.HighCut,10000));
}
function tremoloWave(context,data){
  const size=256,harmonics=64,real=new Float32Array(harmonics),imag=new Float32Array(harmonics),shape=clamp(num(data.Shape,1),0,1),square=clamp(num(data.Square),0,1),duty=clamp(num(data.Duty,.5),.05,.95),skew=clamp(num(data.Skew),-1,1);
  for(let n=1;n<harmonics;n++){let r=0,im=0;for(let i=0;i<size;i++){const phase=i/size,shifted=(phase+skew*.2+1)%1,sine=Math.sin(shifted*Math.PI*2),triangle=1-4*Math.abs(((shifted+.25)%1)-.5);const smooth=sine*shape+triangle*(1-shape),value=smooth*(1-square)+(shifted<duty?1:-1)*square;r+=value*Math.cos(phase*Math.PI*2*n);im+=value*Math.sin(phase*Math.PI*2*n);}real[n]=r*2/size;imag[n]=im*2/size;}
  return context.createPeriodicWave(real,imag,{disableNormalization:false});
}
function effectNode(context,input,d){
  let wet;
  switch(d.Type){
    case 'EQ': wet=biquad(context,input,'lowshelf',num(d.LowFreq,180),.707,d.LowGain);wet=biquad(context,wet,'peaking',num(d.MidFreq,1000),num(d.MidQ,.707),d.MidGain);wet=biquad(context,wet,'highshelf',num(d.HighFreq,5000),.707,d.HighGain);break;
    case 'Compressor':wet=compressor(context,input,d);break;
    case 'Multiband':{
      const sum=gain(context),lo=num(d.LowCross,220),hi=num(d.HighCross,3500);
      const low=biquad(context,biquad(context,input,'lowpass',lo),'lowpass',lo);
      let mid=biquad(context,biquad(context,input,'highpass',lo),'highpass',lo);mid=biquad(context,biquad(context,mid,'lowpass',hi),'lowpass',hi);
      const high=biquad(context,biquad(context,input,'highpass',hi),'highpass',hi);
      compressor(context,low,d,num(d.LowThreshold,-20),d.LowGain).connect(sum);compressor(context,mid,d,num(d.MidThreshold,-18),d.MidGain).connect(sum);compressor(context,high,d,num(d.HighThreshold,-16),d.HighGain).connect(sum);wet=sum;break;
    }
    case 'Saturation':wet=biquad(context,distortion(context,input,d.Drive),'lowpass',num(d.Tone,14000));{const out=gain(context,db(num(d.Output,-2)));wet.connect(out);wet=out;}break;
    case 'Amp':wet=distortion(context,input,num(d.Drive,.3));wet=biquad(context,wet,'lowshelf',200,.707,d.Bass);wet=biquad(context,wet,'peaking',Math.sqrt(200*2500),.707,d.Mid);wet=biquad(context,wet,'highshelf',2500,.707,d.Treble);wet=biquad(context,wet,'lowpass',num(d.Cabinet,6500));{const out=gain(context,db(num(d.Output,-3)));wet.connect(out);wet=out;}break;
    case 'Utility':wet=stereo(context,input,clamp(num(d.Width,1),0,1),clamp(num(d.Pan),-1,1),db(d.Gain),true);break;
    case 'Delay':{const delay=context.createDelay(5),feedback=gain(context,clamp(num(d.Feedback,.35),0,.95));delay.delayTime.value=clamp(num(d.Time,.375),.001,5);input.connect(delay);delay.connect(feedback);feedback.connect(delay);wet=delay;break;}
    case 'Reverb':wet=reverb(context,input,d);break;
    case 'Chorus':case 'Flanger':{
      const flange=d.Type==='Flanger',delay=context.createDelay(.1),lfo=context.createOscillator(),depth=gain(context,clamp(num(d.Depth,.2),0,1)*(flange?.003:.008));delay.delayTime.value=flange?.005:.018;lfo.frequency.value=clamp(num(d.Rate,.6),.01,20);lfo.connect(depth);depth.connect(delay.delayTime);lfo.start(0);input.connect(delay);if(flange){const feedback=gain(context,.35);delay.connect(feedback);feedback.connect(delay);}wet=delay;break;
    }
    case 'Tremolo':{const amplitude=gain(context,1-clamp(num(d.Depth,.6),0,1)/2),lfo=context.createOscillator(),depth=gain(context,clamp(num(d.Depth,.6),0,1)/2);input.connect(amplitude);lfo.setPeriodicWave(tremoloWave(context,d));lfo.frequency.value=clamp(num(d.Rate,4),.1,20);lfo.connect(depth);depth.connect(amplitude.gain);lfo.start(0);wet=amplitude;break;}
    default:throw new Error(`Efeito sem renderizador: ${text(d.Type)}.`);
  }
  const mix=clamp(num(d.Mix,1),0,1),dry=gain(context,1-mix),processed=gain(context,mix),out=gain(context);input.connect(dry);dry.connect(out);wet.connect(processed);processed.connect(out);return out;
}
function chain(context,input,effects){let current=input;for(const effect of list(effects)){if(effect.Enabled===false||num(effect.Mix,1)===0)continue;current=effectNode(context,current,effect);}return current;}
function envelope(context,input,event){
  const d=event.device||{},a=Math.max(0,num(d.Attack)),release=Math.max(0,num(d.Release)),decay=Math.max(.001,num(d.Decay,.2)),sustain=event.kind==='synth'?clamp(num(d.Sustain,.72),0,1):1;
  const start=event.start,gate=event.oneShot?event.hardEnd:event.end,ending=Math.min(event.hardEnd,gate+release),amp=gain(context,0);
  input.connect(amp);const p=amp.gain,age=Math.max(0,gate-start),at=age<a?age/Math.max(a,1e-9):1-(1-sustain)*clamp((age-a)/decay,0,1);
  p.setValueAtTime(a>0?0:1,start);
  if(start+a<gate && a>0)p.linearRampToValueAtTime(1,start+a);
  if(event.kind==='synth' && start+a+decay<gate)p.linearRampToValueAtTime(sustain,start+a+decay);
  if(gate>start)p.linearRampToValueAtTime(at,gate);
  if(ending>gate)p.linearRampToValueAtTime(0,ending);else p.setValueAtTime(0,gate);
  return {node:amp,ending};
}

export async function renderProject(model,files,{sampleRate=44100,tail=2,approximate=false,onProgress=()=>{}}={}){
  const check=inspect(model,files,approximate);
  if(check.unsupported.length)throw new Error(check.unsupported[0]);
  if(check.missing.length)throw new Error(`Adicione ${check.missing.length} sample(s) original(is). Primeiro: ${check.missing[0].Name} — ${check.missing[0].Id}.`);
  if(![22050,44100,48000].includes(Number(sampleRate)))throw new Error('Sample rate inválido.');
  const Offline=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;
  if(!Offline)throw new Error('Este navegador não oferece OfflineAudioContext. Use um navegador atual.');
  const length=Math.ceil((model.seconds+clamp(num(tail,2),0,12))*sampleRate),context=new Offline(2,length,sampleRate),buffers=new Map();
  onProgress('Decodificando samples originais…');
  for(const entry of check.required){const file=files.get(entry.Id);try{buffers.set(entry.Id,await context.decodeAudioData(await file.arrayBuffer()));}catch{throw new Error(`Não foi possível decodificar ${file.name}. Tente o arquivo original em WAV, MP3 ou OGG compatível com seu navegador.`);}}
  const master=model.project.Master||{},masterInput=gain(context),masterFX=chain(context,masterInput,master.Effects);
  stereo(context,masterFX,1,clamp(num(master.Pan),-1,1),master.Muted?0:clamp(num(master.Volume,1),0,1)).connect(context.destination);
  const inputs=new Map();
  for(const track of check.tracks){const input=gain(context),fx=chain(context,input,track.Effects),out=stereo(context,fx,1,clamp(num(track.Pan),-1,1),clamp(num(track.Volume,.75),0,1));out.connect(masterInput);inputs.set(track.Id,input);}
  onProgress(`Agendando ${check.events.length.toLocaleString('pt-BR')} vozes…`);
  for(const event of check.events){
    let source,gainValue=event.gain;
    const meta=model.samples.get(event.id),sampleVolume=clamp(num(meta?.Volume,.5),0,10);
    gainValue*=sampleVolume;
    if(event.kind==='synth'&&approximate){source=context.createOscillator();source.type=['sine','sawtooth','square'][event.wave-1];source.frequency.value=440*2**((event.pitch-69+num(event.device.Tune))/12)*event.ratio;}
    else {const buffer=buffers.get(event.id);if(!buffer)throw new Error(`Sample não encontrado: ${event.id}.`);source=context.createBufferSource();source.buffer=buffer;source.playbackRate.value=event.rate;source.loop=event.kind==='synth'||meta?.Loop===true;}
    let current=source;
    if(event.kind==='synth'){
      const d=event.device;current=biquad(context,current,'lowpass',num(d.Filter,8500),.707+num(d.Resonance,.12)*8);current=biquad(context,current,'lowpass',num(d.Filter,8500),.707);
      if(num(d.LfoDepth)>0){const lfo=context.createOscillator(),depth=gain(context,num(d.LfoDepth)*100);lfo.frequency.value=clamp(num(d.LfoRate,1),.05,12);lfo.connect(depth);depth.connect(source.detune);lfo.start(event.start);lfo.stop(event.hardEnd);}
    }
    const level=gain(context,clamp(gainValue,0,10));current.connect(level);
    let ending=event.end,output=level;
    if(event.kind!=='audio'){const env=envelope(context,level,event);output=env.node;ending=event.oneShot?event.hardEnd:env.ending;}
    output.connect(inputs.get(event.track.Id));
    if(event.kind==='audio'){
      if(event.offset>=source.buffer.duration)continue;
      ending=Math.min(ending,event.start+(Math.min(event.sourceEnd,source.buffer.duration)-event.offset)/event.rate);
      if(ending<=event.start)continue;
      source.start(event.start,event.offset);source.stop(ending);
    }else {source.start(event.start);source.stop(Math.max(event.start+.0001,ending));}
  }
  onProgress('Renderizando a mixagem e os efeitos da Master…');
  const audio=await context.startRendering();
  let peak=0,sum=0,count=0;
  for(let channel=0;channel<audio.numberOfChannels;channel++){const data=audio.getChannelData(channel);for(let i=0;i<data.length;i++){peak=Math.max(peak,Math.abs(data[i]));sum+=data[i]**2;count++;}}
  onProgress('Preparando o arquivo WAV…');
  return {audio,wav:encodeWav(audio),peak,rms:Math.sqrt(sum/Math.max(1,count)),clipped:peak>1,voices:check.events.length};
}

export function encodeWav(audio){
  const channels=audio.numberOfChannels,frames=audio.length,bytes=frames*channels*2,buffer=new ArrayBuffer(44+bytes),view=new DataView(buffer);
  const write=(offset,string)=>{for(let i=0;i<string.length;i++)view.setUint8(offset+i,string.charCodeAt(i));};
  write(0,'RIFF');view.setUint32(4,36+bytes,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,audio.sampleRate,true);view.setUint32(28,audio.sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,bytes,true);
  const data=Array.from({length:channels},(_,i)=>audio.getChannelData(i));let offset=44;
  for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++){const value=clamp(data[channel][frame],-1,1);view.setInt16(offset,Math.round(value*(value<0?32768:32767)),true);offset+=2;}
  return new Blob([buffer],{type:'audio/wav'});
}
const utf8=new TextEncoder();
const varLen=value=>{let n=Math.max(0,Math.round(value)),out=[n&127];while((n>>=7)>0)out.unshift((n&127)|128);return out;};
function chunk(name,data){const length=data.length;return [...utf8.encode(name),(length>>>24)&255,(length>>>16)&255,(length>>>8)&255,length&255,...data];}
export function encodeMidi(model){
  const ppq=480,tracks=[],tempo=Math.round(60000000/model.bpm),metadata=[0,255,81,3,(tempo>>>16)&255,(tempo>>>8)&255,tempo&255,0,255,88,4,4,2,24,8,0,255,47,0];tracks.push(chunk('MTrk',metadata));
  let channel=0;
  for(const track of model.project.Tracks){
    if(track.Type==='Audio')continue;
    const events=[];
    for(const block of list(track.Arrangement)){
      const clip=model.project.Clips[block.ClipId];if(!clip||clip.Type!=='MIDI')continue;
      const period=num(clip.Length),offset=num(block.Offset),begin=num(block.Start),end=Math.min(model.length,begin+num(block.Length,period)),first=clip.Loop===false?0:Math.floor(offset/period),last=clip.Loop===false?0:Math.floor((offset+end-begin-1e-7)/period);
      for(let cycle=first;cycle<=last;cycle++)for(const note of list(clip.Notes)){
        if(num(note.Start)>=period)continue;
        const onset=begin+cycle*period-offset+num(note.Start),start=Math.max(begin,onset),ending=Math.min(end,onset+num(note.Length));
        if(ending>start){const pitch=clamp(Math.round(num(note.Pitch,60)),0,127);events.push({at:Math.round(start*ppq),priority:1,data:[144|channel,pitch,clamp(Math.round(num(note.Velocity,100)),1,127)]},{at:Math.round(ending*ppq),priority:0,data:[128|channel,pitch,0]});}
      }
    }
    events.sort((a,b)=>a.at-b.at||a.priority-b.priority);
    const name=[...utf8.encode(text(track.Name||'MIDI'))],data=[0,255,3,...varLen(name.length),...name];let previous=0;
    for(const event of events){data.push(...varLen(event.at-previous),...event.data);previous=event.at;}
    data.push(...varLen(Math.max(0,Math.round(model.length*ppq)-previous)),255,47,0);tracks.push(chunk('MTrk',data));channel=(channel+1)%16;if(channel===9)channel=10;
  }
  const count=tracks.length,header=[77,84,104,100,0,0,0,6,0,1,(count>>>8)&255,count&255,(ppq>>>8)&255,ppq&255];
  return new Blob([new Uint8Array([...header,...tracks.flat()])],{type:'audio/midi'});
}

export function demoProject(){
  const clips={},tracks=[],chords=[[57,60,64],[53,57,60],[60,64,67],[55,59,62]],root=[33,29,36,31];
  const synth=(id,name,wave,extra={})=>({Id:id,Name:name,Type:'Synth',Kind:'Analog',Enabled:true,Gain:-8,Tune:0,Attack:.006,Decay:.2,Sustain:.4,Release:.18,Filter:6500,Resonance:.1,LfoRate:.3,LfoDepth:0,OscWave:wave,Unison:1,...extra});
  const track=(id,name,color,device,volume,pan,effects=[])=>({Id:id,Name:name,Type:'MIDI',Color:color,Volume:volume,Pan:pan,Muted:false,Solo:false,Devices:[device],Effects:effects,Arrangement:[]});
  const bass=track('bass','Warm Sub',1,synth('d1','Warm Sub',1,{Gain:-5,Filter:900,Sustain:.65}),.65,0);
  const pad=track('pad','Soft Chords',4,synth('d2','Soft Chords',2,{Gain:-13,Attack:.14,Decay:.3,Sustain:.25,Release:.45,Filter:1700}),.52,-.1,[{Id:'fx1',Type:'Reverb',Enabled:true,Decay:1.8,Size:.8,Diffusion:.8,PreDelay:.02,HighCut:6000,Mix:.18}]);
  const pluck=track('pluck','Glass Pattern',3,synth('d3','Glass Pattern',3,{Gain:-13,Decay:.19,Sustain:.03,Release:.1,Filter:4200}),.5,.16,[{Id:'fx2',Type:'Delay',Enabled:true,Time:.254,Feedback:.27,Mix:.18}]);
  const pulse=track('pulse','Low Pulse',2,synth('d4','Low Pulse',1,{Gain:-6,Decay:.07,Sustain:0,Release:.03,Filter:550}),.6,0);
  const notes=[[],[],[],[]];let id=0;
  const add=(i,pitch,start,length,velocity)=>notes[i].push({Id:'n'+(++id),Pitch:pitch,Start:start,Length:length,Velocity:velocity});
  for(let bar=0;bar<4;bar++){const at=bar*4;for(const offset of [0,.75,2,2.75])add(0,root[bar],at+offset,.55,offset===0?110:92);for(const pitch of chords[bar])add(1,pitch,at,3.5,87);for(let eighth=0;eighth<8;eighth++)add(2,chords[bar][eighth%3]+12,at+eighth*.5,.22,eighth%2?68:92);for(let beat=0;beat<4;beat++)add(3,beat===0?29:33,at+beat,.15,beat%2?81:113);}
  [bass,pad,pluck,pulse].forEach((t,i)=>{const clip={Id:'c'+i,Name:['Am · F · C · G','First Light','Glass Eight','Pulse'][i],Type:'MIDI',Length:16,Loop:true,Notes:notes[i],SampleId:'',Start:0,End:0,Gain:0,Transpose:0};clips[clip.Id]=clip;t.Arrangement=[{Id:'b'+i,ClipId:clip.Id,Start:0,Length:16,Offset:0}];tracks.push(t);});
  return {Format:'Velto Project',Version:1,Demo:true,Project:{Name:'First Light — browser session',BPM:118,ArrangementLength:16,Tracks:tracks,Clips:clips,Master:{Id:'master',Name:'Master',Volume:.83,Pan:0,Muted:false,Effects:[{Id:'masterfx',Type:'EQ',Name:'Equalizer',Enabled:true,LowGain:0,LowFreq:180,MidGain:-1.5,MidFreq:800,MidQ:.707,HighGain:1,HighFreq:5000}]}},Samples:SYNTH_SAMPLES.map((Id,i)=>({Id,Name:['Sine','Saw','Square'][i],Volume:.5,Loop:true})),Notes:'Demonstração original de osciladores Web Audio. Não utiliza samples da Roblox Creator Store.'};
}