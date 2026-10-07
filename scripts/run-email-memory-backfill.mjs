import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const dir=path.resolve('tmp');fs.mkdirSync(dir,{recursive:true});
const lock=path.join(dir,'email-memory-worker.pid');
if(fs.existsSync(lock)){const pid=Number(fs.readFileSync(lock,'utf8'));try{process.kill(pid,0);throw new Error('An indexing supervisor is already running.');}catch(e){if(e.code!=='ESRCH')throw e;}}
fs.writeFileSync(lock,String(process.pid));
const log=path.join(dir,'email-memory-progress.log');
const record=x=>fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),...x})+'\n');
try {
 for(let attempt=1;attempt<=20;attempt++){
  record({state:'running',attempt});let finalStatus;let buffer='';
  const child=spawn(process.execPath,['scripts/index-email-memory.mjs','--backfill=500'],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const item=JSON.parse(line);record(item);if(item.status)finalStatus=item.status;}catch{}}});
  // Avoid recording credentials or customer content from raw exceptions.
  child.stderr.on('data',()=>{});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(code===0&&finalStatus&&finalStatus.ready_sources>=finalStatus.sources){record({state:'complete',status:finalStatus});break;}
  record({state:'retrying',exit_code:code,status:finalStatus,delay_seconds:30});
  if(attempt===20){record({state:'needs_attention',reason:'Restart limit reached; check provider and database connections.'});break;}
  await new Promise(resolve=>setTimeout(resolve,30000));
 }
} finally {fs.rmSync(lock,{force:true});}
