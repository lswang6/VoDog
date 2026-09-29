package swu

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

func TestPacketPumpForwardsBothDirections(t *testing.T) {
	device := newPumpFakeDevice()
	session := newPumpFakeSession()
	pump, err := NewPacketPump(PacketPumpConfig{Session: session, Device: device})
	if err != nil {
		t.Fatalf("NewPacketPump() error = %v", err)
	}
	if err := pump.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	outbound := []byte{0x45, 0, 0, 0x14, 0xaa}
	device.reads <- outbound
	if got := readPumpBytes(t, session.sent); !bytes.Equal(got, outbound) {
		t.Fatalf("sent=%x, want %x", got, outbound)
	}

	inbound := []byte{0x60, 0, 0, 0, 0xbb}
	session.reads <- PacketTunnelPacket{Payload: inbound}
	if got := readPumpBytes(t, device.writes); !bytes.Equal(got, inbound) {
		t.Fatalf("written=%x, want %x", got, inbound)
	}

	if err := pump.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	stats, err := pump.Wait()
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if stats.DeviceToESPPackets != 1 || stats.DeviceToESPBytes != uint64(len(outbound)) ||
		stats.ESPToDevicePackets != 1 || stats.ESPToDeviceBytes != uint64(len(inbound)) {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestPacketPumpReportsSendErrors(t *testing.T) {
	device := newPumpFakeDevice()
	sendErr := errors.New("send failed")
	session := newPumpFakeSession()
	session.sendErr = sendErr
	var gotDirection PacketPumpDirection
	pump, err := NewPacketPump(PacketPumpConfig{
		Session: session,
		Device:  device,
		OnError: func(direction PacketPumpDirection, err error) {
			gotDirection = direction
		},
	})
	if err != nil {
		t.Fatalf("NewPacketPump() error = %v", err)
	}
	if err := pump.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	device.reads <- []byte{0x45, 0, 0, 0x14}
	stats, err := pump.Wait()
	if !errors.Is(err, sendErr) {
		t.Fatalf("Wait() err=%v, want sendErr", err)
	}
	if gotDirection != PacketPumpDeviceToESP {
		t.Fatalf("direction=%s, want %s", gotDirection, PacketPumpDeviceToESP)
	}
	if stats.ESPSendErrors != 1 || stats.DeviceToESPPackets != 0 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestPacketPumpReportsDeviceWriteErrors(t *testing.T) {
	device := newPumpFakeDevice()
	writeErr := errors.New("write failed")
	device.writeErr = writeErr
	session := newPumpFakeSession()
	pump, err := NewPacketPump(PacketPumpConfig{Session: session, Device: device})
	if err != nil {
		t.Fatalf("NewPacketPump() error = %v", err)
	}
	if err := pump.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	session.reads <- PacketTunnelPacket{Payload: []byte{0x60, 0, 0, 0}}
	stats, err := pump.Wait()
	if !errors.Is(err, writeErr) {
		t.Fatalf("Wait() err=%v, want writeErr", err)
	}
	if stats.DeviceWriteErrors != 1 || stats.ESPToDevicePackets != 0 {
		t.Fatalf("stats=%+v", stats)
	}
}

func TestPacketPumpRunsChildSARekeyBeforeOutbound(t *testing.T) {
	device := newPumpFakeDevice()
	session := newPumpFakeSession()
	session.rekeyDue = time.Now().Add(-time.Second)
	pump, err := NewPacketPump(PacketPumpConfig{Session: session, Device: device})
	if err != nil {
		t.Fatalf("NewPacketPump() error = %v", err)
	}
	if err := pump.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	outbound := []byte{0x45, 0, 0, 0x14, 0xaa}
	device.reads <- outbound
	if got := readPumpBytes(t, session.sent); !bytes.Equal(got, outbound) {
		t.Fatalf("sent=%x, want %x", got, outbound)
	}
	if err := pump.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	stats, err := pump.Wait()
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if stats.ChildSARekeys != 1 || stats.ChildSARekeyErrors != 0 {
		t.Fatalf("stats=%+v", stats)
	}
	if calls := session.rekeyCallCount(); calls != 1 {
		t.Fatalf("rekey calls=%d, want 1", calls)
	}
	if events := session.eventLog(); len(events) != 2 || events[0] != "rekey" || events[1] != "send" {
		t.Fatalf("events=%+v, want rekey before send", events)
	}
}

func TestPacketPumpReportsChildSARekeyErrors(t *testing.T) {
	device := newPumpFakeDevice()
	wantErr := errors.New("rekey failed")
	session := newPumpFakeSession()
	session.rekeyDue = time.Now().Add(-time.Second)
	session.rekeyErr = wantErr
	var gotDirection PacketPumpDirection
	pump, err := NewPacketPump(PacketPumpConfig{
		Session: session,
		Device:  device,
		OnError: func(direction PacketPumpDirection, err error) {
			gotDirection = direction
		},
	})
	if err != nil {
		t.Fatalf("NewPacketPump() error = %v", err)
	}
	if err := pump.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	device.reads <- []byte{0x45, 0, 0, 0x14}

	stats, err := pump.Wait()
	if !errors.Is(err, wantErr) {
		t.Fatalf("Wait() err=%v, want rekey failed", err)
	}
	if gotDirection != PacketPumpDeviceToESP {
		t.Fatalf("direction=%s, want %s", gotDirection, PacketPumpDeviceToESP)
	}
	if stats.ChildSARekeyErrors != 1 || stats.ChildSARekeys != 0 || stats.DeviceToESPPackets != 0 {
		t.Fatalf("stats=%+v", stats)
	}
	if len(session.eventLog()) != 1 || session.eventLog()[0] != "rekey" {
		t.Fatalf("events=%+v, want only rekey", session.eventLog())
	}
}

func TestPacketPumpWaitBeforeStartReturnsError(t *testing.T) {
	pump, err := NewPacketPump(PacketPumpConfig{Session: newPumpFakeSession(), Device: newPumpFakeDevice()})
	if err != nil {
		t.Fatalf("NewPacketPump() error = %v", err)
	}
	if _, err := pump.Wait(); !errors.Is(err, ErrInvalidPacketPump) {
		t.Fatalf("Wait() err=%v, want ErrInvalidPacketPump", err)
	}
	if err := pump.Close(context.Background()); err != nil {
		t.Fatalf("Close(before start) error = %v", err)
	}
}

func readPumpBytes(t *testing.T, ch <-chan []byte) []byte {
	t.Helper()
	select {
	case packet := <-ch:
		return packet
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for packet")
		return nil
	}
}

type pumpFakeDevice struct {
	reads    chan []byte
	writes   chan []byte
	writeErr error
	close    sync.Once
	closed   chan struct{}
}

func newPumpFakeDevice() *pumpFakeDevice {
	return &pumpFakeDevice{
		reads:  make(chan []byte, 4),
		writes: make(chan []byte, 4),
		closed: make(chan struct{}),
	}
}

func (d *pumpFakeDevice) ReadInnerPacket(ctx context.Context) ([]byte, error) {
	select {
	case packet := <-d.reads:
		return append([]byte(nil), packet...), nil
	case <-d.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (d *pumpFakeDevice) WriteInnerPacket(ctx context.Context, packet []byte) error {
	if d.writeErr != nil {
		return d.writeErr
	}
	select {
	case d.writes <- append([]byte(nil), packet...):
		return nil
	case <-d.closed:
		return io.EOF
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *pumpFakeDevice) Close(ctx context.Context) error {
	d.close.Do(func() { close(d.closed) })
	return nil
}

type pumpFakeSession struct {
	mu         sync.Mutex
	sent       chan []byte
	reads      chan PacketTunnelPacket
	sendErr    error
	readErr    error
	rekeyDue   time.Time
	rekeyErr   error
	rekeyCalls int
	events     []string
	close      sync.Once
	closed     chan struct{}
}

func newPumpFakeSession() *pumpFakeSession {
	return &pumpFakeSession{
		sent:   make(chan []byte, 4),
		reads:  make(chan PacketTunnelPacket, 4),
		closed: make(chan struct{}),
	}
}

func (s *pumpFakeSession) Result() TunnelResult {
	return TunnelResult{Ready: true, IKEEstablished: true, IPsecEstablished: true}
}

func (s *pumpFakeSession) MOBIKE(ctx context.Context, req MOBIKERequest) (MOBIKEResult, error) {
	return MOBIKEResult{}, nil
}

func (s *pumpFakeSession) Close(ctx context.Context) error {
	s.close.Do(func() { close(s.closed) })
	return nil
}

func (s *pumpFakeSession) SendInnerPacket(ctx context.Context, packet []byte) error {
	if s.sendErr != nil {
		return s.sendErr
	}
	s.recordEvent("send")
	select {
	case s.sent <- append([]byte(nil), packet...):
		return nil
	case <-s.closed:
		return ErrPacketTunnelClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *pumpFakeSession) SendInnerPacketWithNextHeader(ctx context.Context, nextHeader uint8, packet []byte) error {
	return s.SendInnerPacket(ctx, packet)
}

func (s *pumpFakeSession) ReceiveESPPacket(ctx context.Context, packet []byte) (PacketTunnelPacket, error) {
	return PacketTunnelPacket{Payload: append([]byte(nil), packet...)}, nil
}

func (s *pumpFakeSession) ReadInnerPacket(ctx context.Context) (PacketTunnelPacket, error) {
	if s.readErr != nil {
		return PacketTunnelPacket{}, s.readErr
	}
	select {
	case packet := <-s.reads:
		packet.Payload = append([]byte(nil), packet.Payload...)
		return packet, nil
	case <-s.closed:
		return PacketTunnelPacket{}, ErrPacketTunnelClosed
	case <-ctx.Done():
		return PacketTunnelPacket{}, ctx.Err()
	}
}

func (s *pumpFakeSession) PacketStats() PacketTunnelStats {
	return PacketTunnelStats{}
}

func (s *pumpFakeSession) RekeyChildSA(ctx context.Context) (TunnelResult, error) {
	decision, err := s.RunChildSARekeyDue(ctx, time.Now())
	if err != nil {
		return TunnelResult{}, err
	}
	return TunnelResult{
		Ready:             true,
		IKEEstablished:    true,
		IPsecEstablished:  true,
		ChildSAIdentifier: decision.Reason,
	}, nil
}

func (s *pumpFakeSession) NextChildSARekeyDue() (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rekeyDue.IsZero() {
		return time.Time{}, false
	}
	return s.rekeyDue, true
}

func (s *pumpFakeSession) RunChildSARekeyDue(ctx context.Context, now time.Time) (ChildSARekeyDecision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rekeyDue.IsZero() {
		return ChildSARekeyDecision{Action: ChildSARekeyNoAction, Reason: "rekey disabled"}, nil
	}
	dueAt := s.rekeyDue
	if now.Before(dueAt) {
		return ChildSARekeyDecision{
			Action:  ChildSARekeyNoAction,
			DueAt:   dueAt,
			NextDue: dueAt,
			Reason:  "child sa rekey not due",
		}, nil
	}
	s.rekeyCalls++
	s.events = append(s.events, "rekey")
	decision := ChildSARekeyDecision{
		Action:  ChildSARekeyDue,
		DueAt:   dueAt,
		NextDue: now.Add(time.Hour),
		Reason:  "child sa rekey due",
	}
	if s.rekeyErr != nil {
		return decision, s.rekeyErr
	}
	s.rekeyDue = decision.NextDue
	return decision, nil
}

func (s *pumpFakeSession) ChildSARekeySnapshot() ChildSARekeySnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rekeyDue.IsZero() {
		return ChildSARekeySnapshot{}
	}
	return ChildSARekeySnapshot{
		Enabled: true,
		DueAt:   s.rekeyDue,
	}
}

func (s *pumpFakeSession) rekeyCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rekeyCalls
}

func (s *pumpFakeSession) eventLog() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.events...)
}

func (s *pumpFakeSession) recordEvent(event string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
}
