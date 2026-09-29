import type {TurnstileConfig} from './turnstile';

export type AuthConfigState=
 | {status:'loading';config:null;message:string}
 | {status:'error';config:null;message:string}
 | {status:'ready';config:TurnstileConfig;message:''};

export const initialAuthConfigState:AuthConfigState={status:'loading',config:null,message:'正在读取安全验证配置…'};
export const AUTH_CONFIG_TIMEOUT_MS=8000;

function checkedConfig(value:{turnstile:TurnstileConfig}):TurnstileConfig{
 const config=value.turnstile;
 const siteKey=typeof config?.siteKey==='string'?config.siteKey.trim():'';
 if(!config||typeof config.enabled!=='boolean'||(config.enabled&&!siteKey))throw new Error('安全验证配置无效，请重试读取。');
 return config.enabled?{...config,siteKey}:config;
}

export class AuthConfigLoader{
 private generation=0;
 invalidate(){this.generation++;}
 async load(request:()=>Promise<{turnstile:TurnstileConfig}>,apply:(state:AuthConfigState)=>void,timeoutMs=AUTH_CONFIG_TIMEOUT_MS){
  const generation=++this.generation;
  apply(initialAuthConfigState);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const result=await Promise.race([
    request(),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('安全验证配置读取超时，请重试。')),timeoutMs);}),
   ]);
   const config=checkedConfig(result);
   if(generation===this.generation)apply({status:'ready',config,message:''});
  }catch(error){
   if(generation===this.generation)apply({status:'error',config:null,message:error instanceof Error?error.message:'安全验证配置暂不可用，请重试。'});
  }finally{if(timer)clearTimeout(timer);}
 }
}

export function passwordTurnstileToken(state:AuthConfigState,token:string|null):string|undefined{
 if(state.status!=='ready')throw new Error(state.status==='error'?state.message:'正在读取安全验证配置，请稍候。');
 if(!state.config.enabled)return undefined;
 if(!token)throw new Error('请先完成人机验证');
 return token;
}

export function passwordLoginDisabled(state:AuthConfigState,token:string|null,busy:boolean):boolean{
 return busy||state.status!=='ready'||Boolean(state.config.enabled&&!token);
}

export function loginAvailability(state:AuthConfigState,token:string|null,busy:boolean){
 return {passwordDisabled:passwordLoginDisabled(state,token,busy),passkeyDisabled:busy};
}

export async function finishPasswordAttempt(attempt:()=>Promise<boolean>,resetToken:()=>void):Promise<boolean>{
 const accepted=await attempt();
 if(!accepted)resetToken();
 return accepted;
}

export function passkeyOptionsBody(username:string):{username:string}{
 if(!username.trim())throw new Error('请先输入用户名');
 return {username};
}
