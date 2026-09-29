package swu

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

var ErrUDPNATTTransport = errors.New("swu udp natt transport")

// UDPNATTTransport multiplexes IKE and ESP-in-UDP over one connected UDP
// socket. A stable source port is part of the IKE SA's NAT mapping and must be
// preserved from IKE_SA_INIT through EAP, CHILD_SA traffic, DPD, and teardown.
type UDPNATTTransport struct {
	RemoteAddr      string
	LocalAddr       string
	Timeout         time.Duration
	ReadBufferSize  int
	UseNonESPMarker bool

	mu         sync.Mutex
	writeMu    sync.Mutex
	exchangeMu sync.Mutex
	conn       net.Conn
	ike        chan []byte
	esp        chan []byte
	done       chan struct{}
	readErr    error
	started    bool
	closed     bool
	doneOnce   sync.Once
	closeOnce  sync.Once
}

var (
	_ interface {
		ExchangeIKE(context.Context, []byte) ([]byte, error)
	} = (*UDPNATTTransport)(nil)
	_ ESPPacketReadWriteTransport = (*UDPNATTTransport)(nil)
	_ ESPPacketTransportCloser    = (*UDPNATTTransport)(nil)
	_ NATTKeepaliveSender         = (*UDPNATTTransport)(nil)
)

func NewUDPNATTTransport(remoteAddr, localAddr string, timeout time.Duration, useNonESPMarker bool) *UDPNATTTransport {
	return &UDPNATTTransport{
		RemoteAddr:      strings.TrimSpace(remoteAddr),
		LocalAddr:       strings.TrimSpace(localAddr),
		Timeout:         timeout,
		UseNonESPMarker: useNonESPMarker,
		ike:             make(chan []byte, 16),
		esp:             make(chan []byte, 64),
		done:            make(chan struct{}),
	}
}

func (t *UDPNATTTransport) ExchangeIKE(ctx context.Context, request []byte) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	t.exchangeMu.Lock()
	defer t.exchangeMu.Unlock()
	if err := t.ensureConnected(ctx); err != nil {
		return nil, err
	}
	wire := append([]byte(nil), request...)
	if t.UseNonESPMarker {
		wire = append([]byte{0, 0, 0, 0}, wire...)
	}
	if err := t.writePayload(ctx, wire); err != nil {
		return nil, err
	}
	timer := time.NewTimer(t.timeout())
	defer timer.Stop()
	select {
	case response := <-t.ike:
		return response, nil
	case <-t.done:
		return nil, t.terminalError()
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("%w: IKE response timeout", ErrUDPNATTTransport)
	}
}

func (t *UDPNATTTransport) SendESPPacket(ctx context.Context, packet []byte) error {
	if len(packet) < 8 || isNonESPMarker(packet) {
		return fmt.Errorf("%w: invalid ESP packet", ErrUDPNATTTransport)
	}
	if err := t.ensureConnected(ctx); err != nil {
		return err
	}
	return t.writePayload(ctx, packet)
}

func (t *UDPNATTTransport) SendNATTKeepalive(ctx context.Context) error {
	if err := t.ensureConnected(ctx); err != nil {
		return err
	}
	return t.writePayload(ctx, []byte{0xff})
}

func (t *UDPNATTTransport) ReadESPPacket(ctx context.Context) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := t.ensureConnected(ctx); err != nil {
		return nil, err
	}
	select {
	case packet := <-t.esp:
		return packet, nil
	case <-t.done:
		return nil, t.terminalError()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *UDPNATTTransport) Close(context.Context) error {
	if t == nil {
		return nil
	}
	var err error
	t.closeOnce.Do(func() {
		t.mu.Lock()
		t.closed = true
		conn := t.conn
		t.conn = nil
		t.mu.Unlock()
		t.signalDone()
		if conn != nil {
			err = conn.Close()
		}
	})
	return err
}

func (t *UDPNATTTransport) LocalNetworkAddr() net.Addr {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conn == nil {
		return nil
	}
	return t.conn.LocalAddr()
}

func (t *UDPNATTTransport) ensureConnected(ctx context.Context) error {
	if t == nil {
		return fmt.Errorf("%w: transport is nil", ErrUDPNATTTransport)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return ErrPacketTunnelClosed
	}
	if t.started {
		return nil
	}
	remote, err := udpAddrWithDefaultPort(t.RemoteAddr, DefaultNATTUDPPort)
	if err != nil {
		return err
	}
	dialer := net.Dialer{Timeout: t.timeout()}
	if t.LocalAddr != "" {
		local, err := udpAddrWithDefaultPort(t.LocalAddr, "0")
		if err != nil {
			return err
		}
		localAddr, err := net.ResolveUDPAddr("udp", local)
		if err != nil {
			return err
		}
		dialer.LocalAddr = localAddr
	}
	conn, err := dialer.DialContext(ctx, "udp", remote)
	if err != nil {
		return fmt.Errorf("%w: connect: %v", ErrUDPNATTTransport, err)
	}
	t.conn, t.started = conn, true
	go t.readLoop(conn)
	return nil
}

func (t *UDPNATTTransport) writePayload(ctx context.Context, payload []byte) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	t.mu.Lock()
	conn, closed := t.conn, t.closed
	t.mu.Unlock()
	if closed || conn == nil {
		return ErrPacketTunnelClosed
	}
	deadline := time.Now().Add(t.timeout())
	if ctx != nil {
		if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
			deadline = value
		}
	}
	if err := conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	_, err := conn.Write(payload)
	if err != nil {
		return fmt.Errorf("%w: UDP write: %v", ErrUDPNATTTransport, err)
	}
	return nil
}

func (t *UDPNATTTransport) readLoop(conn net.Conn) {
	size := t.ReadBufferSize
	if size <= 0 {
		size = 64 * 1024
	}
	buf := make([]byte, size)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			t.finishRead(err)
			return
		}
		payload := buf[:n]
		if len(payload) == 0 || isNATTKeepalive(payload) {
			continue
		}
		if isNonESPMarker(payload) {
			packet := append([]byte(nil), payload[4:]...)
			select {
			case t.ike <- packet:
			case <-t.done:
				return
			}
			continue
		}
		if len(payload) < 8 {
			continue
		}
		packet := append([]byte(nil), payload...)
		select {
		case t.esp <- packet:
		case <-t.done:
			return
		}
	}
}

func (t *UDPNATTTransport) finishRead(err error) {
	t.mu.Lock()
	if !t.closed {
		t.readErr = err
		t.closed = true
	}
	t.mu.Unlock()
	t.signalDone()
}

func (t *UDPNATTTransport) signalDone() {
	t.doneOnce.Do(func() { close(t.done) })
}

func (t *UDPNATTTransport) terminalError() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.readErr != nil && !errors.Is(t.readErr, net.ErrClosed) {
		return fmt.Errorf("%w: %v", ErrUDPNATTTransport, t.readErr)
	}
	return ErrPacketTunnelClosed
}

func (t *UDPNATTTransport) timeout() time.Duration {
	if t != nil && t.Timeout > 0 {
		return t.Timeout
	}
	return 8 * time.Second
}
