package simauth

import (
	"bytes"
	"reflect"
	"testing"
)

func TestEncodeTLVRoundTrip(t *testing.T) {
	value := bytes.Repeat([]byte{0xAB}, 128)
	encoded, err := EncodeTLV(0x5F50, value)
	if err != nil {
		t.Fatalf("EncodeTLV() error = %v", err)
	}
	if got, want := encoded[:4], []byte{0x5F, 0x50, 0x81, 0x80}; !reflect.DeepEqual(got, want) {
		t.Fatalf("encoded prefix=% X, want % X", got, want)
	}
	items, err := ParseTLVList(encoded)
	if err != nil {
		t.Fatalf("ParseTLVList() error = %v", err)
	}
	if len(items) != 1 || items[0].Tag != 0x5F50 || !bytes.Equal(items[0].Value, value) {
		t.Fatalf("items=%+v", items)
	}
}

func TestEncodeTLVRejectsInvalidTag(t *testing.T) {
	if got, err := EncodeTLV(0, []byte{1}); err == nil {
		t.Fatalf("EncodeTLV(invalid tag) = %x nil error, want error", got)
	}
}
