package swu

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var ErrSOCKSUDPTransport = errors.New("swu socks udp transport")

// SOCKSNATTTransport carries both IKE (with the non-ESP marker) and ESP-in-UDP
// over one SOCKS5 UDP association. Sharing the association is required so the
// ePDG sees one stable NAT mapping for the complete IKE SA.
type SOCKSNATTTransport struct {
	Proxy           ProxyConfig
	RemoteAddr      string
	Timeout         time.Duration
	ReadBufferSize  int
	UseNonESPMarker bool

	mu        sync.Mutex
	writeMu   sync.Mutex
	control   net.Conn
	udp       net.Conn
	remote    socksAddress
	ike       chan []byte
	esp       chan []byte
	done      chan struct{}
	readErr   error
	started   bool
	closed    bool
	doneOnce  sync.Once
	closeOnce sync.Once
}

var (
	_ interface {
		ExchangeIKE(context.Context, []byte) ([]byte, error)
	} = (*SOCKSNATTTransport)(nil)
	_ ESPPacketReadWriteTransport = (*SOCKSNATTTransport)(nil)
	_ ESPPacketTransportCloser    = (*SOCKSNATTTransport)(nil)
	_ NATTKeepaliveSender         = (*SOCKSNATTTransport)(nil)
)

type socksAddress struct {
	host string
	port uint16
}

func NewSOCKSNATTTransport(proxy ProxyConfig, remote string, timeout time.Duration) (*SOCKSNATTTransport, error) {
	if !proxy.Enabled {
		return nil, fmt.Errorf("%w: proxy is disabled", ErrSOCKSUDPTransport)
	}
	host, port, err := net.SplitHostPort(strings.TrimSpace(remote))
	if err != nil {
		return nil, fmt.Errorf("%w: remote address: %v", ErrSOCKSUDPTransport, err)
	}
	portNumber, err := strconv.ParseUint(port, 10, 16)
	if err != nil || portNumber == 0 {
		return nil, fmt.Errorf("%w: invalid remote port", ErrSOCKSUDPTransport)
	}
	return &SOCKSNATTTransport{
		Proxy:           proxy,
		RemoteAddr:      remote,
		Timeout:         timeout,
		UseNonESPMarker: true,
		remote:          socksAddress{host: strings.Trim(host, "[]"), port: uint16(portNumber)},
		ike:             make(chan []byte, 16),
		esp:             make(chan []byte, 64),
		done:            make(chan struct{}),
	}, nil
}

func (t *SOCKSNATTTransport) ExchangeIKE(ctx context.Context, request []byte) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := t.ensureConnected(ctx); err != nil {
		return nil, err
	}
	wire := append([]byte(nil), request...)
	if t.UseNonESPMarker {
		wire = append([]byte{0, 0, 0, 0}, wire...)
	}
	if err := t.writePayload(wire); err != nil {
		return nil, err
	}
	select {
	case response := <-t.ike:
		return response, nil
	case <-t.done:
		return nil, t.terminalError()
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(t.timeout()):
		return nil, fmt.Errorf("%w: IKE response timeout", ErrSOCKSUDPTransport)
	}
}

func (t *SOCKSNATTTransport) SendESPPacket(ctx context.Context, packet []byte) error {
	if len(packet) < 8 || isNonESPMarker(packet) {
		return fmt.Errorf("%w: invalid ESP packet", ErrSOCKSUDPTransport)
	}
	if err := t.ensureConnected(ctx); err != nil {
		return err
	}
	return t.writePayload(packet)
}

func (t *SOCKSNATTTransport) SendNATTKeepalive(ctx context.Context) error {
	if err := t.ensureConnected(ctx); err != nil {
		return err
	}
	return t.writePayload([]byte{0xff})
}

func (t *SOCKSNATTTransport) ReadESPPacket(ctx context.Context) ([]byte, error) {
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

func (t *SOCKSNATTTransport) Close(ctx context.Context) error {
	if t == nil {
		return nil
	}
	var err error
	t.closeOnce.Do(func() {
		t.mu.Lock()
		t.closed = true
		control, udp := t.control, t.udp
		t.control, t.udp = nil, nil
		t.mu.Unlock()
		t.signalDone()
		if udp != nil {
			err = errors.Join(err, udp.Close())
		}
		if control != nil {
			err = errors.Join(err, control.Close())
		}
	})
	return err
}

func (t *SOCKSNATTTransport) ensureConnected(ctx context.Context) error {
	if t == nil {
		return fmt.Errorf("%w: transport is nil", ErrSOCKSUDPTransport)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return ErrPacketTunnelClosed
	}
	if t.started {
		return nil
	}
	proxyAddr, username, password, err := normalizedSOCKSProxy(t.Proxy)
	if err != nil {
		return err
	}
	dialer := net.Dialer{Timeout: t.timeout()}
	control, err := dialer.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return fmt.Errorf("%w: connect control: %v", ErrSOCKSUDPTransport, err)
	}
	failed := true
	defer func() {
		if failed {
			_ = control.Close()
		}
	}()
	_ = control.SetDeadline(time.Now().Add(t.timeout()))
	reader := bufio.NewReader(control)
	methods := []byte{0x00}
	if username != "" || password != "" {
		methods = append(methods, 0x02)
	}
	if _, err := control.Write(append([]byte{0x05, byte(len(methods))}, methods...)); err != nil {
		return fmt.Errorf("%w: method request: %v", ErrSOCKSUDPTransport, err)
	}
	methodReply := make([]byte, 2)
	if _, err := io.ReadFull(reader, methodReply); err != nil || methodReply[0] != 0x05 || methodReply[1] == 0xff {
		return fmt.Errorf("%w: method negotiation failed", ErrSOCKSUDPTransport)
	}
	if methodReply[1] == 0x02 {
		if err := socksUsernamePassword(control, reader, username, password); err != nil {
			return err
		}
	} else if methodReply[1] != 0x00 {
		return fmt.Errorf("%w: unsupported auth method %d", ErrSOCKSUDPTransport, methodReply[1])
	}
	if _, err := control.Write([]byte{0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		return fmt.Errorf("%w: UDP ASSOCIATE request: %v", ErrSOCKSUDPTransport, err)
	}
	relay, err := readSOCKSReply(reader, proxyAddr)
	if err != nil {
		return err
	}
	udp, err := dialer.DialContext(ctx, "udp", net.JoinHostPort(relay.host, strconv.Itoa(int(relay.port))))
	if err != nil {
		return fmt.Errorf("%w: connect UDP relay: %v", ErrSOCKSUDPTransport, err)
	}
	_ = control.SetDeadline(time.Time{})
	t.control, t.udp, t.started = control, udp, true
	failed = false
	go t.readLoop(udp)
	return nil
}

func (t *SOCKSNATTTransport) writePayload(payload []byte) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	t.mu.Lock()
	udp, remote, closed := t.udp, t.remote, t.closed
	t.mu.Unlock()
	if closed || udp == nil {
		return ErrPacketTunnelClosed
	}
	wire, err := encodeSOCKSUDP(remote, payload)
	if err != nil {
		return err
	}
	_, err = udp.Write(wire)
	if err != nil {
		return fmt.Errorf("%w: UDP write: %v", ErrSOCKSUDPTransport, err)
	}
	return nil
}

func (t *SOCKSNATTTransport) readLoop(conn net.Conn) {
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
		payload, err := decodeSOCKSUDP(buf[:n])
		if err != nil || len(payload) == 0 || isNATTKeepalive(payload) {
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

func (t *SOCKSNATTTransport) finishRead(err error) {
	t.mu.Lock()
	if !t.closed {
		t.readErr = err
		t.closed = true
	}
	t.mu.Unlock()
	t.signalDone()
	_ = t.Close(context.Background())
}

func (t *SOCKSNATTTransport) signalDone() {
	t.doneOnce.Do(func() { close(t.done) })
}

func (t *SOCKSNATTTransport) terminalError() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.readErr != nil {
		return fmt.Errorf("%w: %v", ErrSOCKSUDPTransport, t.readErr)
	}
	return ErrPacketTunnelClosed
}

func (t *SOCKSNATTTransport) timeout() time.Duration {
	if t != nil && t.Timeout > 0 {
		return t.Timeout
	}
	return 8 * time.Second
}

func normalizedSOCKSProxy(proxy ProxyConfig) (address, username, password string, err error) {
	address = strings.TrimSpace(proxy.Address)
	if address == "" {
		address = strings.TrimSpace(proxy.Addr)
	}
	username, password = proxy.Username, proxy.Password
	if raw := strings.TrimSpace(proxy.URL); raw != "" {
		parsed, parseErr := url.Parse(raw)
		if parseErr != nil || (parsed.Scheme != "socks5" && parsed.Scheme != "socks5h") {
			return "", "", "", fmt.Errorf("%w: invalid proxy URL", ErrSOCKSUDPTransport)
		}
		address = parsed.Host
		if parsed.User != nil {
			username = parsed.User.Username()
			password, _ = parsed.User.Password()
		}
	}
	if _, _, splitErr := net.SplitHostPort(address); splitErr != nil {
		return "", "", "", fmt.Errorf("%w: proxy address: %v", ErrSOCKSUDPTransport, splitErr)
	}
	if len(username) > 255 || len(password) > 255 {
		return "", "", "", fmt.Errorf("%w: proxy credentials too long", ErrSOCKSUDPTransport)
	}
	return address, username, password, nil
}

func socksUsernamePassword(conn net.Conn, reader *bufio.Reader, username, password string) error {
	request := []byte{0x01, byte(len(username))}
	request = append(request, username...)
	request = append(request, byte(len(password)))
	request = append(request, password...)
	if _, err := conn.Write(request); err != nil {
		return fmt.Errorf("%w: username/password request: %v", ErrSOCKSUDPTransport, err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(reader, reply); err != nil || reply[1] != 0 {
		return fmt.Errorf("%w: username/password rejected", ErrSOCKSUDPTransport)
	}
	return nil
}

func readSOCKSReply(reader *bufio.Reader, proxyAddr string) (socksAddress, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil || header[0] != 0x05 || header[1] != 0 {
		return socksAddress{}, fmt.Errorf("%w: UDP ASSOCIATE rejected", ErrSOCKSUDPTransport)
	}
	host, err := readSOCKSHost(reader, header[3])
	if err != nil {
		return socksAddress{}, err
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(reader, portBytes); err != nil {
		return socksAddress{}, fmt.Errorf("%w: relay port: %v", ErrSOCKSUDPTransport, err)
	}
	if host == "0.0.0.0" || host == "::" || host == "" {
		host, _, _ = net.SplitHostPort(proxyAddr)
	}
	port := binary.BigEndian.Uint16(portBytes)
	if port == 0 {
		return socksAddress{}, fmt.Errorf("%w: relay port is zero", ErrSOCKSUDPTransport)
	}
	return socksAddress{host: host, port: port}, nil
}

func readSOCKSHost(reader *bufio.Reader, atyp byte) (string, error) {
	switch atyp {
	case 0x01:
		value := make([]byte, 4)
		if _, err := io.ReadFull(reader, value); err != nil {
			return "", err
		}
		return net.IP(value).String(), nil
	case 0x04:
		value := make([]byte, 16)
		if _, err := io.ReadFull(reader, value); err != nil {
			return "", err
		}
		return net.IP(value).String(), nil
	case 0x03:
		length, err := reader.ReadByte()
		if err != nil || length == 0 {
			return "", fmt.Errorf("%w: relay domain", ErrSOCKSUDPTransport)
		}
		value := make([]byte, int(length))
		if _, err := io.ReadFull(reader, value); err != nil {
			return "", err
		}
		return string(value), nil
	default:
		return "", fmt.Errorf("%w: relay address type %d", ErrSOCKSUDPTransport, atyp)
	}
}

func encodeSOCKSUDP(destination socksAddress, payload []byte) ([]byte, error) {
	frame := []byte{0, 0, 0}
	if ip := net.ParseIP(destination.host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			frame = append(frame, 0x01)
			frame = append(frame, v4...)
		} else {
			frame = append(frame, 0x04)
			frame = append(frame, ip.To16()...)
		}
	} else {
		encoded := []byte(destination.host)
		if len(encoded) == 0 || len(encoded) > 255 {
			return nil, fmt.Errorf("%w: invalid destination host", ErrSOCKSUDPTransport)
		}
		frame = append(frame, 0x03, byte(len(encoded)))
		frame = append(frame, encoded...)
	}
	frame = binary.BigEndian.AppendUint16(frame, destination.port)
	return append(frame, payload...), nil
}

func decodeSOCKSUDP(frame []byte) ([]byte, error) {
	if len(frame) < 4 || frame[0] != 0 || frame[1] != 0 || frame[2] != 0 {
		return nil, fmt.Errorf("%w: invalid UDP header", ErrSOCKSUDPTransport)
	}
	offset := 4
	switch frame[3] {
	case 0x01:
		offset += 4
	case 0x04:
		offset += 16
	case 0x03:
		if len(frame) < 5 || frame[4] == 0 {
			return nil, fmt.Errorf("%w: invalid UDP domain", ErrSOCKSUDPTransport)
		}
		offset = 5 + int(frame[4])
	default:
		return nil, fmt.Errorf("%w: invalid UDP address type", ErrSOCKSUDPTransport)
	}
	if len(frame) < offset+2 {
		return nil, fmt.Errorf("%w: truncated UDP frame", ErrSOCKSUDPTransport)
	}
	return append([]byte(nil), frame[offset+2:]...), nil
}
