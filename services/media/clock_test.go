package main

import "testing"

func TestRTPClockWrapAndLate(t *testing.T) {
	var c rtpClock
	expect := func(what string, seq uint16, ts uint32, wantUS uint64, wantLate, wantOK bool) {
		t.Helper()
		got, late, ok := c.accept(seq, ts)
		if ok != wantOK || late != wantLate || (ok && got != wantUS) {
			t.Fatalf("%s: seq=%d ts=%d got (%d, late=%v, ok=%v) want (%d, late=%v, ok=%v)", what, seq, ts, got, late, ok, wantUS, wantLate, wantOK)
		}
	}
	expect("first", 65535, 0xfffffc40, 0, false, true)
	expect("clock wrap", 0, 0, 20000, false, true)
	expect("duplicate", 0, 0, 0, false, false)
	expect("duplicate of first", 65535, 0xfffffc40, 0, false, false)
	expect("loss gap", 2, 1920, 60000, false, true)
	expect("backward in-order timestamp", 3, 960, 0, false, false)
	expect("in order", 4, 3840, 100000, false, true)
	// seq 1 (ts 960) and 3 (ts 2880) were lost; they arrive late now.
	expect("late back-computed", 1, 960, 40000, true, true)
	expect("late duplicate", 1, 960, 0, false, false)
	expect("late back-computed 2", 3, 2880, 80000, true, true)
	// A late packet never advances the clock.
	expect("in order after late", 5, 4800, 120000, false, true)
}

func TestRTPClockLateWindowBoundary(t *testing.T) {
	var c rtpClock
	c.accept(1000, 0)
	c.accept(1100, 100*960) // 99 missing
	if ts, late, ok := c.accept(1100-lateForwardWindow, uint32((100-lateForwardWindow)*960)); !ok || !late || ts != uint64(100-lateForwardWindow)*20000 {
		t.Fatalf("edge of window: %d %v %v", ts, late, ok)
	}
	if _, _, ok := c.accept(1100-lateForwardWindow-1, uint32((100-lateForwardWindow-1)*960)); ok {
		t.Fatal("packet older than the window accepted")
	}
	// A late sequence whose timestamp is not behind the newest is a clock reject.
	if _, _, ok := c.accept(1099, 100*960); ok {
		t.Fatal("late packet with a non-backward timestamp accepted")
	}
	// A late timestamp before the clock origin cannot be placed.
	if _, _, ok := c.accept(1098, 0xffff0000); ok {
		t.Fatal("late packet before the clock origin accepted")
	}
}

func TestLateWindowDuplicatesAndPreStart(t *testing.T) {
	w := startLateWindow
	if w.fill(3) {
		t.Fatal("a slot before the first packet must count as resolved")
	}
	w.advance(5) // slots 1..4 unresolved
	for _, back := range []uint64{1, 4} {
		if !w.fill(back) {
			t.Fatalf("slot %d not fillable", back)
		}
		if w.fill(back) {
			t.Fatalf("slot %d filled twice", back)
		}
	}
	if w.fill(5) || w.fill(0) {
		t.Fatal("newest/pre-start slot fillable")
	}
	w.advance(200)
	if !w.fill(lateForwardWindow) || w.fill(lateForwardWindow+1) {
		t.Fatal("window edge after a long jump")
	}
}
