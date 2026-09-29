package ikev2

import (
	"encoding/hex"
	"errors"
	"net"
	"testing"
)

func TestIdentityPayloadMarshalParse(t *testing.T) {
	payload, err := IdentityPayload(PayloadIDi, Identity{Type: IDRFC822Addr, Data: []byte("310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org")})
	if err != nil {
		t.Fatalf("IdentityPayload() error = %v", err)
	}
	id, err := ParseIdentity(payload.Body)
	if err != nil {
		t.Fatalf("ParseIdentity() error = %v", err)
	}
	if payload.Type != PayloadIDi || id.Type != IDRFC822Addr || string(id.Data) != "310280000000001@nai.epc.mnc280.mcc310.3gppnetwork.org" {
		t.Fatalf("payload=%+v id=%+v", payload, id)
	}
}

func TestSWuConfigurationRequestMarshalParse(t *testing.T) {
	cfg := SWuConfigurationRequest()
	body, err := cfg.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	if got, want := hex.EncodeToString(body), "01000000000100000003000000080000000a00000014000000150000"; got != want {
		t.Fatalf("cfg body=%s, want %s", got, want)
	}
	parsed, err := ParseConfiguration(body)
	if err != nil {
		t.Fatalf("ParseConfiguration() error = %v", err)
	}
	if parsed.Type != CFGRequest || len(parsed.Attributes) != 6 || parsed.Attributes[2].Type != ConfigInternalIPv6Address || parsed.Attributes[4].Type != ConfigPCSCFIPv4Address {
		t.Fatalf("parsed=%+v", parsed)
	}
}

func TestIPv4AnyTrafficSelectorMarshalParse(t *testing.T) {
	body, err := IPv4AnyTrafficSelectors().MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	if got, want := hex.EncodeToString(body), "01000000070000100000ffff00000000ffffffff"; got != want {
		t.Fatalf("TS body=%s, want %s", got, want)
	}
	parsed, err := ParseTrafficSelectors(body)
	if err != nil {
		t.Fatalf("ParseTrafficSelectors() error = %v", err)
	}
	ts := parsed.Selectors[0]
	if ts.Type != TSIPv4AddressRange || ts.EndPort != 65535 || !ts.StartAddr.Equal(net.IPv4(0, 0, 0, 0)) || !ts.EndAddr.Equal(net.IPv4(255, 255, 255, 255)) {
		t.Fatalf("selector=%+v", ts)
	}
}

func TestDualStackAnyTrafficSelectorsMarshalParse(t *testing.T) {
	body, err := DualStackAnyTrafficSelectors().MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	parsed, err := ParseTrafficSelectors(body)
	if err != nil {
		t.Fatalf("ParseTrafficSelectors() error = %v", err)
	}
	if len(parsed.Selectors) != 2 || parsed.Selectors[0].Type != TSIPv4AddressRange || parsed.Selectors[1].Type != TSIPv6AddressRange {
		t.Fatalf("selectors=%+v", parsed.Selectors)
	}
	if !parsed.Selectors[1].StartAddr.Equal(net.ParseIP("::")) || !parsed.Selectors[1].EndAddr.Equal(net.ParseIP("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")) {
		t.Fatalf("IPv6 selector=%+v", parsed.Selectors[1])
	}
}

func TestTrafficSelectorRejectsWrongAddressFamily(t *testing.T) {
	_, err := (TrafficSelector{
		Type:      TSIPv4AddressRange,
		StartAddr: net.ParseIP("2001:db8::1"),
		EndAddr:   net.ParseIP("2001:db8::2"),
	}).MarshalBinary()
	if !errors.Is(err, ErrInvalidTrafficSelector) {
		t.Fatalf("MarshalBinary() err=%v, want ErrInvalidTrafficSelector", err)
	}
}

func TestValidateTrafficSelectorNarrowingAllowsSubset(t *testing.T) {
	offered := TrafficSelectors{Selectors: []TrafficSelector{{
		Type:      TSIPv4AddressRange,
		StartPort: 0,
		EndPort:   65535,
		StartAddr: net.IPv4(10, 0, 0, 0),
		EndAddr:   net.IPv4(10, 0, 0, 255),
	}}}
	selected := TrafficSelectors{Selectors: []TrafficSelector{{
		Type:       TSIPv4AddressRange,
		IPProtocol: 17,
		StartPort:  500,
		EndPort:    4500,
		StartAddr:  net.IPv4(10, 0, 0, 10),
		EndAddr:    net.IPv4(10, 0, 0, 20),
	}}}
	if err := ValidateTrafficSelectorNarrowing(offered, selected); err != nil {
		t.Fatalf("ValidateTrafficSelectorNarrowing() error = %v", err)
	}
}

func TestValidateTrafficSelectorNarrowingRejectsWidening(t *testing.T) {
	offered := TrafficSelectors{Selectors: []TrafficSelector{{
		Type:       TSIPv4AddressRange,
		IPProtocol: 17,
		StartPort:  500,
		EndPort:    4500,
		StartAddr:  net.IPv4(10, 0, 0, 10),
		EndAddr:    net.IPv4(10, 0, 0, 20),
	}}}
	selected := TrafficSelectors{Selectors: []TrafficSelector{{
		Type:      TSIPv4AddressRange,
		StartPort: 0,
		EndPort:   65535,
		StartAddr: net.IPv4(10, 0, 0, 0),
		EndAddr:   net.IPv4(10, 0, 0, 255),
	}}}
	if err := ValidateTrafficSelectorNarrowing(offered, selected); !errors.Is(err, ErrInvalidTrafficSelector) {
		t.Fatalf("ValidateTrafficSelectorNarrowing() err=%v, want ErrInvalidTrafficSelector", err)
	}
}
