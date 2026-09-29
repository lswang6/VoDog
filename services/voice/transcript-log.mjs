const MAX_TEXT = 16_384;
const MAX_BUFFERS = 50;

/**
 * S27: a provider closes every intermediate final with a full stop and rewrites it into a comma when
 * the sentence turns out to continue — run 0407de3e reported "呃，请记下号码。" then "呃，请记下号码，
 * 388。" then "呃，请记下号码，388665。". Compared literally those are not prefixes, so a sentence read
 * across pauses split into a row per revision no matter how long it was held. Trailing punctuation is
 * therefore not part of the utterance for the comparison; it is kept in the text that is posted.
 * Only the tail is normalised, so a rewrite deeper inside the sentence is still a different utterance.
 */
const TRAILING_PUNCTUATION = /[\s。？！，、；：…．\.,?!;:]+$/u;

/**
 * Two caller finals are the same utterance when one is the other, or a prefix of it, ignoring the
 * punctuation each ends with. That covers all three shapes seen in production: the identical text
 * repeated ("请问你是" three times in a second), the growing prefix ("呃，那我" → "呃，那我这里还有个
 * 快递") and the re-punctuated prefix above. Distinct sentences are not prefixes of one another, so
 * they are never merged. The accepted cost is that a genuinely new sentence that starts with the
 * previous one ("好" then "好的谢谢") is treated as a revision inside the hold window.
 */
function isSameUtterance(held, next) {
  const a = held.replace(TRAILING_PUNCTUATION, '');
  const b = next.replace(TRAILING_PUNCTUATION, '');
  // A final made of nothing but punctuation normalises to '' and would otherwise prefix-match — and
  // so swallow — whatever the caller says next. It only merges into an identical one.
  if (!a || !b) return held === next;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Turns adapter transcript events into batched Control items. Every post is
 * best effort: the transcript is a by-product of the call, never a reason to
 * fault it. Sequence is one monotonic counter shared by both roles because
 * Control enforces UNIQUE(run_id, sequence) per run, not per role.
 */
export class TranscriptCollector {
  // S27: callerHoldMs 1_200 → 3_000. On run 0407de3e xAI spread one slowly read phone number over
  // four to seven `...transcription.completed` events 1–2.5 s apart, so a 1.2 s hold expired between
  // revisions and one sentence became four and seven rows. 3 s covers the observed gaps with margin;
  // the accepted cost is that a settled caller row now lands 3–5 s after its last revision (hold plus
  // the flushMs 2 s tick) instead of 1.2–3.2 s. Nothing waits on it: close() flushes what is held.
  constructor({ flushMs = 2_000, maxBatch = 50, maxPending = 400, post, recording = true,
    now = () => Date.now(), callerHoldMs = 3_000 } = {}) {
    Object.assign(this, { flushMs, maxBatch, maxPending, post, now, callerHoldMs });
    // S22 决策 3: the worker starts the collector muted and opens it at activation, so the opener the
    // Space agent says to itself while the bridge is still silent never becomes call history.
    this.recording = recording === true;
    this.pending = [];
    this.buffers = new Map();
    // S23 决策 4: one held caller utterance, replaced in place while the provider keeps revising it.
    this.callerPending = null;
    // How many caller finals were folded into an utterance already held: dedup self-evidence in run_closed.
    this.merged = 0;
    this.sequence = 0;
    this.sent = 0;
    this.dropped = 0;
    this.failed = 0;
    this.started = false;
    this.closed = false;
    this.flushing = null;
    this.onTranscript = event => { if (!this.closed) this.handleTranscript(event); };
    this.onCompleted = event => { if (!this.closed) this.flushResponse(event?.responseId ?? ''); };
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.timer = setInterval(() => { void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  /** Opened once at real audio activation; closing it again also drops any half-built response. */
  setRecording(value) {
    const next = value === true;
    if (this.recording === next) return;
    this.recording = next;
    if (!next) { this.buffers.clear(); this.callerPending = null; }
  }

  attach(agent) { agent.on('transcript', this.onTranscript); agent.on('completed', this.onCompleted); }
  detach(agent) { agent.off('transcript', this.onTranscript); agent.off('completed', this.onCompleted); }

  handleTranscript(event) {
    if (!this.recording) return;
    // Expiry is checked here as well as on the flush tick: with flushMs 2 s the tick alone decides
    // "is this still the same utterance?" up to 2 s late, which would fold a revision that arrived
    // well after the hold window into the previous row. Evaluated per event, the boundary is exactly
    // callerHoldMs since the last revision, whatever the timer is doing.
    this.expireCaller();
    const text = String(event?.text ?? '');
    // Caller transcription arrives as cumulative updates then one final text.
    if (event?.speaker === 'caller') { if (event.final === true) this.holdCaller(text); return; }
    const key = event?.responseId ?? '';
    this.buffers.set(key, `${this.buffers.get(key) ?? ''}${text}`.slice(0, MAX_TEXT));
    while (this.buffers.size > MAX_BUFFERS) this.flushResponse(this.buffers.keys().next().value);
  }

  /**
   * S23 决策 4: xAI reports one caller utterance as several `...transcription.completed` events —
   * the same text three times within a second, or a growing prefix ("呃，那我" → "呃，那我这里还有个
   * 快递"). Each one used to take its own sequence, so a single sentence became three transcript rows.
   * Hold the newest version of the current utterance for callerHoldMs and enqueue only that: a
   * revision replaces what is held, an unrelated sentence posts the held one first. Control keeps
   * UNIQUE(run_id, sequence), which cannot see content, so the whole rule lives here.
   * The window is measured from the LAST accepted revision, not from the first: a caller reading a
   * number aloud keeps extending one utterance, and each extension restarts the hold.
   */
  holdCaller(text) {
    const value = String(text ?? '').trim().slice(0, MAX_TEXT);
    // An empty final is not an utterance: it must neither close nor become the held one.
    if (!value) return;
    const held = this.callerPending;
    const revision = Boolean(held) && isSameUtterance(held.text, value);
    if (held && !revision) this.flushCaller(); else if (revision) this.merged++;
    // Only the longest version survives: a late repeat must never truncate a completed sentence.
    const longest = revision && held.text.length > value.length ? held.text : value;
    // S27: `at` is the FIRST revision's time — when the caller started saying this — not the latest.
    // It used to follow the latest event; with a 3 s hold over several revisions that read seconds
    // after the fact and could sort a long caller utterance after the AI reply it triggered. Rows are
    // ordered by `sequence` in Control, so this only changes the timestamp shown next to the row.
    // `now` is Date.now outside tests, so production timestamps keep their real wall-clock value.
    const at = revision ? held.at : new Date(this.now()).toISOString();
    // heldSince is the last accepted revision: expireCaller measures the window from here.
    this.callerPending = { text: longest, at, heldSince: this.now() };
  }

  flushCaller() {
    const held = this.callerPending;
    if (!held) return;
    this.callerPending = null;
    this.enqueue('caller', held.text, held.at);
  }

  /** Posts the held utterance once the provider has stopped revising it. */
  expireCaller() {
    if (this.callerPending && this.now() - this.callerPending.heldSince >= this.callerHoldMs) this.flushCaller();
  }

  flushResponse(key) {
    if (!this.buffers.has(key)) return;
    const text = this.buffers.get(key);
    this.buffers.delete(key);
    // The caller spoke before the reply it triggered: keep the shared sequence in conversation order.
    this.flushCaller();
    this.enqueue('ai', text);
  }

  enqueue(role, text, at = new Date().toISOString()) {
    const value = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!value) return;
    this.pending.push({ role, sequence: this.sequence++, text: value, at });
    while (this.pending.length > this.maxPending) { this.pending.shift(); this.dropped++; }
    if (this.pending.length >= this.maxBatch) void this.flush();
  }

  flush() {
    this.expireCaller();
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async drain() {
    while (this.pending.length) {
      const batch = this.pending.splice(0, this.maxBatch);
      try { await this.post(batch); this.sent += batch.length; }
      catch {
        // Never requeue and never keep retrying: a stalled Control must not
        // delay the run's failure report behind a queue of timing-out posts.
        this.failed += batch.length;
        this.dropped += this.pending.length;
        this.pending.length = 0;
        return;
      }
    }
  }

  async close() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.closed) {
      this.closed = true;
      for (const key of [...this.buffers.keys()]) this.flushResponse(key);
      // The last utterance never gets a following event to close it: the run ending is that event.
      this.flushCaller();
    }
    await this.flush();
  }

  stats() { return { sent: this.sent, dropped: this.dropped, failed: this.failed, pending: this.pending.length, merged: this.merged }; }
}
