import { PerformanceObserver } from 'node:perf_hooks';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createVoiceAgent } from './providers/index.mjs';
import { transferableBytes } from './pcm-pipeline.mjs';

/**
 * S24 决策 2 — the provider side of the thread boundary.
 *
 * Everything expensive about a realtime provider session lives here: the WebSocket, `JSON.parse`
 * of every provider frame, base64 decode of every audio delta and base64 encode of every 100 ms
 * caller batch. On relay-primary that work shared one event loop with `audio-bridge.tick()`, whose 5 ms
 * monotonic pacing is the only thing keeping the RTP timestamps honest — production measured
 * 54–162 `paceStalls` per call and an event-loop p99 of 57–72 ms. The main thread now keeps only
 * the wrtc objects (which cannot cross a thread), the pacing, and Control I/O.
 *
 * The agent's event contract is unchanged on the far side of the port: payload fields are the
 * adapter's own, PCM travels as a transferable `ArrayBuffer`, and `outputGeneration` rides along
 * on every message so the proxy's copy is never stale when the bridge reads it.
 */

/** Adapter events forwarded verbatim. `audio` is handled separately because it carries PCM. */
const FORWARDED = ['flushAudio', 'completed', 'transcript', 'notice', 'speechStarted', 'response', 'closed'];

/**
 * S27 决策 5: how long this thread stays alive after `stop()` so an adapter that has to say goodbye
 * on the wire can finish saying it. Deliberately below `provider-proxy.mjs`'s `TERMINATE_GRACE_MS`
 * (500 ms): the proxy's terminate is the outer bound and must never be the thing that fires first.
 */
const STOP_CLOSE_WAIT_MS = 300;

/**
 * Binds one already-constructed agent to one `MessagePort`. Exported so the proxy can be tested
 * over a `MessageChannel` without paying for a real thread, and so the entry point below is three
 * lines that cannot drift from what the tests cover.
 */
export function serveVoiceAgent(port, agent, { onClosed = () => {}, gcReportMs = 2_000 } = {}) {
  let finished = false, stopping = false;
  const gen = () => (Number.isSafeInteger(agent.outputGeneration) ? agent.outputGeneration : 0);
  const post = (message, transfer) => { if (!finished) try { port.postMessage({ ...message, gen: gen() }, transfer); } catch {} };

  // R7 §2(d): a `gc` PerformanceObserver only ever sees its own isolate. The main thread's `gc` in
  // `run_closed` is the pacing thread's, which is the number the acceptance target is about; this
  // one says whether the provider's JSON and base64 merely moved their pauses somewhere else.
  // It is reported on a timer as well as at the end because the run's log line is written on the
  // main thread and must not have to wait for a dying thread's last message.
  const gc = { count: 0, totalMs: 0, maxMs: 0 };
  const gcObserver = (() => {
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          gc.count += 1;
          gc.totalMs = Math.round((gc.totalMs + entry.duration) * 10) / 10;
          if (entry.duration > gc.maxMs) gc.maxMs = Math.round(entry.duration * 10) / 10;
        }
      });
      observer.observe({ entryTypes: ['gc'] });
      return observer;
    } catch { return null; }
  })();
  const reportGc = () => { if (gcObserver) post({ t: 'gc', gc: { ...gc } }); };
  const gcTimer = gcObserver ? setInterval(reportGc, gcReportMs) : null;
  gcTimer?.unref?.();
  // Provider text never reaches a log line; the proxy re-raises a bounded message as an Error.
  // S69: `name`/`code` cross too, so the worker can log `provider_fault {errorName, code}` without the message.
  const faulted = error => post({ t: 'ev', name: 'fault', payload: { message: String(error?.message ?? error).slice(0, 500), name: String(error?.name ?? 'Error').slice(0, 64),
    ...(error?.code != null ? { code: String(error.code).slice(0, 80) } : {}) } });

  const listeners = FORWARDED.map(name => {
    const handler = payload => post({ t: 'ev', name, payload: payload ?? {} });
    agent.on(name, handler);
    return [name, handler];
  });
  const onAudio = data => {
    const bytes = transferableBytes(data.pcm);
    post({ t: 'pcm', pcm: bytes, sampleRate: data.sampleRate, responseId: data.responseId, generation: data.generation }, [bytes]);
  };
  agent.on('audio', onAudio);
  const onFault = error => faulted(error);
  agent.on('fault', onFault);

  const finish = () => {
    if (finished) return;
    reportGc();
    finished = true;
    clearInterval(gcTimer);
    try { gcObserver?.disconnect(); } catch {}
    for (const [name, handler] of listeners) agent.off(name, handler);
    agent.off('audio', onAudio); agent.off('fault', onFault);
    try { port.close(); } catch {}
    onClosed();
  };

  port.on('message', message => {
    if (finished) return;
    try {
      switch (message?.t) {
        case 'start':
          // No AbortSignal crosses the port: the proxy turns an abort into `stop`, which is the
          // same terminal path the adapter takes for a signal it owns itself.
          agent.start().then(info => post({ t: 'started', info: info ?? null }), error => {
            post({ t: 'startFailed', message: String(error?.message ?? error).slice(0, 500) });
            try { agent.stop(); } catch {}
            finish();
          });
          break;
        case 'greet': agent.greet(); break;
        case 'audio': agent.appendAudio(Buffer.from(message.pcm), { sampleRate: message.sampleRate, sequence: message.sequence }); break;
        case 'interrupt': agent.interrupt({ sendCancel: message.sendCancel !== false }); break;
        case 'transcription': agent.requestInputTranscription(); break;
        case 'stop': {
          if (stopping) break;
          stopping = true;
          // S27 决策 5: 豆包要求先发 `session.close`、收到 `session.closed` 再断 WebSocket，
          // 否则服务端记 55000001 ContextCanceled（R11 §6.2）。`finish()` 会触发线程入口的
          // `process.exit(0)`，立刻收尾就等于在那一帧写出去之前杀掉 isolate。所以这里等适配器
          // 自己的 `closed`，上限 STOP_CLOSE_WAIT_MS——必须小于 proxy 的 TERMINATE_GRACE_MS。
          // 先把 GC 统计发出去，`run_closed` 不必等这段收尾。
          reportGc();
          let timer;
          const end = () => { clearTimeout(timer); agent.off('closed', end); finish(); };
          timer = setTimeout(end, STOP_CLOSE_WAIT_MS);
          timer.unref?.();
          agent.once('closed', end);
          try { agent.stop(); } catch {}
          break;
        }
        default: break;
      }
    } catch (error) {
      // `appendAudio` throws synchronously on a replayed sequence or a malformed batch (since S27
      // no longer on upstream backpressure, which only drops that batch). In a thread
      // an uncaught throw here would kill the isolate mid-call; it becomes a fault instead, which
      // is the same outcome the single-threaded worker produced.
      faulted(error);
      try { agent.stop(); } catch {}
    }
  });
  port.start?.();
  return finish;
}

/* c8 ignore start — thread entry: exercised by the real-thread test, not reachable in-process. */
if (!isMainThread && parentPort && workerData?.kind === 'voice-provider') {
  const agent = createVoiceAgent({ provider: workerData.provider, config: workerData.config });
  // A per-run thread must be able to end: once the session is finished nothing else keeps this
  // isolate alive, and an exit code of 0 is how the proxy tells a clean close from a crash.
  serveVoiceAgent(parentPort, agent, { onClosed: () => { process.exit(0); } });
}
/* c8 ignore stop */
