/** Store only payload digests and idempotency keys, never SMS text or phone numbers. */
type Pending={digest:string;key:string};
export class OutboundAttempt {
  private readonly storage: Pick<Storage,'getItem'|'setItem'|'removeItem'>;
  private readonly scope:string;
  constructor(storage: Pick<Storage,'getItem'|'setItem'|'removeItem'>,scope:string) {this.storage=storage;this.scope=scope;}
  private pending():Pending[]{
    const raw=this.storage.getItem(this.scope);if(!raw)return [];
    if(raw.length>40_000)throw new Error('待确认操作记录异常，请联系管理员核对发送状态');
    const parsed=JSON.parse(raw);
    const items=parsed?.version===2?parsed.pending:[parsed];
    if(!Array.isArray(items)||items.length>128||items.some(item=>!item||typeof item.digest!=='string'||!/^[a-f0-9]{64}$/.test(item.digest)||typeof item.key!=='string'||!/^[a-f0-9-]{36}$/.test(item.key)))throw new Error('待确认操作记录异常，请联系管理员核对发送状态');
    return items;
  }
  async key(payload: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    // Read after the asynchronous hash; same-page callers cannot overwrite a stale snapshot.
    const pending=this.pending();const prior=pending.find(item=>item.digest===digest);
    if(prior)return prior.key;
    if(pending.length>=128)throw new Error('待确认操作过多，请先核对之前的发送状态');
    const key=crypto.randomUUID();
    this.storage.setItem(this.scope,JSON.stringify({version:2,pending:[...pending,{digest,key}]}));
    return key;
  }
  confirmed(key:string):void {
    const prior=this.pending();const pending=prior.filter(item=>item.key!==key);
    if(pending.length===prior.length)return;
    if(pending.length)this.storage.setItem(this.scope,JSON.stringify({version:2,pending}));
    else this.storage.removeItem(this.scope);
  }
}
