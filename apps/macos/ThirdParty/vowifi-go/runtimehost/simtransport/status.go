package simtransport

import (
	"fmt"
	"strings"
)

type APDUStatusClass string

const (
	APDUStatusClassSuccess        APDUStatusClass = "success"
	APDUStatusClassProcedure      APDUStatusClass = "procedure"
	APDUStatusClassWarning        APDUStatusClass = "warning"
	APDUStatusClassExecutionError APDUStatusClass = "execution_error"
	APDUStatusClassCheckingError  APDUStatusClass = "checking_error"
	APDUStatusClassUnknown        APDUStatusClass = "unknown"
)

type APDUStatusInfo struct {
	SW1         byte
	SW2         byte
	Status      uint16
	Class       APDUStatusClass
	Recovery    RecoveryClass
	Meaning     string
	Detail      string
	MoreData    bool
	Remaining   int
	CorrectLe   int
	RetriesLeft int
}

func DescribeAPDUStatus(sw1, sw2 byte) APDUStatusInfo {
	info := APDUStatusInfo{
		SW1:      sw1,
		SW2:      sw2,
		Status:   uint16(sw1)<<8 | uint16(sw2),
		Class:    APDUStatusClassUnknown,
		Recovery: StatusRecoveryClass(sw1, sw2),
		Meaning:  "unknown APDU status",
	}

	if meaning, ok := exactAPDUStatusMeanings[info.Status]; ok {
		info.Meaning = meaning
		info.Class = classForAPDUStatusSW1(sw1)
	}

	switch {
	case sw1 == 0x90 && sw2 == 0x00:
		info.Class = APDUStatusClassSuccess
		info.Meaning = "command successful"
	case sw1 == 0x61 || sw1 == 0x9F:
		info.Class = APDUStatusClassProcedure
		info.Meaning = "response bytes available"
		info.MoreData = true
		info.Remaining = apduLeFromSW2(sw2)
		info.Detail = fmt.Sprintf("%d byte(s) available via GET RESPONSE", info.Remaining)
	case sw1 == 0x6C:
		info.Class = APDUStatusClassProcedure
		info.Meaning = "wrong Le field"
		info.CorrectLe = apduLeFromSW2(sw2)
		info.Detail = fmt.Sprintf("retry with Le=%d", info.CorrectLe)
	case sw1 == 0x63 && sw2&0xF0 == 0xC0:
		info.Class = APDUStatusClassWarning
		info.Meaning = "verification failed"
		info.RetriesLeft = int(sw2 & 0x0F)
		info.Detail = fmt.Sprintf("%d retry attempt(s) left", info.RetriesLeft)
	case info.Class == APDUStatusClassUnknown:
		info.Class, info.Meaning = genericAPDUStatusMeaning(sw1, sw2)
	}

	return info
}

func (i APDUStatusInfo) StatusString() string {
	return fmt.Sprintf("%02X%02X", i.SW1, i.SW2)
}

func (i APDUStatusInfo) String() string {
	parts := []string{i.StatusString(), i.Meaning}
	if strings.TrimSpace(i.Detail) != "" {
		parts = append(parts, i.Detail)
	}
	return strings.Join(parts, ": ")
}

func (r APDUResult) StatusInfo() APDUStatusInfo {
	return DescribeAPDUStatus(r.SW1, r.SW2)
}

func (r APDUResult) StatusDescription() string {
	return r.StatusInfo().String()
}

func (r CRSMResult) StatusInfo() APDUStatusInfo {
	return DescribeAPDUStatus(r.SW1, r.SW2)
}

func (r CRSMResult) StatusDescription() string {
	return r.StatusInfo().String()
}

var exactAPDUStatusMeanings = map[uint16]string{
	0x6200: "warning: non-volatile memory unchanged",
	0x6281: "part of returned data may be corrupted",
	0x6282: "end of file or record reached before reading Le bytes",
	0x6283: "selected file invalidated",
	0x6284: "selected file control information is not formatted",
	0x6300: "warning: non-volatile memory changed",
	0x6400: "execution error: non-volatile memory unchanged",
	0x6500: "execution error: non-volatile memory changed",
	0x6581: "memory failure",
	0x6700: "wrong length",
	0x6800: "functions in CLA not supported",
	0x6881: "logical channel not supported",
	0x6882: "secure messaging not supported",
	0x6883: "last command of chain expected",
	0x6884: "command chaining not supported",
	0x6900: "command not allowed",
	0x6981: "command incompatible with file structure",
	0x6982: "security status not satisfied",
	0x6983: "authentication method blocked",
	0x6984: "referenced data invalidated",
	0x6985: "conditions of use not satisfied",
	0x6986: "command not allowed without current elementary file",
	0x6987: "expected secure messaging object missing",
	0x6988: "secure messaging object incorrect",
	0x6A80: "incorrect parameters in command data",
	0x6A81: "function not supported",
	0x6A82: "file or application not found",
	0x6A83: "record not found",
	0x6A84: "not enough memory space",
	0x6A85: "Lc inconsistent with TLV structure",
	0x6A86: "incorrect P1 or P2 parameter",
	0x6A87: "Lc inconsistent with P1 or P2",
	0x6A88: "referenced data or object not found",
	0x6B00: "wrong P1 or P2 parameter",
	0x6D00: "instruction code not supported or invalid",
	0x6E00: "class not supported",
	0x6F00: "technical problem with no precise diagnosis",
}

func classForAPDUStatusSW1(sw1 byte) APDUStatusClass {
	switch sw1 {
	case 0x62, 0x63:
		return APDUStatusClassWarning
	case 0x64, 0x65, 0x6F:
		return APDUStatusClassExecutionError
	case 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6D, 0x6E:
		return APDUStatusClassCheckingError
	default:
		return APDUStatusClassUnknown
	}
}

func genericAPDUStatusMeaning(sw1, sw2 byte) (APDUStatusClass, string) {
	switch sw1 {
	case 0x62:
		return APDUStatusClassWarning, "warning: non-volatile memory unchanged"
	case 0x63:
		return APDUStatusClassWarning, "warning: non-volatile memory changed"
	case 0x64:
		return APDUStatusClassExecutionError, "execution error: non-volatile memory unchanged"
	case 0x65:
		return APDUStatusClassExecutionError, "execution error: non-volatile memory changed"
	case 0x67:
		return APDUStatusClassCheckingError, "wrong length"
	case 0x68:
		return APDUStatusClassCheckingError, "functions in CLA not supported"
	case 0x69:
		return APDUStatusClassCheckingError, "command not allowed"
	case 0x6A:
		return APDUStatusClassCheckingError, "wrong parameters P1-P2 or command data"
	case 0x6B:
		return APDUStatusClassCheckingError, "wrong P1 or P2 parameter"
	case 0x6D:
		return APDUStatusClassCheckingError, "instruction code not supported or invalid"
	case 0x6E:
		return APDUStatusClassCheckingError, "class not supported"
	case 0x6F:
		return APDUStatusClassExecutionError, "technical problem with no precise diagnosis"
	default:
		return APDUStatusClassUnknown, fmt.Sprintf("unknown APDU status %02X%02X", sw1, sw2)
	}
}
