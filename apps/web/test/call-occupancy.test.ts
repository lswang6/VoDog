import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer} from 'vite';
import {
  AI_ANSWERING_LABEL,
  aiSuppressed,
  audibleRingingCall,
  callOccupancyLabel,
  callOwnerLabel,
  canReleaseOccupancy,
  gatewayOccupiedCall,
  isCurrentSessionOccupancy,
  occupancyNotice,
  offersAnswerControls,
  releaseConfirmLabel,
  releaseConfirmPrompt,
  type CallOccupancy,
  type OccupiableCall,
} from '../src/call-occupancy.ts';
import {CALL_REJECT_PROMPT, CALL_RELEASE_PROMPT} from '../src/confirm-copy.ts';

function occupancy(overrides: Partial<CallOccupancy> = {}): CallOccupancy {
  return {
    holdsLock: true,
    lockedSince: '2026-09-11T13:05:00.000Z',
    occupantPlatform: 'ios',
    occupantDevice: null,
    isCurrentSession: false,
    canRelease: true,
    ...overrides,
  };
}

function call(overrides: Partial<OccupiableCall> = {}): OccupiableCall {
  return {
    id: 'call-1',
    simId: 'sim-1',
    state: 'active',
    startedAt: '2026-09-11T13:00:00.000Z',
    gatewayTimeZone: 'Asia/Shanghai',
    ...overrides,
  };
}

const sims = [{id: 'sim-1', gatewayId: 'gateway-1'}, {id: 'sim-2', gatewayId: 'gateway-2'}];

test('occupant labels use the same Chinese copy as the Android client', () => {
  const platforms: [CallOccupancy['occupantPlatform'], string, string | null][] = [
    ['ios', 'iPhone 端通话', 'iPhone 端'],
    ['android', 'Android 端通话', 'Android 端'],
    ['macos', 'Mac 端通话', 'Mac 端'],
    ['web', '网页端通话', '网页端'],
    ['ai', 'AI 接听', 'AI 接听'],
    ['pixel', '手机通话中', '手机通话中'],
    [null, '处理另一通电话', null],
  ];
  for (const [platform, occupancyLabel, ownerLabel] of platforms) {
    const item = call({occupancy: occupancy({occupantPlatform: platform})});
    assert.equal(callOccupancyLabel(item), occupancyLabel);
    assert.equal(callOwnerLabel(item), ownerLabel);
  }
  assert.equal(callOwnerLabel(call({occupancy: occupancy({occupantDevice: ' 家里的 iPhone '})})), '家里的 iPhone');
  assert.equal(callOccupancyLabel(call({answeredByPlatform: 'android'})), 'Android 端通话', 'the legacy derivation still works');
  assert.equal(callOwnerLabel(call({originatingPlatform: 'web', answeredByDevice: 'Web 浏览器'})), 'Web 浏览器');
  // S38 三端合同：手机拨号盘直拨时占用条写「手机通话中」，行主体的「通过手机拨打」由列表自己给。
  assert.equal(callOccupancyLabel(call({originatingPlatform: 'pixel'})), '手机通话中');
  assert.match(occupancyNotice(call({occupancy: occupancy({occupantPlatform: 'pixel'})})), /^通话中 · 由 Pixel 接听 · 自 /);
  // S58：DJI 4G 模组直拨只换文字。
  assert.equal(callOccupancyLabel(call({originatingPlatform: 'pixel', gatewayKind: 'dji4g'})), 'DJI 4G 模组通话中');
  assert.equal(callOwnerLabel(call({originatingPlatform: 'pixel', gatewayKind: 'dji4g'})), 'DJI 4G 模组通话中');
});

test('suppression needs both ai mode and a live AI run, and timeout_ai keeps ringing', () => {
  const ringing = (overrides: Partial<OccupiableCall>) => call({state: 'incoming_ringing', ...overrides});
  assert.equal(aiSuppressed(ringing({answerMode: 'ai', aiHandling: true})), true);
  assert.equal(aiSuppressed(ringing({answerMode: 'timeout_ai', aiHandling: true})), false,
    'timeout_ai rings until the AI actually commits the answer (R2 §2.1)');
  assert.equal(aiSuppressed(ringing({answerMode: 'ai', aiHandling: false})), false,
    'a lost or failed run hands the call back to the humans');
  assert.equal(aiSuppressed(ringing({answerMode: 'ai'})), false);
  assert.equal(aiSuppressed(ringing({})), false, 'an older Control sends neither field and suppresses nothing');

  const suppressed = ringing({id: 'ai-call', answerMode: 'ai', aiHandling: true});
  const audible = ringing({id: 'human-call'});
  assert.equal(audibleRingingCall([suppressed]), undefined, 'the browser never rings for the AI');
  assert.equal(audibleRingingCall([suppressed, audible])?.id, 'human-call');
  assert.equal(audibleRingingCall([call({state: 'active'})]), undefined);
  assert.equal(offersAnswerControls(suppressed), false, '接听/拒接 are hidden while the AI answers');
  assert.equal(offersAnswerControls(audible), true);
  assert.equal(offersAnswerControls(call({state: 'active'})), false);
  assert.equal(AI_ANSWERING_LABEL, 'AI 接听中');
});

test('an AI-answered call names its occupant even before any platform is reported', () => {
  const suppressed = call({state: 'incoming_ringing', answerMode: 'ai', aiHandling: true});
  assert.equal(callOccupancyLabel(suppressed), 'AI 接听');
  assert.equal(callOwnerLabel(suppressed), 'AI 接听');
  assert.equal(
    callOccupancyLabel(call({state: 'incoming_ringing', answerMode: 'ai', aiHandling: true, occupancy: occupancy({occupantPlatform: null})})),
    'AI 接听',
    'an occupancy block without a platform still resolves to the AI',
  );
  assert.equal(
    callOccupancyLabel(call({state: 'incoming_ringing', answerMode: 'timeout_ai', aiHandling: true})),
    '处理另一通电话',
    'a timeout_ai call waiting for its human is not labelled AI',
  );
  assert.equal(
    callOccupancyLabel(call({answerMode: 'ai', aiHandling: true, occupancy: occupancy({occupantPlatform: 'web'})})),
    '网页端通话',
    'a reported platform always wins over the fallback',
  );
});

test('the occupancy notice reports the occupant and the lock time', () => {
  assert.equal(
    occupancyNotice(call({occupancy: occupancy()})),
    '通话中 · 由 iPhone 端 接听 · 自 2026-09-11 21:05',
  );
  assert.equal(
    occupancyNotice(call({occupancy: occupancy({lockedSince: null, occupantPlatform: null})})),
    '通话中 · 自 2026-09-11 21:00',
    'a missing lock time falls back to the call start and an unknown platform to the generic copy',
  );
  assert.equal(
    occupancyNotice(call({occupancy: occupancy({isCurrentSession: true})}), {currentSessionLabel: 'lswang · 当前浏览器'}),
    '通话中 · 由 lswang · 当前浏览器 接听 · 自 2026-09-11 21:05',
  );
  // S72 A4/B5：设备本机、呼出、振铃与内部通话。
  assert.equal(occupancyNotice(call({occupancy: occupancy({occupantPlatform: 'device'})})), '通话中 · 由 网关本机 接听 · 自 2026-09-11 21:05');
  assert.equal(occupancyNotice(call({direction: 'outgoing', occupancy: occupancy({occupantPlatform: 'web'})})), '通话中 · 由 网页端 拨出 · 自 2026-09-11 21:05');
  assert.equal(occupancyNotice(call({state: 'incoming_ringing', occupancy: occupancy({occupantPlatform: null})})), '来电振铃 · 自 2026-09-11 21:05');
  assert.equal(
    occupancyNotice(call({direction: 'incoming', internal: true, peerSimLabel: '联通186', occupancy: occupancy({occupantPlatform: 'macos'})}), {simLabel: '电信133'}),
    '内部通话 · 联通186 → 电信133 · 由 Mac 端 接听 · 自 2026-09-11 21:05',
  );
  assert.equal(
    occupancyNotice(call({direction: 'outgoing', internal: true, peerSimLabel: '电信133', occupancy: occupancy()}), {simLabel: '联通186'}),
    '内部通话 · 联通186 → 电信133 · 由 iPhone 端 拨出 · 自 2026-09-11 21:05',
  );
  assert.equal(isCurrentSessionOccupancy(call({claimedByCurrentSession: true})), true);
  assert.equal(isCurrentSessionOccupancy(call({claimedByCurrentSession: true, occupancy: occupancy()})), false, 'the server verdict wins');
});

test('gateway occupancy follows the server lock and falls back to the call state', () => {
  const ended = call({id: 'ended', state: 'ended', occupancy: occupancy({holdsLock: false})});
  const live = call({id: 'live', occupancy: occupancy()});
  assert.equal(gatewayOccupiedCall([ended, live], sims, 'gateway-1')?.id, 'live');
  assert.equal(gatewayOccupiedCall([call({id: 'stale', occupancy: occupancy({holdsLock: false})})], sims, 'gateway-1'), undefined,
    'a call that no longer holds the lock does not occupy the gateway');
  assert.equal(gatewayOccupiedCall([call({id: 'ringing', state: 'incoming_ringing'})], sims, 'gateway-1')?.id, 'ringing',
    'without occupancy the browser keeps counting a ringing call as occupied');
  assert.equal(gatewayOccupiedCall([call({id: 'done', state: 'failed'})], sims, 'gateway-1'), undefined);
  assert.equal(gatewayOccupiedCall([live], sims, 'gateway-2'), undefined, 'another gateway is unaffected');
  assert.equal(gatewayOccupiedCall([live], sims, undefined), undefined);
});

test('releasing is offered only for another session and carries the right confirmation', () => {
  assert.equal(canReleaseOccupancy(call({occupancy: occupancy()})), true);
  assert.equal(canReleaseOccupancy(call({occupancy: occupancy({isCurrentSession: true})})), false, 'this session uses 停止通话');
  assert.equal(canReleaseOccupancy(call({occupancy: occupancy({canRelease: false})})), false);
  assert.equal(canReleaseOccupancy(call()), false, 'an older server offers no release entry');
  assert.equal(releaseConfirmPrompt(call()), CALL_RELEASE_PROMPT);
  assert.match(releaseConfirmPrompt(call()), /将挂断本账号在另一台设备上的通话/);
  assert.equal(releaseConfirmPrompt(call({state: 'incoming_ringing'})), CALL_REJECT_PROMPT);
  assert.match(releaseConfirmPrompt(call({state: 'incoming_ringing'})), /拒接/);
  assert.equal(releaseConfirmLabel(call()), '确认结束');
  assert.equal(releaseConfirmLabel(call({state: 'incoming_ringing'})), '确认拒接');
});

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}
function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === 'button' && collectText(node).includes(label))[0];
}

test('the occupancy panel shows 结束该通话 only when this account may end another device call', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const vite = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  try {
    const {OccupancyNotice} = await vite.ssrLoadModule('/src/occupancy-notice.tsx') as typeof import('../src/occupancy-notice.tsx');
    const released: string[] = [];
    const render = async (item: OccupiableCall) => {
      renderer?.unmount();
      await act(async () => {
        renderer = create(React.createElement(OccupancyNotice, {
          call: item,
          timeZone: 'Asia/Shanghai',
          currentSessionLabel: 'lswang · 当前浏览器',
          busy: false,
          onRelease: () => {released.push(item.id);},
        }));
      });
      return collectText(renderer!.toJSON());
    };

    assert.match(await render(call({occupancy: occupancy({occupantPlatform: 'android'})})), /通话中 · 由 Android 端 接听 · 自 2026-09-11 21:05/);
    assert.ok(findButton(renderer!, '结束该通话'), 'another session with canRelease offers the entry');
    assert.match(findButton(renderer!, '结束该通话')!.props.className,/\bhangup\b/);

    assert.equal(findButton(await render(call({occupancy: occupancy({isCurrentSession: true})})) && renderer!, '结束该通话'), undefined,
      'this session never gets the release entry');
    assert.equal(findButton(await render(call({occupancy: occupancy({canRelease: false})})) && renderer!, '结束该通话'), undefined);
    assert.equal(findButton(await render(call()) && renderer!, '结束该通话'), undefined, 'an older server renders the notice alone');

    await render(call({id: 'ringing-1', state: 'incoming_ringing', occupancy: occupancy()}));
    await act(async () => {findButton(renderer!, '结束该通话')!.props.onClick();});
    assert.match(collectText(renderer!.toJSON()), new RegExp(CALL_REJECT_PROMPT));
    await act(async () => {findButton(renderer!, '取消')!.props.onClick();});
    assert.deepEqual(released, [], 'cancelling never ends the call');

    await render(call({id: 'active-1', occupancy: occupancy()}));
    await act(async () => {findButton(renderer!, '结束该通话')!.props.onClick();});
    assert.match(collectText(renderer!.toJSON()), new RegExp(CALL_RELEASE_PROMPT));
    await act(async () => {findButton(renderer!, '确认结束')!.props.onClick();});
    assert.deepEqual(released, ['active-1']);
  } finally {
    renderer?.unmount();
    await vite.close();
  }
});
