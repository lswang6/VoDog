package swu

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

func TestTUNTunnelManagerStartsPumpAndCleansRouting(t *testing.T) {
	baseSession := newTUNManagerPacketSession(TunnelResult{
		Ready:             true,
		Mode:              DataplaneModeUserspace,
		EPDGAddress:       "epdg.example",
		LocalInnerIP:      "10.0.0.2",
		IKEEstablished:    true,
		IPsecEstablished:  true,
		ChildSAIdentifier: "11111111/22222222",
	})
	base := &tunManagerBase{session: baseSession}
	device := newTUNManagerDevice("vohive0")
	routing := &tunManagerRouting{}
	manager := NewTUNTunnelManager(TUNTunnelManagerConfig{
		Base:           base,
		RoutingManager: routing,
		DeviceFactory: func(ctx context.Context, cfg TunnelConfig, result TunnelResult) (InnerPacketDevice, string, error) {
			if result.LocalInnerIP != "10.0.0.2" {
				t.Fatalf("device factory result=%+v", result)
			}
			return device, "", nil
		},
		MTU:    1420,
		Routes: []TUNRoute{{Destination: "default", Table: "200"}},
		Rules:  []TUNRule{{Priority: 1000, From: "10.0.0.2", Table: "200"}},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	result := session.Result()
	if !result.IsReady() || result.LocalInnerIP != "10.0.0.2" || result.ChildSAIdentifier == "" {
		t.Fatalf("result=%+v", result)
	}
	if len(routing.applies) != 1 {
		t.Fatalf("routing applies=%d, want 1", len(routing.applies))
	}
	applied := routing.applies[0]
	if applied.InterfaceName != "vohive0" || applied.MTU != 1420 || len(applied.Addresses) != 1 || applied.Addresses[0] != "10.0.0.2" {
		t.Fatalf("routing config=%+v", applied)
	}
	if len(applied.Routes) != 1 || applied.Routes[0].Destination != "default" || len(applied.Rules) != 1 {
		t.Fatalf("routing routes/rules=%+v/%+v", applied.Routes, applied.Rules)
	}

	outbound := []byte{0x45, 0, 0, 0x14, 0xaa}
	device.reads <- outbound
	if got := readPumpBytes(t, baseSession.sent); !bytes.Equal(got, outbound) {
		t.Fatalf("sent=%x, want %x", got, outbound)
	}
	inbound := []byte{0x60, 0, 0, 0, 0xbb}
	baseSession.reads <- PacketTunnelPacket{Payload: inbound}
	if got := readPumpBytes(t, device.writes); !bytes.Equal(got, inbound) {
		t.Fatalf("written=%x, want %x", got, inbound)
	}

	if err := session.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if !baseSession.isClosed() || !device.isClosed() {
		t.Fatalf("closed session=%t device=%t", baseSession.isClosed(), device.isClosed())
	}
	if len(routing.cleanups) != 1 || routing.cleanups[0].InterfaceName != "vohive0" {
		t.Fatalf("routing cleanups=%+v", routing.cleanups)
	}
}

func TestTUNTunnelManagerResultTracksPumpDrivenChildSARekey(t *testing.T) {
	baseSession := newTUNManagerPacketSession(TunnelResult{
		Ready:             true,
		Mode:              DataplaneModeUserspace,
		EPDGAddress:       "epdg.example",
		LocalInnerIP:      "10.0.0.2",
		IKEEstablished:    true,
		IPsecEstablished:  true,
		ChildSAIdentifier: "11111111/22222222",
		Reason:            "ike ipsec ready",
	})
	baseSession.rekeyDue = time.Now().Add(-time.Second)
	baseSession.rekeyResult = TunnelResult{
		Ready:             true,
		Mode:              DataplaneModeUserspace,
		EPDGAddress:       "epdg.example",
		LocalInnerIP:      "10.0.0.2",
		IKEEstablished:    true,
		IPsecEstablished:  true,
		ChildSAIdentifier: "33333333/44444444",
		Reason:            "child sa rekeyed",
	}
	device := newTUNManagerDevice("vohive0")
	manager := NewTUNTunnelManager(TUNTunnelManagerConfig{
		Base:           &tunManagerBase{session: baseSession},
		DisableRouting: true,
		DeviceFactory: func(ctx context.Context, cfg TunnelConfig, result TunnelResult) (InnerPacketDevice, string, error) {
			return device, "vohive0", nil
		},
	})

	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())

	device.reads <- []byte{0x45, 0, 0, 0x14, 0xaa}
	_ = readPumpBytes(t, baseSession.sent)
	if calls := baseSession.rekeyCallCount(); calls != 1 {
		t.Fatalf("rekey calls=%d, want 1", calls)
	}
	result := session.Result()
	if result.ChildSAIdentifier != "33333333/44444444" || result.Reason != "child sa rekeyed" {
		t.Fatalf("result after pump-driven rekey=%+v", result)
	}
}

func TestTUNTunnelManagerRejectsNonPacketSession(t *testing.T) {
	plain := &tunManagerPlainSession{result: TunnelResult{Ready: true, IKEEstablished: true, IPsecEstablished: true}}
	manager := NewTUNTunnelManager(TUNTunnelManagerConfig{
		Base: &tunManagerBase{session: plain},
	})
	_, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	})
	if !errors.Is(err, ErrInvalidTUNTunnelManager) {
		t.Fatalf("EstablishTunnel() err=%v, want ErrInvalidTUNTunnelManager", err)
	}
	if !plain.closed {
		t.Fatalf("plain base session was not closed")
	}
}

func TestTUNTunnelManagerRollsBackOnRoutingFailure(t *testing.T) {
	baseSession := newTUNManagerPacketSession(TunnelResult{Ready: true, IKEEstablished: true, IPsecEstablished: true})
	device := newTUNManagerDevice("vohive0")
	wantErr := errors.New("ip failed")
	manager := NewTUNTunnelManager(TUNTunnelManagerConfig{
		Base: &tunManagerBase{session: baseSession},
		DeviceFactory: func(ctx context.Context, cfg TunnelConfig, result TunnelResult) (InnerPacketDevice, string, error) {
			return device, "vohive0", nil
		},
		RoutingManager: &tunManagerRouting{applyErr: wantErr},
	})
	_, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("EstablishTunnel() err=%v, want routing error", err)
	}
	if !baseSession.isClosed() || !device.isClosed() {
		t.Fatalf("rollback closed session=%t device=%t", baseSession.isClosed(), device.isClosed())
	}
}

func TestTUNTunnelManagerAddsDefaultRouteAndEPDGProtection(t *testing.T) {
	baseSession := newTUNManagerPacketSession(TunnelResult{
		Ready:            true,
		EPDGAddress:      "epdg.example:4500",
		LocalInnerIP:     "10.0.0.2",
		IKEEstablished:   true,
		IPsecEstablished: true,
	})
	device := newTUNManagerDevice("vohive0")
	routing := &tunManagerRouting{}
	manager := NewTUNTunnelManager(TUNTunnelManagerConfig{
		Base:              &tunManagerBase{session: baseSession},
		RoutingManager:    routing,
		DefaultRoutes:     true,
		ProtectEPDGRoutes: true,
		EPDGRouteResolver: func(ctx context.Context, host string) ([]net.IP, error) {
			if host != "epdg.example" {
				t.Fatalf("resolve host=%q, want epdg.example", host)
			}
			return []net.IP{net.ParseIP("198.51.100.7")}, nil
		},
		DeviceFactory: func(ctx context.Context, cfg TunnelConfig, result TunnelResult) (InnerPacketDevice, string, error) {
			return device, "vohive0", nil
		},
	})
	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:       "dev-1",
		Mode:           DataplaneModeUserspace,
		EPDGAddress:    "epdg.example",
		LocalInterface: "wwan0",
		OuterLocalIP:   "192.0.2.10",
		IMSI:           "310280000000001",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())
	if len(routing.applies) != 1 {
		t.Fatalf("routing applies=%d, want 1", len(routing.applies))
	}
	applied := routing.applies[0]
	if len(applied.Routes) != 1 || applied.Routes[0].Destination != "default" {
		t.Fatalf("routes=%+v", applied.Routes)
	}
	if len(applied.EPDGRouteExclusions) != 1 {
		t.Fatalf("ePDG exclusions=%+v", applied.EPDGRouteExclusions)
	}
	exclusion := applied.EPDGRouteExclusions[0]
	if exclusion.Address != "198.51.100.7" || exclusion.InterfaceName != "wwan0" || exclusion.Source != "192.0.2.10" || len(exclusion.Tables) != 0 {
		t.Fatalf("ePDG exclusion=%+v", exclusion)
	}
}

func TestTUNTunnelManagerProtectsEPDGRoutesForPolicyTables(t *testing.T) {
	baseSession := newTUNManagerPacketSession(TunnelResult{
		Ready:            true,
		EPDGAddress:      "198.51.100.8",
		LocalInnerIP:     "10.0.0.2",
		IKEEstablished:   true,
		IPsecEstablished: true,
	})
	routing := &tunManagerRouting{}
	manager := NewTUNTunnelManager(TUNTunnelManagerConfig{
		Base:              &tunManagerBase{session: baseSession},
		RoutingManager:    routing,
		DefaultRoutes:     true,
		ProtectEPDGRoutes: true,
		Routes: []TUNRoute{
			{Destination: "default", Table: "200"},
			{Destination: "10.10.0.0/24", Table: "200"},
			{Destination: "default", Table: "200"},
			{Destination: "default", Table: "201"},
		},
		DeviceFactory: func(ctx context.Context, cfg TunnelConfig, result TunnelResult) (InnerPacketDevice, string, error) {
			return newTUNManagerDevice("vohive0"), "vohive0", nil
		},
	})
	session, err := manager.EstablishTunnel(context.Background(), TunnelConfig{
		DeviceID:       "dev-1",
		Mode:           DataplaneModeUserspace,
		EPDGAddress:    "198.51.100.8",
		LocalInterface: "wwan0",
		IMSI:           "310280000000001",
	})
	if err != nil {
		t.Fatalf("EstablishTunnel() error = %v", err)
	}
	defer session.Close(context.Background())
	exclusions := routing.applies[0].EPDGRouteExclusions
	if len(exclusions) != 1 || exclusions[0].Address != "198.51.100.8" {
		t.Fatalf("exclusions=%+v", exclusions)
	}
	if got, want := exclusions[0].Tables, []string{"200", "201"}; !stringSlicesEqual(got, want) {
		t.Fatalf("tables=%+v, want %+v", got, want)
	}
}

type tunManagerBase struct {
	config  TunnelConfig
	session TunnelSession
	err     error
}

func (m *tunManagerBase) EstablishTunnel(ctx context.Context, cfg TunnelConfig) (TunnelSession, error) {
	m.config = cfg
	if m.err != nil {
		return nil, m.err
	}
	return m.session, nil
}

type tunManagerRouting struct {
	applies  []TUNRoutingConfig
	cleanups []TUNRoutingState
	applyErr error
}

func (r *tunManagerRouting) Apply(ctx context.Context, cfg TUNRoutingConfig) (TUNRoutingState, error) {
	r.applies = append(r.applies, cfg)
	if r.applyErr != nil {
		return TUNRoutingState{InterfaceName: cfg.InterfaceName}, r.applyErr
	}
	return TUNRoutingState{InterfaceName: cfg.InterfaceName}, nil
}

func (r *tunManagerRouting) Cleanup(ctx context.Context, state TUNRoutingState) error {
	r.cleanups = append(r.cleanups, state)
	return nil
}

type tunManagerDevice struct {
	name    string
	reads   chan []byte
	writes  chan []byte
	close   sync.Once
	closed  chan struct{}
	closeMu sync.Mutex
}

func newTUNManagerDevice(name string) *tunManagerDevice {
	return &tunManagerDevice{
		name:   name,
		reads:  make(chan []byte, 4),
		writes: make(chan []byte, 4),
		closed: make(chan struct{}),
	}
}

func (d *tunManagerDevice) Name() string { return d.name }

func (d *tunManagerDevice) ReadInnerPacket(ctx context.Context) ([]byte, error) {
	select {
	case packet := <-d.reads:
		return append([]byte(nil), packet...), nil
	case <-d.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (d *tunManagerDevice) WriteInnerPacket(ctx context.Context, packet []byte) error {
	select {
	case d.writes <- append([]byte(nil), packet...):
		return nil
	case <-d.closed:
		return io.EOF
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *tunManagerDevice) Close(ctx context.Context) error {
	d.close.Do(func() { close(d.closed) })
	return nil
}

func (d *tunManagerDevice) isClosed() bool {
	select {
	case <-d.closed:
		return true
	default:
		return false
	}
}

type tunManagerPacketSession struct {
	mu          sync.Mutex
	result      TunnelResult
	sent        chan []byte
	reads       chan PacketTunnelPacket
	close       sync.Once
	closed      chan struct{}
	mobike      MOBIKEResult
	rekeyDue    time.Time
	rekeyResult TunnelResult
	rekeyErr    error
	rekeyCalls  int
	closeMu     sync.Mutex
}

func newTUNManagerPacketSession(result TunnelResult) *tunManagerPacketSession {
	return &tunManagerPacketSession{
		result: result,
		sent:   make(chan []byte, 4),
		reads:  make(chan PacketTunnelPacket, 4),
		closed: make(chan struct{}),
		mobike: MOBIKEResult{
			IKEEstablished:   result.IKEEstablished,
			IPsecEstablished: result.IPsecEstablished,
			LocalInnerIP:     result.LocalInnerIP,
			RemoteInnerIP:    result.RemoteInnerIP,
		},
	}
}

func (s *tunManagerPacketSession) Result() TunnelResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneTunnelResult(s.result)
}

func (s *tunManagerPacketSession) MOBIKE(ctx context.Context, req MOBIKERequest) (MOBIKEResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mobike, nil
}

func (s *tunManagerPacketSession) Close(ctx context.Context) error {
	s.close.Do(func() { close(s.closed) })
	return nil
}

func (s *tunManagerPacketSession) SendInnerPacket(ctx context.Context, packet []byte) error {
	select {
	case s.sent <- append([]byte(nil), packet...):
		return nil
	case <-s.closed:
		return ErrPacketTunnelClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *tunManagerPacketSession) SendInnerPacketWithNextHeader(ctx context.Context, nextHeader uint8, packet []byte) error {
	return s.SendInnerPacket(ctx, packet)
}

func (s *tunManagerPacketSession) ReceiveESPPacket(ctx context.Context, packet []byte) (PacketTunnelPacket, error) {
	return PacketTunnelPacket{Payload: append([]byte(nil), packet...)}, nil
}

func (s *tunManagerPacketSession) PacketStats() PacketTunnelStats {
	return PacketTunnelStats{}
}

func (s *tunManagerPacketSession) RekeyChildSA(ctx context.Context) (TunnelResult, error) {
	decision, err := s.RunChildSARekeyDue(ctx, time.Now())
	if err != nil {
		return TunnelResult{}, err
	}
	if decision.Action != ChildSARekeyDue {
		return s.Result(), nil
	}
	return s.Result(), nil
}

func (s *tunManagerPacketSession) NextChildSARekeyDue() (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rekeyDue.IsZero() {
		return time.Time{}, false
	}
	return s.rekeyDue, true
}

func (s *tunManagerPacketSession) RunChildSARekeyDue(ctx context.Context, now time.Time) (ChildSARekeyDecision, error) {
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
	decision := ChildSARekeyDecision{
		Action:  ChildSARekeyDue,
		DueAt:   dueAt,
		NextDue: now.Add(time.Hour),
		Reason:  "child sa rekey due",
	}
	if s.rekeyErr != nil {
		return decision, s.rekeyErr
	}
	if !isZeroTunnelResult(s.rekeyResult) {
		s.result = cloneTunnelResult(s.rekeyResult)
	}
	s.rekeyDue = decision.NextDue
	return decision, nil
}

func (s *tunManagerPacketSession) ChildSARekeySnapshot() ChildSARekeySnapshot {
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

func (s *tunManagerPacketSession) ReadInnerPacket(ctx context.Context) (PacketTunnelPacket, error) {
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

func (s *tunManagerPacketSession) isClosed() bool {
	select {
	case <-s.closed:
		return true
	default:
		return false
	}
}

func (s *tunManagerPacketSession) rekeyCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rekeyCalls
}

type tunManagerPlainSession struct {
	result TunnelResult
	closed bool
}

func (s *tunManagerPlainSession) Result() TunnelResult { return s.result }

func (s *tunManagerPlainSession) MOBIKE(ctx context.Context, req MOBIKERequest) (MOBIKEResult, error) {
	return MOBIKEResult{}, nil
}

func (s *tunManagerPlainSession) Close(ctx context.Context) error {
	s.closed = true
	return nil
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
