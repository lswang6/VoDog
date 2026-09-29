package simtransport

import (
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const defaultTimeout = 10 * time.Second

var (
	hexTokenRE = regexp.MustCompile(`(?i)"([0-9a-f]+)"`)
	apduLineRE = regexp.MustCompile(`(?im)^\s*\+(?:CGLA|CSIM):\s*\d+\s*,\s*(?:"([0-9a-fA-F]*)"|([0-9a-fA-F]+))\s*$`)
	cmeErrorRE = regexp.MustCompile(`(?i)\+CME ERROR:\s*([^\r\n]+)`)
	cchoLineRE = regexp.MustCompile(`(?im)^\s*\+CCHO:\s*(\d+)\s*$`)
	crsmLineRE = regexp.MustCompile(`(?im)^\s*\+CRSM:\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:"([0-9a-fA-F]*)"|([0-9a-fA-F]+)))?\s*$`)
	intTokenRE = regexp.MustCompile(`[-+]?\d+`)
)

type ATCommander interface {
	ExecuteATSilent(cmd string, timeout time.Duration) (string, error)
}

type Adapter struct {
	Control ATCommander
	Timeout time.Duration
}

type APDUResult struct {
	Hex  string
	Body string
	SW1  byte
	SW2  byte
}

type CRSMResult struct {
	Data string
	SW1  byte
	SW2  byte
}

func (r APDUResult) Status() uint16 {
	return uint16(r.SW1)<<8 | uint16(r.SW2)
}

func (r APDUResult) StatusString() string {
	return fmt.Sprintf("%02X%02X", r.SW1, r.SW2)
}

func (r APDUResult) Success() bool {
	return r.SW1 == 0x90 && r.SW2 == 0x00
}

func (r CRSMResult) Status() uint16 {
	return uint16(r.SW1)<<8 | uint16(r.SW2)
}

func (r CRSMResult) StatusString() string {
	return fmt.Sprintf("%02X%02X", r.SW1, r.SW2)
}

func (r CRSMResult) Success() bool {
	return r.SW1 == 0x90 && r.SW2 == 0x00
}

func NewAdapter(control ATCommander) *Adapter {
	return &Adapter{Control: control, Timeout: defaultTimeout}
}

func (a *Adapter) ExecuteATSilent(cmd string, timeout time.Duration) (string, error) {
	if a == nil || a.Control == nil {
		return "", errors.New("nil AT control")
	}
	return a.Control.ExecuteATSilent(cmd, timeout)
}

func (a *Adapter) OpenLogicalChannel(aid string) (int, error) {
	if a == nil || a.Control == nil {
		return 0, errors.New("nil AT control")
	}
	aid, err := normalizeHex(aid)
	if err != nil {
		return 0, fmt.Errorf("invalid AID: %w", err)
	}
	out, err := a.Control.ExecuteATSilent(`AT+CCHO="`+aid+`"`, a.timeout())
	if err != nil {
		return 0, err
	}
	if err := parseATError(out); err != nil {
		return 0, err
	}
	channel, ok := parseCCHOChannel(out)
	if !ok || channel < 0 {
		return 0, fmt.Errorf("parse CCHO channel from %q", compactAT(out))
	}
	return channel, nil
}

func (a *Adapter) CloseLogicalChannel(channel int) error {
	if a == nil || a.Control == nil {
		return errors.New("nil AT control")
	}
	if channel < 0 {
		return fmt.Errorf("invalid logical channel: %d", channel)
	}
	out, err := a.Control.ExecuteATSilent(fmt.Sprintf("AT+CCHC=%d", channel), a.timeout())
	if err != nil {
		return err
	}
	return parseATError(out)
}

func (a *Adapter) TransmitAPDU(channel int, hexAPDU string) (string, error) {
	if a == nil || a.Control == nil {
		return "", errors.New("nil AT control")
	}
	apdu, err := normalizeHex(hexAPDU)
	if err != nil {
		return "", fmt.Errorf("invalid APDU: %w", err)
	}
	resp, err := a.transmitAPDUOnce(channel, apdu)
	if err != nil {
		return "", err
	}
	resp, err = a.recoverAPDUStatus(channel, apdu, resp)
	if err != nil {
		return "", err
	}
	return resp.Hex, nil
}

func (a *Adapter) transmitAPDUOnce(channel int, apdu string) (APDUResult, error) {
	var cmd string
	if channel > 0 {
		cmd = fmt.Sprintf(`AT+CGLA=%d,%d,"%s"`, channel, len(apdu), apdu)
	} else {
		cmd = fmt.Sprintf(`AT+CSIM=%d,"%s"`, len(apdu), apdu)
	}
	out, err := a.Control.ExecuteATSilent(cmd, a.timeout())
	if err != nil {
		return APDUResult{}, err
	}
	resp, err := ParseAPDUResult(out)
	if err != nil {
		return APDUResult{}, err
	}
	return resp, nil
}

func (a *Adapter) recoverAPDUStatus(channel int, apdu string, resp APDUResult) (APDUResult, error) {
	bodyPrefix := ""
	usedCorrectLe := false
	getResponses := 0

	for {
		plan := PlanAPDUStatusRecovery(resp.SW1, resp.SW2)
		switch plan.Action {
		case APDURecoveryCorrectLe:
			if usedCorrectLe {
				return mergeAPDUResult(bodyPrefix, resp), nil
			}
			corrected, err := correctAPDUHexLe(apdu, plan.Le)
			if err != nil {
				return mergeAPDUResult(bodyPrefix, resp), nil
			}
			apdu = corrected
			resp, err = a.transmitAPDUOnce(channel, apdu)
			if err != nil {
				return APDUResult{}, err
			}
			usedCorrectLe = true
		case APDURecoveryGetResponse:
			if getResponses >= 4 {
				return mergeAPDUResult(bodyPrefix, resp), nil
			}
			bodyPrefix += resp.Body
			getResponse, err := GetResponseAPDUWithCLA(apduCLA(apdu), plan.Le)
			if err != nil {
				return mergeAPDUResult(bodyPrefix, resp), nil
			}
			apdu = strings.ToUpper(hex.EncodeToString(getResponse))
			resp, err = a.transmitAPDUOnce(channel, apdu)
			if err != nil {
				return APDUResult{}, err
			}
			getResponses++
		default:
			return mergeAPDUResult(bodyPrefix, resp), nil
		}
	}
}

func (a *Adapter) ReadCRSMBinary(fileID uint16, offset, length int, pathID string) (CRSMResult, error) {
	if offset < 0 || offset > 0xffff {
		return CRSMResult{}, fmt.Errorf("invalid CRSM offset: %d", offset)
	}
	p3 := crsmLengthByte(length)
	return a.runCRSM(176, int(fileID), offset>>8, offset&0xff, p3, "", pathID)
}

func (a *Adapter) ReadCRSMRecord(fileID uint16, record, length int, pathID string) (CRSMResult, error) {
	if record <= 0 || record > 0xff {
		return CRSMResult{}, fmt.Errorf("invalid CRSM record: %d", record)
	}
	p3 := crsmLengthByte(length)
	return a.runCRSM(178, int(fileID), record, 4, p3, "", pathID)
}

// ReadIMEI queries the modem identity through common AT commands.
func (a *Adapter) ReadIMEI() (string, error) {
	if a == nil || a.Control == nil {
		return "", errors.New("nil AT control")
	}
	commands := []string{"AT+CGSN", "AT+CGSN=1", "AT+GSN"}
	var errs []error
	for _, cmd := range commands {
		out, err := a.Control.ExecuteATSilent(cmd, a.timeout())
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", cmd, err))
			continue
		}
		if err := parseATError(out); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", cmd, err))
			continue
		}
		imei, ok := ExtractIMEI(out)
		if ok {
			return imei, nil
		}
		errs = append(errs, fmt.Errorf("%s: parse IMEI from %q", cmd, compactAT(out)))
	}
	return "", errors.Join(errs...)
}

// ReadIMSI queries the subscriber identity through the standard AT+CIMI command.
func (a *Adapter) ReadIMSI() (string, error) {
	if a == nil || a.Control == nil {
		return "", errors.New("nil AT control")
	}
	out, err := a.Control.ExecuteATSilent("AT+CIMI", a.timeout())
	if err != nil {
		return "", err
	}
	if err := parseATError(out); err != nil {
		return "", err
	}
	imsi, ok := ExtractIMSI(out)
	if !ok {
		return "", fmt.Errorf("parse IMSI from %q", compactAT(out))
	}
	return imsi, nil
}

func ParseAPDUResult(out string) (APDUResult, error) {
	if err := parseATError(out); err != nil {
		return APDUResult{}, err
	}
	hexOut, ok := extractResponseHex(out)
	if !ok {
		return APDUResult{}, fmt.Errorf("parse APDU response hex from %q", compactAT(out))
	}
	hexOut, err := normalizeHex(hexOut)
	if err != nil {
		return APDUResult{}, fmt.Errorf("invalid APDU response: %w", err)
	}
	if len(hexOut) < 4 {
		return APDUResult{}, fmt.Errorf("APDU response too short: %d hex chars", len(hexOut))
	}
	sw1, _ := strconv.ParseUint(hexOut[len(hexOut)-4:len(hexOut)-2], 16, 8)
	sw2, _ := strconv.ParseUint(hexOut[len(hexOut)-2:], 16, 8)
	return APDUResult{
		Hex:  hexOut,
		Body: hexOut[:len(hexOut)-4],
		SW1:  byte(sw1),
		SW2:  byte(sw2),
	}, nil
}

func ParseCRSMResult(out string) (CRSMResult, error) {
	if err := parseATError(out); err != nil {
		return CRSMResult{}, err
	}
	m := crsmLineRE.FindStringSubmatch(out)
	if len(m) == 0 {
		return CRSMResult{}, fmt.Errorf("parse CRSM result from %q", compactAT(out))
	}
	sw1, err := parseCRSMStatusByte(m[1])
	if err != nil {
		return CRSMResult{}, fmt.Errorf("invalid CRSM SW1: %w", err)
	}
	sw2, err := parseCRSMStatusByte(m[2])
	if err != nil {
		return CRSMResult{}, fmt.Errorf("invalid CRSM SW2: %w", err)
	}
	data := firstNonEmpty(m[3], m[4])
	if data != "" {
		var normalizeErr error
		data, normalizeErr = normalizeHex(data)
		if normalizeErr != nil {
			return CRSMResult{}, fmt.Errorf("invalid CRSM data: %w", normalizeErr)
		}
	}
	return CRSMResult{Data: data, SW1: sw1, SW2: sw2}, nil
}

func (a *Adapter) runCRSM(command, fileID, p1, p2, p3 int, data, pathID string) (CRSMResult, error) {
	if a == nil || a.Control == nil {
		return CRSMResult{}, errors.New("nil AT control")
	}
	if fileID <= 0 || fileID > 0xffff {
		return CRSMResult{}, fmt.Errorf("invalid CRSM file ID: %d", fileID)
	}
	if !validCRSMByte(command) || !validCRSMByte(p1) || !validCRSMByte(p2) || !validCRSMByte(p3) {
		return CRSMResult{}, fmt.Errorf("invalid CRSM command parameters: command=%d p1=%d p2=%d p3=%d", command, p1, p2, p3)
	}
	cmd := fmt.Sprintf("AT+CRSM=%d,%d,%d,%d,%d", command, fileID, p1, p2, p3)
	if strings.TrimSpace(data) != "" || strings.TrimSpace(pathID) != "" {
		hexData, err := normalizeOptionalHex(data)
		if err != nil {
			return CRSMResult{}, fmt.Errorf("invalid CRSM data: %w", err)
		}
		cmd += fmt.Sprintf(`,"%s"`, hexData)
	}
	if strings.TrimSpace(pathID) != "" {
		path, err := normalizeOptionalHex(pathID)
		if err != nil {
			return CRSMResult{}, fmt.Errorf("invalid CRSM path ID: %w", err)
		}
		cmd += fmt.Sprintf(`,"%s"`, path)
	}
	out, err := a.Control.ExecuteATSilent(cmd, a.timeout())
	if err != nil {
		return CRSMResult{}, err
	}
	return ParseCRSMResult(out)
}

func (a *Adapter) timeout() time.Duration {
	if a.Timeout > 0 {
		return a.Timeout
	}
	return defaultTimeout
}

func parseATError(out string) error {
	trimmed := strings.TrimSpace(out)
	if trimmed == "" {
		return nil
	}
	if m := cmeErrorRE.FindStringSubmatch(trimmed); len(m) == 2 {
		return fmt.Errorf("AT CME ERROR: %s", strings.TrimSpace(m[1]))
	}
	for _, line := range strings.FieldsFunc(trimmed, func(r rune) bool { return r == '\r' || r == '\n' }) {
		if strings.EqualFold(strings.TrimSpace(line), "ERROR") {
			return errors.New("AT ERROR")
		}
	}
	return nil
}

func ExtractIMEI(out string) (string, bool) {
	for _, line := range atLines(out) {
		line = strings.TrimSpace(line)
		if line == "" || strings.EqualFold(line, "OK") || isATCommandEcho(line) {
			continue
		}
		if strings.HasPrefix(strings.ToUpper(line), "+CGSN:") {
			line = strings.TrimSpace(strings.TrimPrefix(line, line[:strings.IndexByte(line, ':')+1]))
		}
		if imei := firstIMEIDigits(line); imei != "" {
			return imei, true
		}
	}
	return "", false
}

func firstIMEIDigits(value string) string {
	digits := make([]byte, 0, 15)
	for i := 0; i < len(value); i++ {
		b := value[i]
		if b >= '0' && b <= '9' {
			digits = append(digits, b)
			if len(digits) == 15 {
				return string(digits)
			}
			continue
		}
		digits = digits[:0]
	}
	return ""
}

func ExtractIMSI(out string) (string, bool) {
	for _, line := range atLines(out) {
		line = strings.TrimSpace(line)
		if line == "" || strings.EqualFold(line, "OK") || isATCommandEcho(line) {
			continue
		}
		if strings.HasPrefix(strings.ToUpper(line), "+CIMI:") {
			line = strings.TrimSpace(strings.TrimPrefix(line, line[:strings.IndexByte(line, ':')+1]))
		}
		if imsi := firstIMSIRun(line); imsi != "" {
			return imsi, true
		}
	}
	return "", false
}

func firstIMSIRun(value string) string {
	start := -1
	for i := 0; i < len(value); i++ {
		b := value[i]
		if b >= '0' && b <= '9' {
			if start < 0 {
				start = i
			}
			continue
		}
		if start >= 0 {
			if imsi := validIMSIRun(value[start:i]); imsi != "" {
				return imsi
			}
			start = -1
		}
	}
	if start >= 0 {
		return validIMSIRun(value[start:])
	}
	return ""
}

func validIMSIRun(run string) string {
	if len(run) < 5 || len(run) > 15 {
		return ""
	}
	return run
}

func parseCCHOChannel(out string) (int, bool) {
	if m := cchoLineRE.FindStringSubmatch(out); len(m) == 2 {
		n, err := strconv.Atoi(m[1])
		return n, err == nil
	}
	return parseFirstInt(out)
}

func parseCRSMStatusByte(value string) (byte, error) {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0, err
	}
	if n < 0 || n > 0xff {
		return 0, fmt.Errorf("out of range: %d", n)
	}
	return byte(n), nil
}

func crsmLengthByte(length int) int {
	if length <= 0 || length > 256 {
		return 0
	}
	if length == 256 {
		return 0
	}
	return length
}

func validCRSMByte(n int) bool {
	return n >= 0 && n <= 0xff
}

func correctAPDUHexLe(apdu string, le int) (string, error) {
	raw, err := hex.DecodeString(apdu)
	if err != nil {
		return "", err
	}
	corrected, err := CorrectAPDULe(raw, le)
	if err != nil {
		return "", err
	}
	return strings.ToUpper(hex.EncodeToString(corrected)), nil
}

func apduCLA(apdu string) byte {
	if len(apdu) < 2 {
		return 0x00
	}
	cla, err := strconv.ParseUint(apdu[:2], 16, 8)
	if err != nil {
		return 0x00
	}
	return byte(cla)
}

func mergeAPDUResult(bodyPrefix string, resp APDUResult) APDUResult {
	if bodyPrefix == "" {
		return resp
	}
	body := bodyPrefix + resp.Body
	return APDUResult{
		Hex:  body + resp.StatusString(),
		Body: body,
		SW1:  resp.SW1,
		SW2:  resp.SW2,
	}
}

func extractResponseHex(out string) (string, bool) {
	if m := apduLineRE.FindAllStringSubmatch(out, -1); len(m) > 0 {
		last := m[len(m)-1]
		return firstNonEmpty(last[1], last[2]), true
	}
	quoted := ""
	for _, line := range atLines(out) {
		if isATCommandEcho(line) {
			continue
		}
		if m := hexTokenRE.FindAllStringSubmatch(line, -1); len(m) > 0 {
			quoted = m[len(m)-1][1]
		}
	}
	if quoted != "" {
		return quoted, true
	}
	for _, line := range atLines(out) {
		if isATCommandEcho(line) {
			continue
		}
		for _, field := range strings.FieldsFunc(line, func(r rune) bool {
			return r == ',' || r == ':' || r == ' ' || r == '\t'
		}) {
			if looksHex(field) && len(field) >= 4 {
				return field, true
			}
		}
	}
	return "", false
}

func atLines(out string) []string {
	return strings.FieldsFunc(out, func(r rune) bool {
		return r == '\r' || r == '\n'
	})
}

func isATCommandEcho(line string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(line)), "AT+")
}

func parseFirstInt(out string) (int, bool) {
	token := intTokenRE.FindString(out)
	if token == "" {
		return 0, false
	}
	n, err := strconv.Atoi(token)
	return n, err == nil
}

func normalizeOptionalHex(in string) (string, error) {
	if strings.TrimSpace(in) == "" {
		return "", nil
	}
	return normalizeHex(in)
}

func normalizeHex(in string) (string, error) {
	out := strings.ToUpper(strings.TrimSpace(in))
	if out == "" {
		return "", errors.New("empty hex")
	}
	if len(out)%2 != 0 {
		return "", errors.New("odd hex length")
	}
	if !looksHex(out) {
		return "", errors.New("non-hex character")
	}
	return out, nil
}

func looksHex(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F' {
			continue
		}
		return false
	}
	return true
}

func firstNonEmpty(items ...string) string {
	for _, item := range items {
		if strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}

func compactAT(out string) string {
	return strings.Join(strings.Fields(out), " ")
}
