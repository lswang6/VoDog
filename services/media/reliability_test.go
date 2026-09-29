package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/datachannel"
	"github.com/pion/logging"
	"github.com/pion/sctp"
	transporttest "github.com/pion/transport/v4/test"
)

const reliabilityObservationWindow = 1600 * time.Millisecond

type targetTransmission struct {
	tsn uint32
	age time.Duration
}

func (t targetTransmission) String() string {
	return fmt.Sprintf("{tsn:%d age:%s}", t.tsn, t.age)
}

type reliabilityResult struct {
	transmissions []targetTransmission
	arrivalAge    time.Duration
	arrived       bool
}

type targetReadResult struct {
	age time.Duration
	err error
}

func TestPinnedSCTPRexmitSemantics(t *testing.T) {
	type matrixResult struct {
		dropFirst reliabilityResult
		dropAll   reliabilityResult
	}
	results := make(map[uint32]matrixResult)
	for _, retransmits := range []uint32{0, 1, 2} {
		t.Run(fmt.Sprintf("max-retransmits-%d", retransmits), func(t *testing.T) {
			first := observeRexmitBehavior(t, retransmits, false)
			all := observeRexmitBehavior(t, retransmits, true)
			results[retransmits] = matrixResult{dropFirst: first, dropAll: all}

			t.Logf(
				"maxRetransmits=%d dropFirst transmissions=%v arrived=%t arrivalAge=%s; dropAll transmissions=%v arrived=%t",
				retransmits,
				first.transmissions,
				first.arrived,
				first.arrivalAge,
				all.transmissions,
				all.arrived,
			)

			if len(first.transmissions) == 0 || len(all.transmissions) == 0 {
				t.Fatal("the target application DATA chunk was never transmitted")
			}
			if all.arrived {
				t.Fatal("a target dropped on every transmission unexpectedly arrived")
			}
			if first.arrived != (len(first.transmissions) > 1) {
				t.Fatalf("drop-first arrival and observed application retransmission disagree: %+v", first)
			}
			assertSameTSN(t, first.transmissions)
			assertSameTSN(t, all.transmissions)
		})
	}

	// Lock the behavior actually provided by the pinned Pion SCTP release. An
	// initial DATA send starts at nSent=1; values 0 and 1 are both abandoned
	// before another DATA transmission, while value 2 permits one retry.
	for _, retransmits := range []uint32{0, 1} {
		result := results[retransmits]
		if len(result.dropFirst.transmissions) != 1 || result.dropFirst.arrived {
			t.Errorf("maxRetransmits=%d unexpectedly recovered the dropped application message: %+v", retransmits, result.dropFirst)
		}
		if len(result.dropAll.transmissions) != 1 {
			t.Errorf("maxRetransmits=%d application DATA transmissions=%d, want 1", retransmits, len(result.dropAll.transmissions))
		}
	}
	result := results[2]
	if len(result.dropFirst.transmissions) != 2 || !result.dropFirst.arrived {
		t.Errorf("maxRetransmits=2 did not provide exactly one successful application retry: %+v", result.dropFirst)
	}
	if len(result.dropAll.transmissions) != 2 {
		t.Errorf("maxRetransmits=2 application DATA transmissions=%d, want 2", len(result.dropAll.transmissions))
	}
}

func observeRexmitBehavior(t *testing.T, retransmits uint32, dropEveryTarget bool) reliabilityResult {
	t.Helper()

	bridge := transporttest.NewBridge()
	stopPump := make(chan struct{})
	pumpDone := make(chan struct{})
	go func() {
		defer close(pumpDone)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				bridge.Tick()
			case <-stopPump:
				return
			}
		}
	}()

	var a0, a1 *sctp.Association
	var closeOnce sync.Once
	cleanup := func() {
		closeOnce.Do(func() {
			_ = bridge.GetConn0().Close()
			_ = bridge.GetConn1().Close()
			if a0 != nil {
				_ = a0.Close()
			}
			if a1 != nil {
				_ = a1.Close()
			}
			close(stopPump)
			select {
			case <-pumpDone:
			case <-time.After(time.Second):
				t.Error("bridge pump did not stop")
			}
		})
	}
	defer cleanup()
	a0, a1 = newSCTPAssociationPair(t, bridge)

	dc0, dc1 := newDataChannelPair(t, a0, a1, retransmits)
	defer func() {
		_ = dc0.Close()
		_ = dc1.Close()
	}()

	marker := []byte(fmt.Sprintf("vodog-rexmit-%d-%t-%d", retransmits, dropEveryTarget, time.Now().UnixNano()))
	started := time.Now()
	firstSeen := make(chan struct{})
	var firstSeenOnce sync.Once
	var observationMu sync.Mutex
	var transmissions []targetTransmission
	var mixedApplicationPacket bool

	bridge.Filter(0, func(raw []byte) bool {
		targets, binaryChunks, ok := inspectSCTPApplicationData(raw, marker)
		if !ok || len(targets) == 0 {
			return true
		}
		observationMu.Lock()
		if binaryChunks != len(targets) {
			mixedApplicationPacket = true
		}
		for _, tsn := range targets {
			transmissions = append(transmissions, targetTransmission{tsn: tsn, age: time.Since(started)})
		}
		ordinal := len(transmissions)
		observationMu.Unlock()
		firstSeenOnce.Do(func() { close(firstSeen) })

		return !dropEveryTarget && ordinal > 1
	})

	readResult := make(chan targetReadResult, 1)
	go func() {
		buffer := make([]byte, 2048)
		_ = dc1.SetReadDeadline(started.Add(reliabilityObservationWindow))
		for {
			n, _, err := dc1.ReadDataChannel(buffer)
			if err != nil {
				readResult <- targetReadResult{err: err}
				return
			}
			if bytes.Equal(buffer[:n], marker) {
				readResult <- targetReadResult{age: time.Since(started)}
				return
			}
		}
	}()

	if _, err := dc0.WriteDataChannel(marker, false); err != nil {
		t.Fatalf("write target application message: %v", err)
	}
	select {
	case <-firstSeen:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("target DATA transmission was not observed")
	}
	observationMu.Lock()
	mixed := mixedApplicationPacket
	observationMu.Unlock()
	if mixed {
		t.Fatal("target DATA was bundled with another binary application chunk")
	}

	// Separate writes create SACK gap evidence for fast recovery. Their unique
	// payloads cannot be mistaken for a retransmission of marker.
	for i := range 4 {
		trigger := []byte(fmt.Sprintf("trigger-%d-%d", retransmits, i))
		if _, err := dc0.WriteDataChannel(trigger, false); err != nil {
			t.Fatalf("write recovery trigger %d: %v", i, err)
		}
		time.Sleep(5 * time.Millisecond)
	}

	var result reliabilityResult
	select {
	case read := <-readResult:
		if read.err == nil {
			result.arrivalAge = read.age
			result.arrived = true
			break
		}
		var netErr net.Error
		if !errors.As(read.err, &netErr) || !netErr.Timeout() {
			t.Fatalf("receiver ended before observation deadline: %v", read.err)
		}
	case <-time.After(reliabilityObservationWindow + 250*time.Millisecond):
		t.Fatal("receiver did not honor its bounded read deadline")
	}

	observationMu.Lock()
	result.transmissions = append(result.transmissions, transmissions...)
	mixed = mixedApplicationPacket
	observationMu.Unlock()
	if mixed {
		t.Fatal("target retransmission was bundled with another binary application chunk")
	}

	return result
}

func newSCTPAssociationPair(t *testing.T, bridge *transporttest.Bridge) (*sctp.Association, *sctp.Association) {
	t.Helper()
	type associationResult struct {
		index       int
		association *sctp.Association
		err         error
	}
	results := make(chan associationResult, 2)
	loggerFactory := logging.NewDefaultLoggerFactory()
	for index, connection := range []net.Conn{bridge.GetConn0(), bridge.GetConn1()} {
		index := index
		connection := connection
		go func() {
			association, err := sctp.ClientWithOptions(
				sctp.WithNetConn(connection),
				sctp.WithLoggerFactory(loggerFactory),
			)
			results <- associationResult{index: index, association: association, err: err}
		}()
	}

	pair := make([]*sctp.Association, 2)
	for range 2 {
		select {
		case result := <-results:
			if result.err != nil {
				_ = bridge.GetConn0().Close()
				_ = bridge.GetConn1().Close()
				t.Fatalf("establish SCTP association: %v", result.err)
			}
			pair[result.index] = result.association
		case <-time.After(2 * time.Second):
			_ = bridge.GetConn0().Close()
			_ = bridge.GetConn1().Close()
			t.Fatal("SCTP association handshake timed out")
		}
	}

	return pair[0], pair[1]
}

func newDataChannelPair(
	t *testing.T,
	senderAssociation *sctp.Association,
	receiverAssociation *sctp.Association,
	retransmits uint32,
) (*datachannel.DataChannel, *datachannel.DataChannel) {
	t.Helper()
	loggerFactory := logging.NewDefaultLoggerFactory()
	config := &datachannel.Config{
		ChannelType:          datachannel.ChannelTypePartialReliableRexmitUnordered,
		ReliabilityParameter: retransmits,
		Label:                "cellular-opus-v1",
		LoggerFactory:        loggerFactory,
	}
	sender, err := datachannel.Dial(senderAssociation, 100, config)
	if err != nil {
		t.Fatalf("dial data channel: %v", err)
	}
	opened := make(chan struct{})
	var openedOnce sync.Once
	sender.OnOpen(func() { openedOnce.Do(func() { close(opened) }) })

	type acceptResult struct {
		channel *datachannel.DataChannel
		err     error
	}
	accepted := make(chan acceptResult, 1)
	go func() {
		channel, acceptErr := datachannel.Accept(receiverAssociation, &datachannel.Config{LoggerFactory: loggerFactory})
		accepted <- acceptResult{channel: channel, err: acceptErr}
	}()
	var receiver *datachannel.DataChannel
	select {
	case result := <-accepted:
		if result.err != nil {
			t.Fatalf("accept data channel: %v", result.err)
		}
		receiver = result.channel
	case <-time.After(2 * time.Second):
		t.Fatal("accept data channel timed out")
	}

	// Read the reliable DCEP ACK on the dialing side so it commits the requested
	// partial-reliability parameters. A receiver application message lets the
	// same read return instead of leaving a goroutine behind.
	readyRead := make(chan error, 1)
	go func() {
		buffer := make([]byte, 64)
		_, _, readErr := sender.ReadDataChannel(buffer)
		readyRead <- readErr
	}()
	select {
	case <-opened:
	case <-time.After(2 * time.Second):
		t.Fatal("data channel ACK timed out")
	}
	if _, err = receiver.WriteDataChannel([]byte("ready"), false); err != nil {
		t.Fatalf("write data channel readiness message: %v", err)
	}
	select {
	case err = <-readyRead:
		if err != nil {
			t.Fatalf("read data channel readiness message: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("data channel readiness read timed out")
	}

	return sender, receiver
}

func inspectSCTPApplicationData(raw, marker []byte) (targets []uint32, binaryChunks int, valid bool) {
	const commonHeaderSize = 12
	if len(raw) < commonHeaderSize {
		return nil, 0, false
	}
	for offset := commonHeaderSize; offset+4 <= len(raw); {
		chunkType := raw[offset]
		flags := raw[offset+1]
		length := int(binary.BigEndian.Uint16(raw[offset+2 : offset+4]))
		if length < 4 || offset+length > len(raw) {
			return nil, 0, false
		}
		var ppidOffset, payloadOffset int
		switch chunkType {
		case 0: // DATA
			ppidOffset, payloadOffset = offset+12, offset+16
		case 64: // I-DATA when message interleaving is negotiated
			ppidOffset, payloadOffset = offset+16, offset+20
		}
		if ppidOffset != 0 && flags&0x03 == 0x03 && payloadOffset <= offset+length && ppidOffset+4 <= offset+length {
			if binary.BigEndian.Uint32(raw[ppidOffset:ppidOffset+4]) == uint32(sctp.PayloadTypeWebRTCBinary) {
				binaryChunks++
				if bytes.Equal(raw[payloadOffset:offset+length], marker) {
					targets = append(targets, binary.BigEndian.Uint32(raw[offset+4:offset+8]))
				}
			}
		}
		offset += (length + 3) &^ 3
	}

	return targets, binaryChunks, true
}

func assertSameTSN(t *testing.T, transmissions []targetTransmission) {
	t.Helper()
	if len(transmissions) < 2 {
		return
	}
	for _, transmission := range transmissions[1:] {
		if transmission.tsn != transmissions[0].tsn {
			t.Fatalf("application retry changed TSN: %+v", transmissions)
		}
	}
}
