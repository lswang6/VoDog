import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {ContactDto, ContactImportEntry} from '../src/contacts.ts';

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
function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}
function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === 'button' && collectText(node).trim() === label)[0];
}
/** The panel only needs `text()`, so a plain object stands in for a picked File. */
function vcfFile(text: string) {
  return {text: async () => text};
}

let server: ViteDevServer | undefined;
async function harness() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await server.ssrLoadModule('/src/contacts-panel.tsx')) as typeof import('../src/contacts-panel.tsx');
}
after(async () => {
  await server?.close();
  server = undefined;
});

const stored: ContactDto[] = [
  {
    id: 'c-1',
    displayName: '张三',
    phones: [{id: 'p-1', rawNumber: '202 555 0117', label: 'mobile'}],
    blocked: true,
  },
  // An old server may omit the whole optional block; the row must still render.
  {id: 'c-2', displayName: '李四'},
];

test('the 通讯录 list shows names, primary numbers and the blocked badge, and searches on the server', async () => {
  const {ContactsPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const paths: string[] = [];
    const request = async <T,>(requestPath: string): Promise<T> => {
      paths.push(requestPath);
      return {items: stored} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactsPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const text = collectText(renderer!.toJSON());
    assert.match(text, /张三/);
    assert.match(text, /手机 202 555 0117/);
    assert.match(text, /已屏蔽/);
    assert.match(text, /李四/);
    assert.match(text, /无号码/, 'a contact without phones or emails still says so');
    assert.deepEqual(paths, ['/contacts?limit=200']);

    const search = renderer!.root.findAll(node => node.type === 'input' && node.props.type === 'search')[0]!;
    await act(async () => {
      search.props.onChange({target: {value: '张'}});
    });
    assert.deepEqual(paths, ['/contacts?limit=200'], 'typing does not fire a request per keystroke');
    await act(async () => {
      await sleep(320);
      await flush();
    });
    assert.deepEqual(paths, ['/contacts?limit=200', '/contacts?limit=200&query=%E5%BC%A0']);
  } finally {
    renderer?.unmount();
  }
});

test('a .vcf file is parsed in the browser, uploaded as web_vcard and summarised', async () => {
  const {ContactsPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const posts: {source: string; contacts: ContactImportEntry[]}[] = [];
    let listReads = 0;
    const request = async <T,>(requestPath: string, body?: unknown): Promise<T> => {
      if (requestPath === '/contacts/import') {
        const payload = body as {source: string; contacts: ContactImportEntry[]};
        posts.push(payload);
        return {total: payload.contacts.length, created: 2, updated: 0, merged: 0, skipped: 0, phonesSkipped: 1} as T;
      }
      listReads++;
      return {items: stored} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactsPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const before = listReads;
    const fileField = renderer!.root.findAll(node => node.type === 'input' && node.props.type === 'file')[0]!;
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E5=BC=A0;=E4=B8=89;;;',
      'TEL;CELL:2025550111',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Jane Doe',
      'TEL;TYPE=WORK:+15550100',
      'EMAIL:jane@example.com',
      'END:VCARD',
    ].join('\r\n');
    await act(async () => {
      fileField.props.onChange({target: {files: [vcfFile(vcf)]}});
    });
    await act(async () => {
      await flush();
      await flush();
    });
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.source, 'web_vcard');
    assert.deepEqual(posts[0]!.contacts, [
      {
        displayName: '张三',
        familyName: '张',
        givenName: '三',
        phones: [{rawNumber: '2025550111', label: 'mobile'}],
        emails: [],
        addresses: [],
      },
      {
        displayName: 'Jane Doe',
        phones: [{rawNumber: '+15550100', label: 'work'}],
        emails: [{address: 'jane@example.com'}],
        addresses: [],
      },
    ]);
    assert.match(collectText(renderer!.toJSON()), /导入完成：共 2 条 · 新增 2 · 更新 0 · 合并 0 · 跳过 0 · 忽略号码 1/);
    assert.ok(listReads > before, 'the list reloads once the import finished');
  } finally {
    renderer?.unmount();
  }
});

test('a large export is uploaded in batches and the counts are summed', async () => {
  const {ContactsPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const sizes: number[] = [];
    const request = async <T,>(requestPath: string, body?: unknown): Promise<T> => {
      if (requestPath === '/contacts/import') {
        const payload = body as {contacts: ContactImportEntry[]};
        sizes.push(payload.contacts.length);
        return {total: payload.contacts.length, created: payload.contacts.length} as T;
      }
      return {items: []} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactsPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const cards = Array.from({length: 620}, (_value, index) =>
      ['BEGIN:VCARD', 'VERSION:3.0', `FN:联系人 ${index}`, `TEL;TYPE=CELL:1380013${String(index).padStart(4, '0')}`, 'END:VCARD'].join('\r\n'),
    ).join('\r\n');
    const fileField = renderer!.root.findAll(node => node.type === 'input' && node.props.type === 'file')[0]!;
    await act(async () => {
      fileField.props.onChange({target: {files: [vcfFile(cards)]}});
    });
    await act(async () => {
      for (let tick = 0; tick < 6; tick++) await flush();
    });
    assert.deepEqual(sizes, [500, 120], 'one request per batch, none above the contract cap');
    assert.match(collectText(renderer!.toJSON()), /共 620 条 · 新增 620/);
  } finally {
    renderer?.unmount();
  }
});

test('a contact can be created by hand', async () => {
  const {ContactsPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const calls: {path: string; method?: string; body?: unknown}[] = [];
    const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
      calls.push({path: requestPath, method, body});
      if (requestPath.startsWith('/contacts?')) return {items: stored} as T;
      return {} as T;
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactsPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
        }),
      );
    });
    await act(async () => {
      await flush();
    });

    await act(async () => {
      button(renderer!, '新建联系人')!.props.onClick();
    });
    const form = () => renderer!.root.findAllByType('form')[0]!;
    const fields = () => renderer!.root.findAllByType('input');
    await act(async () => {
      form().props.onSubmit({preventDefault() {}});
    });
    assert.match(collectText(renderer!.toJSON()), /请填写联系人姓名/);
    assert.equal(calls.filter(call => call.path === '/contacts').length, 0, 'an invalid draft never reaches the server');

    await act(async () => {
      fields()[0]!.props.onChange({target: {value: '王五'}});
    });
    await act(async () => {
      form().props.onSubmit({preventDefault() {}});
    });
    assert.match(collectText(renderer!.toJSON()), /请至少填写一个电话或邮箱/);

    await act(async () => {
      fields().find(field => field.props['aria-label'] === '电话 1')!.props.onChange({target: {value: ' 2025550108 '}});
    });
    await act(async () => {
      form().props.onSubmit({preventDefault() {}});
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(
      calls.filter(call => call.path === '/contacts'),
      [
        // `source` is set by the server for manual creates and is not part of the accepted body.
        {
          path: '/contacts',
          method: undefined,
          body: {displayName: '王五', phones: [{rawNumber: '2025550108'}], emails: [], addresses: []},
        },
      ],
    );
  } finally {
    renderer?.unmount();
  }
});

test('removing one phone, email and address is draft-only and the CAS save keeps every other row', async () => {
  const {ContactsPanel} = await harness();
  const original: ContactDto = {
    id: 'remove-rows', version: 7, displayName: '林小美', givenName: '小美', familyName: '林',
    organization: '原公司', notes: '保留备注',
    phones: [
      {rawNumber: '2025550128', label: '旧号码'},
      {rawNumber: '2025550129', label: '保留号码'},
    ],
    emails: [
      {address: 'old@example.test', label: '旧邮箱'},
      {address: 'keep@example.test', label: '保留邮箱'},
    ],
    addresses: [
      {formatted: '旧地址', label: '旧'},
      {formatted: '台北市信义路 2 号', label: '保留', city: '台北市'},
    ],
  };
  let saved: unknown;
  const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
    if (requestPath.startsWith('/contacts?')) return {items: [original]} as T;
    if (requestPath === '/contacts/remove-rows' && method === 'PUT') {
      saved = body;
      return {item: original} as T;
    }
    throw new Error(`unexpected ${method || 'GET'} ${requestPath}`);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(ContactsPanel, {busy: false, run: async action => {await action(); return true;}, request, editFor: {contact: original, token: 1}}));
      await flush();
    });
    const remove = (label: string) => renderer!.root.findAll(node => node.type === 'button' && node.props['aria-label'] === label)[0]!;
    for (const label of ['移除电话 1', '移除邮箱 1', '移除地址 1']) {
      assert.match(remove(label).props.className,/\bcontact-field-remove\b/);
      assert.doesNotMatch(remove(label).props.className,/\bhangup\b/,`${label} is a quiet draft-only action, not final deletion`);
      await act(async () => remove(label).props.onClick());
    }
    assert.equal(saved, undefined, 'removing rows only changes the local draft');
    await act(async () => renderer!.root.findByType('form').props.onSubmit({preventDefault() {}}));
    await act(async () => await flush());
    assert.deepEqual(saved, {
      expectedVersion: 7,
      displayName: '林小美', givenName: '小美', familyName: '林', organization: '原公司', notes: '保留备注',
      phones: [{rawNumber: '2025550129', label: '保留号码'}],
      emails: [{address: 'keep@example.test', label: '保留邮箱'}],
      addresses: [{formatted: '台北市信义路 2 号', label: '保留', city: '台北市'}],
    });
  } finally {
    renderer?.unmount();
  }
});

test('a Control without the 通讯录 routes shows a note instead of an error', async () => {
  const {ContactsPanel} = await harness();
  let renderer: ReactTestRenderer | undefined;
  try {
    const request = async <T,>(): Promise<T> => {
      throw Object.assign(new Error('请求失败 (404)'), {status: 404, code: 'HTTP_404'});
    };
    await act(async () => {
      renderer = create(
        React.createElement(ContactsPanel, {
          busy: false,
          run: async action => {
            await action();
            return true;
          },
          request,
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    assert.match(collectText(renderer!.toJSON()), /此服务器尚未启用通讯录功能。/);
    assert.equal(renderer!.root.findAll(node => node.props?.role === 'alert').length, 0);
  } finally {
    renderer?.unmount();
  }
});

test('a stale editor keeps its full draft and cannot overwrite until the user explicitly loads current data', async () => {
  const {ContactsPanel} = await harness();
  const original: ContactDto = {
    id: 'cas-1',
    version: 4,
    displayName: '王小明',
    givenName: '小明',
    familyName: '王',
    organization: '原公司',
    notes: '保留备注',
    phones: [{rawNumber: '2025550111', label: 'mobile'}],
    emails: [{address: 'wang@example.com', label: 'work'}],
    addresses: [{formatted: '台北市信义路 1 号', label: 'work', city: '台北市', street: '信义路 1 号'}],
  };
  const current: ContactDto = {...original, version: 5, organization: '其他设备的新公司'};
  const puts: unknown[] = [];
  let latestFailures = 1;
  const request = async <T,>(requestPath: string, body?: unknown, method?: string): Promise<T> => {
    if (requestPath.startsWith('/contacts?')) return {items: [original]} as T;
    if (requestPath === '/contacts/cas-1' && method === 'PUT') {
      puts.push(body);
      throw Object.assign(new Error('conflict'), {status: 409, code: 'CONTACT_VERSION_CONFLICT'});
    }
    if (requestPath === '/contacts/cas-1') {
      if (latestFailures-- > 0) throw new Error('offline');
      return {item: current} as T;
    }
    return {} as T;
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(ContactsPanel, {busy: false, run: async action => {await action(); return true;}, request, editFor: {contact: original, token: 1}}));
      await flush();
    });
    const company = () => renderer!.root.findAllByType('input').find(node => node.props.value === '原公司' || node.props.value === '我的公司' || node.props.value === '其他设备的新公司')!;
    await act(async () => company().props.onChange({target: {value: '我的公司'}}));
    await act(async () => renderer!.root.findByType('form').props.onSubmit({preventDefault() {}}));
    await act(async () => await flush());
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0], {
      expectedVersion: 4,
      displayName: '王小明',
      givenName: '小明',
      familyName: '王',
      organization: '我的公司',
      notes: '保留备注',
      phones: [{rawNumber: '2025550111', label: 'mobile'}],
      emails: [{address: 'wang@example.com', label: 'work'}],
      addresses: [{formatted: '台北市信义路 1 号', label: 'work', street: '信义路 1 号', city: '台北市'}],
    });
    assert.match(collectText(renderer!.toJSON()), /草稿和原版本已保留/);
    assert.equal(button(renderer!, '保存修改')!.props.disabled, true);
    await act(async () => renderer!.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.equal(puts.length, 1, 'repeated save cannot silently adopt the new version');
    await act(async () => {button(renderer!, '载入服务器最新内容（替换当前草稿）')!.props.onClick(); await flush();});
    assert.equal(company().props.value, '我的公司', 'failed current read keeps the dirty draft');
    assert.ok(button(renderer!, '载入服务器最新内容（替换当前草稿）'), 'the recovery action remains available');
    assert.match(collectText(renderer!.toJSON()), /暂时无法读取服务器最新内容/);
    await act(async () => {button(renderer!, '载入服务器最新内容（替换当前草稿）')!.props.onClick(); await flush();});
    assert.equal(company().props.value, '其他设备的新公司');
    assert.equal(button(renderer!, '保存修改')!.props.disabled, false);
  } finally {
    renderer?.unmount();
  }
});

