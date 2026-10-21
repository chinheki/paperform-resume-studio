import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const required=['index.html','style.css','app.js','sample-resume.md','vendor/pdfmake.min.js','vendor/marked.esm.js','vendor/pdf.mjs','vendor/pdf.worker.mjs','fonts/NotoSansSC-Regular.otf','fonts/NotoSansSC-Bold.otf','fonts/OFL.txt'];
for(const file of required){
  const info=await stat(path.join(root,file));
  if(!info.isFile()||info.size===0)throw new Error(`Missing or empty asset: ${file}`);
}
const html=await readFile(path.join(root,'index.html'),'utf8');
for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){
  const asset=match[1];
  if(asset.startsWith('/')&&!asset.startsWith('//'))throw new Error(`Root-relative asset breaks project Pages URLs: ${asset}`);
}
console.log(`Static site validated: ${required.length} required assets; project-relative URLs.`);
