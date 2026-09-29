package swu

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestMOBIKENATStateDetectsLocalAddressChange(t *testing.T) {
	start := time.Unix(4000, 0)
	state := NewMOBIKENATState(MOBIKENATStateConfig{
		MOBIKESupported: true,
		LocalIP:         net.ParseIP("192.0.2.10"),
		RemoteIP:        net.ParseIP("198.51.100.10"),
		LocalPort:       4500,
		RemotePort:      4500,
		NATDetected:     true,
		UpdatedAt:       start,
	})
	change := state.Observe(MOBIKENATObservation{
		DeviceID:         "device-a",
		TraceID:          "trace-a",
		LocalIP:          net.ParseIP("192.0.2.11"),
		RemoteIP:         net.ParseIP("198.51.100.10"),
		LocalPort:        4500,
		RemotePort:       4500,
		NATDetected:      true,
		NATDetectedKnown: true,
		At:               start.Add(time.Second),
	})
	if !change.Changed || !change.RequiresMOBIKEUpdate || !change.LocalAddressChanged || change.RemoteAddressChanged ||
		change.Request.OldIP != "192.0.2.10" || change.Request.NewIP != "192.0.2.11" ||
		change.Request.DeviceID != "device-a" || change.Request.TraceID != "trace-a" {
		t.Fatalf("change=%+v", change)
	}
	snapshot, updatedAt := state.Snapshot()
	if got := snapshot.LocalIP.String(); got != "192.0.2.11" || !updatedAt.Equal(start.Add(time.Second)) {
		t.Fatalf("snapshot=%+v updatedAt=%v", snapshot, updatedAt)
	}
}

func TestMOBIKENATStateDetectsNATAndPortChangeWithoutAddressChange(t *testing.T) {
	start := time.Unix(5000, 0)
	state := NewMOBIKENATState(MOBIKENATStateConfig{
		MOBIKESupported: true,
		LocalIP:         net.ParseIP("2001:db8::10"),
		RemoteIP:        net.ParseIP("2001:db8::20"),
		NATDetected:     false,
		UpdatedAt:       start,
	})
	change := state.Observe(MOBIKENATObservation{
		LocalIP:          net.ParseIP("2001:db8::10"),
		RemoteIP:         net.ParseIP("2001:db8::20"),
		LocalPort:        55000,
		RemotePort:       4500,
		NATDetected:      true,
		NATDetectedKnown: true,
		At:               start.Add(2 * time.Second),
	})
	if !change.Changed || !change.RequiresMOBIKEUpdate || !change.PortChanged || !change.NATChanged ||
		change.LocalAddressChanged || change.Request.OldIP != "2001:db8::10" || change.Request.NewIP != "2001:db8::10" {
		t.Fatalf("change=%+v", change)
	}
	if !strings.Contains(change.Reason, "udp port changed") || !strings.Contains(change.Reason, "nat status changed") {
		t.Fatalf("reason=%q", change.Reason)
	}
}

func TestMOBIKENATStateDoesNotRequireUpdateWhenMOBIKEUnsupported(t *testing.T) {
	state := NewMOBIKENATState(MOBIKENATStateConfig{
		MOBIKESupported: false,
		LocalIP:         net.ParseIP("192.0.2.10"),
		RemoteIP:        net.ParseIP("198.51.100.10"),
	})
	change := state.Observe(MOBIKENATObservation{
		LocalIP:  net.ParseIP("192.0.2.12"),
		RemoteIP: net.ParseIP("198.51.100.10"),
	})
	if !change.Changed || change.RequiresMOBIKEUpdate {
		t.Fatalf("change=%+v", change)
	}
}

func TestMOBIKENATStatePreservesNATWhenObservationDoesNotIncludeIt(t *testing.T) {
	state := NewMOBIKENATState(MOBIKENATStateConfig{
		MOBIKESupported: true,
		LocalIP:         net.ParseIP("192.0.2.10"),
		RemoteIP:        net.ParseIP("198.51.100.10"),
		NATDetected:     true,
	})
	change := state.Observe(MOBIKENATObservation{
		LocalIP:  net.ParseIP("192.0.2.10"),
		RemoteIP: net.ParseIP("198.51.100.10"),
	})
	if change.Changed || change.NATChanged {
		t.Fatalf("change=%+v", change)
	}
	snapshot, _ := state.Snapshot()
	if !snapshot.NATDetected {
		t.Fatalf("snapshot=%+v, want NATDetected preserved", snapshot)
	}
}

func TestMOBIKENATStateClonesSnapshot(t *testing.T) {
	state := NewMOBIKENATState(MOBIKENATStateConfig{
		MOBIKESupported: true,
		LocalIP:         net.ParseIP("192.0.2.10"),
		RemoteIP:        net.ParseIP("198.51.100.10"),
	})
	snapshot, _ := state.Snapshot()
	snapshot.LocalIP[0] ^= 0xff
	again, _ := state.Snapshot()
	if got := again.LocalIP.String(); got != "192.0.2.10" {
		t.Fatalf("snapshot mutation leaked, got %s", got)
	}
}
