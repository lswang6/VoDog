//go:build linux

package swu

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const defaultTUNDevicePath = "/dev/net/tun"

type TUNDeviceConfig struct {
	Name string
	Path string
}

type TUNDevice struct {
	mu     sync.Mutex
	file   *os.File
	name   string
	closed bool
}

var _ InnerPacketDeviceCloser = (*TUNDevice)(nil)

func OpenTUNDevice(cfg TUNDeviceConfig) (*TUNDevice, error) {
	if err := validateTUNName(cfg.Name); err != nil {
		return nil, err
	}
	path := strings.TrimSpace(cfg.Path)
	if path == "" {
		path = defaultTUNDevicePath
	}
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("%w: open %s: %v", ErrInvalidPacketTunnel, path, err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("%w: open %s returned nil file", ErrInvalidPacketTunnel, path)
	}
	ifr, err := unix.NewIfreq(strings.TrimSpace(cfg.Name))
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("%w: tun name: %v", ErrInvalidPacketTunnel, err)
	}
	ifr.SetUint16(uint16(unix.IFF_TUN | unix.IFF_NO_PI))
	if err := unix.IoctlIfreq(int(file.Fd()), uint(unix.TUNSETIFF), ifr); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("%w: TUNSETIFF: %v", ErrInvalidPacketTunnel, err)
	}
	return &TUNDevice{file: file, name: ifr.Name()}, nil
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
	file := d.file
	closed := d.closed
	d.mu.Unlock()
	if closed || file == nil {
		return nil, ErrPacketTunnelClosed
	}
	buf := make([]byte, 64*1024)
	n, err := file.Read(buf)
	if err != nil {
		return nil, tunDeviceError(ctx, err)
	}
	return append([]byte(nil), buf[:n]...), nil
}

func (d *TUNDevice) WriteInnerPacket(ctx context.Context, packet []byte) error {
	if d == nil {
		return ErrInvalidPacketTunnel
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := contextReady(ctx); err != nil {
		return err
	}
	if len(packet) == 0 {
		return nil
	}
	d.mu.Lock()
	file := d.file
	closed := d.closed
	d.mu.Unlock()
	if closed || file == nil {
		return ErrPacketTunnelClosed
	}
	n, err := file.Write(packet)
	if err != nil {
		return tunDeviceError(ctx, err)
	}
	if n != len(packet) {
		return io.ErrShortWrite
	}
	return nil
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
	return tunDeviceError(ctx, file.Close())
}

func validateTUNName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	if strings.ContainsAny(name, "/\x00") {
		return fmt.Errorf("%w: invalid tun name %q", ErrInvalidPacketTunnel, name)
	}
	if len(name) >= unix.IFNAMSIZ {
		return fmt.Errorf("%w: tun name %q exceeds %d bytes", ErrInvalidPacketTunnel, name, unix.IFNAMSIZ-1)
	}
	return nil
}

func tunDeviceError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
	}
	if strings.Contains(err.Error(), "file already closed") || strings.Contains(err.Error(), "use of closed file") {
		return ErrPacketTunnelClosed
	}
	return err
}
