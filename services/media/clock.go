package main

// S70: a packet up to lateForwardWindow sequences behind the newest one is still
// forwarded (the receiver's jitter buffer reorders it); only exact duplicates and
// older packets are dropped.
const lateForwardWindow = 50

// lateWindow bit i marks the slot i sequences behind the newest as resolved
// (arrived, or older than the first packet ever seen).
type lateWindow uint64

// startLateWindow treats everything before the first packet as resolved, so a
// pre-start straggler never "fills" a gap that was never counted as missing.
const startLateWindow = ^lateWindow(0)

func (w *lateWindow) advance(distance uint64) {
	if distance >= 64 {
		*w = 1
		return
	}
	*w = *w<<distance | 1
}

// fill resolves the slot back sequences behind the newest. It reports false for
// a duplicate and for a slot outside the late-forward window.
func (w *lateWindow) fill(back uint64) bool {
	if back == 0 || back > lateForwardWindow || *w&(1<<back) != 0 {
		return false
	}
	*w |= 1 << back
	return true
}

// rtpClock unwraps the 48 kHz RTP clock of one remote track (an SSRC change is
// never conflated). Late packets inside the window get a timestamp computed
// backwards from the newest packet without advancing the clock; duplicates,
// older packets and backward in-order timestamps are rejected.
type rtpClock struct {
	seen      bool
	sequence  uint16
	timestamp uint32
	elapsed   uint64
	window    lateWindow
}

func (c *rtpClock) accept(sequence uint16, timestamp uint32) (timestampUS uint64, late bool, ok bool) {
	if !c.seen {
		c.seen = true
		c.sequence = sequence
		c.timestamp = timestamp
		c.window = startLateWindow
		return 0, false, true
	}
	distance := int16(sequence - c.sequence)
	if distance <= 0 {
		back := int32(c.timestamp - timestamp)
		if distance == 0 || back <= 0 || uint64(back) > c.elapsed || !c.window.fill(uint64(-int32(distance))) {
			return 0, false, false
		}
		return (c.elapsed - uint64(back)) * 1000 / 48, true, true
	}
	delta := int32(timestamp - c.timestamp)
	if delta <= 0 {
		return 0, false, false
	}
	c.window.advance(uint64(distance))
	c.sequence = sequence
	c.timestamp = timestamp
	c.elapsed += uint64(delta)
	return c.elapsed * 1000 / 48, false, true
}
