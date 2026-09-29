//go:build darwin

package swu

import (
	"context"
	"strings"
	"testing"
)

func TestValidDarwinUTUNName(t *testing.T) {
	for _, name := range []string{"utun0", "utun8", "utun254"} {
		if !validDarwinUTUNName(name) {
			t.Fatalf("validDarwinUTUNName(%q)=false", name)
		}
	}
	for _, name := range []string{"", "utun", "utun-1", "utun255", "utun8extra", "tun8"} {
		if validDarwinUTUNName(name) {
			t.Fatalf("validDarwinUTUNName(%q)=true", name)
		}
	}
}

func TestOpenTUNDeviceRejectsDarwinPath(t *testing.T) {
	_, err := OpenTUNDevice(TUNDeviceConfig{Path: "/dev/net/tun"})
	if err == nil || !strings.Contains(err.Error(), "does not accept a device path") {
		t.Fatalf("OpenTUNDevice(path) error = %v", err)
	}
}

func TestOpenAndCloseDarwinUTUNDevice(t *testing.T) {
	device, err := OpenTUNDevice(TUNDeviceConfig{})
	if err != nil {
		if strings.Contains(err.Error(), "operation not permitted") {
			t.Skip("utun creation requires a privileged host on this macOS configuration")
		}
		t.Fatalf("OpenTUNDevice() error = %v", err)
	}
	if name := device.Name(); !strings.HasPrefix(name, "utun") {
		t.Fatalf("Name() = %q, want utun prefix", name)
	}
	if err := device.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}
