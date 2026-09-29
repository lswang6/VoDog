package swu

import (
	"errors"
	"testing"
)

func TestTunnelConfigValidateAllowsExplicitEPDG(t *testing.T) {
	cfg := TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        DataplaneModeUserspace,
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestTunnelConfigValidateAllowsCarrierDerivedEPDG(t *testing.T) {
	cfg := TunnelConfig{
		DeviceID: "dev-1",
		MCC:      "310",
		MNC:      "280",
		Identity: IMSIdentity{IMPI: "310280000000001@private.att.net"},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestTunnelConfigValidateAllowsKernelMode(t *testing.T) {
	cfg := TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        " Kernel ",
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	}
	if got := cfg.NormalizedMode(); got != DataplaneModeKernel {
		t.Fatalf("NormalizedMode()=%q, want %q", got, DataplaneModeKernel)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestTunnelConfigValidateRejectsUnknownDataplaneMode(t *testing.T) {
	err := (TunnelConfig{
		DeviceID:    "dev-1",
		Mode:        "wireguard",
		EPDGAddress: "epdg.example",
		IMSI:        "310280000000001",
	}).Validate()
	if !errors.Is(err, ErrInvalidTunnelConfig) {
		t.Fatalf("Validate() err=%v, want ErrInvalidTunnelConfig", err)
	}
}

func TestTunnelConfigValidateRejectsMissingIdentity(t *testing.T) {
	err := (TunnelConfig{
		DeviceID:    "dev-1",
		EPDGAddress: "epdg.example",
	}).Validate()
	if !errors.Is(err, ErrInvalidTunnelConfig) {
		t.Fatalf("Validate() err=%v, want ErrInvalidTunnelConfig", err)
	}
}

func TestTunnelResultReadyRequiresIKEAndIPsec(t *testing.T) {
	if (TunnelResult{Ready: true, IKEEstablished: true}).IsReady() {
		t.Fatalf("IsReady()=true without IPsec")
	}
	if !(TunnelResult{Ready: true, IKEEstablished: true, IPsecEstablished: true}).IsReady() {
		t.Fatalf("IsReady()=false with all readiness flags")
	}
}
