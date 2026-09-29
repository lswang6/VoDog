package ikev2

import (
	"bytes"
	"encoding/hex"
	"errors"
	"testing"
)

func TestMessageMarshalParseRoundTrip(t *testing.T) {
	msg := Message{
		Header: Header{
			InitiatorSPI: 0x0102030405060708,
			ResponderSPI: 0x1112131415161718,
			ExchangeType: ExchangeIKE_SA_INIT,
			Flags:        FlagInitiator,
			MessageID:    7,
		},
		Payloads: []Payload{
			{Type: PayloadSA, Body: []byte{0x01, 0x02, 0x03}},
			NoncePayload([]byte{0x04, 0x05}),
		},
	}
	raw, err := msg.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	if len(raw) != 41 {
		t.Fatalf("len(raw)=%d, want 41", len(raw))
	}
	if got, want := raw[:28], mustHex("01020304050607081112131415161718212022080000000700000029"); !bytes.Equal(got, want) {
		t.Fatalf("header = % X, want % X", got, want)
	}
	parsed, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("ParseMessage() error = %v", err)
	}
	if parsed.Header.NextPayload != PayloadSA || parsed.Header.Length != 41 {
		t.Fatalf("parsed header=%+v", parsed.Header)
	}
	if len(parsed.Payloads) != 2 || parsed.Payloads[0].Type != PayloadSA || parsed.Payloads[1].Type != PayloadNonce {
		t.Fatalf("payloads=%+v", parsed.Payloads)
	}
	if !bytes.Equal(parsed.Payloads[0].Body, []byte{1, 2, 3}) || !bytes.Equal(parsed.Payloads[1].Body, []byte{4, 5}) {
		t.Fatalf("payload bodies=%+v", parsed.Payloads)
	}
}

func TestParseRejectsInvalidLengths(t *testing.T) {
	if _, err := ParseHeader([]byte{1, 2, 3}); !errors.Is(err, ErrShortHeader) {
		t.Fatalf("ParseHeader() err=%v, want ErrShortHeader", err)
	}
	header := mustHex("0102030405060708111213141516171820212208000000070000001b")
	if _, err := ParseHeader(header); !errors.Is(err, ErrInvalidLength) {
		t.Fatalf("ParseHeader() err=%v, want ErrInvalidLength", err)
	}
	if _, err := ParsePayloads(PayloadSA, []byte{0, 0, 0, 3}); !errors.Is(err, ErrInvalidLength) {
		t.Fatalf("ParsePayloads() err=%v, want ErrInvalidLength", err)
	}
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}
