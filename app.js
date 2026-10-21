import {parseProject,buildEvents,inspect,renderProject,encodeMidi,demoProject,assetId} from './engine.js';

const $=id=>document.getElementById(id);
const files=new Map();
let model=null,busy=false,resultUrl=null;
const colors=['#a99adb','#79afd6','#88d4c0','#d8b07f','#cc8ea4','#8fbf85'];
const time=value=>`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
const name=value=>String(value||'velto-mix').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').trim().slice(0,90)||'velto-mix';
const text=(element,value)=>{element.textContent=String(value);return element;};
const el=(tag,className,content)=>{const element=document.createElement(tag);if(className)element.className=className;if(content!==undefined)element.textContent=String(content);return element;};

function status(message,type=''){$('status').textContent=message;$('status').className='status '+type;}
function setBusy(value){busy=value;$('render-button').disabled=value||!model;$('progress').hidden=!value;$('render-button-label').textContent=value?'Renderizando…':'Renderizar WAV';$('demo-button').disabled=value;$('open-project').disabled=value;$('open-samples').disabled=value;}
function resetOutput(){if(resultUrl)URL.revokeObjectURL(resultUrl);resultUrl=null;$('download-wav').hidden=true;$('audio-preview').hidden=true;$('audio-preview').removeAttribute('src');$('render-title').textContent='Pronto para criar.';$('render-subtitle').textContent='O arquivo WAV aparecerá aqui depois de renderizado.';$('peak-value').textContent='— dBFS';$('master-level').style.width='0%';drawWaveform();}
function drawWaveform(audio){
  const canvas=$('waveform'),width=Math.max(200,canvas.clientWidth),height=79,dpr=window.devicePixelRatio||1;canvas.width=width*dpr;canvas.height=height*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);c.fillStyle='#131c23';c.fillRect(0,0,width,height);c.strokeStyle='#293741';c.lineWidth=1;c.beginPath();c.moveTo(0,height/2+.5);c.lineTo(width,height/2+.5);c.stroke();
  if(!audio){c.fillStyle='#516b7a';c.font='9px Consolas,monospace';c.textAlign='center';c.fillText('AGUARDANDO RENDERIZAÇÃO',width/2,height/2+3);return;}
  const data=audio.getChannelData(0),step=Math.max(1,Math.floor(data.length/width));c.fillStyle='#88e2c7';
  for(let x=0;x<width;x++){let low=1,high=-1;for(let i=x*step;i<Math.min(data.length,(x+1)*step);i++){low=Math.min(low,data[i]);high=Math.max(high,data[i]);}const top=height/2-high*(height*.42),bottom=height/2-low*(height*.42);c.fillRect(x,top,1,Math.max(1,bottom-top));}
}
function summary(){
  if(!model)return;
  const duration=model.seconds+Number($('tail').value),size=(44+Math.ceil(duration*Number($('sample-rate').value))*4)/(1024*1024);
  $('duration').textContent=time(duration);$('file-size').textContent=size.toLocaleString('pt-BR',{maximumFractionDigits:1})+' MB';
}
function review(){
  if(!model)return;
  try{
    const check=inspect(model,files,$('approximate-synth').checked),sourceList=$('source-list'),compat=$('compatibility-list');sourceList.replaceChildren();compat.replaceChildren();
    $('sample-count').textContent=check.required.filter(s=>s.ready).length+'/'+check.required.length;
    for(const sample of check.required){const row=el('div','source-item'+(sample.ready?' ready':'')),dot=el('span','source-dot'),copy=el('div');copy.append(el('strong','',sample.Name),el('small','',sample.Id));if(sample.ready)copy.append(el('small','',sample.file));row.append(dot,copy);sourceList.append(row);}
    if(!check.required.length)sourceList.append(el('div','source-empty',$('approximate-synth').checked?'Este arranjo usa osciladores do navegador. Nenhum sample original é necessário.':'Este arranjo não usa samples.'));
    compat.append(el('li','',`${check.tracks.length} faixas audíveis · ${check.events.length.toLocaleString('pt-BR')} vozes agendadas.`));
    compat.append(el('li','',check.missing.length?`${check.missing.length} sample(s) original(is) pendente(s). Adicione os arquivos com o ID numérico no nome.`:'Todos os arquivos de áudio necessários estão disponíveis.'));
    if(check.fx.length)compat.append(el('li','',`Cadeias de efeitos: ${check.fx.join(' / ')}.`));
    else compat.append(el('li','','Nenhum efeito ativo no arranjo ou na Master.'));
    if($('approximate-synth').checked)compat.append(el('li','','Modo aproximado: synths usam osciladores Web Audio, com envelopes, filtro, afinação, camadas, unison e LFO. O timbre difere dos osciladores sampleados do Velto.'));
    for(const message of check.unsupported)compat.append(el('li','error',message));
    if(check.unsupported.length)status(check.unsupported[0],'error');
    else if(check.missing.length)status(`Adicione ${check.missing.length} sample(s) original(is) para habilitar a mixagem.`);
    else status('Arquivos prontos. Confirme o motor Web Audio e renderize a mixagem.');
  }catch(error){status(error.message,'error');}
}
function miniature(clip){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 120 25');svg.setAttribute('preserveAspectRatio','none');
  if(clip.Type==='MIDI'){
    for(const note of (Array.isArray(clip.Notes)?clip.Notes:[]).slice(0,160)){const r=document.createElementNS(svg.namespaceURI,'rect');r.setAttribute('x',Number(note.Start)/Number(clip.Length)*120);r.setAttribute('y',22-((Number(note.Pitch)%24)/24)*20);r.setAttribute('width',Math.max(1,Number(note.Length)/Number(clip.Length)*120));r.setAttribute('height','1.5');r.setAttribute('fill','currentColor');svg.append(r);}
  }else{
    // Source waveform data is intentionally omitted when the actual file is unavailable.
    const line=document.createElementNS(svg.namespaceURI,'path');line.setAttribute('d','M0 13 H120');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-dasharray','2 3');svg.append(line);
  }
  return svg;
}
function drawArrangement(){
  const timeline=$('timeline');timeline.replaceChildren();const ruler=el('div','timeline-ruler');const count=Math.min(16,Math.ceil(model.length/4)),unit=model.length/count;
  for(let i=0;i<count;i++)ruler.append(el('span','',Math.floor(i*unit/4)+1));timeline.append(ruler);
  const hasSolo=model.project.Tracks.some(t=>t.Solo);
  model.project.Tracks.forEach((track,index)=>{
    const row=el('div','track-row'+(track.Muted||(hasSolo&&!track.Solo)?' muted':'')),color=colors[(Number(track.Color||index+1)-1)%colors.length];row.style.setProperty('--track',color);const title=el('div','track-name');title.append(el('em','',String(index+1).padStart(2,'0')),el('span','',track.Name));const lane=el('div','track-lane');lane.style.setProperty('--grid',100/count+'%');
    for(const block of (Array.isArray(track.Arrangement)?track.Arrangement:[])){
      const clip=model.project.Clips[block.ClipId];if(!clip)continue;const visual=el('div','clip');visual.style.left=Math.max(0,Number(block.Start)/model.length*100)+'%';visual.style.width=Math.max(0,Math.min(Number(block.Length||clip.Length),model.length-Number(block.Start))/model.length*100)+'%';visual.style.color=color;visual.title=`${clip.Name} · ${Number(block.Length||clip.Length)} beats`;visual.append(el('span','',clip.Name),miniature(clip));lane.append(visual);
    }
    row.append(title,lane);timeline.append(row);
  });
  if(!model.project.Tracks.length)timeline.append(el('div','source-empty','Este set ainda não tem faixas.'));
}
function load(input){
  if(busy)return;
  const next=parseProject(input);buildEvents(next);model=next;resetOutput();
  $('empty-state').hidden=true;$('timeline').hidden=false;$('project-name').textContent=String(model.project.Name||'Untitled');$('project-subtitle').textContent=model.envelope.Demo?'Demonstração original · synths aproximados no navegador':`${model.project.Tracks.length} faixas · arranjo completo · renderização local`;
  $('tempo').textContent=model.bpm;$('bars').textContent=Math.ceil(model.length/4);$('track-count').textContent=model.project.Tracks.length;$('filename').value=name(model.project.Name);
  $('json-button').disabled=false;$('midi-button').disabled=false;$('render-button').disabled=false;
  const fx=(model.project.Master?.Effects||[]).filter(f=>f.Enabled!==false).map(f=>f.Name||f.Type);$('master-fx').textContent=fx.length?fx.join(' → '):'Sem efeitos';
  if(model.envelope.Demo)$('approximate-synth').checked=true;
  drawArrangement();summary();review();
}
async function loadFile(file){if(file.size>5*1024*1024)throw new Error('O projeto ultrapassa o limite de 5 MB.');load(await file.text());}
function normalize(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function loadSamples(selected){
  if(busy)return;
  let added=0;const unmatched=[];
  for(const file of selected){
    if(file.size>150*1024*1024){unmatched.push(file.name+' (maior que 150 MB)');continue;}
    const ids=file.name.match(/\d{5,}/g)||[];let id=ids[0];
    if(model){const known=ids.find(n=>model.samples.has(n));if(known)id=known;if(!id){const basename=normalize(file.name.replace(/\.[^.]+$/,'')),matches=[...model.samples.values()].filter(s=>normalize(s.Name)===basename);if(matches.length===1)id=assetId(matches[0].Id);}}
    if(!id){unmatched.push(file.name);continue;}
    files.set(id,file);added++;
  }
  if(added)resetOutput();review();
  if(unmatched.length)status(`${added} arquivo(s) associado(s). Sem ID reconhecido: ${unmatched.slice(0,3).join(', ')}. Renomeie usando o ID numérico do sample (ex.: 123456789.wav).`,'error');
  else if(added)status(`${added} sample(s) original(is) associado(s). Os arquivos permanecem no seu dispositivo.`,'success');
}
function download(blob,filename){const url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}

$('open-project').addEventListener('click',()=>$('project-input').click());
$('load-empty').addEventListener('click',()=>$('project-input').click());
$('open-samples').addEventListener('click',()=>$('samples-input').click());
$('project-input').addEventListener('change',async event=>{try{const file=event.target.files[0];if(file)await loadFile(file);}catch(error){status(error.message,'error');}event.target.value='';});
$('samples-input').addEventListener('change',event=>{loadSamples([...event.target.files]);event.target.value='';});
$('paste-button').addEventListener('click',()=>{$('paste-error').textContent='';$('paste-dialog').showModal();$('project-data').focus();});
$('load-pasted').addEventListener('click',()=>{try{load($('project-data').value);$('paste-dialog').close();}catch(error){$('paste-error').textContent=error.message;}});
$('demo-button').addEventListener('click',()=>{try{load(demoProject());status('Demonstração carregada com osciladores do navegador. Confirme o motor Web Audio para criar um WAV real.');}catch(error){status(error.message,'error');}});
for(const control of ['sample-rate','tail','approximate-synth'])$(control).addEventListener('change',()=>{resetOutput();summary();review();});
$('filename').addEventListener('input',()=>{if(resultUrl)$('download-wav').download=name($('filename').value)+'.wav';});
$('json-button').addEventListener('click',()=>{if(model)download(new Blob([JSON.stringify(model.envelope,null,2)],{type:'application/json'}),name($('filename').value)+'.velto.json');});
$('midi-button').addEventListener('click',()=>{try{if(model)download(encodeMidi(model),name($('filename').value)+'.mid');}catch(error){status(error.message,'error');}});
$('render-button').addEventListener('click',async()=>{
  if(busy||!model)return;
  if(!$('accept-engine').checked){status('Confirme “Usar o motor Web Audio” antes de renderizar.','error');$('accept-engine').focus();return;}
  setBusy(true);resetOutput();
  try{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const result=await renderProject(model,files,{sampleRate:Number($('sample-rate').value),tail:Number($('tail').value),approximate:$('approximate-synth').checked,onProgress:message=>status(message)});
    resultUrl=URL.createObjectURL(result.wav);const link=$('download-wav');link.href=resultUrl;link.download=name($('filename').value)+'.wav';link.hidden=false;$('audio-preview').src=resultUrl;$('audio-preview').hidden=false;
    const peak=result.peak>0?20*Math.log10(result.peak):-Infinity;$('peak-value').textContent=Number.isFinite(peak)?peak.toFixed(1)+' dBFS':'−∞ dBFS';$('master-level').style.width=Math.min(100,result.peak*100)+'%';$('master-level').style.background=result.clipped?'#e9a275':'#88e2c7';
    $('render-title').textContent='Sua mixagem está pronta.';$('render-subtitle').textContent=`${time(result.audio.duration)} · ${(result.wav.size/1048576).toLocaleString('pt-BR',{maximumFractionDigits:1})} MB · estéreo · ${Number($('sample-rate').value)/1000} kHz`;
    drawWaveform(result.audio);
    status(result.clipped?'O pico passou de 0 dBFS. O WAV terá clipping. Reduza o volume da Master no projeto e renderize novamente.':'WAV criado no seu dispositivo. Ouça a prévia e baixe a mixagem.',result.clipped?'error':'success');
  }catch(error){status(error.message||'Não foi possível renderizar este projeto.','error');}
  finally{setBusy(false);}
});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b===button));$('output-tab').hidden=button.dataset.tab!=='output';$('details-tab').hidden=button.dataset.tab!=='details';}));
document.addEventListener('dragover',event=>event.preventDefault());
document.addEventListener('drop',async event=>{event.preventDefault();if(busy)return;const selected=[...(event.dataTransfer?.files||[])];try{const project=selected.find(f=>/\.(json|velto)$/i.test(f.name));if(project)await loadFile(project);loadSamples(selected.filter(f=>f!==project));}catch(error){status(error.message,'error');}});
window.addEventListener('pagehide',()=>{if(resultUrl)URL.revokeObjectURL(resultUrl);});
drawWaveform();