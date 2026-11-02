import TurndownService from './vendor/turndown.js';
import gfm from './vendor/turndown-plugin-gfm.js';

const markdownSyntax=/(^|\n) {0,3}(?:#{1,6}[ \t]+|`{3,}|~{3,}|>[ \t]+)|(^|\n)[ \t]*\|?\s*:?-{3,}:?\s*\||\[[^\]\n]+\]\([^\n)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|~~[^~\n]+~~|(?:^|\s)(?:\*[^*\n]+\*|_[^_\n]+_)(?=$|\s|[.,，。!?])/;

function wordLists(root){
  for(const paragraph of [...root.querySelectorAll('p')]){
    if(!/mso-list\s*:/i.test(paragraph.getAttribute('style')||''))continue;
    const marker=paragraph.querySelector('[style*="mso-list:Ignore"], [style*="mso-list: Ignore"]');
    const prefix=(marker?.textContent||paragraph.textContent).trim();
    const tag=/^\d+[.)]/.test(prefix)?'ol':'ul';
    marker?.remove();
    if(!marker)paragraph.innerHTML=paragraph.innerHTML.replace(/^\s*(?:[•·●▪◦]|\d+[.)])(?:\s|&nbsp;)+/,'');
    let list=paragraph.previousElementSibling;
    if(!list||list.localName!==tag) {list=root.ownerDocument.createElement(tag);paragraph.before(list);}
    if(tag==='ol'&&!list.children.length){const start=prefix.match(/^(\d+)/)?.[1];if(start)list.setAttribute('start',start);}
    const item=root.ownerDocument.createElement('li');item.append(...paragraph.childNodes);list.append(item);paragraph.remove();
  }
}

export function htmlToMarkdown(html){
  // Template contents stay detached: pasted resources and scripts are never loaded or inserted into the page.
  const template=document.createElement('template');template.innerHTML=html;
  const root=document.createElement('div');root.append(template.content);
  root.querySelectorAll('script,style,noscript,iframe,object,embed,meta,link,svg,canvas').forEach(node=>node.remove());
  root.querySelectorAll('[hidden],[aria-hidden="true"]').forEach(node=>node.remove());
  wordLists(root);
  for(const node of [...root.querySelectorAll('p,span,div')]){
    const style=node.getAttribute('style')||'',className=node.getAttribute('class')||'';
    const heading=className.match(/(?:MsoHeading|heading)([1-6])/i)?.[1]||style.match(/mso-outline-level\s*:\s*([1-6])/i)?.[1];
    if(heading){const h=document.createElement('h'+heading);h.append(...node.childNodes);node.replaceWith(h);continue;}
    if(/font-weight\s*:\s*(?:bold|[6-9]00)\b/i.test(style)) {const strong=document.createElement('strong');strong.append(...node.childNodes);node.append(strong);}
    if(/font-style\s*:\s*italic\b/i.test(style)) {const em=document.createElement('em');em.append(...node.childNodes);node.append(em);}
  }
  const converter=new TurndownService({headingStyle:'atx',codeBlockStyle:'fenced',bulletListMarker:'-',emDelimiter:'*',strongDelimiter:'**'});
  converter.use([gfm.strikethrough,gfm.taskListItems]);
  converter.addRule('strike',{filter:['del','s','strike'],replacement:content=>'~~'+content+'~~'});
  converter.addRule('table',{
    filter:'table',
    replacement:(_content,node)=>{
      const rows=[...node.rows].filter(row=>row.closest('table')===node);
      if(!rows.length)return '';
      const cells=rows.map(row=>[...row.cells].map(cell=>converter.turndown(cell.innerHTML).replace(/\|/g,'\\|').replace(/\s*\n+\s*/g,' ').trim()));
      const columns=Math.max(...cells.map(row=>row.length));
      const row=text=>'| '+Array.from({length:columns},(_,i)=>text[i]||'').join(' | ')+' |';
      // Clipboard tables often use TD rather than TH. Treat their first row as the GFM header.
      return '\n\n'+[row(cells[0]),row(Array(columns).fill('---')),...cells.slice(1).map(row)].join('\n')+'\n\n';
    }
  });
  converter.addRule('safeLinks',{
    filter:'a',replacement:(content,node)=>{
      const href=node.getAttribute('href')||'';
      return /^(https?:|mailto:)/i.test(href)?`[${content}](${href.replace(/ /g,'%20').replace(/\(/g,'%28').replace(/\)/g,'%29')})`:content;
    }
  });
  return converter.turndown(root).replace(/\u00a0/g,' ').trim();
}

export function readClipboard({plain='',html='',markdown=''}={}){
  if(markdown)return {text:markdown,converted:false};
  // Source editors commonly put the source text in both plain-text and HTML clipboard formats.
  // Never escape or rewrite Markdown that is already present in the plain-text representation.
  const sourceList=/(^|\n) {0,3}(?:[-+*]|\d+[.)])[ \t]+/.test(plain)&&!/<(?:h[1-6]|li|table)\b|mso-list\s*:|MsoHeading/i.test(html);
  if(!html||markdownSyntax.test(plain)||sourceList)return {text:plain,converted:false};
  const text=htmlToMarkdown(html);
  return {text:text||plain,converted:!!text};
}

export function installPasteHandler(editor,{onChange,onConverted,onError}={}){
  editor.addEventListener('paste',event=>{
    const data=event.clipboardData;if(!data)return;
    try{
      const result=readClipboard({plain:data.getData('text/plain'),html:data.getData('text/html'),markdown:data.getData('text/markdown')});
      if(!result.converted&&!data.getData('text/markdown'))return;
      event.preventDefault();
      // Native text insertion preserves the textarea's undo transaction where supported.
      editor.focus();
      if(!document.execCommand('insertText',false,result.text))editor.setRangeText(result.text,editor.selectionStart,editor.selectionEnd,'end');
      onChange?.();
      if(result.converted)onConverted?.();
    }catch(error){
      // Keep the browser's original paste behavior if conversion fails.
      onError?.(error);
    }
  });
}
