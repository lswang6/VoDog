package ikev2

import "bytes"

type ChildSADeleteOutcome uint8

const (
	ChildSADeleteNone ChildSADeleteOutcome = iota
	// ChildSADeleteCurrent means every AH/ESP delete SPI matches the tracked ESP child.
	ChildSADeleteCurrent
	// ChildSADeleteOther means AH/ESP delete payloads exist, but none match the tracked ESP child.
	ChildSADeleteOther
	// ChildSADeleteMixed means an INFORMATIONAL deletes both the tracked child and other AH/ESP SPIs.
	ChildSADeleteMixed
)

type ChildSADeleteMatch struct {
	ProtocolID    uint8
	SPI           []byte
	MatchesLocal  bool
	MatchesRemote bool
}

type ChildSADeleteSummary struct {
	Outcome       ChildSADeleteOutcome
	Deletes       []ChildSADeleteMatch
	CurrentSPIs   [][]byte
	OtherSPIs     [][]byte
	MatchesLocal  bool
	MatchesRemote bool
	DeleteIKE     bool
}

func ClassifyChildSADeletePayloads(payloads []Payload, child ChildSAResult) (ChildSADeleteSummary, error) {
	content, err := ParseInformationalContent(payloads)
	if err != nil {
		return ChildSADeleteSummary{}, err
	}
	return ClassifyChildSADeletes(content, child), nil
}

// ClassifyChildSADeletes summarizes AH/ESP Delete payloads against a tracked ESP child SA.
func ClassifyChildSADeletes(content InformationalContent, child ChildSAResult) ChildSADeleteSummary {
	var out ChildSADeleteSummary
	for _, deletePayload := range content.Deletes {
		switch deletePayload.ProtocolID {
		case ProtocolIKE:
			out.DeleteIKE = true
		case ProtocolAH, ProtocolESP:
			classifyChildSADeleteSPIs(&out, deletePayload, child)
		}
	}
	out.Outcome = childSADeleteOutcome(out)
	return out
}

func classifyChildSADeleteSPIs(out *ChildSADeleteSummary, deletePayload Delete, child ChildSAResult) {
	for _, spi := range deletePayload.SPIs {
		match := ChildSADeleteMatch{
			ProtocolID: deletePayload.ProtocolID,
			SPI:        append([]byte(nil), spi...),
		}
		if deletePayload.ProtocolID == ProtocolESP {
			match.MatchesLocal = len(child.LocalSPI) > 0 && bytes.Equal(spi, child.LocalSPI)
			match.MatchesRemote = len(child.RemoteSPI) > 0 && bytes.Equal(spi, child.RemoteSPI)
		}
		out.Deletes = append(out.Deletes, match)
		if match.MatchesLocal || match.MatchesRemote {
			out.CurrentSPIs = append(out.CurrentSPIs, append([]byte(nil), spi...))
			out.MatchesLocal = out.MatchesLocal || match.MatchesLocal
			out.MatchesRemote = out.MatchesRemote || match.MatchesRemote
			continue
		}
		out.OtherSPIs = append(out.OtherSPIs, append([]byte(nil), spi...))
	}
}

func childSADeleteOutcome(summary ChildSADeleteSummary) ChildSADeleteOutcome {
	switch {
	case len(summary.Deletes) == 0:
		return ChildSADeleteNone
	case len(summary.CurrentSPIs) > 0 && len(summary.OtherSPIs) > 0:
		return ChildSADeleteMixed
	case len(summary.CurrentSPIs) > 0:
		return ChildSADeleteCurrent
	default:
		return ChildSADeleteOther
	}
}

func cloneChildSADeleteSummary(in ChildSADeleteSummary) ChildSADeleteSummary {
	out := in
	out.Deletes = make([]ChildSADeleteMatch, len(in.Deletes))
	for i, match := range in.Deletes {
		out.Deletes[i] = ChildSADeleteMatch{
			ProtocolID:    match.ProtocolID,
			SPI:           append([]byte(nil), match.SPI...),
			MatchesLocal:  match.MatchesLocal,
			MatchesRemote: match.MatchesRemote,
		}
	}
	out.CurrentSPIs = cloneByteSlices(in.CurrentSPIs)
	out.OtherSPIs = cloneByteSlices(in.OtherSPIs)
	return out
}
