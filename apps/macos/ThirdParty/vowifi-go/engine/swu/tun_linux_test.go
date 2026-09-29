//go:build linux

package swu

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestValidateTUNName(t *testing.T) {
	if err := validateTUNName(""); err != nil {
		t.Fatalf("validateTUNName(empty) error = %v", err)
	}
	if err := validateTUNName("vohive0"); err != nil {
		t.Fatalf("validateTUNName(valid) error = %v", err)
	}
	if err := validateTUNName("bad/name"); !errors.Is(err, ErrInvalidPacketTunnel) {
		t.Fatalf("validateTUNName(slash) err=%v, want ErrInvalidPacketTunnel", err)
	}
	if err := validateTUNName(strings.Repeat("a", 16)); !errors.Is(err, ErrInvalidPacketTunnel) {
		t.Fatalf("validateTUNName(long) err=%v, want ErrInvalidPacketTunnel", err)
	}
}

func TestOpenTUNDeviceRejectsInvalidNameBeforeOpeningDevice(t *testing.T) {
	_, err := OpenTUNDevice(TUNDeviceConfig{Name: "bad/name", Path: "/definitely/not/a/tun"})
	if !errors.Is(err, ErrInvalidPacketTunnel) {
		t.Fatalf("OpenTUNDevice() err=%v, want ErrInvalidPacketTunnel", err)
	}
	if err == nil || strings.Contains(err.Error(), "/definitely/not/a/tun") {
		t.Fatalf("OpenTUNDevice() should reject the name before opening path, err=%v", err)
	}
}

func TestNilTUNDeviceMethods(t *testing.T) {
	var dev *TUNDevice
	if dev.Name() != "" {
		t.Fatalf("nil Name()=%q, want empty", dev.Name())
	}
	if _, err := dev.ReadInnerPacket(context.Background()); !errors.Is(err, ErrInvalidPacketTunnel) {
		t.Fatalf("nil ReadInnerPacket() err=%v, want ErrInvalidPacketTunnel", err)
	}
	if err := dev.WriteInnerPacket(context.Background(), []byte{0x45}); !errors.Is(err, ErrInvalidPacketTunnel) {
		t.Fatalf("nil WriteInnerPacket() err=%v, want ErrInvalidPacketTunnel", err)
	}
	if err := dev.Close(context.Background()); err != nil {
		t.Fatalf("nil Close() error = %v", err)
	}
}
