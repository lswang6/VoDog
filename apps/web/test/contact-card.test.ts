import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {ContactDto} from '../src/contacts.ts';

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}
function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}
function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === 'button' && collectText(node).trim() === label)[0];
}

const zhang: ContactDto = {
  id: 'c-1',
  displayName: '张三',
  organization: '云图科技',
  phones: [
    {id: 'p-1', rawNumber: '202 555 0117', e164: '+12025550117', label: 'mobile', isPrimary: true},
    {id: 'p-2', rawNumber: '202-555-0199', label: 'home'},
  ],
  emails: [{id: 'e-1', address: 'zhang@example.com', label: 'work'}],
  addresses: [{id: 'a-1', formatted: '广东省深圳市和平路 12 号', label: 'home'}],
};

/** One dev server for the whole file: restarting it per test makes esbuild abort its in-flight scans. */
let server: ViteDevServer | undefined;
async function harness() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const {ContactCard} = (await server.ssrLoadModule('/src/contact-card.tsx')) as typeof import('../src/contact-card.tsx');
  return {ContactCard};
}
after(async () => {
  await server?.close();
  server = undefined;
});

test('a record card offers 拨打/短信 on top, then 新建/添加/屏蔽 and the call media in place', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; method?: string; body?: unknown}[] = [];
    const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
      calls.push({path: requestPath, method, body});
      if (requestPath.startsWith('/contacts/lookup')) return {item: null} as T;
      return {} as T;
    };
    const opened: string[] = [];
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          // An old Control sends neither blocked nor blockedEntryId with the call row.
          target: {remoteNumber: '2025550117', simId: 'sim-1', callId: 'call-1'},
          busy: false,
          mediaLive: false,
          request,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => opened.push('close'),
          onCall: () => opened.push('call'),
          onSms: () => opened.push('sms'),
          onCreateContact: number => opened.push(`create:${number}`),
          // The opener's 录音 / 转录 sections render inside the card: nothing jumps to another tab.
          media: React.createElement('button', {type: 'button', className: 'media-probe'}, '查看录音'),
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /2025550117/);
    for (const label of ['拨打电话', '发送短信', '新建联系人', '添加到现有联系人', '屏蔽此号码']) {
      assert.ok(button(renderer!, label), `${label} is offered`);
    }
    assert.equal(renderer!.root.findAll(node => node.type === 'button' && collectText(node).includes('解除屏蔽')).length, 0);
    assert.equal(
      calls.filter(call => call.path.startsWith('/contacts/lookup')).length,
      1,
      'the card resolves the number through the lookup route',
    );
    assert.ok(
      calls.some(call => call.path === '/contacts/lookup?number=2025550117'),
      'the dialled number is encoded into the query',
    );

    // 拨打电话 needs the same second confirmation as 屏蔽/删除.
    await act(async () => {
      button(renderer!, '拨打电话')!.props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), /拨打此号码/);
    assert.equal(opened.length, 0, 'the call prompt alone never dials');
    await act(async () => {
      button(renderer!, '确认拨打')!.props.onClick();
    });
    await act(async () => {
      button(renderer!, '发送短信')!.props.onClick();
    });
    const media = renderer!.root.find(node => node.props.className === 'contact-card-links');
    assert.equal(media.props['aria-label'], '录音与转录');
    assert.ok(media.findByProps({className: 'media-probe'}), 'the media slot renders inside the card');
    await act(async () => {
      button(renderer!, '新建联系人')!.props.onClick();
    });
    assert.deepEqual(opened, ['call', 'sms', 'create:2025550117']);

    // 屏蔽 needs the same second confirmation the rest of the app uses.
    await act(async () => {
      button(renderer!, '屏蔽此号码')!.props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), /屏蔽后/);
    assert.equal(calls.filter(call => call.path === '/blocklist' && call.body).length, 0, 'the prompt alone sends nothing');
    await act(async () => {
      button(renderer!, '确认屏蔽')!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(
      calls.filter(call => call.path === '/blocklist' && call.body),
      [{path: '/blocklist', method: undefined, body: {remoteNumber: '2025550117', sourceCallId: 'call-1', scope: 'call'}}],
      'blocking carries the originating call so the server can snapshot it',
    );
  } finally {
    renderer?.unmount();
  }
});

test('屏蔽 hands the new entry id back so the same card can immediately 解除屏蔽', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    let changed: {blocked: boolean; blockedEntryId?: string | null} | undefined;
    const request = async <T,>(requestPath: string): Promise<T> => {
      if (requestPath.startsWith('/contacts/lookup')) return {item: null} as T;
      // POST /blocklist answers with the created entry.
      return {item: {id: 'entry-new', remoteNumber: '2025550111'}} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          target: {remoteNumber: '2025550111', simId: 'sim-1'},
          busy: false,
          mediaLive: false,
          request,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {},
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
          onChanged: update => {
            changed = update;
          },
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      button(renderer!, '屏蔽此号码')!.props.onClick();
    });
    await act(async () => {
      button(renderer!, '确认屏蔽')!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(changed, {blocked: true, blockedEntryId: 'entry-new'});
  } finally {
    renderer?.unmount();
  }
});

test('a card opened from 通讯录 unblocks with the phone-level entry of the number it shows', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; method?: string}[] = [];
    const blockedContact: ContactDto = {
      id: 'c-7',
      displayName: '推销号码',
      blocked: true,
      blockedEntryId: 'entry-contact',
      phones: [
        {id: 'p-1', rawNumber: '202 555 0198', e164: '+12025550198', label: 'work', blocked: true, blockedEntryId: 'entry-work'},
        {id: 'p-2', rawNumber: '202-555-0199', label: 'home', blocked: false, blockedEntryId: null},
      ],
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          // The 通讯录 list has no per-row annotation, so only the contact carries the entry ids.
          target: {remoteNumber: '+12025550198', simId: 'sim-1', contactId: 'c-7', blocked: true},
          contact: blockedContact,
          busy: false,
          mediaLive: false,
          request: async <T,>(requestPath: string, _body?: unknown, method?: string): Promise<T> => {
            calls.push({path: requestPath, method});
            return {} as T;
          },
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {},
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.doesNotMatch(collectText(renderer!.toJSON()), /在通话记录或拦截记录中打开/, 'a real unblock is possible now');
    await act(async () => {
      button(renderer!, '解除屏蔽')!.props.onClick();
    });
    await act(async () => {
      button(renderer!, '确认解除')!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(
      calls.filter(call => call.method === 'DELETE'),
      [{path: '/blocklist/entry-work', method: 'DELETE'}],
      'the phone-level entry wins over the contact-level one',
    );
    renderer!.unmount();

    // The contact's other number is not blocked, so that card must offer 屏蔽此号码 instead.
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          target: {remoteNumber: '202-555-0199', simId: 'sim-1', contactId: 'c-7'},
          contact: blockedContact,
          busy: false,
          mediaLive: false,
          request: async <T,>(): Promise<T> => ({item: null}) as T,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {},
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.ok(button(renderer!, '屏蔽此号码'), 'the unblocked number of a partly blocked contact can still be blocked');
    assert.equal(button(renderer!, '屏蔽此号码')!.props.disabled, false);
    assert.equal(renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '解除屏蔽').length, 0);
  } finally {
    renderer?.unmount();
  }
});

test('a contact known to be blocked but without an entry id can resolve it before unblocking', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls:{path:string;method?:string}[]=[];
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          // The cached annotation has no id; the action resolves it from GET /blocklist before deleting.
          target: {remoteNumber: '202 555 0198', simId: 'sim-1', contactId: 'c-9', blocked: true},
          contact: {id: 'c-9', displayName: '推销号码', blocked: true},
          busy: false,
          mediaLive: false,
          request: async <T,>(path:string,_body?:unknown,method?:string): Promise<T> => {
            calls.push({path,method});
            if(path==='/blocklist?scope=call')return {items:[{id:'resolved-entry',remoteNumber:'+1 202 555 0198'}]} as T;
            return {} as T;
          },
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {},
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /已屏蔽/);
    assert.ok(button(renderer!, '解除屏蔽'));
    await act(async()=>button(renderer!,'解除屏蔽')!.props.onClick());
    await act(async()=>{button(renderer!,'确认解除')!.props.onClick();await flush();});
    assert.ok(calls.some(call=>call.path==='/blocklist?scope=call'&&!call.method));
    assert.ok(calls.some(call=>call.path==='/blocklist/resolved-entry'&&call.method==='DELETE'));
  } finally {
    renderer?.unmount();
  }
});

test('a by-id contact 404 closes the open detail with an explicit external-deletion explanation', async()=>{
  const {ContactCard}=await harness();
  let renderer:ReactTestRenderer|undefined,closed=0,missing='';
  try{
    await act(async()=>{
      renderer=create(React.createElement(ContactCard,{
        target:{remoteNumber:'2025550111',simId:'sim-1',contactId:'gone-contact'},
        busy:false,mediaLive:false,
        request:async()=>{throw Object.assign(new Error('missing'),{status:404});},
        run:async action=>{await action();return true;},
        onClose:()=>closed++,onMissing:(message:string)=>{missing=message;},
        onCall:()=>{},onSms:()=>{},onCreateContact:()=>{},
      }));
      await flush();
    });
    assert.equal(closed,1);
    assert.match(missing,/其他设备删除/);
  }finally{renderer?.unmount();}
});

test('a record-linked card closes only after its authoritative call detail returns 404',async()=>{
  const {ContactCard}=await harness();
  let renderer:ReactTestRenderer|undefined,closed=0,missing='';
  try{
    await act(async()=>{
      renderer=create(React.createElement(ContactCard,{
        target:{remoteNumber:'2025550111',simId:'sim-1',callId:'gone-call'},
        busy:false,mediaLive:false,
        request:async <T,>(path:string):Promise<T>=>{
          if(path==='/calls/gone-call')throw Object.assign(new Error('missing'),{status:404});
          return {items:[]} as T;
        },
        run:async action=>{await action();return true;},
        onClose:()=>closed++,onMissing:message=>{missing=message;},
        onCall:()=>{},onSms:()=>{},onCreateContact:()=>{},
      }));
      await flush();
    });
    assert.equal(closed,1);
    assert.match(missing,/此通话已在其他设备删除/);
  }finally{renderer?.unmount();}
});

test('a fresh blocklist read replaces a record rows frozen block annotation',async()=>{
  const {ContactCard}=await harness();
  let renderer:ReactTestRenderer|undefined;
  try{
    await act(async()=>{
      renderer=create(React.createElement(ContactCard,{
        target:{remoteNumber:'2025550111',simId:'sim-1',callId:'live-call',contactName:'旧姓名',blocked:false},
        busy:false,mediaLive:false,
        request:async <T,>(path:string):Promise<T>=>{
          if(path==='/calls/live-call')return {call:{remoteNumber:'2025550111',simId:'sim-1',contactName:'实时姓名',blocked:false}} as T;
          if(path.startsWith('/contacts/lookup'))return {item:null} as T;
          if(path==='/blocklist?scope=call')return {items:[{id:'fresh-entry',remoteNumber:'+1 2025550111'}]} as T;
          return {} as T;
        },
        run:async action=>{await action();return true;},
        onClose:()=>{},onCall:()=>{},onSms:()=>{},onCreateContact:()=>{},
      }));
      await flush();
    });
    assert.ok(button(renderer!,'解除屏蔽'));
    assert.match(collectText(renderer!.toJSON()),/已屏蔽/);
    assert.match(collectText(renderer!.toJSON()),/实时姓名/);
    assert.doesNotMatch(collectText(renderer!.toJSON()),/旧姓名/);
  }finally{renderer?.unmount();}
});

test('a transient detail refresh keeps the last snapshot visible and offers a working retry',async()=>{
  const {ContactCard}=await harness();
  let renderer:ReactTestRenderer|undefined,failContact=true;
  try{
    await act(async()=>{
      renderer=create(React.createElement(ContactCard,{
        target:{remoteNumber:'2025550117',simId:'sim-1',contactId:'c-1'},
        contact:zhang,busy:false,mediaLive:false,
        request:async <T,>(path:string):Promise<T>=>{
          if(path==='/contacts/c-1'&&failContact)throw new Error('S33 transient contact refresh');
          if(path==='/contacts/c-1')return {item:zhang} as T;
          if(path==='/blocklist?scope=call')return {items:[]} as T;
          return {} as T;
        },
        run:async action=>{await action();return true;},onClose:()=>{},onCall:()=>{},onSms:()=>{},onCreateContact:()=>{},
      }));
      await flush();
    });
    const failedText=collectText(renderer!.toJSON());
    assert.match(failedText,/S33 transient contact refresh/);
    assert.match(failedText,/已保留上次内容/);
    assert.match(failedText,/张三/,'the previously loaded contact remains visible');
    failContact=false;
    await act(async()=>{button(renderer!,'重试刷新')!.props.onClick();await flush();});
    assert.doesNotMatch(collectText(renderer!.toJSON()),/S33 transient contact refresh/);
  }finally{renderer?.unmount();}
});

test('a delayed pre-mutation blocklist read cannot overwrite an accepted block',async()=>{
  const {ContactCard}=await harness();
  let renderer:ReactTestRenderer|undefined,resolveOld:(value:{items:never[]})=>void=()=>{};
  const oldBlocklist=new Promise<{items:never[]}>(resolve=>{resolveOld=resolve;});
  try{
    await act(async()=>{
      renderer=create(React.createElement(ContactCard,{
        target:{remoteNumber:'2025550111',simId:'sim-1',blocked:false},busy:false,mediaLive:false,
        request:async <T,>(path:string,body?:unknown):Promise<T>=>{
          if(path.startsWith('/contacts/lookup'))return {item:null} as T;
          if(path==='/blocklist?scope=call'&&!body)return oldBlocklist as Promise<T>;
          if(path==='/blocklist'&&body)return {item:{id:'accepted-entry'}} as T;
          return {} as T;
        },
        run:async action=>{await action();return true;},onClose:()=>{},onCall:()=>{},onSms:()=>{},onCreateContact:()=>{},
      }));
      await flush();
    });
    await act(async()=>button(renderer!,'屏蔽此号码')!.props.onClick());
    await act(async()=>{button(renderer!,'确认屏蔽')!.props.onClick();await flush();});
    assert.ok(button(renderer!,'解除屏蔽'));
    await act(async()=>{resolveOld({items:[]});await flush();});
    assert.ok(button(renderer!,'解除屏蔽'),'the stale empty list was ignored');
  }finally{renderer?.unmount();}
});

test('a blocked row offers 解除屏蔽 and deletes the entry the server named', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; method?: string}[] = [];
    let changed: {blocked: boolean; blockedEntryId?: string | null} | undefined;
    const request = async <T,>(requestPath: string, _body?: unknown, method?: string): Promise<T> => {
      calls.push({path: requestPath, method});
      if (requestPath.startsWith('/contacts/lookup')) return {item: null} as T;
      return {} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          target: {remoteNumber: '202 555 0198', simId: 'sim-1', blocked: true, blockedEntryId: 'entry-9'},
          busy: false,
          mediaLive: false,
          request,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {},
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
          onChanged: update => {
            changed = update;
          },
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /已屏蔽/);
    assert.ok(button(renderer!, '解除屏蔽'));
    assert.match(button(renderer!, '解除屏蔽')!.props.className,/\bhangup\b/,'解除屏蔽 stays visibly destructive before confirmation');
    assert.equal(renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '屏蔽此号码').length, 0);
    assert.equal(
      renderer!.root.findAll(node => node.type === 'button' && collectText(node).includes('查看转录')).length,
      0,
      'an interception card has no call media',
    );

    await act(async () => {
      button(renderer!, '解除屏蔽')!.props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), /解除屏蔽？/);
    await act(async () => {
      button(renderer!, '确认解除')!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(
      calls.filter(call => call.method === 'DELETE'),
      [{path: '/blocklist/entry-9', method: 'DELETE'}],
    );
    assert.deepEqual(
      changed,
      {blocked: false, blockedEntryId: null},
      'the opener is told the new state so the card stays truthful',
    );
  } finally {
    renderer?.unmount();
  }
});

test('a 通讯录 card adopts a newer preloaded version and its live phone block state', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  const target = {remoteNumber: '2025550111', simId: 'sim-1', contactId: 'live-contact', blocked: false};
  const original: ContactDto = {id: 'live-contact', version: 1, displayName: '实时联系人', phones: [{rawNumber: '2025550111', blocked: false}]};
  const current: ContactDto = {id: 'live-contact', version: 2, displayName: '实时联系人', blocked: true, phones: [{rawNumber: '2025550111', blocked: true, blockedEntryId: 'entry-live'}]};
  const view = (contact: ContactDto) => React.createElement(ContactCard, {
    target, contact, busy: false, mediaLive: false,
    request: async <T,>() => ({item: contact}) as T,
    run: async action => {await action(); return true;},
    onClose: () => {}, onCall: () => {}, onSms: () => {}, onCreateContact: () => {},
  });
  try {
    await act(async () => {renderer = create(view(original)); await flush();});
    assert.ok(button(renderer!, '屏蔽此号码'));
    await act(async () => {renderer!.update(view(current)); await flush();});
    assert.ok(button(renderer!, '解除屏蔽'), 'the newer contact wins over the stale opener annotation');
  } finally {
    renderer?.unmount();
  }
});

test('a known contact shows its name, numbers, emails and address instead of 新建联系人', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(requestPath: string): Promise<T> => {
      if (requestPath === '/contacts/c-1') return {item: zhang} as T;
      return {} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          target: {remoteNumber: '2025550117', simId: 'sim-1', contactName: '张三', contactId: 'c-1'},
          busy: false,
          mediaLive: true,
          request,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {},
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /张三/);
    assert.match(text, /云图科技/);
    assert.match(text, /202 555 0117/);
    assert.match(text, /202-555-0199/);
    assert.match(text, /zhang@example.com/);
    assert.match(text, /广东省深圳市和平路 12 号/);
    assert.match(text, /手机/, 'labels are shown in Chinese');
    assert.equal(button(renderer!, '拨打电话')!.props.disabled, true, 'a live call blocks a second outbound call');
    assert.equal(button(renderer!, '发送短信')!.props.disabled, false, 'SMS stays available during a call');
    assert.equal(
      renderer!.root.findAll(node => node.type === 'button' && collectText(node) === '新建联系人').length,
      0,
      'a number that already belongs to a contact is not created again',
    );
  } finally {
    renderer?.unmount();
  }
});

test('添加到现有联系人 lists contacts and attaches the number to the chosen one', async () => {
  const {ContactCard} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; body?: unknown}[] = [];
    const request = async <T,>(requestPath: string, body?: unknown): Promise<T> => {
      calls.push({path: requestPath, body});
      if (requestPath.startsWith('/contacts/lookup')) return {item: null} as T;
      if (requestPath.startsWith('/contacts?')) return {items: [zhang, {id: 'c-2', displayName: '李四'}]} as T;
      return {} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          target: {remoteNumber: '2025550111', simId: 'sim-1'},
          busy: false,
          mediaLive: false,
          request,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {},
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    await act(async () => {
      button(renderer!, '添加到现有联系人')!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /李四/);

    const search = renderer!.root.findAllByType('input')[0]!;
    await act(async () => {
      search.props.onChange({target: {value: '张'}});
    });
    assert.doesNotMatch(collectText(renderer!.toJSON()), /李四/, 'the picker filters as you type');

    await act(async () => {
      renderer!.root.findAll(node => node.props?.className === 'contact-picker-row')[0]!.props.onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(
      calls.filter(call => call.path === '/contacts/c-1/phones'),
      [{path: '/contacts/c-1/phones', body: {rawNumber: '2025550111'}}],
    );
    assert.match(collectText(renderer!.toJSON()), /已把此号码加入「张三」/);
  } finally {
    renderer?.unmount();
  }
});

test('删除 from a 通讯录 card needs a confirmation, sends the CAS delete, then closes and reports', async () => {
  const {ContactCard} = await harness();
  const contact: ContactDto = {
    id: 'c-9',
    version: 7,
    displayName: '待删联系人',
    phones: [{id: 'p-1', rawNumber: '2025550111', label: 'mobile'}],
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; method?: string; body?: unknown}[] = [];
    let closed = 0;
    let changed = 0;
    const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
      calls.push({path: requestPath, method, body});
      return {} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          target: {remoteNumber: '2025550111', simId: 'sim-1', contactId: 'c-9'},
          contact,
          busy: false,
          mediaLive: false,
          request,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {
            closed++;
          },
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
          onEdit: () => {},
          onChanged: () => {
            changed++;
          },
        }),
      );
      await flush();
    });
    await act(async () => {
      button(renderer!, '删除')!.props.onClick();
    });
    assert.match(collectText(renderer!.toJSON()), /删除此联系人/);
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 0, 'the prompt alone sends nothing');
    await act(async () => {
      button(renderer!, '确认删除')!.props.onClick();
      await flush();
    });
    assert.deepEqual(
      calls.filter(call => call.method === 'DELETE'),
      [{path: '/contacts/c-9?expectedVersion=7', method: 'DELETE', body: undefined}],
    );
    assert.equal(closed, 1, 'a successful delete closes the card');
    assert.equal(changed, 1, 'a successful delete tells the opener to reload');
  } finally {
    renderer?.unmount();
  }
});

test('a delete conflict keeps the card open with a notice and the delete action available again', async () => {
  const {ContactCard} = await harness();
  const contact: ContactDto = {
    id: 'c-10',
    version: 7,
    displayName: '并发联系人',
    phones: [{id: 'p-1', rawNumber: '2025550111', label: 'mobile'}],
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    let closed = 0;
    const request = async <T,>(requestPath: string, _body?: unknown, method?: string): Promise<T> => {
      if (method === 'DELETE') throw Object.assign(new Error('stale'), {status: 409, code: 'CONTACT_VERSION_CONFLICT'});
      return {} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactCard, {
          target: {remoteNumber: '2025550111', simId: 'sim-1', contactId: 'c-10'},
          contact,
          busy: false,
          mediaLive: false,
          request,
          run: async action => {
            await action();
            return true;
          },
          onClose: () => {
            closed++;
          },
          onCall: () => {},
          onSms: () => {},
          onCreateContact: () => {},
          onEdit: () => {},
        }),
      );
      await flush();
    });
    await act(async () => {
      button(renderer!, '删除')!.props.onClick();
    });
    await act(async () => {
      button(renderer!, '确认删除')!.props.onClick();
      await flush();
    });
    assert.equal(closed, 0, 'a conflicted delete keeps the card open');
    assert.match(collectText(renderer!.toJSON()), /未执行删除/);
    assert.ok(button(renderer!, '删除'), 'the delete action is available again after the conflict');
  } finally {
    renderer?.unmount();
  }
});
