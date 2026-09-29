package simtransport

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeAT struct {
	calls     []string
	timeouts  []time.Duration
	responses []string
	err       error
}

func (f *fakeAT) ExecuteATSilent(cmd string, timeout time.Duration) (string, error) {
	f.calls = append(f.calls, cmd)
	f.timeouts = append(f.timeouts, timeout)
	if f.err != nil {
		return "", f.err
	}
	if len(f.responses) == 0 {
		return "OK", nil
	}
	out := f.responses[0]
	f.responses = f.responses[1:]
	return out, nil
}

func TestAdapterCCHOCGLACCHC(t *testing.T) {
	at := &fakeAT{responses: []string{
		"AT+CCHO=\"A0000000871004\"\r\n\r\n+CCHO: 2\r\n\r\nOK\r\n",
		"\r\n+CGLA: 8,\"DEAD9000\"\r\n\r\nOK\r\n",
		"\r\nOK\r\n",
	}}
	adapter := NewAdapter(at)

	channel, err := adapter.OpenLogicalChannel("a0000000871004")
	if err != nil {
		t.Fatalf("OpenLogicalChannel() error = %v", err)
	}
	if channel != 2 {
		t.Fatalf("channel = %d, want 2", channel)
	}
	resp, err := adapter.TransmitAPDU(channel, "00a4040002")
	if err != nil {
		t.Fatalf("TransmitAPDU() error = %v", err)
	}
	if resp != "DEAD9000" {
		t.Fatalf("response = %s, want DEAD9000", resp)
	}
	if err := adapter.CloseLogicalChannel(channel); err != nil {
		t.Fatalf("CloseLogicalChannel() error = %v", err)
	}

	want := []string{
		`AT+CCHO="A0000000871004"`,
		`AT+CGLA=2,10,"00A4040002"`,
		`AT+CCHC=2`,
	}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
	for _, timeout := range at.timeouts {
		if timeout != defaultTimeout {
			t.Fatalf("timeout = %v, want %v", timeout, defaultTimeout)
		}
	}
}

func TestAdapterExecuteATSilentDelegates(t *testing.T) {
	at := &fakeAT{responses: []string{"OK"}}
	adapter := NewAdapter(at)

	out, err := adapter.ExecuteATSilent("AT", 3*time.Second)
	if err != nil {
		t.Fatalf("ExecuteATSilent() error = %v", err)
	}
	if out != "OK" {
		t.Fatalf("out = %q, want OK", out)
	}
	if len(at.calls) != 1 || at.calls[0] != "AT" || at.timeouts[0] != 3*time.Second {
		t.Fatalf("delegated calls=%+v timeouts=%+v", at.calls, at.timeouts)
	}
}

func TestAdapterCSIMOnBasicChannel(t *testing.T) {
	at := &fakeAT{responses: []string{`+CSIM: 4,"9000"`}}
	adapter := &Adapter{Control: at, Timeout: 2 * time.Second}

	resp, err := adapter.TransmitAPDU(0, "00")
	if err != nil {
		t.Fatalf("TransmitAPDU() error = %v", err)
	}
	if resp != "9000" {
		t.Fatalf("response = %s, want 9000", resp)
	}
	want := []string{`AT+CSIM=2,"00"`}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
	if at.timeouts[0] != 2*time.Second {
		t.Fatalf("timeout = %v, want 2s", at.timeouts[0])
	}
}

func TestAdapterTransmitAPDURetries6CWithCorrectLe(t *testing.T) {
	at := &fakeAT{responses: []string{
		`+CSIM: 4,"6C03"`,
		`+CSIM: 10,"AABBCC9000"`,
	}}
	adapter := NewAdapter(at)

	resp, err := adapter.TransmitAPDU(0, "00B0000000")
	if err != nil {
		t.Fatalf("TransmitAPDU() error = %v", err)
	}
	if resp != "AABBCC9000" {
		t.Fatalf("response = %s, want AABBCC9000", resp)
	}
	want := []string{
		`AT+CSIM=10,"00B0000000"`,
		`AT+CSIM=10,"00B0000003"`,
	}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
}

func TestAdapterTransmitAPDURetries6CWithExtendedCorrectLe(t *testing.T) {
	at := &fakeAT{responses: []string{
		`+CGLA: 4,"6C03"`,
		`+CGLA: 10,"AABBCC9000"`,
	}}
	adapter := NewAdapter(at)

	resp, err := adapter.TransmitAPDU(3, "00880081000002AABB")
	if err != nil {
		t.Fatalf("TransmitAPDU(extended 6C) error = %v", err)
	}
	if resp != "AABBCC9000" {
		t.Fatalf("response = %s, want AABBCC9000", resp)
	}
	want := []string{
		`AT+CGLA=3,18,"00880081000002AABB"`,
		`AT+CGLA=3,22,"00880081000002AABB0003"`,
	}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
}

func TestAdapterTransmitAPDUSendsGetResponseFor61(t *testing.T) {
	at := &fakeAT{responses: []string{
		`+CGLA: 8,"11226102"`,
		`+CGLA: 8,"33449000"`,
	}}
	adapter := NewAdapter(at)

	resp, err := adapter.TransmitAPDU(3, "00A4040002AABB")
	if err != nil {
		t.Fatalf("TransmitAPDU() error = %v", err)
	}
	if resp != "112233449000" {
		t.Fatalf("response = %s, want 112233449000", resp)
	}
	want := []string{
		`AT+CGLA=3,14,"00A4040002AABB"`,
		`AT+CGLA=3,10,"00C0000002"`,
	}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
}

func TestAdapterTransmitAPDUSendsGetResponseFor9F(t *testing.T) {
	at := &fakeAT{responses: []string{
		`+CGLA: 8,"11229F02"`,
		`+CGLA: 8,"33449000"`,
	}}
	adapter := NewAdapter(at)

	resp, err := adapter.TransmitAPDU(3, "A0A4000002AABB")
	if err != nil {
		t.Fatalf("TransmitAPDU() error = %v", err)
	}
	if resp != "112233449000" {
		t.Fatalf("response = %s, want 112233449000", resp)
	}
	want := []string{
		`AT+CGLA=3,14,"A0A4000002AABB"`,
		`AT+CGLA=3,10,"A0C0000002"`,
	}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
}

func TestAdapterTransmitAPDUKeeps6CWhenLeCannotBeCorrected(t *testing.T) {
	at := &fakeAT{responses: []string{`+CSIM: 4,"6C10"`}}
	adapter := NewAdapter(at)

	resp, err := adapter.TransmitAPDU(0, "00")
	if err != nil {
		t.Fatalf("TransmitAPDU() error = %v", err)
	}
	if resp != "6C10" {
		t.Fatalf("response = %s, want 6C10", resp)
	}
	want := []string{`AT+CSIM=2,"00"`}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
}

func TestAdapterCRSMReadsTransparentAndRecordEFs(t *testing.T) {
	at := &fakeAT{responses: []string{
		"\r\n+CRSM: 144,0,\"8003616263\"\r\n\r\nOK\r\n",
		"\r\n+CRSM: 106,130,\"\"\r\n\r\nOK\r\n",
	}}
	adapter := NewAdapter(at)

	binary, err := adapter.ReadCRSMBinary(0x6F02, 258, 3, "7fff")
	if err != nil {
		t.Fatalf("ReadCRSMBinary() error = %v", err)
	}
	if binary.Data != "8003616263" || binary.StatusString() != "9000" || !binary.Success() {
		t.Fatalf("binary=%+v", binary)
	}
	record, err := adapter.ReadCRSMRecord(0x6F04, 2, 256, "")
	if err != nil {
		t.Fatalf("ReadCRSMRecord() error = %v", err)
	}
	if record.Data != "" || record.StatusString() != "6A82" || record.Success() {
		t.Fatalf("record=%+v", record)
	}

	want := []string{
		`AT+CRSM=176,28418,1,2,3,"","7FFF"`,
		`AT+CRSM=178,28420,2,4,0`,
	}
	if !reflect.DeepEqual(at.calls, want) {
		t.Fatalf("calls = %#v, want %#v", at.calls, want)
	}
}

func TestParseCRSMResultVariants(t *testing.T) {
	tests := []struct {
		name string
		in   string
		data string
		sw   string
	}{
		{name: "quoted data", in: "\r\n+CRSM: 144,0,\"DEADBEEF\"\r\nOK\r\n", data: "DEADBEEF", sw: "9000"},
		{name: "unquoted data", in: "+CRSM: 98,131,beef", data: "BEEF", sw: "6283"},
		{name: "no data", in: "+CRSM: 106,130", data: "", sw: "6A82"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseCRSMResult(tt.in)
			if err != nil {
				t.Fatalf("ParseCRSMResult() error = %v", err)
			}
			if got.Data != tt.data || got.StatusString() != tt.sw {
				t.Fatalf("result=%+v, want data=%s sw=%s", got, tt.data, tt.sw)
			}
		})
	}
}

func TestCRSMErrorsAndValidation(t *testing.T) {
	if _, err := ParseCRSMResult("\r\n+CME ERROR: SIM failure\r\n"); err == nil || err.Error() != "AT CME ERROR: SIM failure" {
		t.Fatalf("ParseCRSMResult(CME) err=%v", err)
	}
	if _, err := ParseCRSMResult("+CRSM: 144,300"); err == nil || !strings.Contains(err.Error(), "invalid CRSM SW2") {
		t.Fatalf("ParseCRSMResult(bad sw) err=%v", err)
	}
	if _, err := ParseCRSMResult("+CRSM: 144,0,\"ABC\""); err == nil || !strings.Contains(err.Error(), "invalid CRSM data") {
		t.Fatalf("ParseCRSMResult(bad data) err=%v", err)
	}
	if _, err := NewAdapter(&fakeAT{}).ReadCRSMBinary(0x6F02, -1, 1, ""); err == nil {
		t.Fatal("ReadCRSMBinary(negative offset) err=nil, want error")
	}
	if _, err := NewAdapter(&fakeAT{}).ReadCRSMRecord(0x6F04, 0, 1, ""); err == nil {
		t.Fatal("ReadCRSMRecord(record 0) err=nil, want error")
	}
	if _, err := NewAdapter(&fakeAT{}).ReadCRSMBinary(0x6F02, 0, 1, "bad-path"); err == nil || !strings.Contains(err.Error(), "invalid CRSM path ID") {
		t.Fatalf("ReadCRSMBinary(bad path) err=%v", err)
	}
}

func TestParseAPDUResultVariants(t *testing.T) {
	tests := []struct {
		name string
		in   string
		body string
		sw   string
	}{
		{name: "cgla quoted", in: "\r\n+CGLA: 12,\"01029000\"\r\nOK\r\n", body: "0102", sw: "9000"},
		{name: "csim quoted", in: "+CSIM: 4,\"6A82\"", body: "", sw: "6A82"},
		{name: "csim unquoted", in: "\r\n+CSIM: 8,beef9000\r\nOK\r\n", body: "BEEF", sw: "9000"},
		{name: "echo before result", in: "AT+CGLA=2,10,\"00A4040002\"\r\n\r\n+CGLA: 4,\"9000\"\r\n\r\nOK\r\n", body: "", sw: "9000"},
		{name: "plain hex", in: "DEADBEEF9000", body: "DEADBEEF", sw: "9000"},
		{name: "lowercase quoted", in: "\"beef6283\"", body: "BEEF", sw: "6283"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseAPDUResult(tt.in)
			if err != nil {
				t.Fatalf("ParseAPDUResult() error = %v", err)
			}
			if got.Body != tt.body || got.StatusString() != tt.sw {
				t.Fatalf("result = body %s sw %s, want body %s sw %s", got.Body, got.StatusString(), tt.body, tt.sw)
			}
		})
	}
}

func TestParseAPDUResultIgnoresATCommandEcho(t *testing.T) {
	_, err := ParseAPDUResult("AT+CSIM=10,\"00A4040002\"\r\n\r\nOK\r\n")
	if err == nil || !strings.Contains(err.Error(), "parse APDU response hex") {
		t.Fatalf("ParseAPDUResult(echo only) err = %v, want parse APDU response hex", err)
	}
}

func TestExtractIMEIFromATResponses(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{
			name: "plain cgsn",
			in:   "AT+CGSN\r\n\r\n490154203237518\r\n\r\nOK\r\n",
			want: "490154203237518",
			ok:   true,
		},
		{
			name: "quoted cgsn",
			in:   "\r\n+CGSN: \"356938035643809\"\r\n\r\nOK\r\n",
			want: "356938035643809",
			ok:   true,
		},
		{
			name: "no imei",
			in:   "\r\n+CGSN: \"serial\"\r\n\r\nOK\r\n",
			ok:   false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ExtractIMEI(tt.in)
			if got != tt.want || ok != tt.ok {
				t.Fatalf("ExtractIMEI() = %q,%t want %q,%t", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestExtractIMSIFromATResponses(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{
			name: "plain cimi",
			in:   "AT+CIMI\r\n\r\n001010123456789\r\n\r\nOK\r\n",
			want: "001010123456789",
			ok:   true,
		},
		{
			name: "quoted cimi",
			in:   "\r\n+CIMI: \"310260123456789\"\r\n\r\nOK\r\n",
			want: "310260123456789",
			ok:   true,
		},
		{
			name: "too long",
			in:   "\r\n+CIMI: \"0010101234567890\"\r\n\r\nOK\r\n",
			ok:   false,
		},
		{
			name: "no imsi",
			in:   "\r\n+CIMI: \"subscriber\"\r\n\r\nOK\r\n",
			ok:   false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ExtractIMSI(tt.in)
			if got != tt.want || ok != tt.ok {
				t.Fatalf("ExtractIMSI() = %q,%t want %q,%t", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestAdapterReadIMEIFallsBackAcrossCommonCommands(t *testing.T) {
	at := &fakeAT{responses: []string{
		"\r\nERROR\r\n",
		"\r\n+CGSN: \"356938035643809\"\r\n\r\nOK\r\n",
	}}
	imei, err := NewAdapter(at).ReadIMEI()
	if err != nil {
		t.Fatalf("ReadIMEI() error = %v", err)
	}
	if imei != "356938035643809" {
		t.Fatalf("ReadIMEI() = %q", imei)
	}
	wantCalls := []string{"AT+CGSN", "AT+CGSN=1"}
	if !reflect.DeepEqual(at.calls, wantCalls) {
		t.Fatalf("AT calls=%+v want %+v", at.calls, wantCalls)
	}
}

func TestAdapterReadIMSI(t *testing.T) {
	at := &fakeAT{responses: []string{
		"\r\n001010123456789\r\n\r\nOK\r\n",
	}}
	imsi, err := NewAdapter(at).ReadIMSI()
	if err != nil {
		t.Fatalf("ReadIMSI() error = %v", err)
	}
	if imsi != "001010123456789" {
		t.Fatalf("ReadIMSI() = %q", imsi)
	}
	wantCalls := []string{"AT+CIMI"}
	if !reflect.DeepEqual(at.calls, wantCalls) {
		t.Fatalf("AT calls=%+v want %+v", at.calls, wantCalls)
	}
}

func TestParseATErrors(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "error", in: "\r\nERROR\r\n", want: "AT ERROR"},
		{name: "cme", in: "\r\n+CME ERROR: SIM busy\r\n", want: "AT CME ERROR: SIM busy"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseAPDUResult(tt.in)
			if err == nil || err.Error() != tt.want {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestValidationAndCommandErrors(t *testing.T) {
	if _, err := NewAdapter(&fakeAT{}).TransmitAPDU(1, "ABC"); err == nil {
		t.Fatal("TransmitAPDU(odd hex) err=nil, want error")
	}
	if _, err := NewAdapter(&fakeAT{}).OpenLogicalChannel("not-hex"); err == nil {
		t.Fatal("OpenLogicalChannel(non-hex) err=nil, want error")
	}

	sentinel := errors.New("boom")
	_, err := NewAdapter(&fakeAT{err: sentinel}).TransmitAPDU(1, "00")
	if !errors.Is(err, sentinel) {
		t.Fatalf("TransmitAPDU() err = %v, want sentinel", err)
	}

	_, err = NewAdapter(&fakeAT{responses: []string{"OK"}}).OpenLogicalChannel("A000")
	if err == nil || !strings.Contains(err.Error(), "parse CCHO channel") {
		t.Fatalf("OpenLogicalChannel(no channel) err = %v, want parse error", err)
	}
}
