package ikev2

import (
	"bytes"
	"errors"
	"testing"
)

func TestClassifyChildSADeletesCurrentAndOther(t *testing.T) {
	localSPI := []byte{0x11, 0x22, 0x33, 0x44}
	remoteSPI := []byte{0xaa, 0xbb, 0xcc, 0xdd}
	otherSPI := []byte{0xde, 0xad, 0xbe, 0xef}
	ahSPI := []byte{0x55, 0x66, 0x77, 0x88}
	espDelete, err := ESPDeletePayload(localSPI, otherSPI)
	if err != nil {
		t.Fatalf("ESPDeletePayload() error = %v", err)
	}
	ahDelete, err := DeletePayload(Delete{ProtocolID: ProtocolAH, SPIs: [][]byte{ahSPI}})
	if err != nil {
		t.Fatalf("DeletePayload(AH) error = %v", err)
	}
	content, err := ParseInformationalContent([]Payload{IKEDeletePayload(), espDelete, ahDelete})
	if err != nil {
		t.Fatalf("ParseInformationalContent() error = %v", err)
	}
	summary := ClassifyChildSADeletes(content, ChildSAResult{
		LocalSPI:  localSPI,
		RemoteSPI: remoteSPI,
	})
	if summary.Outcome != ChildSADeleteMixed || !summary.DeleteIKE ||
		!summary.MatchesLocal || summary.MatchesRemote ||
		len(summary.Deletes) != 3 || len(summary.CurrentSPIs) != 1 || len(summary.OtherSPIs) != 2 {
		t.Fatalf("summary=%+v", summary)
	}
	if summary.Deletes[0].ProtocolID != ProtocolESP ||
		!summary.Deletes[0].MatchesLocal || summary.Deletes[0].MatchesRemote ||
		!bytes.Equal(summary.Deletes[0].SPI, localSPI) {
		t.Fatalf("current match=%+v", summary.Deletes[0])
	}
	if !bytes.Equal(summary.OtherSPIs[0], otherSPI) || !bytes.Equal(summary.OtherSPIs[1], ahSPI) {
		t.Fatalf("other SPIs=%x", summary.OtherSPIs)
	}

	summary.Deletes[0].SPI[0] = 0
	summary.CurrentSPIs[0][0] = 0
	if !bytes.Equal(content.Deletes[1].SPIs[0], localSPI) || !bytes.Equal(localSPI, []byte{0x11, 0x22, 0x33, 0x44}) {
		t.Fatalf("classification did not clone delete SPI metadata")
	}
}

func TestClassifyChildSADeletesMatchesRemoteSPI(t *testing.T) {
	remoteSPI := []byte{0xaa, 0xbb, 0xcc, 0xdd}
	payload, err := ESPDeletePayload(remoteSPI)
	if err != nil {
		t.Fatalf("ESPDeletePayload() error = %v", err)
	}
	summary, err := ClassifyChildSADeletePayloads([]Payload{payload}, ChildSAResult{
		LocalSPI:  []byte{0x11, 0x22, 0x33, 0x44},
		RemoteSPI: remoteSPI,
	})
	if err != nil {
		t.Fatalf("ClassifyChildSADeletePayloads() error = %v", err)
	}
	if summary.Outcome != ChildSADeleteCurrent || summary.MatchesLocal || !summary.MatchesRemote ||
		len(summary.Deletes) != 1 || len(summary.CurrentSPIs) != 1 || len(summary.OtherSPIs) != 0 {
		t.Fatalf("summary=%+v", summary)
	}
	if !summary.Deletes[0].MatchesRemote || !bytes.Equal(summary.Deletes[0].SPI, remoteSPI) {
		t.Fatalf("delete match=%+v", summary.Deletes[0])
	}
}

func TestClassifyChildSADeletePayloadsOtherAndMalformed(t *testing.T) {
	payload, err := ESPDeletePayload([]byte{0xde, 0xad, 0xbe, 0xef})
	if err != nil {
		t.Fatalf("ESPDeletePayload() error = %v", err)
	}
	summary, err := ClassifyChildSADeletePayloads([]Payload{payload}, ChildSAResult{
		LocalSPI:  []byte{0x11, 0x22, 0x33, 0x44},
		RemoteSPI: []byte{0xaa, 0xbb, 0xcc, 0xdd},
	})
	if err != nil {
		t.Fatalf("ClassifyChildSADeletePayloads() error = %v", err)
	}
	if summary.Outcome != ChildSADeleteOther || len(summary.Deletes) != 1 ||
		len(summary.CurrentSPIs) != 0 || len(summary.OtherSPIs) != 1 {
		t.Fatalf("summary=%+v", summary)
	}

	_, err = ClassifyChildSADeletePayloads([]Payload{
		{Type: PayloadDelete, Body: []byte{ProtocolESP, 4, 0, 1, 1, 2, 3}},
	}, ChildSAResult{})
	if !errors.Is(err, ErrInvalidInformational) || !errors.Is(err, ErrInvalidDelete) {
		t.Fatalf("ClassifyChildSADeletePayloads(malformed) err=%v, want ErrInvalidInformational and ErrInvalidDelete", err)
	}
}
