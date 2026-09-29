//go:build darwin

package swu

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const (
	darwinSystemProtocolControl = 2
	darwinUTUNControlName       = "com.apple.net.utun_control"
	darwinUTUNOptionInterface   = 2
	darwinUTUNHeaderSize        = 4
)

type TUNDeviceConfig struct {
	Name string
	Path string
}

// TUNDevice adapts macOS' utun socket framing to the raw inner-IP packet
// contract used by PacketPump. utun prepends a four-byte, big-endian address
// family to every packet; callers of this type never see that platform detail.
type TUNDevice struct {
	mu     sync.Mutex
	file   *os.File
	name   string
	closed bool
}

var _ InnerPacketDeviceCloser = (*TUNDevice)(nil)

func OpenTUNDevice(cfg TUNDeviceConfig) (*TUNDevice, error) {
	if strings.TrimSpace(cfg.Path) != "" {
		return nil, fmt.Errorf("%w: darwin utun does not accept a device path", ErrInvalidPacketTunnel)
	}
	wanted := strings.TrimSpace(cfg.Name)
	if wanted != "" && !validDarwinUTUNName(wanted) {
		return nil, fmt.Errorf("%w: invalid utun name %q", ErrInvalidPacketTunnel, wanted)
	}

	fd, err := unix.Socket(unix.AF_SYSTEM, unix.SOCK_DGRAM, darwinSystemProtocolControl)
	if err != nil {
		return nil, fmt.Errorf("%w: create utun control socket: %v", ErrInvalidPacketTunnel, err)
	}
	closeFD := true
	defer func() {
		if closeFD {
			_ = unix.Close(fd)
		}
	}()

	var info unix.CtlInfo
	copy(info.Name[:], darwinUTUNControlName)
	if err := unix.IoctlCtlInfo(fd, &info); err != nil {
		return nil, fmt.Errorf("%w: resolve utun control: %v", ErrInvalidPacketTunnel, err)
	}
	unit, err := connectDarwinUTUN(fd, info.Id, wanted)
	if err != nil {
		return nil, err
	}
	name, err := unix.GetsockoptString(fd, darwinSystemProtocolControl, darwinUTUNOptionInterface)
	if err != nil || strings.TrimSpace(name) == "" {
		// The unit is one-based while the public utun suffix is zero-based.
		name = fmt.Sprintf("utun%d", unit-1)
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		return nil, fmt.Errorf("%w: create file for %s", ErrInvalidPacketTunnel, name)
	}
	closeFD = false
	return &TUNDevice{file: file, name: strings.TrimSpace(name)}, nil
}

func connectDarwinUTUN(fd int, controlID uint32, wanted string) (uint32, error) {
	first, last := uint32(1), uint32(255)
	if wanted != "" {
		var index uint32
		if _, err := fmt.Sscanf(wanted, "utun%d", &index); err != nil {
			return 0, fmt.Errorf("%w: invalid utun name %q", ErrInvalidPacketTunnel, wanted)
		}
		first, last = index+1, index+1
	}
	var lastErr error
	for unit := first; unit <= last; unit++ {
		if err := unix.Connect(fd, &unix.SockaddrCtl{ID: controlID, Unit: unit}); err == nil {
			return unit, nil
		} else {
			lastErr = err
		}
	}
	return 0, fmt.Errorf("%w: connect utun control: %v", ErrInvalidPacketTunnel, lastErr)
}

func validDarwinUTUNName(name string) bool {
	if !strings.HasPrefix(name, "utun") || len(name) == len("utun") {
		return false
	}
	index, err := strconv.ParseUint(strings.TrimPrefix(name, "utun"), 10, 8)
	return err == nil && index < 255
}

func (d *TUNDevice) Name() string {
	if d == nil {
		return ""
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.name
}

func (d *TUNDevice) ReadInnerPacket(ctx context.Context) ([]byte, error) {
	file, err := d.openFile(ctx)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 64*1024+darwinUTUNHeaderSize)
	n, err := file.Read(buf)
	if err != nil {
		return nil, darwinTUNError(ctx, err)
	}
	if n <= darwinUTUNHeaderSize {
		return nil, fmt.Errorf("%w: short utun frame: %d", ErrInvalidPacketTunnel, n)
	}
	family := binary.BigEndian.Uint32(buf[:darwinUTUNHeaderSize])
	if family != unix.AF_INET && family != unix.AF_INET6 {
		return nil, fmt.Errorf("%w: unsupported utun address family %d", ErrInvalidPacketTunnel, family)
	}
	return append([]byte(nil), buf[darwinUTUNHeaderSize:n]...), nil
}

func (d *TUNDevice) WriteInnerPacket(ctx context.Context, packet []byte) error {
	if len(packet) == 0 {
		return nil
	}
	file, err := d.openFile(ctx)
	if err != nil {
		return err
	}
	var family uint32
	switch packet[0] >> 4 {
	case 4:
		family = unix.AF_INET
	case 6:
		family = unix.AF_INET6
	default:
		return fmt.Errorf("%w: invalid inner IP version", ErrInvalidPacketTunnel)
	}
	frame := make([]byte, darwinUTUNHeaderSize+len(packet))
	binary.BigEndian.PutUint32(frame, family)
	copy(frame[darwinUTUNHeaderSize:], packet)
	n, err := file.Write(frame)
	if err != nil {
		return darwinTUNError(ctx, err)
	}
	if n != len(frame) {
		return io.ErrShortWrite
	}
	return nil
}

func (d *TUNDevice) openFile(ctx context.Context) (*os.File, error) {
	if d == nil {
		return nil, ErrInvalidPacketTunnel
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := contextReady(ctx); err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.file == nil {
		return nil, ErrPacketTunnelClosed
	}
	return d.file, nil
}

func (d *TUNDevice) Close(ctx context.Context) error {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
	file := d.file
	d.file = nil
	d.mu.Unlock()
	if file == nil {
		return nil
	}
	return darwinTUNError(ctx, file.Close())
}

func darwinTUNError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	if strings.Contains(err.Error(), "file already closed") || strings.Contains(err.Error(), "use of closed file") {
		return ErrPacketTunnelClosed
	}
	return err
}
