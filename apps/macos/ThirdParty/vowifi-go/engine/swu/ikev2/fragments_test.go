package ikev2

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestEncryptedFragmentPayloadMarshalParseRoundTrip(t *testing.T) {
	fragment := EncryptedFragment{
		FragmentNumber: 2,
		TotalFragments: 3,
		EncryptedData:  []byte{0xa1, 0xa2, 0xa3, 0xa4, 0xa5},
	}
	payload, err := EncryptedFragmentPayload(PayloadIDi, fragment)
	if err != nil {
		t.Fatalf("EncryptedFragmentPayload() error = %v", err)
	}
	msg := Message{
		Header: Header{
			InitiatorSPI: 0x0102030405060708,
			ResponderSPI: 0x1112131415161718,
			ExchangeType: ExchangeIKE_AUTH,
			Flags:        FlagInitiator,
			MessageID:    9,
		},
		Payloads: []Payload{payload},
	}
	raw, err := msg.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	if raw[16] != PayloadSKF || raw[28] != PayloadIDi {
		t.Fatalf("outer next=%d fragment next=%d", raw[16], raw[28])
	}
	parsed, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("ParseMessage() error = %v", err)
	}
	if len(parsed.Payloads) != 1 || parsed.Payloads[0].Type != PayloadSKF || parsed.Payloads[0].NextPayload != PayloadIDi {
		t.Fatalf("parsed payloads=%+v", parsed.Payloads)
	}
	parsedFragment, err := ParseEncryptedFragment(parsed.Payloads[0].Body)
	if err != nil {
		t.Fatalf("ParseEncryptedFragment() error = %v", err)
	}
	if parsedFragment.FragmentNumber != fragment.FragmentNumber ||
		parsedFragment.TotalFragments != fragment.TotalFragments ||
		!bytes.Equal(parsedFragment.EncryptedData, fragment.EncryptedData) {
		t.Fatalf("fragment=%+v data=%x", parsedFragment, parsedFragment.EncryptedData)
	}
}

func TestParseEncryptedFragmentRejectsInvalidBoundaries(t *testing.T) {
	tests := []struct {
		name string
		body []byte
	}{
		{"short", []byte{0, 1, 0}},
		{"empty encrypted data", []byte{0, 1, 0, 1}},
		{"zero fragment number", []byte{0, 0, 0, 1, 0xaa}},
		{"zero total fragments", []byte{0, 1, 0, 0, 0xaa}},
		{"fragment after total", []byte{0, 3, 0, 2, 0xaa}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseEncryptedFragment(tt.body)
			if !errors.Is(err, ErrInvalidEncryptedFragment) {
				t.Fatalf("ParseEncryptedFragment() err=%v, want ErrInvalidEncryptedFragment", err)
			}
		})
	}
}

func TestEncryptedFragmentMarshalRejectsInvalidBoundaries(t *testing.T) {
	tests := []struct {
		name     string
		fragment EncryptedFragment
		wantErr  error
	}{
		{"zero fragment number", EncryptedFragment{TotalFragments: 1, EncryptedData: []byte{0xaa}}, ErrInvalidEncryptedFragment},
		{"zero total fragments", EncryptedFragment{FragmentNumber: 1, EncryptedData: []byte{0xaa}}, ErrInvalidEncryptedFragment},
		{"fragment after total", EncryptedFragment{FragmentNumber: 2, TotalFragments: 1, EncryptedData: []byte{0xaa}}, ErrInvalidEncryptedFragment},
		{"empty encrypted data", EncryptedFragment{FragmentNumber: 1, TotalFragments: 1}, ErrInvalidEncryptedFragment},
		{"too large", EncryptedFragment{FragmentNumber: 1, TotalFragments: 1, EncryptedData: []byte(strings.Repeat("x", 0xffff))}, ErrInvalidLength},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := tt.fragment.MarshalBinary()
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("MarshalBinary() err=%v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestMarshalPayloadsRejectsPayloadAfterEncryptedFragment(t *testing.T) {
	fragment, err := EncryptedFragmentPayload(PayloadIDi, EncryptedFragment{
		FragmentNumber: 1,
		TotalFragments: 2,
		EncryptedData:  []byte{0xaa},
	})
	if err != nil {
		t.Fatalf("EncryptedFragmentPayload() error = %v", err)
	}
	_, _, err = MarshalPayloads([]Payload{fragment, NoncePayload([]byte{0x01})})
	if !errors.Is(err, ErrInvalidLength) {
		t.Fatalf("MarshalPayloads(SKF then nonce) err=%v, want ErrInvalidLength", err)
	}
	fragment.NextPayload = PayloadNoNext
	_, _, err = MarshalPayloads([]Payload{fragment, NoncePayload([]byte{0x01})})
	if !errors.Is(err, ErrInvalidLength) {
		t.Fatalf("MarshalPayloads(SKF no inner next then nonce) err=%v, want ErrInvalidLength", err)
	}
}
