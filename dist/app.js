import { marked } from './vendor/marked.esm.js';
import * as pdfjs from './vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
const $ = id => document.getElementById(id);
const defaults = {theme:'classic',paper:'A4',margin:18,fontSize:10,lineHeight:1.3,sectionSpace:8,accent:'#2e4737',pageNumbers:true};
const state = { settings:{...defaults}, revision:0, renderedRevision:-1, bytes:null, blob:null, pdf:null, zoom:1, fit:true, building:false, fontPromise:null, timer:null, previewTicket:0, persistTimer:null, abort:false };
const storageKey='paperform-draft-v1';
let sample='', toastTimer;
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3800);}
function setStatus(text,kind=''){ $('status').textContent=text;$('status').title=text;$('status-dot').className='status-dot '+kind; }
function cleanName(){return ($('filename').value.trim()||'我的文档').replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').slice(0,80);}
function persist(){clearTimeout(state.persistTimer);state.persistTimer=setTimeout(()=>{try{localStorage.setItem(storageKey,JSON.stringify({markdown:$('editor').value,filename:$('filename').value,settings:state.settings}));$('save-state').textContent='已保存在本机';}catch{$('save-state').textContent='本机存储不可用';}},400);}
function markDirty(){state.revision++;$('download').disabled=true;$('word-count').textContent=$('editor').value.length.toLocaleString();setStatus('有修改，等待更新');persist();clearTimeout(state.timer);if($('auto-update').checked)state.timer=setTimeout(generate,700);}

async function loadFonts(){
  if(state.fontPromise)return state.fontPromise;
  state.fontPromise=(async()=>{
    if(!window.pdfMake)throw new Error('PDF 引擎尚未就绪，请刷新页面重试。');
    const files=['NotoSansSC-Regular.otf','NotoSansSC-Bold.otf'];
    const contents=await Promise.all(files.map(async file=>{
      const response=await fetch(new URL('fonts/'+file,import.meta.url));
      if(!response.ok)throw new Error('中文字体加载失败，请检查网络后点击更新预览。');
      const data=new Uint8Array(await response.arrayBuffer());let binary='';
      for(let i=0;i<data.length;i+=0x8000)binary+=String.fromCharCode(...data.subarray(i,i+0x8000));
      return btoa(binary);
    }));
    pdfMake.addVirtualFileSystem(Object.fromEntries(files.map((name,i)=>[name,contents[i]])));
    pdfMake.addFonts({Noto:{normal:files[0],bold:files[1],italics:files[0],bolditalics:files[1]}});
  })().catch(error=>{state.fontPromise=null;throw error;});
  return state.fontPromise;
}

const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g,s=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&#x27;':"'",'&nbsp;':' '}[s]));
function safeURL(href){try{const u=new URL(href);return ['https:','http:','mailto:'].includes(u.protocol)?u.href:null;}catch{return null;}}
function inline(tokens=[],style={}){
  const out=[];
  for(const t of tokens){
    switch(t.type){
      case 'strong':out.push(...inline(t.tokens,{...style,bold:true}));break;
      case 'em':out.push(...inline(t.tokens,{...style,italics:true}));break;
      case 'del':out.push(...inline(t.tokens,{...style,decoration:'lineThrough'}));break;
      case 'link':{const url=safeURL(t.href);out.push(...inline(t.tokens,{...style,...(url?{link:url,color:state.settings.accent,decoration:'underline'}:{})}));break;}
      case 'br':out.push({text:'\n',...style});break;
      case 'codespan':out.push({text:decode(t.text),...style,background:'#eff2ec',fontSize:state.settings.fontSize*.88,color:'#586b52'});break;
      case 'image':throw new Error('当前版本尚不支持图片。请移除图片 Markdown 后再导出。');
      case 'html':throw new Error('检测到 HTML。请改用 Markdown；分页请用 <!-- pagebreak -->。');
      default: if(t.tokens)out.push(...inline(t.tokens,style));else out.push({text:decode(t.text??t.raw??''),...style});
    }
  }
  return out.length?out:[{text:''}];
}
function pdfContent(tokens){
  const s=state.settings, gap=s.sectionSpace, content=[];
  for(const token of tokens){
    switch(token.type){
      case 'space':break;
      case 'heading':content.push({text:inline(token.tokens),style:'h'+Math.min(token.depth,4),headlineLevel:token.depth,margin:[0,token.depth===1?0:gap+3,0,token.depth===1?gap+2:gap*.55]});break;
      case 'paragraph':case 'text':content.push({text:inline(token.tokens??[{type:'text',text:token.text}]),margin:[0,0,0,gap*.7]});break;
      case 'list':{
        const items=token.items.map(item=>{
          let parts=pdfContent(item.tokens);if(item.task){parts.unshift({text:item.checked?'[x]':'[ ]',bold:true});}
          return {stack:parts.length?parts:[{text:''}],margin:[0,0,0,2]};
        });
        content.push({[token.ordered?'ol':'ul']:items,...(token.ordered?{start:token.start||1}:{}),margin:[0,0,0,gap*.55],markerColor:s.accent});break;
      }
      case 'table':{
        const header=token.header.map((cell,i)=>({text:inline(cell.tokens),bold:true,color:s.accent,fillColor:'#eef2eb',alignment:token.align[i]||'left',margin:[5,5,5,5]}));
        const rows=token.rows.map(row=>row.map((cell,i)=>({text:inline(cell.tokens),alignment:token.align[i]||'left',margin:[5,5,5,5]})));
        content.push({table:{headerRows:1,widths:token.header.map(()=>'*'),body:[header,...rows],dontBreakRows:true,keepWithHeaderRows:1},layout:{hLineWidth:i=>i===1?.8:.4,vLineWidth:()=>0,hLineColor:()=>'#dce3d6',paddingLeft:()=>2,paddingRight:()=>2,paddingTop:()=>0,paddingBottom:()=>0},fontSize:s.fontSize*.92,margin:[0,2,0,gap]});break;
      }
      case 'blockquote':content.push({stack:pdfContent(token.tokens),color:'#788273',fontSize:s.fontSize*.9,margin:[10,4,0,gap*.8]});break;
      case 'code':{
        if(/^(mermaid|math|latex|katex)$/i.test(token.lang||''))throw new Error('当前版本尚不渲染 Mermaid 或数学公式，请移除相关代码块后再导出。');
        content.push({text:token.text,fontSize:s.fontSize*.86,background:'#f0f3ec',color:'#52624a',margin:[7,5,7,gap],preserveLeadingSpaces:true});break;
      }
      case 'hr':content.push({canvas:[{type:'line',x1:0,y1:0,x2:100,y2:0,lineWidth:.5,lineColor:'#cdd7c5'}],margin:[0,gap,0,gap]});break;
      case 'html':{
        if(/^\s*<!--\s*pagebreak\s*-->\s*$/i.test(token.text))content.push({text:'',pageBreak:'before'});
        else if(/^\s*<!--[\s\S]*-->\s*$/.test(token.text))break;
        else throw new Error('检测到 HTML。请改用 Markdown；分页请用 <!-- pagebreak -->。');break;
      }
      default:if(token.raw?.trim())content.push({text:decode(token.raw),margin:[0,0,0,gap*.7]});
    }
  }
  const grouped=[];
  for(let i=0;i<content.length;i++){
    if(!content[i].headlineLevel){grouped.push(content[i]);continue;}
    let end=i;while(content[end]?.headlineLevel)end++;
    const next=content[end];
    const length=next?.text?JSON.stringify(next.text).length:Infinity;
    if(next?.text&&length<1600&&!next.pageBreak){grouped.push({stack:content.slice(i,end+1),unbreakable:true});i=end;}
    else{grouped.push(...content.slice(i,end));i=end-1;}
  }
  return grouped;
}
function documentDefinition(markdown){
  const s=state.settings, margin=s.margin*72/25.4;
  if(markdown.length>100000)throw new Error('当前版本最多处理 100,000 个字符，请拆分文档后导出。');
  if(/(^|\n)\s*\$\$|\\\[|\\\(|(?<!\\)\$[^\s$][^\n$]*\$/.test(markdown))throw new Error('检测到数学公式。当前版本尚不渲染公式，请改为普通文字后导出。');
  let content=pdfContent(marked.lexer(markdown,{gfm:true,breaks:false}));
  while(content.at(-1)?.pageBreak==='before')content.pop();
  while(content[0]?.pageBreak==='before')content.shift();
  if(!content.length)content=[{text:' '}];
  const compact=s.theme==='compact', editorial=s.theme==='editorial';
  return {
    info:{title:cleanName(),author:'',subject:'Markdown document',creator:'Paperform',keywords:'Markdown, PDF'},
    pageSize:s.paper,pageMargins:[margin,margin,margin,margin+8],
    defaultStyle:{font:'Noto',fontSize:s.fontSize,lineHeight:s.lineHeight,color:'#303a32'},
    content,
    styles:{h1:{fontSize:s.fontSize*(compact?2:2.35),bold:true,color:s.accent,alignment:editorial?'center':'left'},h2:{fontSize:s.fontSize*1.28,bold:true,color:s.accent},h3:{fontSize:s.fontSize*1.08,bold:true,color:'#33422e'},h4:{fontSize:s.fontSize,bold:true,color:'#33422e'}},
    pageBreakBefore(current,following){return !!current.headlineLevel&&following.length===0;},
    footer:s.pageNumbers?(current,total)=>({text:`${current} / ${total}`,alignment:'center',font:'Noto',fontSize:8,color:'#a1aa99',margin:[0,7,0,0]}):undefined,
    compress:true
  };
}

async function generate(){
  clearTimeout(state.timer);
  if(state.building){state.abort=true;return;}
  const revision=state.revision,markdown=$('editor').value;
  state.building=true;state.abort=false;$('download').disabled=true;$('refresh').disabled=true;
  try{
    setStatus(state.fontPromise?'正在排版':'正在加载中文字体');
    const definition=documentDefinition(markdown);
    await loadFonts();
    const bytes=await new Promise((resolve,reject)=>{
      try{pdfMake.createPdf(definition).getBuffer(buffer=>resolve(new Uint8Array(buffer)));}catch(error){reject(error);}
    });
    if(revision!==state.revision||state.abort)return;
    const doc=await pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false}).promise;
    if(revision!==state.revision||state.abort){await doc.destroy();return;}
    const oldPdf=state.pdf;
    state.pdf=doc;state.bytes=bytes;state.blob=new Blob([bytes],{type:'application/pdf'});state.renderedRevision=revision;
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    const hash=Array.from(digest).map(n=>n.toString(16).padStart(2,'0')).join('');
    $('version').textContent=`PDF · ${hash.slice(0,10)}`;$('version').title=`SHA-256: ${hash}`;
    $('version').dataset.sha256=hash;
    $('pdf-size').textContent=(bytes.length/1024).toFixed(1)+' KB';$('page-count').textContent=doc.numPages+' 页 · '+state.settings.paper;
    await renderPages();
    if(oldPdf&&oldPdf!==state.pdf)await oldPdf.destroy();
    if(revision===state.revision){setStatus('已同步','ready');$('download').disabled=false;}
  }catch(error){
    setStatus(error.message||'生成失败，请重试','error');
    toast(error.message||'生成失败，请重试');
    if(!state.bytes){$('empty-preview').hidden=false;$('empty-preview').replaceChildren();const title=document.createElement('strong');title.textContent='暂时无法生成预览';const p=document.createElement('p');p.textContent=error.message;$('empty-preview').append(title,p);}
  }finally{
    state.building=false;$('refresh').disabled=false;
    if((revision!==state.revision||state.abort)&&$('auto-update').checked)state.timer=setTimeout(generate,150);
  }
}
async function renderPages(){
  if(!state.pdf)return;
  const doc=state.pdf,ticket=++state.previewTicket;
  const available=Math.max(180,$('preview-scroll').clientWidth-(innerWidth<560?30:innerWidth<1100?34:60));
  const first=await doc.getPage(1), natural=first.getViewport({scale:1}).width;
  const scale=state.fit?Math.min(1.15,available/natural):state.zoom;
  const fragment=document.createDocumentFragment();
  for(let number=1;number<=doc.numPages;number++){
    if(ticket!==state.previewTicket)return;
    const page=await doc.getPage(number),viewport=page.getViewport({scale});
    const ratio=Math.min(devicePixelRatio||1,2);
    const paper=document.createElement('div');paper.className='pdf-page';paper.style.width=viewport.width+'px';paper.style.height=viewport.height+'px';paper.setAttribute('aria-label',`PDF 第 ${number} 页`);
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.setAttribute('aria-label',`第 ${number} 页，共 ${doc.numPages} 页`);paper.append(canvas);
    await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]}).promise;
    const layer=document.createElement('div');layer.className='textLayer';layer.style.setProperty('--scale-factor',scale);paper.append(layer);
    try{await new pdfjs.TextLayer({textContentSource:await page.getTextContent(),container:layer,viewport}).render();}catch{}
    const linkLayer=document.createElement('div');linkLayer.className='page-link-layer';
    for(const annotation of await page.getAnnotations()){
      const url=annotation.url&&safeURL(annotation.url);if(!url)continue;
      const rect=viewport.convertToViewportRectangle(annotation.rect),link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.title=url;link.setAttribute('aria-label','打开链接 '+url);
      Object.assign(link.style,{left:Math.min(rect[0],rect[2])+'px',top:Math.min(rect[1],rect[3])+'px',width:Math.abs(rect[2]-rect[0])+'px',height:Math.abs(rect[3]-rect[1])+'px'});linkLayer.append(link);
    }
    paper.append(linkLayer);fragment.append(paper);
    const label=document.createElement('div');label.className='page-label';label.style.width=viewport.width+'px';const left=document.createElement('span');left.textContent='PAGE '+String(number).padStart(2,'0');const right=document.createElement('span');right.textContent=state.settings.paper+' / '+doc.numPages+' PAGES';label.append(left,right);fragment.append(label);
  }
  if(ticket!==state.previewTicket)return;
  $('pages').replaceChildren(fragment);$('empty-preview').hidden=true;$('zoom-fit').textContent=state.fit?'适合宽度':Math.round(scale*100)+'%';
}

function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
$('download').addEventListener('click',()=>{
  if(!state.blob||state.renderedRevision!==state.revision||state.building){toast('请先更新成品预览，再下载。');return;}
  downloadBlob(state.blob,cleanName()+'.pdf');toast('已下载当前预览的同一份 PDF');
});
$('save-md').onclick=()=>downloadBlob(new Blob([$ ('editor').value],{type:'text/markdown;charset=utf-8'}),cleanName()+'.md');
$('editor').addEventListener('input',markDirty);
$('filename').addEventListener('input',markDirty);
$('editor').addEventListener('keydown',event=>{
  if(event.key==='Tab'){event.preventDefault();insert('  ','');}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();$('save-md').click();}
});
function syncControls(){
  const s=state.settings;for(const [id,key]of [['paper','paper'],['margin','margin'],['font-size','fontSize'],['line-height','lineHeight'],['section-space','sectionSpace'],['accent','accent']])$(id).value=s[key];
  $('page-numbers').checked=s.pageNumbers;
  $('margin-value').textContent=s.margin+' mm';$('font-size-value').textContent=s.fontSize+' pt';$('line-height-value').textContent=Number(s.lineHeight).toFixed(2).replace(/0$/,'')+' 倍';$('section-space-value').textContent=s.sectionSpace+' pt';
  for(const b of document.querySelectorAll('[data-theme]')){const on=b.dataset.theme===s.theme;b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);}
  for(const b of document.querySelectorAll('[data-color]')){const on=b.dataset.color===s.accent;b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);}
}
for(const [id,key]of [['paper','paper'],['margin','margin'],['font-size','fontSize'],['line-height','lineHeight'],['section-space','sectionSpace'],['accent','accent']]){
  $(id).addEventListener('input',()=>{state.settings[key]=['paper','accent'].includes(key)?$(id).value:Number($(id).value);syncControls();markDirty();});
}
$('page-numbers').onchange=()=>{state.settings.pageNumbers=$('page-numbers').checked;markDirty();};
$('auto-update').onchange=()=>{clearTimeout(state.timer);if($('auto-update').checked&&state.revision!==state.renderedRevision)generate();};
$('refresh').onclick=()=>{state.revision++;generate();};
$('reset-style').onclick=()=>{state.settings={...defaults};syncControls();markDirty();toast('已恢复清简版式');};
for(const button of document.querySelectorAll('[data-theme]'))button.onclick=()=>{
  const theme=button.dataset.theme;state.settings.theme=theme;
  Object.assign(state.settings,theme==='compact'?{fontSize:8.5,margin:13,lineHeight:1.1,sectionSpace:4}:theme==='editorial'?{fontSize:10.5,margin:22,lineHeight:1.45,sectionSpace:10}:{fontSize:10,margin:18,lineHeight:1.3,sectionSpace:8});
  syncControls();markDirty();
};
for(const button of document.querySelectorAll('[data-color]'))button.onclick=()=>{state.settings.accent=button.dataset.color;syncControls();markDirty();};
function insert(before,after,placeholder=''){
  const el=$('editor'),start=el.selectionStart,end=el.selectionEnd,selected=el.value.slice(start,end)||placeholder;
  el.setRangeText(before+selected+after,start,end,'select');el.focus();markDirty();
}
for(const b of document.querySelectorAll('[data-insert]'))b.onclick=()=>{
  const actions={heading:()=>insert('\n## ','\n','章节标题'),bold:()=>insert('**','**','重点内容'),list:()=>insert('\n- ','\n','列表内容'),table:()=>insert('\n| 标题 | 内容 |\n| --- | --- |\n| 项目 | 说明 |\n',''),link:()=>insert('[','](https://example.com)','链接文字'),pagebreak:()=>insert('\n\n<!-- pagebreak -->\n\n','')};actions[b.dataset.insert]();
};
$('import-button').onclick=()=>$('file-input').click();
$('file-input').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>400000)throw new Error('文件过大，请导入小于 400 KB 的 Markdown 文档。');const text=await file.text();if(text.includes('\ufffd'))throw new Error('文件可能不是 UTF-8 编码，请转为 UTF-8 后导入。');$('editor').value=text;$('filename').value=file.name.replace(/\.(md|markdown|txt)$/i,'');markDirty();toast('已导入 '+file.name);}catch(e){toast(e.message);}event.target.value='';
};
$('sample-button').onclick=()=>{if($('editor').value.trim()&&$('editor').value!==sample){if(!confirm('载入示例会替换当前编辑内容。建议先保存 Markdown，是否继续？'))return;}$('editor').value=sample;$('filename').value='示例简历';markDirty();};
for(const [button,dialog]of [['guide-button','guide'],['comparison-button','comparison']])$(button).onclick=()=>$(dialog).showModal();
for(const d of document.querySelectorAll('dialog')){d.querySelector('.dialog-close').onclick=()=>d.close();d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});}
$('zoom-fit').onclick=()=>{state.fit=true;renderPages();};
$('zoom-in').onclick=()=>{state.zoom=Math.min(1.8,state.fit?Math.min(1.2,($('preview-scroll').clientWidth-60)/595)+.15:state.zoom+.15);state.fit=false;renderPages();};
$('zoom-out').onclick=()=>{state.zoom=Math.max(.25,state.fit?Math.min(1.2,($('preview-scroll').clientWidth-60)/595)-.15:state.zoom-.15);state.fit=false;renderPages();};
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.pdf&&state.fit)renderPages();},180);}).observe($('preview-scroll'));

async function init(){
  try{sample=await(await fetch('sample-resume.md')).text();}catch{sample='# 我的简历\n\n## 个人简介\n\n在这里介绍自己。';}
  let saved;try{saved=JSON.parse(localStorage.getItem(storageKey)||'null');}catch{}
  if(saved&&typeof saved.markdown==='string'){
    $('editor').value=saved.markdown;$('filename').value=typeof saved.filename==='string'?saved.filename:'我的简历';
    const p=saved.settings||{};state.settings={...defaults,theme:['classic','editorial','compact'].includes(p.theme)?p.theme:defaults.theme,paper:['A4','LETTER'].includes(p.paper)?p.paper:'A4',accent:/^#[\da-f]{6}$/i.test(p.accent)?p.accent:defaults.accent,pageNumbers:typeof p.pageNumbers==='boolean'?p.pageNumbers:true};
    for(const [key,min,max]of [['fontSize',8,14],['margin',10,30],['lineHeight',1.05,1.65],['sectionSpace',3,16]])if(Number.isFinite(p[key]))state.settings[key]=Math.max(min,Math.min(max,p[key]));
  }else{$('editor').value=sample;$('filename').value='示例简历';}
  syncControls();$('word-count').textContent=$('editor').value.length.toLocaleString();state.revision++;generate();
}
init();
