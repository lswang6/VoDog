import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}
function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === 'button' && collectText(node).includes(label))[0]!;
}

let server: ViteDevServer | undefined;
async function load<T>(entry: string): Promise<T> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await server.ssrLoadModule(entry)) as T;
}
after(async () => {
  await server?.close();
  server = undefined;
});

test('clampPage keeps every page number inside 1..totalPages and PAGE_SIZES is 50/100/200', async () => {
  const {clampPage, PAGE_SIZES, DEFAULT_PAGE_SIZE, normalizePageSize} =
    await load<typeof import('../src/pager.tsx')>('/src/pager.tsx');

  assert.deepEqual([...PAGE_SIZES], [50, 100, 200]);
  assert.equal(DEFAULT_PAGE_SIZE, 50);
  assert.equal(clampPage(1, 7), 1);
  assert.equal(clampPage(4, 7), 4);
  assert.equal(clampPage(9, 7), 7, 'past the end lands on the last page');
  assert.equal(clampPage(0, 7), 1);
  assert.equal(clampPage(-3, 7), 1);
  assert.equal(clampPage(2.8, 7), 2, 'a fractional input truncates rather than rounding up past the end');
  assert.equal(clampPage(Number.NaN, 7), 1);
  assert.equal(clampPage(3, 0), 1, 'an empty result set still has page 1');

  assert.equal(normalizePageSize('100'), 100);
  assert.equal(normalizePageSize(200), 200);
  assert.equal(normalizePageSize(75), 50, 'an unsupported size falls back to the default');
  assert.equal(normalizePageSize(undefined), 50);
});

test('the pager disables the bounds, states the window and offers the three page sizes', async () => {
  const {Pager} = await load<typeof import('../src/pager.tsx')>('/src/pager.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    const pages: number[] = [];
    const sizes: number[] = [];
    await act(async () => {
      renderer = create(
        React.createElement(Pager, {
          page: 1,
          pageSize: 50,
          total: 137,
          totalPages: 3,
          onPageChange: value => pages.push(value),
          onPageSizeChange: value => sizes.push(value),
        }),
      );
    });
    assert.equal(renderer!.root.findByType('nav').props['aria-label'], '分页');
    assert.match(collectText(renderer!.toJSON()), /第 1 \/ 3 页 · 共 137 条/);

    assert.equal(findButton(renderer!, '首页').props.disabled, true, 'page 1 cannot go back');
    assert.equal(findButton(renderer!, '上一页').props.disabled, true);
    assert.equal(findButton(renderer!, '下一页').props.disabled, false);
    assert.equal(findButton(renderer!, '末页').props.disabled, false);

    await act(async () => {
      findButton(renderer!, '下一页').props.onClick();
    });
    await act(async () => {
      findButton(renderer!, '末页').props.onClick();
    });
    assert.deepEqual(pages, [2, 3]);

    const select = renderer!.root.findByType('select');
    assert.equal(select.props['aria-label'], '每页条数');
    assert.deepEqual(
      renderer!.root.findAllByType('option').map(option => option.props.value),
      [50, 100, 200],
    );
    await act(async () => {
      select.props.onChange({target: {value: '200'}});
    });
    assert.deepEqual(sizes, [200]);

    // The last page disables the forward controls instead of hiding them.
    await act(async () => {
      renderer!.update(
        React.createElement(Pager, {
          page: 3,
          pageSize: 50,
          total: 137,
          totalPages: 3,
          onPageChange: value => pages.push(value),
          onPageSizeChange: value => sizes.push(value),
        }),
      );
    });
    assert.equal(findButton(renderer!, '下一页').props.disabled, true);
    assert.equal(findButton(renderer!, '末页').props.disabled, true);
    assert.equal(findButton(renderer!, '首页').props.disabled, false);
    assert.equal(findButton(renderer!, '上一页').props.disabled, false);
  } finally {
    renderer?.unmount();
  }
});

test('every control is disabled while the page is loading', async () => {
  const {Pager} = await load<typeof import('../src/pager.tsx')>('/src/pager.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        React.createElement(Pager, {
          page: 2,
          pageSize: 50,
          total: 137,
          totalPages: 3,
          busy: true,
          onPageChange: () => {},
          onPageSizeChange: () => {},
        }),
      );
    });
    for (const label of ['首页', '上一页', '下一页', '末页', '跳转']) {
      assert.equal(findButton(renderer!, label).props.disabled, true, `${label} waits for the page in flight`);
    }
    assert.equal(renderer!.root.findByType('select').props.disabled, true);
    assert.equal(renderer!.root.findByType('input').props.disabled, true);
  } finally {
    renderer?.unmount();
  }
});

test('跳转 clamps the typed page, writes the clamped value back and ignores an empty box', async () => {
  const {Pager} = await load<typeof import('../src/pager.tsx')>('/src/pager.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    const pages: number[] = [];
    const element = (page: number) =>
      React.createElement(Pager, {
        page,
        pageSize: 50,
        total: 137,
        totalPages: 3,
        onPageChange: (value: number) => pages.push(value),
        onPageSizeChange: () => {},
      });
    await act(async () => {
      renderer = create(element(1));
    });
    const form = renderer!.root.findByType('form');
    const input = () => renderer!.root.findByType('input');
    assert.equal(input().props.min, 1);
    assert.equal(input().props.max, 3);
    assert.equal(input().props.inputMode, 'numeric');

    let prevented = 0;
    await act(async () => {
      form.props.onSubmit({preventDefault: () => {prevented += 1;}});
    });
    assert.equal(prevented, 1, 'the form never reloads the page');
    assert.deepEqual(pages, [], 'an empty box is a no-op');

    await act(async () => {
      input().props.onChange({target: {value: '99'}});
    });
    await act(async () => {
      form.props.onSubmit({preventDefault: () => {}});
    });
    assert.deepEqual(pages, [3], '99 clamps to the last page');
    assert.equal(input().props.value, '3', 'the box shows the page it actually jumped to');

    // The owner moved to page 3; jumping below the first page must now come back to 1.
    await act(async () => {
      renderer!.update(element(3));
    });
    await act(async () => {
      input().props.onChange({target: {value: '0'}});
    });
    await act(async () => {
      form.props.onSubmit({preventDefault: () => {}});
    });
    assert.deepEqual(pages, [3, 1], '0 clamps to the first page');
  } finally {
    renderer?.unmount();
  }
});

test('a server that never sent totalPages gets no pager at all', async () => {
  const {Pager} = await load<typeof import('../src/pager.tsx')>('/src/pager.tsx');
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        React.createElement(Pager, {
          page: 1,
          pageSize: 50,
          onPageChange: () => {},
          onPageSizeChange: () => {},
        }),
      );
    });
    assert.equal(renderer!.toJSON(), null);
  } finally {
    renderer?.unmount();
  }
});

test('clientPage slices an already-loaded list and clamps a stale page to the last page', async () => {
  const {clientPage} = await load<typeof import('../src/pager.tsx')>('/src/pager.tsx');
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  assert.deepEqual(clientPage(items, 1, 4), {items: [1, 2, 3, 4], page: 1, totalPages: 3});
  assert.deepEqual(clientPage(items, 2, 4), {items: [5, 6, 7, 8], page: 2, totalPages: 3});
  assert.deepEqual(clientPage(items, 3, 4), {items: [9, 10], page: 3, totalPages: 3});
  assert.deepEqual(
    clientPage(items, 99, 4),
    {items: [9, 10], page: 3, totalPages: 3},
    'a page beyond the end lands on the last page instead of an empty slice',
  );
  assert.deepEqual(clientPage(items, 0, 4), {items: [1, 2, 3, 4], page: 1, totalPages: 3});
  assert.deepEqual(clientPage([], 1, 4), {items: [], page: 1, totalPages: 1}, 'an empty list still has page 1');
  assert.deepEqual(
    clientPage(items, 1, 0),
    {items: [1], page: 1, totalPages: 10},
    'a zero page size falls back to one item per page',
  );
});
