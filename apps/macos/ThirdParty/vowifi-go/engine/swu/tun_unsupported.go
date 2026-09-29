//go:build !linux && !darwin

package swu

import (
	"context"
	"fmt"
	"runtime"
)

type TUNDeviceConfig struct {
	Name string
	Path string
}

type TUNDevice struct{}

var _ InnerPacketDeviceCloser = (*TUNDevice)(nil)

func OpenTUNDevice(cfg TUNDeviceConfig) (*TUNDevice, error) {
	return nil, fmt.Errorf("%w: tun device unsupported on %s", ErrInvalidPacketTunnel, runtime.GOOS)
}

func (d *TUNDevice) Name() string { return "" }

func (d *TUNDevice) ReadInnerPacket(ctx context.Context) ([]byte, error) {
	return nil, ErrInvalidPacketTunnel
}

func (d *TUNDevice) WriteInnerPacket(ctx context.Context, packet []byte) error {
	return ErrInvalidPacketTunnel
}

func (d *TUNDevice) Close(ctx context.Context) error { return nil }
