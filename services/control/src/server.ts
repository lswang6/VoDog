import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import {createTranscriptionRuntime} from './transcription/runtime.js';

// Nothing below may exit the process on a database connection that Postgres killed.
const logFailure=(event:string,value:unknown)=>{
  const error=value as {name?:unknown;code?:unknown;message?:unknown};
  console.error(JSON.stringify({level:'error',event,
    name:typeof error?.name==='string'?error.name:null,
    code:error?.code===undefined?null:String(error.code),
    msg:typeof error?.message==='string'?error.message:String(value)}));
};
process.on('unhandledRejection',reason=>logFailure('unhandled_rejection',reason));
process.on('uncaughtException',error=>{logFailure('uncaught_exception',error);process.exit(1);});

const config=loadConfig(); const db=createDb(config.DATABASE_URL);
db.on('error',error=>logFailure('pg_idle_client_error',error));
const app=await buildApp(db,config);
const transcription=createTranscriptionRuntime(db,config);let closing=false;
const shutdown=async()=>{if(closing)return;closing=true;await transcription.stop();await app.close();await db.end();}; process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
await app.listen({host:'127.0.0.1',port:config.PORT});
transcription.start();
