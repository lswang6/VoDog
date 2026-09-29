package runtimehost

import (
	"context"
	"encoding/hex"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	swusim "github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/engine/swu"
	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
	"github.com/boa-z/vowifi-go/runtimehost/carrier"
	"github.com/boa-z/vowifi-go/runtimehost/eventhost"
	"github.com/boa-z/vowifi-go/runtimehost/identity"
	"github.com/boa-z/vowifi-go/runtimehost/messaging"
	"github.com/boa-z/vowifi-go/runtimehost/simtransport"
	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
	"github.com/boa-z/vowifi-go/runtimehost/voicehost"
)

type testModem struct{}

func (testModem) DeviceID() string                           { return "dev-1" }
func (testModem) IsHealthy() bool                            { return true }
func (testModem) IsSimInserted() bool                        { return true }
func (testModem) QuerySIMInserted() (bool, error)            { return true, nil }
func (testModem) GetRegStatus() (int, string)                { return 1, "registered" }
func (testModem) GetNetworkMode() string                     { return "LTE" }
func (testModem) Stop()                                      {}
func (testModem) OpenLogicalChannel(aid string) (int, error) { return 1, nil }
func (testModem) CloseLogicalChannel(channel int) error      { return nil }
func (testModem) TransmitAPDU(channel int, hexAPDU string) (string, error) {
	return "9000", nil
}

type testIMSRegistrar struct {
	result IMSRegistrationResult
	err    error
	config IMSRegistrationConfig
}

func (r *testIMSRegistrar) RegisterIMS(ctx context.Context, cfg IMSRegistrationConfig) (IMSRegistrationResult, error) {
	r.config = cfg
	if r.err != nil {
		return IMSRegistrationResult{}, r.err
	}
	return r.result, nil
}

type runtimeIdentityReaderModem struct {
	testModem
	id identity.Identity
}

func (m runtimeIdentityReaderModem) GetISIMIdentity() (identity.Identity, error) {
	return m.id, nil
}

type runtimeRecoveringIdentityModem struct {
	testModem
	attempts int
	requests []SIMAccessRecoveryRequest
	id       identity.Identity
}

func (m *runtimeRecoveringIdentityModem) GetISIMIdentity() (identity.Identity, error) {
	m.attempts++
	if m.attempts == 1 {
		return identity.Identity{}, context.DeadlineExceeded
	}
	return m.id, nil
}

func (m *runtimeRecoveringIdentityModem) RecoverSIMAccess(req SIMAccessRecoveryRequest) error {
	m.requests = append(m.requests, req)
	return nil
}

type runtimeAPDUIdentityModem struct {
	testModem
	opened    string
	closed    []int
	calls     []string
	responses []string
}

func (m *runtimeAPDUIdentityModem) OpenLogicalChannel(aid string) (int, error) {
	m.opened = aid
	return 3, nil
}

func (m *runtimeAPDUIdentityModem) CloseLogicalChannel(channel int) error {
	m.closed = append(m.closed, channel)
	return nil
}

func (m *runtimeAPDUIdentityModem) TransmitAPDU(channel int, hexAPDU string) (string, error) {
	m.calls = append(m.calls, hexAPDU)
	if len(m.responses) == 0 {
		return "6A82", nil
	}
	resp := m.responses[0]
	m.responses = m.responses[1:]
	return resp, nil
}

type runtimeCRSMFallbackModem struct {
	testModem
	binary  []simtransport.CRSMResult
	records []simtransport.CRSMResult
}

func (m *runtimeCRSMFallbackModem) ReadCRSMBinary(fileID uint16, offset, length int, pathID string) (simtransport.CRSMResult, error) {
	if len(m.binary) == 0 {
		return simtransport.CRSMResult{SW1: 0x6A, SW2: 0x82}, nil
	}
	resp := m.binary[0]
	m.binary = m.binary[1:]
	return resp, nil
}

func (m *runtimeCRSMFallbackModem) ReadCRSMRecord(fileID uint16, record, length int, pathID string) (simtransport.CRSMResult, error) {
	if len(m.records) == 0 {
		return simtransport.CRSMResult{SW1: 0x6A, SW2: 0x82}, nil
	}
	resp := m.records[0]
	m.records = m.records[1:]
	return resp, nil
}

type runtimeATCRSMModem struct {
	testModem
	responses []string
	calls     []string
}

func (m *runtimeATCRSMModem) OpenLogicalChannel(aid string) (int, error) {
	return 0, errors.New("logical channel unavailable")
}

func (m *runtimeATCRSMModem) ExecuteATSilent(cmd string, timeout time.Duration) (string, error) {
	m.calls = append(m.calls, cmd)
	if len(m.responses) == 0 {
		return "\r\n+CRSM: 106,130\r\n\r\nOK\r\n", nil
	}
	resp := m.responses[0]
	m.responses = m.responses[1:]
	return resp, nil
}

type runtimeRecoveringIMEIATModem struct {
	testModem
	recovered bool
	calls     []string
	requests  []SIMAccessRecoveryRequest
}

func (m *runtimeRecoveringIMEIATModem) ExecuteATSilent(cmd string, timeout time.Duration) (string, error) {
	m.calls = append(m.calls, cmd)
	if !m.recovered {
		return "", context.DeadlineExceeded
	}
	return "\r\n490154203237518\r\n\r\nOK\r\n", nil
}

func (m *runtimeRecoveringIMEIATModem) RecoverSIMAccess(req SIMAccessRecoveryRequest) error {
	m.requests = append(m.requests, req)
	m.recovered = true
	return nil
}

type runtimeDefaultRecoveringATModem struct {
	testModem
	recovered bool
	calls     []string
}

func (m *runtimeDefaultRecoveringATModem) ExecuteATSilent(cmd string, timeout time.Duration) (string, error) {
	m.calls = append(m.calls, cmd)
	switch cmd {
	case "AT+CFUN=0":
		return "\r\nOK\r\n", nil
	case "AT+CFUN=1":
		m.recovered = true
		return "\r\nOK\r\n", nil
	case "AT+CGSN", "AT+CGSN=1", "AT+GSN":
		if m.recovered {
			return "\r\n490154203237518\r\n\r\nOK\r\n", nil
		}
		return "", context.DeadlineExceeded
	default:
		return "", context.DeadlineExceeded
	}
}

type runtimeDefaultRecoveringIdentityATModem struct {
	runtimeDefaultRecoveringATModem
	id identity.Identity
}

func (m *runtimeDefaultRecoveringIdentityATModem) GetISIMIdentity() (identity.Identity, error) {
	if !m.recovered {
		return identity.Identity{}, context.DeadlineExceeded
	}
	return m.id, nil
}

type runtimeQCFGRecoveringIMEIATModem struct {
	testModem
	reconfigured bool
	calls        []string
}

func (m *runtimeQCFGRecoveringIMEIATModem) ExecuteATSilent(cmd string, timeout time.Duration) (string, error) {
	m.calls = append(m.calls, cmd)
	switch cmd {
	case `AT+QCFG="usbnet"`, `AT+QCFG="usbnet",0`:
		return "\r\nOK\r\n", nil
	case "AT+CFUN=1,1":
		m.reconfigured = true
		return "\r\nOK\r\n", nil
	case "AT+CGSN", "AT+CGSN=1", "AT+GSN":
		if m.reconfigured {
			return "\r\n490154203237518\r\n\r\nOK\r\n", nil
		}
		return "", errors.New("QMI UIM service unavailable while reading IMEI")
	default:
		return "", errors.New("unexpected AT command")
	}
}

func TestModemAccessAdapterReadsISIMIdentity(t *testing.T) {
	direct := identity.Identity{
		IMPI:   "001010123456789@private.example.test",
		Domain: "ims.example.test",
		IMPU:   []string{"sip:001010123456789@ims.example.test"},
	}
	id, err := NewModemAccessAdapter(runtimeIdentityReaderModem{id: direct}).GetISIMIdentity()
	if err != nil {
		t.Fatalf("GetISIMIdentity(direct) error = %v", err)
	}
	if id.IMPI != direct.IMPI || id.Domain != direct.Domain || len(id.IMPU) != 1 || id.IMPU[0] != direct.IMPU[0] {
		t.Fatalf("direct identity=%+v, want %+v", id, direct)
	}

	apdu := &runtimeAPDUIdentityModem{responses: []string{
		"9000",
		runtimeIdentityHexResponse(runtimeISIMTLVString("001010123456789@private.example.test")),
		"9000",
		runtimeIdentityHexResponse(runtimeISIMLengthString("ims.example.test")),
		"9000",
		runtimeIdentityHexResponse(runtimeIdentityPadRecord(runtimeISIMTLVString("sip:001010123456789@ims.example.test"), 48)),
	}}
	id, err = NewModemAccessAdapter(apdu).GetISIMIdentity()
	if err != nil {
		t.Fatalf("GetISIMIdentity(APDU) error = %v", err)
	}
	if apdu.opened == "" || len(apdu.closed) != 1 || id.Domain != "ims.example.test" || len(id.IMPU) != 1 {
		t.Fatalf("APDU identity=%+v opened=%q closed=%+v", id, apdu.opened, apdu.closed)
	}

	crsm := &runtimeCRSMFallbackModem{
		binary: []simtransport.CRSMResult{
			runtimeCRSMOK(runtimeISIMTLVString("001010123456789@private.example.test")),
			runtimeCRSMOK(runtimeISIMLengthString("ims.example.test")),
		},
		records: []simtransport.CRSMResult{
			runtimeCRSMOK(runtimeIdentityPadRecord(runtimeISIMTLVString("sip:001010123456789@ims.example.test"), 48)),
			{SW1: 0x6A, SW2: 0x83},
		},
	}
	id, err = NewModemAccessAdapter(crsm).GetISIMIdentity()
	if err != nil {
		t.Fatalf("GetISIMIdentity(CRSM fallback) error = %v", err)
	}
	if id.IMPI == "" || id.Domain != "ims.example.test" || len(id.IMPU) != 1 {
		t.Fatalf("CRSM fallback identity=%+v", id)
	}
}

func TestModemAccessAdapterRetriesAfterOptInSIMRecovery(t *testing.T) {
	want := identity.Identity{
		IMPI:   "001010123456789@private.example.test",
		Domain: "ims.example.test",
		IMPU:   []string{"sip:001010123456789@ims.example.test"},
	}
	modem := &runtimeRecoveringIdentityModem{id: want}

	got, err := NewModemAccessAdapter(modem).GetISIMIdentity()
	if err != nil {
		t.Fatalf("GetISIMIdentity() error = %v", err)
	}
	if got.IMPI != want.IMPI || got.Domain != want.Domain || len(got.IMPU) != 1 {
		t.Fatalf("identity = %+v, want %+v", got, want)
	}
	if modem.attempts != 2 {
		t.Fatalf("attempts = %d, want retry after recovery", modem.attempts)
	}
	if len(modem.requests) != 1 {
		t.Fatalf("recovery requests = %d, want 1", len(modem.requests))
	}
	req := modem.requests[0]
	if req.Operation != SIMAccessRecoveryOperationISIMIdentity ||
		req.Attempt != 1 ||
		req.Class != simtransport.RecoveryClassControlPortHung ||
		req.Err == nil ||
		req.DestructiveAllowed {
		t.Fatalf("recovery request = %+v, want non-destructive control-port recovery", req)
	}
}

func TestModemAccessAdapterFallsBackToATCRSM(t *testing.T) {
	at := &runtimeATCRSMModem{responses: []string{
		"\r\n+CRSM: 144,0,\"" + strings.ToUpper(hex.EncodeToString(runtimeISIMTLVString("001010123456789@private.example.test"))) + "\"\r\n\r\nOK\r\n",
		"\r\n+CRSM: 144,0,\"" + strings.ToUpper(hex.EncodeToString(runtimeISIMLengthString("ims.example.test"))) + "\"\r\n\r\nOK\r\n",
		"\r\n+CRSM: 144,0,\"" + strings.ToUpper(hex.EncodeToString(runtimeIdentityPadRecord(runtimeISIMTLVString("sip:001010123456789@ims.example.test"), 48))) + "\"\r\n\r\nOK\r\n",
		"\r\n+CRSM: 106,131\r\n\r\nOK\r\n",
	}}
	id, err := NewModemAccessAdapter(at).GetISIMIdentity()
	if err != nil {
		t.Fatalf("GetISIMIdentity(AT+CRSM) error = %v", err)
	}
	if id.IMPI == "" || id.Domain != "ims.example.test" || len(id.IMPU) != 1 {
		t.Fatalf("AT+CRSM identity=%+v", id)
	}
	if len(at.calls) < 3 || !strings.HasPrefix(at.calls[0], "AT+CRSM=176,28418") {
		t.Fatalf("AT calls=%+v", at.calls)
	}
}

func TestModemAccessAdapterRunsDefaultATRecoveryForISIMIdentity(t *testing.T) {
	want := identity.Identity{
		IMPI:   "001010123456789@private.example.test",
		Domain: "ims.example.test",
		IMPU:   []string{"sip:001010123456789@ims.example.test"},
	}
	modem := &runtimeDefaultRecoveringIdentityATModem{id: want}
	access := NewModemAccessAdapterWithRecovery(modem, SIMAccessRecoveryOptions{
		Delay: func(context.Context, time.Duration) error { return nil },
	})
	got, err := access.GetISIMIdentity()
	if err != nil {
		t.Fatalf("GetISIMIdentity() error = %v", err)
	}
	if got.IMPI != want.IMPI || got.Domain != want.Domain || len(got.IMPU) != 1 {
		t.Fatalf("identity = %+v, want %+v", got, want)
	}
	wantCalls := []string{"AT+CFUN=0", "AT+CFUN=1"}
	if !reflect.DeepEqual(modem.calls, wantCalls) {
		t.Fatalf("AT recovery calls=%+v want %+v", modem.calls, wantCalls)
	}
}

func TestModemAccessAdapterReadsIMEIFromAT(t *testing.T) {
	at := &runtimeATCRSMModem{responses: []string{
		"\r\n+CGSN: \"356938035643809\"\r\n\r\nOK\r\n",
	}}
	reader, ok := NewModemAccessAdapter(at).(interface{ GetIMEI() (string, error) })
	if !ok {
		t.Fatal("modem access adapter does not expose GetIMEI")
	}
	imei, err := reader.GetIMEI()
	if err != nil {
		t.Fatalf("GetIMEI() error = %v", err)
	}
	if imei != "356938035643809" {
		t.Fatalf("GetIMEI() = %q", imei)
	}
	if len(at.calls) != 1 || at.calls[0] != "AT+CGSN" {
		t.Fatalf("AT calls=%+v", at.calls)
	}
}

func TestModemAccessAdapterRecoversIMEIRead(t *testing.T) {
	modem := &runtimeRecoveringIMEIATModem{}
	reader, ok := NewModemAccessAdapter(modem).(interface{ GetIMEI() (string, error) })
	if !ok {
		t.Fatal("modem access adapter does not expose GetIMEI")
	}
	imei, err := reader.GetIMEI()
	if err != nil {
		t.Fatalf("GetIMEI() error = %v", err)
	}
	if imei != "490154203237518" {
		t.Fatalf("GetIMEI() = %q", imei)
	}
	if len(modem.requests) != 1 {
		t.Fatalf("recovery requests=%+v, want one", modem.requests)
	}
	req := modem.requests[0]
	if req.Operation != SIMAccessRecoveryOperationIMEI || req.Attempt != 1 ||
		req.Class != simtransport.RecoveryClassControlPortHung || req.DestructiveAllowed {
		t.Fatalf("recovery request=%+v", req)
	}
	if len(modem.calls) != 4 || modem.calls[0] != "AT+CGSN" || modem.calls[3] != "AT+CGSN" {
		t.Fatalf("AT calls=%+v", modem.calls)
	}
}

func TestModemAccessAdapterRunsDefaultATRecoveryForIMEIRead(t *testing.T) {
	modem := &runtimeDefaultRecoveringATModem{}
	access := NewModemAccessAdapterWithRecovery(modem, SIMAccessRecoveryOptions{
		Delay: func(context.Context, time.Duration) error { return nil },
	})
	reader, ok := access.(interface{ GetIMEI() (string, error) })
	if !ok {
		t.Fatal("modem access adapter does not expose GetIMEI")
	}
	imei, err := reader.GetIMEI()
	if err != nil {
		t.Fatalf("GetIMEI() error = %v", err)
	}
	if imei != "490154203237518" {
		t.Fatalf("GetIMEI() = %q", imei)
	}
	wantCalls := []string{"AT+CGSN", "AT+CGSN=1", "AT+GSN", "AT+CFUN=0", "AT+CFUN=1", "AT+CGSN"}
	if !reflect.DeepEqual(modem.calls, wantCalls) {
		t.Fatalf("AT calls=%+v want %+v", modem.calls, wantCalls)
	}
}

func TestModemAccessAdapterDoesNotRunVendorQCFGRecoveryByDefault(t *testing.T) {
	modem := &runtimeQCFGRecoveringIMEIATModem{}
	access := NewModemAccessAdapterWithRecovery(modem, SIMAccessRecoveryOptions{
		ControlPortType: simtransport.ControlPortTypeQMI,
		Delay:           func(context.Context, time.Duration) error { return nil },
	})
	reader, ok := access.(interface{ GetIMEI() (string, error) })
	if !ok {
		t.Fatal("modem access adapter does not expose GetIMEI")
	}
	_, err := reader.GetIMEI()
	if err == nil {
		t.Fatal("GetIMEI() err=nil, want QMI unavailable without vendor recovery opt-in")
	}
	wantCalls := []string{"AT+CGSN", "AT+CGSN=1", "AT+GSN"}
	if !reflect.DeepEqual(modem.calls, wantCalls) {
		t.Fatalf("AT calls=%+v want only initial IMEI reads", modem.calls)
	}
}

func TestModemAccessAdapterRunsVendorQCFGRecoveryForIMEIRead(t *testing.T) {
	modem := &runtimeQCFGRecoveringIMEIATModem{}
	access := NewModemAccessAdapterWithRecovery(modem, SIMAccessRecoveryOptions{
		AllowVendorSpecific: true,
		ControlPortType:     simtransport.ControlPortTypeQMI,
		Delay:               func(context.Context, time.Duration) error { return nil },
	})
	reader, ok := access.(interface{ GetIMEI() (string, error) })
	if !ok {
		t.Fatal("modem access adapter does not expose GetIMEI")
	}
	imei, err := reader.GetIMEI()
	if err != nil {
		t.Fatalf("GetIMEI() error = %v", err)
	}
	if imei != "490154203237518" {
		t.Fatalf("GetIMEI() = %q", imei)
	}
	wantCalls := []string{
		"AT+CGSN", "AT+CGSN=1", "AT+GSN",
		`AT+QCFG="usbnet"`, `AT+QCFG="usbnet",0`, "AT+CFUN=1,1",
		"AT+CGSN",
	}
	if !reflect.DeepEqual(modem.calls, wantCalls) {
		t.Fatalf("AT calls=%+v want %+v", modem.calls, wantCalls)
	}
}

func TestReaderSIMAdapterExposesProviderIMSIAndCaches(t *testing.T) {
	provider := &readerSIMGetIMSIProvider{imsi: " 310280000000001 "}
	adapter := NewReaderSIMAdapter(provider)

	imsi, err := adapter.GetIMSI()
	if err != nil {
		t.Fatalf("GetIMSI() error = %v", err)
	}
	if imsi != "310280000000001" {
		t.Fatalf("GetIMSI() = %q", imsi)
	}

	imsi, err = adapter.GetIMSI()
	if err != nil {
		t.Fatalf("second GetIMSI() error = %v", err)
	}
	if imsi != "310280000000001" {
		t.Fatalf("second GetIMSI() = %q", imsi)
	}
	if provider.imsiCalls != 1 {
		t.Fatalf("GetIMSI provider calls = %d, want 1", provider.imsiCalls)
	}

	aka, err := adapter.CalculateAKA([]byte{1}, []byte{2})
	if err != nil {
		t.Fatalf("CalculateAKA() error = %v", err)
	}
	if got := hex.EncodeToString(aka.RES); got != "01020304" {
		t.Fatalf("CalculateAKA RES = %s", got)
	}
	if provider.akaCalls != 1 {
		t.Fatalf("CalculateAKA provider calls = %d, want 1", provider.akaCalls)
	}

	if err := adapter.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if !provider.closed {
		t.Fatal("Close() did not delegate to provider")
	}
}

func TestReaderSIMAdapterSupportsIMSIVariants(t *testing.T) {
	tests := []struct {
		name string
		sim  swusim.AKAProvider
		want string
	}{
		{
			name: "IMSI string method",
			sim:  &readerSIMIMSIStringProvider{imsi: "310280000000001"},
			want: "310280000000001",
		},
		{
			name: "IMSI string error method",
			sim:  &readerSIMIMSIErrorProvider{imsi: "310280233641504"},
			want: "310280233641504",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			imsi, err := NewReaderSIMAdapter(tt.sim).GetIMSI()
			if err != nil {
				t.Fatalf("GetIMSI() error = %v", err)
			}
			if imsi != tt.want {
				t.Fatalf("GetIMSI() = %q, want %q", imsi, tt.want)
			}
		})
	}
}

func TestReaderSIMAdapterPreservesUnsupportedIMSIBehavior(t *testing.T) {
	imsi, err := NewReaderSIMAdapter(&readerSIMAKAOnlyProvider{}).GetIMSI()
	if err != nil {
		t.Fatalf("GetIMSI() error = %v", err)
	}
	if imsi != "" {
		t.Fatalf("GetIMSI() = %q, want empty", imsi)
	}
}

func TestReaderSIMAdapterRejectsInvalidIMSI(t *testing.T) {
	_, err := NewReaderSIMAdapter(&readerSIMGetIMSIProvider{imsi: "31028x"}).GetIMSI()
	if err == nil {
		t.Fatal("GetIMSI() error = nil, want invalid IMSI error")
	}
	if !strings.Contains(err.Error(), "invalid IMSI") {
		t.Fatalf("GetIMSI() error = %v", err)
	}
}

func runtimeISIMTLVString(s string) []byte {
	return append([]byte{0x80, byte(len(s))}, []byte(s)...)
}

func runtimeISIMLengthString(s string) []byte {
	return append([]byte{byte(len(s))}, []byte(s)...)
}

func runtimeIdentityHexResponse(body []byte) string {
	out := append(append([]byte(nil), body...), 0x90, 0x00)
	return strings.ToUpper(hex.EncodeToString(out))
}

func runtimeIdentityPadRecord(body []byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = 0xFF
	}
	copy(out, body)
	return out
}

func runtimeCRSMOK(body []byte) simtransport.CRSMResult {
	return simtransport.CRSMResult{Data: strings.ToUpper(hex.EncodeToString(body)), SW1: 0x90, SW2: 0x00}
}

func TestStartUsesIMSRegistrarResult(t *testing.T) {
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered: true,
		StatusCode: 200,
		Reason:     "ims registered",
		Server:     "pcscf",
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-1",
		TraceID:      "trace-1",
		Access:       NewModemAccessAdapter(testModem{}),
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	st := inst.State()
	if !st.IMSReady || st.LastReason != "ims registered" {
		t.Fatalf("state=%+v", st)
	}
	if registrar.config.DeviceID != "dev-1" || registrar.config.TraceID != "trace-1" || registrar.config.Access == nil {
		t.Fatalf("registrar config=%+v", registrar.config)
	}
}

func TestStartAndStopDispatchRuntimeStateSnapshots(t *testing.T) {
	dispatch := &runtimeDispatcher{}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID: "dev-1",
		Access:   NewModemAccessAdapter(testModem{}),
		Dispatch: dispatch,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if len(dispatch.events) != 1 {
		t.Fatalf("events=%d, want ready snapshot", len(dispatch.events))
	}
	ready, ok := dispatch.events[0].(eventhost.RuntimeStateSnapshot)
	if !ok {
		t.Fatalf("event=%T, want RuntimeStateSnapshot", dispatch.events[0])
	}
	if ready.DevID != "dev-1" || ready.Phase != eventhost.RuntimePhaseReady ||
		!ready.AccessReady || !ready.IMSReady || !ready.SMSReady ||
		ready.RegStatus != 1 || ready.RegStatusText != "registered" ||
		ready.NetworkMode != "LTE" || ready.LastReason != "started" ||
		ready.Time.IsZero() {
		t.Fatalf("ready snapshot=%+v", ready)
	}

	if err := inst.Stop(context.Background()); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if len(dispatch.events) != 2 {
		t.Fatalf("events=%d, want ready and stopped snapshots", len(dispatch.events))
	}
	stopped, ok := dispatch.events[1].(eventhost.RuntimeStateSnapshot)
	if !ok {
		t.Fatalf("event=%T, want RuntimeStateSnapshot", dispatch.events[1])
	}
	if stopped.Phase != eventhost.RuntimePhaseStopped || stopped.TunnelReady || stopped.LastReason != "stopped" {
		t.Fatalf("stopped snapshot=%+v", stopped)
	}
}

func TestStartRegistersRuntimeIMSVoiceAgent(t *testing.T) {
	transport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote"},
				"Contact": {"<sip:remote@pcscf.ims.example>"},
			},
			Body: runtimeSDP("198.51.100.22", 49170),
		},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"prack-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"options-ok"}}},
		{StatusCode: 202, Reason: "Accepted", Headers: map[string][]string{"X-IMS": {"refer-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"notify-ok"}}},
		{StatusCode: 202, Reason: "Accepted", Headers: map[string][]string{"Expires": {"300"}, "X-IMS": {"subscribe-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"Content-Type": {"text/plain"}, "X-IMS": {"message-ok"}}, Body: []byte("delivered")},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"info-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"dtmf-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"hold-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"resume-ok"}}},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"X-IMS": {"update-ok"}}, Body: runtimeSDP("198.51.100.23", 49172)},
		{StatusCode: 200, Reason: "OK", Headers: map[string][]string{"To": {"<sip:+18005551212@ims.example>;tag=remote"}, "X-IMS": {"reinvite-ok"}}, Body: runtimeSDP("198.51.100.24", 49174)},
		{StatusCode: 200, Reason: "OK"},
	}}
	gw := voicehost.NewGateway()
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered: true,
		StatusCode: 200,
		Reason:     "ims registered",
		Profile: voiceclient.IMSProfile{
			IMPI:   "user@ims.example",
			IMPU:   "sip:user@ims.example",
			Domain: "ims.example",
		},
		Binding: voiceclient.RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@ims.example",
			ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
		},
		VoiceTransport: transport,
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-voice",
		TraceID:      "trace-voice",
		IMSRegistrar: registrar,
		VoiceGateway: gw,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	agent, ok := gw.GetAgent("dev-voice").(voicehost.OutboundCallAgent)
	if !ok || agent == nil || agent != inst {
		t.Fatalf("gateway agent=%T, want runtime outbound agent", gw.GetAgent("dev-voice"))
	}
	res, err := agent.StartOutboundCall(context.Background(), voicehost.OutboundCallRequest{
		DeviceID: "dev-voice",
		CallID:   "call-runtime-voice",
		Callee:   "+18005551212",
		RemoteSDP: voicehost.SDPInfo{
			ConnectionIP: "192.0.2.44",
			MediaPort:    4000,
			Payloads:     []int{0, 8},
			Direction:    "sendrecv",
		},
		RawSDP: runtimeSDP("192.0.2.44", 4000),
	})
	if err != nil || !res.Accepted {
		t.Fatalf("StartOutboundCall() res=%+v err=%v", res, err)
	}
	if len(transport.requests) != 1 || transport.requests[0].Method != "INVITE" {
		t.Fatalf("requests=%+v", transport.requests)
	}
	if transport.requests[0].Headers["Route"] != "<sip:pcscf.ims.example;lr>" {
		t.Fatalf("INVITE Route=%q", transport.requests[0].Headers["Route"])
	}
	if len(transport.writes) != 1 || transport.writes[0].Method != "ACK" {
		t.Fatalf("writes=%+v", transport.writes)
	}
	terminator, ok := gw.GetAgent("dev-voice").(voicehost.DialogTerminator)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog terminator", gw.GetAgent("dev-voice"))
	}
	canceller, ok := gw.GetAgent("dev-voice").(voicehost.DialogCanceller)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog canceller", gw.GetAgent("dev-voice"))
	}
	if err := canceller.CancelVoiceCall(context.Background(), voicehost.DialogInfo{CallID: "unknown-call"}); err != nil {
		t.Fatalf("CancelVoiceCall(unknown) error = %v", err)
	}
	cancellerWithResult, ok := gw.GetAgent("dev-voice").(voicehost.DialogCancellerWithResult)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog canceller result", gw.GetAgent("dev-voice"))
	}
	cancelResult, err := cancellerWithResult.CancelVoiceCallWithResult(context.Background(), voicehost.DialogInfo{CallID: "unknown-call"})
	if err != nil || cancelResult.StatusCode != 481 {
		t.Fatalf("CancelVoiceCallWithResult(unknown) result=%+v err=%v, want 481", cancelResult, err)
	}
	sender, ok := gw.GetAgent("dev-voice").(voicehost.DialogInfoSender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog info sender", gw.GetAgent("dev-voice"))
	}
	prackSender, ok := gw.GetAgent("dev-voice").(voicehost.DialogPrackSender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog PRACK sender", gw.GetAgent("dev-voice"))
	}
	prackResult, err := prackSender.SendDialogPrack(context.Background(), voicehost.DialogPrackRequest{
		CallID: "call-runtime-voice",
		RAck:   "1 1 INVITE",
	})
	if err != nil || !prackResult.Accepted || prackResult.Headers["X-IMS"] != "prack-ok" {
		t.Fatalf("SendDialogPrack() result=%+v err=%v", prackResult, err)
	}
	if len(transport.requests) != 2 || transport.requests[1].Method != "PRACK" || transport.requests[1].Headers["CSeq"] != "2 PRACK" ||
		transport.requests[1].Headers["RAck"] != "1 1 INVITE" {
		t.Fatalf("PRACK requests=%+v", transport.requests)
	}
	optionsSender, ok := gw.GetAgent("dev-voice").(voicehost.DialogOptionsSender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog OPTIONS sender", gw.GetAgent("dev-voice"))
	}
	optionsResult, err := optionsSender.SendDialogOptions(context.Background(), voicehost.DialogOptionsRequest{CallID: "call-runtime-voice"})
	if err != nil || !optionsResult.Accepted || optionsResult.Headers["X-IMS"] != "options-ok" {
		t.Fatalf("SendDialogOptions() result=%+v err=%v", optionsResult, err)
	}
	if len(transport.requests) != 3 || transport.requests[2].Method != "OPTIONS" || transport.requests[2].Headers["CSeq"] != "3 OPTIONS" {
		t.Fatalf("OPTIONS requests=%+v", transport.requests)
	}
	referSender, ok := gw.GetAgent("dev-voice").(voicehost.DialogReferSender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog REFER sender", gw.GetAgent("dev-voice"))
	}
	referResult, err := referSender.SendDialogRefer(context.Background(), voicehost.DialogReferRequest{
		CallID:     "call-runtime-voice",
		ReferTo:    "sip:+18005551313@ims.example",
		ReferredBy: "sip:user@ims.example",
	})
	if err != nil || !referResult.Accepted || referResult.StatusCode != 202 || referResult.Headers["X-IMS"] != "refer-ok" {
		t.Fatalf("SendDialogRefer() result=%+v err=%v", referResult, err)
	}
	if len(transport.requests) != 4 || transport.requests[3].Method != "REFER" || transport.requests[3].Headers["CSeq"] != "4 REFER" ||
		transport.requests[3].Headers["Refer-To"] != "<sip:+18005551313@ims.example>" {
		t.Fatalf("REFER requests=%+v", transport.requests)
	}
	notifySender, ok := gw.GetAgent("dev-voice").(voicehost.DialogNotifySender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog NOTIFY sender", gw.GetAgent("dev-voice"))
	}
	notifyResult, err := notifySender.SendDialogNotify(context.Background(), voicehost.DialogNotifyRequest{
		CallID:            "call-runtime-voice",
		Event:             "refer",
		SubscriptionState: "terminated;reason=noresource",
		ContentType:       "message/sipfrag",
		Body:              []byte("SIP/2.0 200 OK\r\n"),
	})
	if err != nil || !notifyResult.Accepted || notifyResult.Headers["X-IMS"] != "notify-ok" {
		t.Fatalf("SendDialogNotify() result=%+v err=%v", notifyResult, err)
	}
	if len(transport.requests) != 5 || transport.requests[4].Method != "NOTIFY" ||
		transport.requests[4].Headers["CSeq"] != "5 NOTIFY" ||
		transport.requests[4].Headers["Event"] != "refer" ||
		transport.requests[4].Headers["Subscription-State"] != "terminated;reason=noresource" {
		t.Fatalf("NOTIFY requests=%+v", transport.requests)
	}
	subscribeSender, ok := gw.GetAgent("dev-voice").(voicehost.DialogSubscribeSender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog SUBSCRIBE sender", gw.GetAgent("dev-voice"))
	}
	subscribeResult, err := subscribeSender.SendDialogSubscribe(context.Background(), voicehost.DialogSubscribeRequest{
		CallID:  "call-runtime-voice",
		Event:   "refer",
		Expires: "300",
	})
	if err != nil || !subscribeResult.Accepted || subscribeResult.StatusCode != 202 ||
		subscribeResult.Headers["X-IMS"] != "subscribe-ok" || subscribeResult.Headers["Expires"] != "300" {
		t.Fatalf("SendDialogSubscribe() result=%+v err=%v", subscribeResult, err)
	}
	if len(transport.requests) != 6 || transport.requests[5].Method != "SUBSCRIBE" ||
		transport.requests[5].Headers["CSeq"] != "6 SUBSCRIBE" ||
		transport.requests[5].Headers["Event"] != "refer" ||
		transport.requests[5].Headers["Expires"] != "300" {
		t.Fatalf("SUBSCRIBE requests=%+v", transport.requests)
	}
	messageSender, ok := gw.GetAgent("dev-voice").(voicehost.DialogMessageSender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog MESSAGE sender", gw.GetAgent("dev-voice"))
	}
	messageResult, err := messageSender.SendDialogMessage(context.Background(), voicehost.DialogMessageRequest{
		CallID:      "call-runtime-voice",
		ContentType: "text/plain",
		Body:        []byte("hello"),
	})
	if err != nil || !messageResult.Accepted || messageResult.Headers["X-IMS"] != "message-ok" ||
		messageResult.ContentType != "text/plain" || string(messageResult.Body) != "delivered" {
		t.Fatalf("SendDialogMessage() result=%+v err=%v", messageResult, err)
	}
	if len(transport.requests) != 7 || transport.requests[6].Method != "MESSAGE" ||
		transport.requests[6].Headers["CSeq"] != "7 MESSAGE" ||
		transport.requests[6].Headers["Content-Type"] != "text/plain" ||
		string(transport.requests[6].Body) != "hello" {
		t.Fatalf("MESSAGE requests=%+v", transport.requests)
	}
	infoResult, err := sender.SendDialogInfo(context.Background(), voicehost.DialogInfoRequest{
		CallID:      "call-runtime-voice",
		ContentType: "application/dtmf-relay",
		InfoPackage: "dtmf",
		Body:        []byte("Signal=3\r\nDuration=100\r\n"),
	})
	if err != nil || !infoResult.Accepted || infoResult.Headers["X-IMS"] != "info-ok" {
		t.Fatalf("SendDialogInfo() result=%+v err=%v", infoResult, err)
	}
	if len(transport.requests) != 8 || transport.requests[7].Method != "INFO" || transport.requests[7].Headers["CSeq"] != "8 INFO" {
		t.Fatalf("INFO requests=%+v", transport.requests)
	}
	dtmfSender, ok := gw.GetAgent("dev-voice").(voicehost.DialogDTMFSender)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog DTMF sender", gw.GetAgent("dev-voice"))
	}
	dtmfResult, err := dtmfSender.SendDialogDTMF(context.Background(), voicehost.DialogDTMFRequest{
		CallID:     "call-runtime-voice",
		Signal:     "9",
		DurationMS: 110,
	})
	if err != nil || !dtmfResult.Accepted || dtmfResult.Headers["X-IMS"] != "dtmf-ok" {
		t.Fatalf("SendDialogDTMF() result=%+v err=%v", dtmfResult, err)
	}
	if len(transport.requests) != 9 || transport.requests[8].Method != "INFO" || transport.requests[8].Headers["CSeq"] != "9 INFO" ||
		transport.requests[8].Headers["Info-Package"] != voicehost.DTMFInfoPackage || string(transport.requests[8].Body) != "Signal=9\r\nDuration=110\r\n" {
		t.Fatalf("DTMF requests=%+v", transport.requests)
	}
	holdController, ok := gw.GetAgent("dev-voice").(voicehost.DialogHoldController)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog hold controller", gw.GetAgent("dev-voice"))
	}
	holdResult, err := holdController.SendDialogHold(context.Background(), voicehost.DialogHoldRequest{CallID: "call-runtime-voice"})
	if err != nil || !holdResult.Accepted || holdResult.Headers["X-IMS"] != "hold-ok" {
		t.Fatalf("SendDialogHold() result=%+v err=%v", holdResult, err)
	}
	if len(transport.requests) != 10 || transport.requests[9].Method != "UPDATE" || transport.requests[9].Headers["CSeq"] != "10 UPDATE" ||
		!strings.Contains(string(transport.requests[9].Body), "a=sendonly\r\n") {
		t.Fatalf("hold requests=%+v", transport.requests)
	}
	resumeResult, err := holdController.SendDialogResume(context.Background(), voicehost.DialogResumeRequest{CallID: "call-runtime-voice"})
	if err != nil || !resumeResult.Accepted || resumeResult.Headers["X-IMS"] != "resume-ok" {
		t.Fatalf("SendDialogResume() result=%+v err=%v", resumeResult, err)
	}
	if len(transport.requests) != 11 || transport.requests[10].Method != "UPDATE" || transport.requests[10].Headers["CSeq"] != "11 UPDATE" ||
		!strings.Contains(string(transport.requests[10].Body), "a=sendrecv\r\n") {
		t.Fatalf("resume requests=%+v", transport.requests)
	}
	updater, ok := gw.GetAgent("dev-voice").(voicehost.DialogUpdater)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog updater", gw.GetAgent("dev-voice"))
	}
	updateResult, err := updater.SendDialogUpdate(context.Background(), voicehost.DialogUpdateRequest{
		CallID:      "call-runtime-voice",
		ContentType: "application/sdp",
		Body:        runtimeSDP("192.0.2.45", 4002),
	})
	if err != nil || !updateResult.Accepted || updateResult.Headers["X-IMS"] != "update-ok" {
		t.Fatalf("SendDialogUpdate() result=%+v err=%v", updateResult, err)
	}
	if len(transport.requests) != 12 || transport.requests[11].Method != "UPDATE" || transport.requests[11].Headers["CSeq"] != "12 UPDATE" {
		t.Fatalf("UPDATE requests=%+v", transport.requests)
	}
	reinviter, ok := gw.GetAgent("dev-voice").(voicehost.DialogReinviter)
	if !ok {
		t.Fatalf("gateway agent=%T, want dialog reinviter", gw.GetAgent("dev-voice"))
	}
	reinviteResult, err := reinviter.SendDialogReinvite(context.Background(), voicehost.DialogReinviteRequest{
		CallID:      "call-runtime-voice",
		ContentType: "application/sdp",
		Body:        runtimeSDP("192.0.2.46", 4004),
	})
	if err != nil || !reinviteResult.Accepted || reinviteResult.Headers["X-IMS"] != "reinvite-ok" {
		t.Fatalf("SendDialogReinvite() result=%+v err=%v", reinviteResult, err)
	}
	if len(transport.requests) != 13 || transport.requests[12].Method != "INVITE" || transport.requests[12].Headers["CSeq"] != "13 INVITE" {
		t.Fatalf("re-INVITE requests=%+v", transport.requests)
	}
	if len(transport.writes) != 2 || transport.writes[1].Method != "ACK" || transport.writes[1].Headers["CSeq"] != "13 ACK" {
		t.Fatalf("writes after re-INVITE=%+v", transport.writes)
	}
	if err := terminator.EndVoiceCall(context.Background(), voicehost.DialogInfo{CallID: "call-runtime-voice"}); err != nil {
		t.Fatalf("EndVoiceCall() error = %v", err)
	}
	if len(transport.requests) != 14 || transport.requests[13].Method != "BYE" || transport.requests[13].Headers["CSeq"] != "14 BYE" {
		t.Fatalf("requests after BYE=%+v", transport.requests)
	}
}

func TestRuntimeIMSRecoveryRetriesOutboundInviteAfterTransportFailure(t *testing.T) {
	firstTransport := &runtimeVoiceTransport{errors: []error{errors.New("stale pcscf flow")}}
	recoveredTransport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 200,
		Reason:     "OK",
		Headers: map[string][]string{
			"To":      {"<sip:+18005551212@ims.example>;tag=recovered"},
			"Contact": {"<sip:remote@pcscf2.ims.example>"},
		},
		Body: runtimeSDP("198.51.100.32", 49180),
	}}}
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	initialBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf1.ims.example;lr>"},
	}
	recoveredBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.20:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf2.ims.example;lr>"},
	}
	recoveries := 0
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered:     true,
		StatusCode:     200,
		Reason:         "ims registered",
		Profile:        profile,
		Binding:        initialBinding,
		VoiceTransport: firstTransport,
		Recover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered:     true,
				StatusCode:     200,
				Reason:         "ims recovered",
				Profile:        profile,
				Binding:        recoveredBinding,
				VoiceTransport: recoveredTransport,
			}, nil
		},
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-recover",
		TraceID:      "trace-recover",
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	result, err := inst.StartOutboundCall(context.Background(), voicehost.OutboundCallRequest{
		DeviceID: "dev-recover",
		CallID:   "call-recover",
		Callee:   "+18005551212",
		RemoteSDP: voicehost.SDPInfo{
			ConnectionIP: "192.0.2.44",
			MediaPort:    4000,
			Payloads:     []int{0, 8},
			Direction:    "sendrecv",
		},
		RawSDP: runtimeSDP("192.0.2.44", 4000),
	})
	if err != nil || !result.Accepted {
		t.Fatalf("StartOutboundCall() result=%+v err=%v", result, err)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries=%d, want 1", recoveries)
	}
	if len(firstTransport.requests) != 1 || firstTransport.requests[0].Headers["Route"] != "<sip:pcscf1.ims.example;lr>" {
		t.Fatalf("initial requests=%+v", firstTransport.requests)
	}
	if len(recoveredTransport.requests) != 1 || recoveredTransport.requests[0].Headers["Route"] != "<sip:pcscf2.ims.example;lr>" {
		t.Fatalf("recovered requests=%+v", recoveredTransport.requests)
	}
	if len(recoveredTransport.writes) != 1 || recoveredTransport.writes[0].Method != "ACK" {
		t.Fatalf("recovered writes=%+v", recoveredTransport.writes)
	}
	if st := inst.State(); !st.IMSReady || st.LastReason != "ims recovered" {
		t.Fatalf("state=%+v", st)
	}
}

func TestRuntimeIMSRecoveryAfterDialogInfoRecoverableResponse(t *testing.T) {
	transport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote"},
				"Contact": {"<sip:remote@pcscf.ims.example>"},
			},
			Body: runtimeSDP("198.51.100.22", 49170),
		},
		{StatusCode: 503, Reason: "Service Unavailable"},
	}}
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	binding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
	}
	recoveries := 0
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered:     true,
		StatusCode:     200,
		Reason:         "ims registered",
		Profile:        profile,
		Binding:        binding,
		VoiceTransport: transport,
		Recover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered:     true,
				StatusCode:     200,
				Reason:         "ims recovered",
				Profile:        profile,
				Binding:        binding,
				VoiceTransport: transport,
			}, nil
		},
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-dialog-recover",
		TraceID:      "trace-dialog-recover",
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if _, err := inst.StartOutboundCall(context.Background(), voicehost.OutboundCallRequest{
		DeviceID: "dev-dialog-recover",
		CallID:   "call-dialog-recover",
		Callee:   "+18005551212",
		RemoteSDP: voicehost.SDPInfo{
			ConnectionIP: "192.0.2.44",
			MediaPort:    4000,
			Payloads:     []int{0, 8},
			Direction:    "sendrecv",
		},
		RawSDP: runtimeSDP("192.0.2.44", 4000),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	result, err := inst.SendDialogInfo(context.Background(), voicehost.DialogInfoRequest{
		CallID:      "call-dialog-recover",
		ContentType: "application/dtmf-relay",
		InfoPackage: "dtmf",
		Body:        []byte("Signal=5\r\nDuration=100\r\n"),
	})
	if err != nil {
		t.Fatalf("SendDialogInfo() error = %v", err)
	}
	if result.Accepted || result.StatusCode != 503 || !result.RegistrationRecoveryNeeded {
		t.Fatalf("SendDialogInfo() result=%+v", result)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries=%d, want 1", recoveries)
	}
	if st := inst.State(); !st.IMSReady || st.LastReason != "ims recovered" {
		t.Fatalf("state=%+v", st)
	}
}

func TestRuntimeIMSRecoveryHonorsRetryAfterContext(t *testing.T) {
	transport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{
		{
			StatusCode: 200,
			Reason:     "OK",
			Headers: map[string][]string{
				"To":      {"<sip:+18005551212@ims.example>;tag=remote"},
				"Contact": {"<sip:remote@pcscf.ims.example>"},
			},
			Body: runtimeSDP("198.51.100.22", 49170),
		},
		{
			StatusCode: 503,
			Reason:     "Service Unavailable",
			Headers:    map[string][]string{"Retry-After": {"1"}},
		},
	}}
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	binding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
	}
	recoveries := 0
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered:     true,
		StatusCode:     200,
		Reason:         "ims registered",
		Profile:        profile,
		Binding:        binding,
		VoiceTransport: transport,
		Recover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{Registered: true, StatusCode: 200, Reason: "ims recovered", Profile: profile, Binding: binding, VoiceTransport: transport}, nil
		},
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-retry-after",
		TraceID:      "trace-retry-after",
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if _, err := inst.StartOutboundCall(context.Background(), voicehost.OutboundCallRequest{
		DeviceID: "dev-retry-after",
		CallID:   "call-retry-after",
		Callee:   "+18005551212",
		RemoteSDP: voicehost.SDPInfo{
			ConnectionIP: "192.0.2.44",
			MediaPort:    4000,
			Payloads:     []int{0, 8},
			Direction:    "sendrecv",
		},
		RawSDP: runtimeSDP("192.0.2.44", 4000),
	}); err != nil {
		t.Fatalf("StartOutboundCall() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	result, err := inst.SendDialogInfo(ctx, voicehost.DialogInfoRequest{
		CallID:      "call-retry-after",
		ContentType: "application/dtmf-relay",
		InfoPackage: "dtmf",
		Body:        []byte("Signal=5\r\nDuration=100\r\n"),
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SendDialogInfo() result=%+v err=%v, want context deadline", result, err)
	}
	if !result.RegistrationRecoveryNeeded || result.RetryAfter != time.Second {
		t.Fatalf("SendDialogInfo() result=%+v, want RetryAfter=1s", result)
	}
	if recoveries != 0 {
		t.Fatalf("recoveries=%d, want 0 before Retry-After elapses", recoveries)
	}
	st := inst.State()
	if !st.IMSReady || !st.IMSRecoveryPending || st.IMSRecoveryRetryAfter != time.Second ||
		st.IMSRecoveryNextAttemptAt.IsZero() ||
		st.IMSRecoveryReason != "Service Unavailable" ||
		st.LastReason != "IMS registration recovery delayed: Service Unavailable" {
		t.Fatalf("state after Retry-After cancellation=%+v", st)
	}
}

func TestRuntimeIMSRecoveryClearsRetryAfterPendingStateOnSuccess(t *testing.T) {
	profile := voiceclient.IMSProfile{IMPI: "user@ims.example", IMPU: "sip:user@ims.example", Domain: "ims.example"}
	binding := voiceclient.RegistrationBinding{ContactURI: "sip:user@192.0.2.10:5060", PublicIdentity: "sip:user@ims.example"}
	recoveries := 0
	inst := &Instance{
		state: State{DeviceID: "dev-retry-after-success", Phase: PhaseReady, IMSReady: true},
		imsRecover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered: true,
				StatusCode: 200,
				Reason:     "ims recovered",
				Profile:    profile,
				Binding:    binding,
			}, nil
		},
	}

	result, recovered, err := inst.recoverIMSRegistration(context.Background(), "Service Unavailable", false, time.Millisecond)
	if err != nil || !recovered || !result.Registered {
		t.Fatalf("recoverIMSRegistration() result=%+v recovered=%v err=%v", result, recovered, err)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries=%d, want 1", recoveries)
	}
	st := inst.State()
	if !st.IMSReady || st.IMSRecoveryPending || st.IMSRecoveryRetryAfter != 0 ||
		!st.IMSRecoveryNextAttemptAt.IsZero() || st.IMSRecoveryReason != "" ||
		st.LastReason != "ims recovered" {
		t.Fatalf("state after recovery success=%+v", st)
	}
}

func TestRuntimeIMSRecoveryAfterByeCancelRecoverableResults(t *testing.T) {
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	binding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf.ims.example;lr>"},
	}
	agent := &runtimeDialogRecoveryAgent{
		terminateResult: voicehost.DialogInfoResult{
			Accepted:                   false,
			StatusCode:                 503,
			Reason:                     "Service Unavailable",
			RegistrationRecoveryNeeded: true,
		},
		terminateErr: errors.New("IMS BYE rejected"),
		cancelResult: voicehost.DialogInfoResult{
			Accepted:                   false,
			StatusCode:                 503,
			Reason:                     "Service Unavailable",
			RegistrationRecoveryNeeded: true,
		},
		cancelErr: errors.New("IMS CANCEL rejected"),
	}
	recoveries := 0
	inst := &Instance{
		state: State{DeviceID: "dev-bye-cancel-recover", Phase: PhaseReady, IMSReady: true},
		voice: agent,
		imsRecover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered:     true,
				StatusCode:     200,
				Reason:         "ims recovered",
				Profile:        profile,
				Binding:        binding,
				VoiceTransport: &runtimeVoiceTransport{},
			}, nil
		},
	}

	byeResult, err := inst.EndVoiceCallWithResult(context.Background(), voicehost.DialogInfo{CallID: "call-bye-recover"})
	if err == nil || !strings.Contains(err.Error(), "IMS BYE rejected") {
		t.Fatalf("EndVoiceCallWithResult() result=%+v err=%v, want BYE rejection", byeResult, err)
	}
	if byeResult.StatusCode != 503 || !byeResult.RegistrationRecoveryNeeded {
		t.Fatalf("EndVoiceCallWithResult() result=%+v, want recoverable 503", byeResult)
	}
	if recoveries != 1 || len(agent.registrationUpdates) != 1 {
		t.Fatalf("recoveries=%d updates=%d, want 1/1", recoveries, len(agent.registrationUpdates))
	}

	err = inst.CancelVoiceCall(context.Background(), voicehost.DialogInfo{CallID: "call-cancel-recover"})
	if err == nil || !strings.Contains(err.Error(), "IMS CANCEL rejected") {
		t.Fatalf("CancelVoiceCall() err=%v, want CANCEL rejection", err)
	}
	if recoveries != 2 || len(agent.registrationUpdates) != 2 {
		t.Fatalf("recoveries=%d updates=%d, want 2/2", recoveries, len(agent.registrationUpdates))
	}
	if len(agent.terminated) != 1 || agent.terminated[0].CallID != "call-bye-recover" ||
		len(agent.canceled) != 1 || agent.canceled[0].CallID != "call-cancel-recover" {
		t.Fatalf("terminated=%+v canceled=%+v", agent.terminated, agent.canceled)
	}
	if st := inst.State(); !st.IMSReady || st.LastReason != "ims recovered" {
		t.Fatalf("state=%+v", st)
	}
}

func TestRuntimeSendDialogAutoDTMFUsesRTPWhenAvailable(t *testing.T) {
	agent := &runtimeAutoDTMFAgent{
		rtpResult: voicehost.DialogRTPDTMFResult{
			Accepted:   true,
			StatusCode: 200,
			Reason:     "OK",
			RTP: voicehost.RTPRelayDTMFResult{
				Packets:    6,
				Signal:     "5",
				DurationMS: 120,
			},
		},
		infoResult: voicehost.DialogDTMFResult{Accepted: true, StatusCode: 200, Reason: "INFO OK"},
	}
	inst := &Instance{state: State{DeviceID: "dev-auto-dtmf", Phase: PhaseReady, IMSReady: true}, voice: agent}

	result, err := inst.SendDialogAutoDTMF(context.Background(), voicehost.DialogDTMFRequest{
		DeviceID:   " dev-auto-dtmf ",
		CallID:     " call-rtp ",
		Signal:     "5",
		DurationMS: 120,
	})
	if err != nil {
		t.Fatalf("SendDialogAutoDTMF() error = %v", err)
	}
	if !result.Accepted || result.Route != voicehost.DialogDTMFRouteRTP || result.RTP.RTP.Packets != 6 {
		t.Fatalf("SendDialogAutoDTMF() result=%+v, want RTP success", result)
	}
	if len(agent.rtpRequests) != 1 || len(agent.infoRequests) != 0 {
		t.Fatalf("rtpRequests=%+v infoRequests=%+v, want RTP only", agent.rtpRequests, agent.infoRequests)
	}
	got := agent.rtpRequests[0]
	if got.DeviceID != "dev-auto-dtmf" || got.CallID != "call-rtp" ||
		got.Direction != voicehost.RTPDTMFClientToIMS || got.Signal != "5" || got.DurationMS != 120 {
		t.Fatalf("RTP request=%+v", got)
	}
}

func TestRuntimeSendDialogAutoDTMFFallsBackToInfoWhenRTPRelayUnavailable(t *testing.T) {
	agent := &runtimeAutoDTMFAgent{
		rtpResult: voicehost.DialogRTPDTMFResult{
			Accepted:   false,
			StatusCode: 409,
			Reason:     "RTP relay unavailable",
		},
		rtpErr: errors.Join(voicehost.ErrRTPRelayConfig, errors.New("payload unavailable")),
		infoResult: voicehost.DialogDTMFResult{
			Accepted:   true,
			StatusCode: 200,
			Reason:     "OK",
			Headers:    map[string]string{"X-IMS": "info-dtmf-ok"},
		},
	}
	inst := &Instance{state: State{DeviceID: "dev-auto-dtmf", Phase: PhaseReady, IMSReady: true}, voice: agent}

	result, err := inst.SendDialogAutoDTMF(context.Background(), voicehost.DialogDTMFRequest{
		CallID:     "call-info",
		Signal:     "#",
		DurationMS: 90,
	})
	if err != nil {
		t.Fatalf("SendDialogAutoDTMF() error = %v", err)
	}
	if !result.Accepted || result.Route != voicehost.DialogDTMFRouteInfo || result.INFO.Headers["X-IMS"] != "info-dtmf-ok" {
		t.Fatalf("SendDialogAutoDTMF() result=%+v, want INFO fallback success", result)
	}
	if len(agent.rtpRequests) != 1 || len(agent.infoRequests) != 1 {
		t.Fatalf("rtpRequests=%+v infoRequests=%+v, want RTP then INFO", agent.rtpRequests, agent.infoRequests)
	}
	if agent.infoRequests[0].Signal != "#" || agent.infoRequests[0].DurationMS != 90 {
		t.Fatalf("INFO request=%+v", agent.infoRequests[0])
	}
}

func TestRuntimeSendDialogAutoDTMFDoesNotFallbackOnInvalidInput(t *testing.T) {
	agent := &runtimeAutoDTMFAgent{
		rtpErr:     voicehost.ErrRTPRelayConfig,
		infoResult: voicehost.DialogDTMFResult{Accepted: true, StatusCode: 200, Reason: "OK"},
	}
	inst := &Instance{state: State{DeviceID: "dev-auto-dtmf", Phase: PhaseReady, IMSReady: true}, voice: agent}

	result, err := inst.SendDialogAutoDTMF(context.Background(), voicehost.DialogDTMFRequest{
		CallID:     "call-invalid",
		Signal:     "12",
		DurationMS: 90,
	})
	if !errors.Is(err, voicehost.ErrInvalidDTMF) {
		t.Fatalf("SendDialogAutoDTMF() result=%+v err=%v, want invalid DTMF", result, err)
	}
	if result.Accepted || result.StatusCode != 400 || result.Route != "" {
		t.Fatalf("SendDialogAutoDTMF() result=%+v, want local 400", result)
	}
	if len(agent.rtpRequests) != 0 || len(agent.infoRequests) != 0 {
		t.Fatalf("rtpRequests=%+v infoRequests=%+v, want no sends", agent.rtpRequests, agent.infoRequests)
	}
}

func TestRuntimeSendDialogAutoDTMFDoesNotFallbackOnDialogMiss(t *testing.T) {
	agent := &runtimeAutoDTMFAgent{
		rtpResult:  voicehost.DialogRTPDTMFResult{Accepted: false, StatusCode: 481, Reason: "dialog not found"},
		infoResult: voicehost.DialogDTMFResult{Accepted: true, StatusCode: 200, Reason: "INFO OK"},
	}
	inst := &Instance{state: State{DeviceID: "dev-auto-dtmf", Phase: PhaseReady, IMSReady: true}, voice: agent}

	result, err := inst.SendDialogAutoDTMF(context.Background(), voicehost.DialogDTMFRequest{
		CallID:     "call-missing",
		Signal:     "7",
		DurationMS: 100,
	})
	if err != nil {
		t.Fatalf("SendDialogAutoDTMF() error = %v", err)
	}
	if result.Accepted || result.StatusCode != 481 || result.Route != voicehost.DialogDTMFRouteRTP {
		t.Fatalf("SendDialogAutoDTMF() result=%+v, want RTP dialog miss", result)
	}
	if len(agent.rtpRequests) != 1 || len(agent.infoRequests) != 0 {
		t.Fatalf("rtpRequests=%+v infoRequests=%+v, want RTP only", agent.rtpRequests, agent.infoRequests)
	}
}

func TestRuntimeIMSRecoveryRetriesSMSPartAfterTransportFailure(t *testing.T) {
	firstTransport := &runtimeVoiceTransport{errors: []error{errors.New("stale sms pcscf flow")}}
	recoveredTransport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{{StatusCode: 202, Reason: "Accepted"}}}
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	initialBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf1.ims.example;lr>"},
	}
	recoveredBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.20:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf2.ims.example;lr>"},
	}
	recoveries := 0
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered: true,
		StatusCode: 200,
		Reason:     "ims registered",
		Profile:    profile,
		Binding:    initialBinding,
		SMSTransport: messaging.IMSSMSTransport{
			Transport:    firstTransport,
			Profile:      profile,
			Registration: initialBinding,
		},
		Recover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered: true,
				StatusCode: 200,
				Reason:     "ims recovered",
				Profile:    profile,
				Binding:    recoveredBinding,
				SMSTransport: messaging.IMSSMSTransport{
					Transport:    recoveredTransport,
					Profile:      profile,
					Registration: recoveredBinding,
				},
			}, nil
		},
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-sms-recover",
		TraceID:      "trace-sms-recover",
		Profile:      identity.Profile{IMSI: "310280000000001"},
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	out, err := inst.SendSMSWithOptions(context.Background(), "+18005551212", "hello", messaging.SendOptions{})
	if err != nil || out.State != "sent" || out.Parts != 1 {
		t.Fatalf("SendSMSWithOptions() out=%+v err=%v", out, err)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries=%d, want 1", recoveries)
	}
	if len(firstTransport.requests) != 1 || firstTransport.requests[0].Headers["Route"] != "<sip:pcscf1.ims.example;lr>" {
		t.Fatalf("initial SMS requests=%+v", firstTransport.requests)
	}
	if len(recoveredTransport.requests) != 1 || recoveredTransport.requests[0].Method != "MESSAGE" ||
		recoveredTransport.requests[0].Headers["Route"] != "<sip:pcscf2.ims.example;lr>" {
		t.Fatalf("recovered SMS requests=%+v", recoveredTransport.requests)
	}
	if st := inst.State(); !st.IMSReady || st.LastReason != "ims recovered" {
		t.Fatalf("state=%+v", st)
	}
}

func TestRuntimeIMSRecoveryRetriesSMSPartAfterRecoverableSIPStatus(t *testing.T) {
	firstTransport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{{StatusCode: 503, Reason: "Service Unavailable"}}}
	recoveredTransport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{{StatusCode: 202, Reason: "Accepted"}}}
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	initialBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf1.ims.example;lr>"},
	}
	recoveredBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.20:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf2.ims.example;lr>"},
	}
	recoveries := 0
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered: true,
		StatusCode: 200,
		Reason:     "ims registered",
		Profile:    profile,
		Binding:    initialBinding,
		SMSTransport: messaging.IMSSMSTransport{
			Transport:    firstTransport,
			Profile:      profile,
			Registration: initialBinding,
		},
		Recover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered: true,
				StatusCode: 200,
				Reason:     "ims recovered",
				Profile:    profile,
				Binding:    recoveredBinding,
				SMSTransport: messaging.IMSSMSTransport{
					Transport:    recoveredTransport,
					Profile:      profile,
					Registration: recoveredBinding,
				},
			}, nil
		},
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-sms-recover-503",
		TraceID:      "trace-sms-recover-503",
		Profile:      identity.Profile{IMSI: "310280000000001"},
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	out, err := inst.SendSMSWithOptions(context.Background(), "+18005551212", "hello", messaging.SendOptions{})
	if err != nil || out.State != "sent" || out.Parts != 1 {
		t.Fatalf("SendSMSWithOptions() out=%+v err=%v", out, err)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries=%d, want 1", recoveries)
	}
	if len(firstTransport.requests) != 1 || firstTransport.requests[0].Headers["Route"] != "<sip:pcscf1.ims.example;lr>" {
		t.Fatalf("initial SMS requests=%+v", firstTransport.requests)
	}
	if len(recoveredTransport.requests) != 1 || recoveredTransport.requests[0].Method != "MESSAGE" ||
		recoveredTransport.requests[0].Headers["Route"] != "<sip:pcscf2.ims.example;lr>" {
		t.Fatalf("recovered SMS requests=%+v", recoveredTransport.requests)
	}
	if st := inst.State(); !st.IMSReady || st.LastReason != "ims recovered" {
		t.Fatalf("state=%+v", st)
	}
}

func TestRuntimeIMSRecoveryRetriesUSSDInviteAfterTransportFailure(t *testing.T) {
	firstTransport := &runtimeVoiceTransport{errors: []error{errors.New("stale ussd pcscf flow")}}
	recoveredTransport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 200,
		Reason:     "OK",
		Headers: map[string][]string{
			"To":      {"<sip:*100%23@ims.example;user=dialstring>;tag=recovered"},
			"Contact": {"<sip:ussd-as@ims.example>"},
		},
	}}}
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	initialBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf1.ims.example;lr>"},
	}
	recoveredBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.20:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf2.ims.example;lr>"},
	}
	recoveries := 0
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered: true,
		StatusCode: 200,
		Reason:     "ims registered",
		Profile:    profile,
		Binding:    initialBinding,
		USSDTransport: &messaging.IMSUSSDTransport{
			Transport:    firstTransport,
			Profile:      profile,
			Registration: initialBinding,
		},
		Recover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered: true,
				StatusCode: 200,
				Reason:     "ims recovered",
				Profile:    profile,
				Binding:    recoveredBinding,
				USSDTransport: &messaging.IMSUSSDTransport{
					Transport:    recoveredTransport,
					Profile:      profile,
					Registration: recoveredBinding,
				},
			}, nil
		},
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-ussd-recover",
		TraceID:      "trace-ussd-recover",
		Profile:      identity.Profile{IMSI: "310280000000001"},
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	result, err := inst.Service().SendUSSD(context.Background(), "*100#")
	if err != nil || result == nil || result.Status != 200 || result.Done {
		t.Fatalf("SendUSSD() result=%+v err=%v", result, err)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries=%d, want 1", recoveries)
	}
	if len(firstTransport.requests) != 1 || firstTransport.requests[0].Headers["Route"] != "<sip:pcscf1.ims.example;lr>" {
		t.Fatalf("initial USSD requests=%+v", firstTransport.requests)
	}
	if len(recoveredTransport.requests) != 1 || recoveredTransport.requests[0].Method != "INVITE" ||
		recoveredTransport.requests[0].Headers["Route"] != "<sip:pcscf2.ims.example;lr>" {
		t.Fatalf("recovered USSD requests=%+v", recoveredTransport.requests)
	}
	if len(recoveredTransport.writes) != 1 || recoveredTransport.writes[0].Method != "ACK" {
		t.Fatalf("recovered USSD writes=%+v", recoveredTransport.writes)
	}
	if st := inst.State(); !st.IMSReady || st.LastReason != "ims recovered" {
		t.Fatalf("state=%+v", st)
	}
}

func TestRuntimeIMSRecoveryRetriesUSSDInviteAfterRecoverableSIPStatus(t *testing.T) {
	firstTransport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 503,
		Reason:     "Service Unavailable",
		Headers: map[string][]string{
			"To": {"<sip:*100%23@ims.example;user=dialstring>;tag=unavailable"},
		},
	}}}
	recoveredTransport := &runtimeVoiceTransport{responses: []voiceclient.SIPResponse{{
		StatusCode: 200,
		Reason:     "OK",
		Headers: map[string][]string{
			"To":      {"<sip:*100%23@ims.example;user=dialstring>;tag=recovered"},
			"Contact": {"<sip:ussd-as@ims.example>"},
		},
	}}}
	profile := voiceclient.IMSProfile{
		IMPI:   "user@ims.example",
		IMPU:   "sip:user@ims.example",
		Domain: "ims.example",
	}
	initialBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.10:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf1.ims.example;lr>"},
	}
	recoveredBinding := voiceclient.RegistrationBinding{
		ContactURI:     "sip:user@192.0.2.20:5060",
		PublicIdentity: "sip:user@ims.example",
		ServiceRoutes:  []string{"<sip:pcscf2.ims.example;lr>"},
	}
	recoveries := 0
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered: true,
		StatusCode: 200,
		Reason:     "ims registered",
		Profile:    profile,
		Binding:    initialBinding,
		USSDTransport: &messaging.IMSUSSDTransport{
			Transport:    firstTransport,
			Profile:      profile,
			Registration: initialBinding,
		},
		Recover: func(ctx context.Context) (IMSRegistrationResult, error) {
			recoveries++
			return IMSRegistrationResult{
				Registered: true,
				StatusCode: 200,
				Reason:     "ims recovered",
				Profile:    profile,
				Binding:    recoveredBinding,
				USSDTransport: &messaging.IMSUSSDTransport{
					Transport:    recoveredTransport,
					Profile:      profile,
					Registration: recoveredBinding,
				},
			}, nil
		},
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-ussd-recover-503",
		TraceID:      "trace-ussd-recover-503",
		Profile:      identity.Profile{IMSI: "310280000000001"},
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	result, err := inst.Service().SendUSSD(context.Background(), "*100#")
	if err != nil || result == nil || result.Status != 200 || result.Done {
		t.Fatalf("SendUSSD() result=%+v err=%v", result, err)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries=%d, want 1", recoveries)
	}
	if len(firstTransport.requests) != 1 || firstTransport.requests[0].Headers["Route"] != "<sip:pcscf1.ims.example;lr>" ||
		len(firstTransport.writes) != 1 || firstTransport.writes[0].Method != "ACK" {
		t.Fatalf("initial USSD requests=%+v writes=%+v", firstTransport.requests, firstTransport.writes)
	}
	if len(recoveredTransport.requests) != 1 || recoveredTransport.requests[0].Method != "INVITE" ||
		recoveredTransport.requests[0].Headers["Route"] != "<sip:pcscf2.ims.example;lr>" {
		t.Fatalf("recovered USSD requests=%+v", recoveredTransport.requests)
	}
	if len(recoveredTransport.writes) != 1 || recoveredTransport.writes[0].Method != "ACK" {
		t.Fatalf("recovered USSD writes=%+v", recoveredTransport.writes)
	}
	if st := inst.State(); !st.IMSReady || st.LastReason != "ims recovered" {
		t.Fatalf("state=%+v", st)
	}
}

func TestStartRejectsIMSRegistrationFailure(t *testing.T) {
	registrar := &testIMSRegistrar{err: errors.New("401 after AKA")}
	_, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-1",
		Access:       NewModemAccessAdapter(testModem{}),
		IMSRegistrar: registrar,
	})
	if err == nil || !strings.Contains(err.Error(), "IMS registration failed") {
		t.Fatalf("Start() err=%v, want IMS registration failure", err)
	}
}

func TestStartRejectsUnregisteredIMSResult(t *testing.T) {
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{Registered: false, StatusCode: 403, Reason: "Forbidden"}}
	_, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-1",
		Access:       NewModemAccessAdapter(testModem{}),
		IMSRegistrar: registrar,
	})
	if err == nil || !strings.Contains(err.Error(), "IMS registration rejected") {
		t.Fatalf("Start() err=%v, want rejected IMS registration", err)
	}
}

func TestStartWithoutIMSRegistrarKeepsCompatibilityReady(t *testing.T) {
	inst, err := Start(context.Background(), StartRequest{
		DeviceID: "dev-1",
		Access:   NewModemAccessAdapter(testModem{}),
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !inst.State().IMSReady {
		t.Fatalf("IMSReady=false without explicit registrar")
	}
	if inst.State().TunnelReady {
		t.Fatalf("TunnelReady=true without explicit tunnel manager")
	}
}

func TestStartEstablishesTunnelWhenManagerProvided(t *testing.T) {
	manager := &runtimeTunnelManager{session: &runtimeTunnelSession{result: swu.TunnelResult{
		Ready:            true,
		Mode:             swu.DataplaneModeUserspace,
		EPDGAddress:      "epdg.example",
		IKEEstablished:   true,
		IPsecEstablished: true,
		MOBIKESupported:  true,
		Reason:           "ike ipsec ready",
	}}}
	prepared := identity.PreparedSession{
		Profile:    identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280", IMEI: "356789012345678"},
		EPDGAddr:   "epdg.example",
		EPDGSource: "redirect",
		CarrierPolicy: carrier.CarrierPolicy{IMS: carrier.IMSAccessProfile{
			IMSAPN:    "ims",
			EAPMethod: "aka-prime",
		}},
		IMSIdentity: identity.IMSIdentityResolution{
			IMPI:   "310280000000001@private.att.net",
			IMPU:   "sip:310280000000001@one.att.net",
			Domain: "one.att.net",
		},
	}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		TraceID:       "trace-1",
		Profile:       prepared.Profile,
		Prepared:      &prepared,
		Access:        NewModemAccessAdapter(testModem{}),
		Dataplane:     DataplanePolicy{Mode: swu.DataplaneModeUserspace},
		TunnelManager: manager,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	st := inst.State()
	if !st.TunnelReady || st.LastReason != "ike ipsec ready" {
		t.Fatalf("state=%+v", st)
	}
	if manager.config.EPDGAddress != "epdg.example" || manager.config.Identity.Domain != "one.att.net" || manager.config.APN != "ims" || manager.config.EAPMethod != swu.EAPMethodAKAPrime {
		t.Fatalf("tunnel config=%+v", manager.config)
	}
}

func TestStartBuildsTunnelManagerForExplicitUserspaceDataplane(t *testing.T) {
	manager := &runtimeTunnelManager{session: &runtimeTunnelSession{result: swu.TunnelResult{
		Ready:            true,
		Mode:             swu.DataplaneModeUserspace,
		EPDGAddress:      "epdg.example",
		LocalInnerIP:     "10.0.0.2",
		IKEEstablished:   true,
		IPsecEstablished: true,
		Reason:           "auto tunnel ready",
	}}}
	var factoryCalled bool
	inst, err := Start(context.Background(), StartRequest{
		DeviceID: "dev-1",
		Profile:  identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		Dataplane: DataplanePolicy{
			Mode: swu.DataplaneModeUserspace,
		},
		TunnelManagerFactory: func(req StartRequest) (swu.TunnelManager, error) {
			factoryCalled = true
			if req.DeviceID != "dev-1" || req.Dataplane.Mode != swu.DataplaneModeUserspace {
				t.Fatalf("factory request=%+v", req)
			}
			return manager, nil
		},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !factoryCalled {
		t.Fatalf("TunnelManagerFactory was not called")
	}
	if !inst.State().TunnelReady || inst.State().LastReason != "auto tunnel ready" {
		t.Fatalf("state=%+v", inst.State())
	}
}

func TestBuildTunnelConfigUsesPreparedSIMHomePLMN(t *testing.T) {
	prepared := identity.PreparedSession{
		Profile:    identity.Profile{IMSI: "310240123456789", MCC: "310", MNC: "240"},
		EPDGAddr:   "epdg.epc.mnc240.mcc310.pub.3gppnetwork.org",
		EPDGSource: "derived",
		CarrierPolicy: carrier.CarrierPolicy{IMS: carrier.IMSAccessProfile{
			IMSAPN:    "ims",
			EAPMethod: "aka-prime",
		}},
	}
	cfg := buildTunnelConfig(StartRequest{
		DeviceID: "dev-ultra",
		Profile:  identity.Profile{IMSI: "310240123456789", MCC: "310", MNC: "260"},
		Prepared: &prepared,
	}, nil)
	if cfg.MCC != "310" || cfg.MNC != "240" || cfg.EPDGAddress != prepared.EPDGAddr || cfg.EAPMethod != swu.EAPMethodAKAPrime {
		t.Fatalf("tunnel config=%+v, want prepared SIM HPLMN 310/240 with AKA'", cfg)
	}
}

func TestStartBuildsTunnelManagerForExplicitKernelDataplane(t *testing.T) {
	manager := &runtimeTunnelManager{session: &runtimeTunnelSession{result: swu.TunnelResult{
		Ready:            true,
		Mode:             swu.DataplaneModeKernel,
		EPDGAddress:      "epdg.example",
		LocalInnerIP:     "10.0.0.2",
		IKEEstablished:   true,
		IPsecEstablished: true,
		Reason:           "kernel tunnel ready",
	}}}
	var factoryCalled bool
	inst, err := Start(context.Background(), StartRequest{
		DeviceID: "dev-1",
		Profile:  identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		Dataplane: DataplanePolicy{
			Mode: swu.DataplaneModeKernel,
		},
		TunnelManagerFactory: func(req StartRequest) (swu.TunnelManager, error) {
			factoryCalled = true
			if req.DeviceID != "dev-1" || req.Dataplane.Mode != swu.DataplaneModeKernel {
				t.Fatalf("factory request=%+v", req)
			}
			return manager, nil
		},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !factoryCalled {
		t.Fatalf("TunnelManagerFactory was not called")
	}
	if manager.config.Mode != swu.DataplaneModeKernel {
		t.Fatalf("tunnel config mode=%q, want %q", manager.config.Mode, swu.DataplaneModeKernel)
	}
	if !inst.State().TunnelReady || inst.State().LastReason != "kernel tunnel ready" {
		t.Fatalf("state=%+v", inst.State())
	}
}

func TestStartDoesNotAutoBuildTunnelForImplicitDataplane(t *testing.T) {
	var factoryCalled bool
	inst, err := Start(context.Background(), StartRequest{
		DeviceID: "dev-1",
		Profile:  identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		TunnelManagerFactory: func(req StartRequest) (swu.TunnelManager, error) {
			factoryCalled = true
			return &runtimeTunnelManager{}, nil
		},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if factoryCalled {
		t.Fatalf("TunnelManagerFactory called for implicit dataplane mode")
	}
	if inst.State().TunnelReady {
		t.Fatalf("state=%+v, want tunnel not ready", inst.State())
	}
}

func TestDefaultTunnelManagerForStartBuildsKernelIKEManager(t *testing.T) {
	reauthState := swu.EAPReauthenticationState{
		Identity:  "reauth-kernel",
		Counter:   5,
		CounterOK: true,
		Keys: eapaka.Keys{
			KEncr: []byte("0123456789abcdef"),
			KAut:  []byte("fedcba9876543210"),
		},
	}
	var callbackState swu.EAPReauthenticationState
	manager, err := defaultTunnelManagerForStart(StartRequest{
		DeviceID:                   "dev-1",
		SIM:                        &runtimeSIMAdapter{},
		EAPReauthentication:        reauthState,
		OnEAPReauthenticationState: func(state swu.EAPReauthenticationState) { callbackState = state },
		Dataplane: DataplanePolicy{
			Mode: swu.DataplaneModeKernel,
		},
	})
	if err != nil {
		t.Fatalf("defaultTunnelManagerForStart() error = %v", err)
	}
	ikeManager, ok := manager.(*swu.IKEPacketTunnelManager)
	if !ok {
		t.Fatalf("manager=%T, want *swu.IKEPacketTunnelManager", manager)
	}
	if ikeManager.Config.SIM == nil || ikeManager.Config.Reauthentication.Identity != "reauth-kernel" ||
		ikeManager.Config.Reauthentication.Counter != 5 || ikeManager.Config.OnReauthenticationState == nil {
		t.Fatalf("ike manager config=%+v", ikeManager.Config)
	}
	ikeManager.Config.OnReauthenticationState(swu.EAPReauthenticationState{Identity: "reauth-kernel-next"})
	if callbackState.Identity != "reauth-kernel-next" {
		t.Fatalf("callback state=%+v", callbackState)
	}
}

func TestDefaultTunnelManagerForStartEnablesTUNRoutingProtection(t *testing.T) {
	reauthState := swu.EAPReauthenticationState{
		Identity:  "reauth-2",
		Counter:   2,
		CounterOK: true,
		Keys: eapaka.Keys{
			KEncr: []byte("0123456789abcdef"),
			KAut:  []byte("fedcba9876543210"),
		},
	}
	var callbackState swu.EAPReauthenticationState
	manager, err := defaultTunnelManagerForStart(StartRequest{
		DeviceID:                   "dev-1",
		SIM:                        &runtimeSIMAdapter{},
		EAPReauthentication:        reauthState,
		OnEAPReauthenticationState: func(state swu.EAPReauthenticationState) { callbackState = state },
		Dataplane: DataplanePolicy{
			Mode:      swu.DataplaneModeUserspace,
			TUNName:   "vohive0",
			TUNMTU:    1420,
			TUNRoutes: []swu.TUNRoute{{Destination: "default", Table: "200"}},
		},
	})
	if err != nil {
		t.Fatalf("defaultTunnelManagerForStart() error = %v", err)
	}
	tunManager, ok := manager.(*swu.TUNTunnelManager)
	if !ok {
		t.Fatalf("manager=%T, want *swu.TUNTunnelManager", manager)
	}
	if tunManager.Config.TUN.Name != "vohive0" || tunManager.Config.MTU != 1420 {
		t.Fatalf("tun config=%+v mtu=%d", tunManager.Config.TUN, tunManager.Config.MTU)
	}
	if !tunManager.Config.DefaultRoutes || !tunManager.Config.ProtectEPDGRoutes {
		t.Fatalf("default route/protect flags = %t/%t", tunManager.Config.DefaultRoutes, tunManager.Config.ProtectEPDGRoutes)
	}
	ikeManager, ok := tunManager.Config.Base.(*swu.IKEPacketTunnelManager)
	if !ok {
		t.Fatalf("base manager=%T, want *swu.IKEPacketTunnelManager", tunManager.Config.Base)
	}
	if ikeManager.Config.Reauthentication.Identity != "reauth-2" || ikeManager.Config.Reauthentication.Counter != 2 || ikeManager.Config.OnReauthenticationState == nil {
		t.Fatalf("reauth config=%+v callback set=%t", ikeManager.Config.Reauthentication, ikeManager.Config.OnReauthenticationState != nil)
	}
	ikeManager.Config.OnReauthenticationState(swu.EAPReauthenticationState{Identity: "reauth-3"})
	if callbackState.Identity != "reauth-3" {
		t.Fatalf("callback state=%+v", callbackState)
	}
	if len(tunManager.Config.Routes) != 1 || tunManager.Config.Routes[0].Table != "200" {
		t.Fatalf("routes=%+v", tunManager.Config.Routes)
	}
}

func TestStartPassesTunnelResultToIMSRegistrar(t *testing.T) {
	manager := &runtimeTunnelManager{session: &runtimeTunnelSession{result: swu.TunnelResult{
		Ready:             true,
		Mode:              swu.DataplaneModeUserspace,
		EPDGAddress:       "epdg.example",
		LocalInnerIP:      "10.0.0.2",
		RemoteInnerIP:     "10.0.0.1",
		IKEEstablished:    true,
		IPsecEstablished:  true,
		ChildSAIdentifier: "11111111/22222222",
		Reason:            "ike ipsec ready",
	}}}
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered: true,
		StatusCode: 200,
		Reason:     "ims registered",
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		Dataplane:     DataplanePolicy{Mode: swu.DataplaneModeUserspace},
		TunnelManager: manager,
		IMSRegistrar:  registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !inst.State().TunnelReady || !inst.State().IMSReady {
		t.Fatalf("state=%+v", inst.State())
	}
	if registrar.config.Tunnel.LocalInnerIP != "10.0.0.2" ||
		registrar.config.Tunnel.RemoteInnerIP != "10.0.0.1" ||
		registrar.config.Tunnel.ChildSAIdentifier != "11111111/22222222" {
		t.Fatalf("registrar tunnel=%+v", registrar.config.Tunnel)
	}
}

func TestStartRejectsIncompleteTunnel(t *testing.T) {
	manager := &runtimeTunnelManager{session: &runtimeTunnelSession{result: swu.TunnelResult{
		Ready:          true,
		IKEEstablished: true,
		Reason:         "child sa missing",
	}}}
	_, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		Dataplane:     DataplanePolicy{Mode: swu.DataplaneModeUserspace},
		TunnelManager: manager,
	})
	if err == nil || !strings.Contains(err.Error(), "SWU tunnel establishment incomplete") {
		t.Fatalf("Start() err=%v, want incomplete tunnel", err)
	}
	if !manager.session.closed {
		t.Fatalf("incomplete tunnel was not closed")
	}
}

func TestStopClosesTunnel(t *testing.T) {
	session := &runtimeTunnelSession{result: swu.TunnelResult{Ready: true, IKEEstablished: true, IPsecEstablished: true}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		Dataplane:     DataplanePolicy{Mode: swu.DataplaneModeUserspace},
		TunnelManager: &runtimeTunnelManager{session: session},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if err := inst.Stop(context.Background()); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if !session.closed || inst.State().TunnelReady {
		t.Fatalf("closed=%t state=%+v", session.closed, inst.State())
	}
}

func TestTriggerMOBIKEDelegatesToTunnel(t *testing.T) {
	dispatch := &runtimeDispatcher{}
	session := &runtimeTunnelSession{
		result: swu.TunnelResult{Ready: true, IKEEstablished: true, IPsecEstablished: true},
		mobikeResult: swu.MOBIKEResult{
			Rekeyed:          true,
			IKEEstablished:   true,
			IPsecEstablished: true,
			Reason:           "mobike rekeyed",
		},
	}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		Dataplane:     DataplanePolicy{Mode: swu.DataplaneModeUserspace},
		TunnelManager: &runtimeTunnelManager{session: session},
		Dispatch:      dispatch,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if err := inst.TriggerMOBIKE("198.51.100.1", "198.51.100.2"); err != nil {
		t.Fatalf("TriggerMOBIKE() error = %v", err)
	}
	if session.mobikeRequest.OldIP != "198.51.100.1" || session.mobikeRequest.NewIP != "198.51.100.2" {
		t.Fatalf("mobike request=%+v", session.mobikeRequest)
	}
	wantReason := "mobike rekeyed 198.51.100.1 -> 198.51.100.2: mobike rekeyed"
	if inst.State().LastReason != wantReason {
		t.Fatalf("state=%+v", inst.State())
	}
	if len(dispatch.events) != 3 {
		t.Fatalf("events=%d, want ready/pending/complete", len(dispatch.events))
	}
	pending, ok := dispatch.events[1].(eventhost.RuntimeStateSnapshot)
	if !ok || !strings.Contains(pending.LastReason, "mobike pending") ||
		strings.Contains(pending.LastReason, "198.51.100.1") ||
		strings.Contains(pending.LastReason, "198.51.100.2") {
		t.Fatalf("pending event=%+v ok=%t", dispatch.events[1], ok)
	}
	complete, ok := dispatch.events[2].(eventhost.RuntimeStateSnapshot)
	if !ok || !strings.Contains(complete.LastReason, "mobike rekeyed") ||
		strings.Contains(complete.LastReason, "198.51.100.1") ||
		strings.Contains(complete.LastReason, "198.51.100.2") {
		t.Fatalf("complete event=%+v ok=%t", dispatch.events[2], ok)
	}
}

func TestTriggerMOBIKERecordsFailedRuntimeState(t *testing.T) {
	dispatch := &runtimeDispatcher{}
	wantErr := errors.New("update timeout")
	session := &runtimeTunnelSession{
		result:    swu.TunnelResult{Ready: true, IKEEstablished: true, IPsecEstablished: true},
		mobikeErr: wantErr,
	}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001", MCC: "310", MNC: "280"},
		Dataplane:     DataplanePolicy{Mode: swu.DataplaneModeUserspace},
		TunnelManager: &runtimeTunnelManager{session: session},
		Dispatch:      dispatch,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	err = inst.TriggerMOBIKE("198.51.100.10", "198.51.100.20")
	if !errors.Is(err, wantErr) {
		t.Fatalf("TriggerMOBIKE() err=%v, want update timeout", err)
	}
	wantReason := "mobike failed 198.51.100.10 -> 198.51.100.20: update timeout"
	if inst.State().LastReason != wantReason {
		t.Fatalf("state=%+v", inst.State())
	}
	if len(dispatch.events) != 3 {
		t.Fatalf("events=%d, want ready/pending/failed", len(dispatch.events))
	}
	failed, ok := dispatch.events[2].(eventhost.RuntimeStateSnapshot)
	if !ok || !strings.Contains(failed.LastReason, "mobike failed") ||
		!strings.Contains(failed.LastReason, "update timeout") ||
		strings.Contains(failed.LastReason, "198.51.100.10") ||
		strings.Contains(failed.LastReason, "198.51.100.20") {
		t.Fatalf("failed event=%+v ok=%t", dispatch.events[2], ok)
	}
}

func TestStartWiresSMSTransport(t *testing.T) {
	transport := &runtimeSMSTransport{}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-1",
		Profile:      identity.Profile{IMSI: "310280000000001"},
		SMSTransport: transport,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	out, err := inst.SendSMSWithOptions(context.Background(), "+18005551212", strings.Repeat("a", 161), messaging.SendOptions{})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if out.PartsTotal != 2 || len(transport.requests) != 2 {
		t.Fatalf("outcome=%+v requests=%+v", out, transport.requests)
	}
}

func TestStartUsesIMSRegistrarSMSTransport(t *testing.T) {
	smsTransport := &runtimeSMSTransport{}
	ussdTransport := &runtimeUSSDTransport{}
	registrar := &testIMSRegistrar{result: IMSRegistrationResult{
		Registered:    true,
		StatusCode:    200,
		Reason:        "OK",
		SMSTransport:  smsTransport,
		USSDTransport: ussdTransport,
	}}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:     "dev-ims-sms",
		Profile:      identity.Profile{IMSI: "310280000000001"},
		IMSRegistrar: registrar,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	out, err := inst.SendSMSWithOptions(context.Background(), "+18005551212", "hello", messaging.SendOptions{})
	if err != nil {
		t.Fatalf("SendSMSWithOptions() error = %v", err)
	}
	if out.PartsTotal != 1 || len(smsTransport.requests) != 1 || smsTransport.requests[0].Peer != "+18005551212" {
		t.Fatalf("outcome=%+v requests=%+v", out, smsTransport.requests)
	}
	ussd, err := inst.Service().SendUSSD(context.Background(), "*100#")
	if err != nil {
		t.Fatalf("SendUSSD() error = %v", err)
	}
	if ussd.Text != "ok" || len(ussdTransport.executeRequests) != 1 || ussdTransport.executeRequests[0].Command != "*100#" {
		t.Fatalf("ussd=%+v requests=%+v", ussd, ussdTransport.executeRequests)
	}
}

func TestStartWiresUSSDTransport(t *testing.T) {
	transport := &runtimeUSSDTransport{}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001"},
		USSDTransport: transport,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	res, err := inst.Service().SendUSSD(context.Background(), "*100#")
	if err != nil {
		t.Fatalf("SendUSSD() error = %v", err)
	}
	if res.Text != "ok" || len(transport.executeRequests) != 1 {
		t.Fatalf("res=%+v requests=%+v", res, transport.executeRequests)
	}
}

func TestInstanceDrainsIMSMessagingRetriesFromStore(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	req := messaging.SMSSendRequest{
		DeviceID:  "dev-1",
		IMSI:      "310280000000001",
		Peer:      "+18005551212",
		MessageID: "retry-msg",
		Part:      messaging.SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	}
	envelope := messaging.NewIMSSMSSubmitRetryEnvelope(req, messaging.SMSSendResult{State: "failed", SIPCode: 503, RetryAfter: time.Second}, errors.New("Service Unavailable"), messaging.IMSMessagingRetryOptions{Attempt: 1, Now: now.Add(-2 * time.Second)})
	store := &runtimeRetryDeliveryStore{dueRetries: []messaging.IMSMessagingRetryEnvelope{envelope}}
	transport := &runtimeSMSTransport{}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001"},
		SMSTransport:  transport,
		DeliveryStore: store,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	results, err := inst.DrainIMSMessagingRetries(context.Background(), now, 4)
	if err != nil {
		t.Fatalf("DrainIMSMessagingRetries() error = %v", err)
	}
	if len(results) != 1 || !results[0].Replayed || len(transport.requests) != 1 || transport.requests[0].MessageID != "retry-msg" {
		t.Fatalf("results=%+v requests=%+v", results, transport.requests)
	}
	if store.dueLimit != 4 || len(store.retryDeletes) != 1 || store.retryDeletes[0].key != envelope.Key {
		t.Fatalf("store dueLimit=%d deletes=%+v", store.dueLimit, store.retryDeletes)
	}
	if !strings.Contains(inst.State().LastReason, "messaging retry replayed=1") {
		t.Fatalf("state=%+v", inst.State())
	}
}

func TestStartIMSMessagingRetryWorkerDrainsDueStore(t *testing.T) {
	now := time.Now()
	req := messaging.SMSSendRequest{
		DeviceID:  "dev-worker",
		IMSI:      "310280000000001",
		Peer:      "+18005551212",
		MessageID: "worker-msg",
		Part:      messaging.SMSPart{PartNo: 1, TotalParts: 1, Text: "hello"},
	}
	envelope := messaging.NewIMSSMSSubmitRetryEnvelope(req, messaging.SMSSendResult{State: "failed", SIPCode: 503, RetryAfter: time.Millisecond}, errors.New("Service Unavailable"), messaging.IMSMessagingRetryOptions{Attempt: 1, Now: now.Add(-time.Second)})
	store := &runtimeRetryDeliveryStore{dueRetries: []messaging.IMSMessagingRetryEnvelope{envelope}}
	transport := &runtimeWorkerSMSTransport{sent: make(chan messaging.SMSSendRequest, 1)}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-worker",
		Profile:       identity.Profile{IMSI: "310280000000001"},
		SMSTransport:  transport,
		DeliveryStore: store,
		IMSMessagingRetryWorker: IMSMessagingRetryWorkerConfig{
			Enabled:    true,
			Interval:   10 * time.Millisecond,
			BatchLimit: 1,
		},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	select {
	case got := <-transport.sent:
		if got.MessageID != "worker-msg" {
			t.Fatalf("worker replay request=%+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for retry worker replay")
	}
	if err := inst.Stop(context.Background()); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if len(store.retryDeletes) != 1 || store.retryDeletes[0].key != envelope.Key {
		t.Fatalf("retry deletes=%+v", store.retryDeletes)
	}
	if !strings.Contains(inst.State().LastReason, "stopped") {
		t.Fatalf("state after stop=%+v", inst.State())
	}
}

func TestInstanceHandlesIncomingSMSAndDeliveryReport(t *testing.T) {
	store := &runtimeDeliveryStore{match: messaging.DeliveryPartMatch{MessageID: "msg-1", PartNo: 1, State: "delivered"}}
	dispatch := &runtimeDispatcher{}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001"},
		DeliveryStore: store,
		Dispatch:      dispatch,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if err := inst.HandleIncomingSMS(context.Background(), messaging.IncomingSMS{Sender: "+10086", Content: "hi"}); err != nil {
		t.Fatalf("HandleIncomingSMS() error = %v", err)
	}
	if len(dispatch.events) != 2 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	match, err := inst.HandleSMSDeliveryReport(context.Background(), messaging.SMSDeliveryReport{InReplyTo: "sip-1", SIPCode: 200})
	if err != nil {
		t.Fatalf("HandleSMSDeliveryReport() error = %v", err)
	}
	if match.MessageID != "msg-1" || store.reportState != "delivered" || store.recomputed != "msg-1" {
		t.Fatalf("match=%+v store=%+v", match, store)
	}
	tpdu, err := hex.DecodeString("0005810180F600006270502143650005E8329BFD06")
	if err != nil {
		t.Fatalf("DecodeString() error = %v", err)
	}
	body := append([]byte{0x01, 0x33, 0x00, 0x00, byte(len(tpdu))}, tpdu...)
	imsResult, err := inst.HandleIMSMessage(context.Background(), voicehost.IMSMessageRequest{
		FromURI:     "sip:smsc@ims.example",
		ToURI:       "sip:user@ims.example",
		CallID:      "sms-downlink-1",
		ContentType: messaging.IMS3GPPSMSContentType,
		Body:        body,
	})
	if err != nil {
		t.Fatalf("HandleIMSMessage() error = %v", err)
	}
	if imsResult.StatusCode != 200 || imsResult.ContentType != messaging.IMS3GPPSMSContentType || string(imsResult.Body) != string(messaging.BuildSMSRPAck(0x33)) {
		t.Fatalf("imsResult=%+v", imsResult)
	}
	if len(dispatch.events) != 3 {
		t.Fatalf("events=%d", len(dispatch.events))
	}
	got, ok := dispatch.events[2].(eventhost.SMSReceived)
	if !ok || got.Sender != "10086" || got.Content != "hello" {
		t.Fatalf("event=%+v", dispatch.events[2])
	}
}

func TestInstanceHandlesIMSUSSDInfoAndBye(t *testing.T) {
	transport := &runtimeUSSDTransport{
		infoResult: messaging.IMSUSSDDialogResult{
			Handled:    true,
			StatusCode: 200,
			USSD:       messaging.USSDResult{SessionID: "ussd-1", Text: "1. Balance", Done: false},
		},
		byeResult: messaging.IMSUSSDDialogResult{
			Handled:    true,
			StatusCode: 200,
			USSD:       messaging.USSDResult{SessionID: "ussd-1", Text: "Bye", Done: true},
		},
	}
	inst, err := Start(context.Background(), StartRequest{
		DeviceID:      "dev-1",
		Profile:       identity.Profile{IMSI: "310280000000001"},
		USSDTransport: transport,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	info, err := inst.HandleIMSInfo(context.Background(), voicehost.IMSInfoRequest{
		CallID:      "ussd-call",
		CSeq:        2,
		ContentType: messaging.IMSUSSDContentType,
		InfoPackage: messaging.IMSUSSDInfoPackage,
		Body:        []byte(`<ussd-data><ussd-string>1. Balance</ussd-string><UnstructuredSS-Request/></ussd-data>`),
	})
	if err != nil {
		t.Fatalf("HandleIMSInfo() error = %v", err)
	}
	if !info.Handled || info.StatusCode != 200 || len(transport.infoRequests) != 1 {
		t.Fatalf("info=%+v transport=%+v", info, transport)
	}
	if _, err := inst.Service().ContinueUSSD(context.Background(), "ussd-1", "1"); err != nil {
		t.Fatalf("ContinueUSSD() after INFO error = %v", err)
	}
	bye, err := inst.HandleIMSBye(context.Background(), voicehost.IMSByeRequest{
		CallID:      "ussd-call",
		CSeq:        3,
		ContentType: messaging.IMSUSSDContentType,
		Body:        []byte(`<ussd-data><ussd-string>Bye</ussd-string><UnstructuredSS-Notify/></ussd-data>`),
	})
	if err != nil {
		t.Fatalf("HandleIMSBye() error = %v", err)
	}
	if !bye.Handled || bye.StatusCode != 200 || len(transport.byeRequests) != 1 {
		t.Fatalf("bye=%+v transport=%+v", bye, transport)
	}
	if _, err := inst.Service().ContinueUSSD(context.Background(), "ussd-1", "1"); err == nil {
		t.Fatal("ContinueUSSD() err=nil after BYE, want inactive session")
	}
}

func TestRuntimeHostExposesUSSDUpdatedEventAlias(t *testing.T) {
	ev := EventUSSDUpdated{
		DevID:     "dev-1",
		SessionID: "ussd-1",
		Text:      "ok",
		Done:      true,
		Time:      time.Now(),
	}
	var module ModuleEvent = ev
	got, ok := module.(eventhost.USSDUpdated)
	if !ok || got.DevID != "dev-1" || got.SessionID != "ussd-1" || got.Text != "ok" || !got.Done || got.Time.IsZero() {
		t.Fatalf("event=%+v", module)
	}
}

type runtimeSMSTransport struct {
	requests []messaging.SMSSendRequest
}

type runtimeVoiceTransport struct {
	requests  []voiceclient.SIPRequestMessage
	writes    []voiceclient.SIPRequestMessage
	responses []voiceclient.SIPResponse
	errors    []error
}

func (t *runtimeVoiceTransport) RoundTripRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) (voiceclient.SIPResponse, error) {
	t.requests = append(t.requests, msg)
	if len(t.errors) > 0 {
		err := t.errors[0]
		t.errors = t.errors[1:]
		if err != nil {
			return voiceclient.SIPResponse{}, err
		}
	}
	if len(t.responses) == 0 {
		return voiceclient.SIPResponse{StatusCode: 500, Reason: "empty"}, nil
	}
	resp := t.responses[0]
	t.responses = t.responses[1:]
	return resp, nil
}

func (t *runtimeVoiceTransport) WriteRequest(ctx context.Context, msg voiceclient.SIPRequestMessage) error {
	t.writes = append(t.writes, msg)
	return nil
}

type runtimeAutoDTMFAgent struct {
	rtpRequests  []voicehost.DialogRTPDTMFRequest
	infoRequests []voicehost.DialogDTMFRequest
	rtpResult    voicehost.DialogRTPDTMFResult
	infoResult   voicehost.DialogDTMFResult
	rtpErr       error
	infoErr      error
}

func (a *runtimeAutoDTMFAgent) SendDialogRTPDTMF(ctx context.Context, req voicehost.DialogRTPDTMFRequest) (voicehost.DialogRTPDTMFResult, error) {
	a.rtpRequests = append(a.rtpRequests, req)
	return a.rtpResult, a.rtpErr
}

func (a *runtimeAutoDTMFAgent) SendDialogDTMF(ctx context.Context, req voicehost.DialogDTMFRequest) (voicehost.DialogDTMFResult, error) {
	a.infoRequests = append(a.infoRequests, req)
	return a.infoResult, a.infoErr
}

type runtimeDialogRecoveryAgent struct {
	terminated          []voicehost.DialogInfo
	canceled            []voicehost.DialogInfo
	registrationUpdates []voicehost.IMSRegistrationUpdate
	terminateResult     voicehost.DialogInfoResult
	cancelResult        voicehost.DialogInfoResult
	terminateErr        error
	cancelErr           error
}

func (a *runtimeDialogRecoveryAgent) EndVoiceCallWithResult(ctx context.Context, info voicehost.DialogInfo) (voicehost.DialogInfoResult, error) {
	a.terminated = append(a.terminated, info)
	return a.terminateResult, a.terminateErr
}

func (a *runtimeDialogRecoveryAgent) CancelVoiceCallWithResult(ctx context.Context, info voicehost.DialogInfo) (voicehost.DialogInfoResult, error) {
	a.canceled = append(a.canceled, info)
	return a.cancelResult, a.cancelErr
}

func (a *runtimeDialogRecoveryAgent) UpdateIMSRegistration(update voicehost.IMSRegistrationUpdate) {
	a.registrationUpdates = append(a.registrationUpdates, update)
}

func runtimeSDP(ip string, port int) []byte {
	return []byte("v=0\r\n" +
		"o=- 0 0 IN IP4 " + ip + "\r\n" +
		"s=VoWiFi\r\n" +
		"c=IN IP4 " + ip + "\r\n" +
		"t=0 0\r\n" +
		"m=audio " + strconv.Itoa(port) + " RTP/AVP 0 8 101\r\n" +
		"a=rtpmap:0 PCMU/8000\r\n" +
		"a=rtpmap:8 PCMA/8000\r\n" +
		"a=rtpmap:101 telephone-event/8000\r\n" +
		"a=sendrecv\r\n")
}

type runtimeTunnelManager struct {
	session *runtimeTunnelSession
	err     error
	config  swu.TunnelConfig
}

func (m *runtimeTunnelManager) EstablishTunnel(ctx context.Context, cfg swu.TunnelConfig) (swu.TunnelSession, error) {
	m.config = cfg
	if m.err != nil {
		return nil, m.err
	}
	return m.session, nil
}

type runtimeTunnelSession struct {
	result        swu.TunnelResult
	mobikeResult  swu.MOBIKEResult
	mobikeErr     error
	mobikeRequest swu.MOBIKERequest
	closed        bool
}

func (s *runtimeTunnelSession) Result() swu.TunnelResult {
	return s.result
}

func (s *runtimeTunnelSession) MOBIKE(ctx context.Context, req swu.MOBIKERequest) (swu.MOBIKEResult, error) {
	s.mobikeRequest = req
	if s.mobikeErr != nil {
		return swu.MOBIKEResult{}, s.mobikeErr
	}
	return s.mobikeResult, nil
}

func (s *runtimeTunnelSession) Close(ctx context.Context) error {
	s.closed = true
	return nil
}

type runtimeSIMAdapter struct{}

func (s *runtimeSIMAdapter) GetIMSI() (string, error) { return "310280000000001", nil }

func (s *runtimeSIMAdapter) CalculateAKA(rand16, autn16 []byte) (swusim.AKAResult, error) {
	return swusim.AKAResult{}, nil
}

func (s *runtimeSIMAdapter) Close() error { return nil }

type readerSIMGetIMSIProvider struct {
	imsi      string
	imsiErr   error
	imsiCalls int
	akaCalls  int
	closed    bool
}

func (p *readerSIMGetIMSIProvider) GetIMSI() (string, error) {
	p.imsiCalls++
	return p.imsi, p.imsiErr
}

func (p *readerSIMGetIMSIProvider) CalculateAKA(rand16, autn16 []byte) (swusim.AKAResult, error) {
	p.akaCalls++
	return swusim.AKAResult{RES: []byte{1, 2, 3, 4}}, nil
}

func (p *readerSIMGetIMSIProvider) Close() error {
	p.closed = true
	return nil
}

type readerSIMIMSIStringProvider struct {
	imsi string
}

func (p *readerSIMIMSIStringProvider) IMSI() string { return p.imsi }

func (p *readerSIMIMSIStringProvider) CalculateAKA(rand16, autn16 []byte) (swusim.AKAResult, error) {
	return swusim.AKAResult{}, nil
}

type readerSIMIMSIErrorProvider struct {
	imsi string
}

func (p *readerSIMIMSIErrorProvider) IMSI() (string, error) { return p.imsi, nil }

func (p *readerSIMIMSIErrorProvider) CalculateAKA(rand16, autn16 []byte) (swusim.AKAResult, error) {
	return swusim.AKAResult{}, nil
}

type readerSIMAKAOnlyProvider struct{}

func (p *readerSIMAKAOnlyProvider) CalculateAKA(rand16, autn16 []byte) (swusim.AKAResult, error) {
	return swusim.AKAResult{}, nil
}

type runtimeUSSDTransport struct {
	executeRequests []messaging.USSDRequest
	infoRequests    []messaging.IMSUSSDDialogRequest
	byeRequests     []messaging.IMSUSSDDialogRequest
	infoResult      messaging.IMSUSSDDialogResult
	byeResult       messaging.IMSUSSDDialogResult
}

type runtimeDispatcher struct {
	events []eventhost.Event
}

func (d *runtimeDispatcher) Dispatch(ctx context.Context, ev eventhost.Event) {
	d.events = append(d.events, ev)
}

type runtimeDeliveryStore struct {
	match       messaging.DeliveryPartMatch
	reportState string
	recomputed  string
}

type runtimeRetryDelete struct {
	operation messaging.IMSMessagingRetryOperation
	key       string
}

type runtimeRetryDeliveryStore struct {
	runtimeDeliveryStore
	dueRetries   []messaging.IMSMessagingRetryEnvelope
	dueLimit     int
	retryUpserts []messaging.IMSMessagingRetryEnvelope
	retryDeletes []runtimeRetryDelete
}

type runtimeWorkerSMSTransport struct {
	sent chan messaging.SMSSendRequest
}

func (s *runtimeDeliveryStore) CreateSMSDelivery(messageID, imsi, deviceID, peer, content string, partsTotal int, at time.Time) error {
	return nil
}

func (s *runtimeDeliveryStore) UpsertSMSDeliveryPart(messageID string, partNo int, callID string, rpMR int, state string, sentAt time.Time) error {
	return nil
}

func (s *runtimeDeliveryStore) MarkSMSDeliveryPartReport(inReplyTo, callID, deviceID string, rpMR int, state string, sipCode int, rpCause int, errText string, at time.Time) (messaging.DeliveryPartMatch, error) {
	s.reportState = state
	return s.match, nil
}

func (s *runtimeDeliveryStore) RecomputeSMSDelivery(messageID string, at time.Time) error {
	s.recomputed = messageID
	return nil
}

func (s *runtimeDeliveryStore) UpdateSMSDeliveryState(messageID, state, lastError string, acks int, at time.Time) error {
	return nil
}

func (s *runtimeDeliveryStore) GetSMSDeliveryStatus(messageID string) (*messaging.DeliveryStatus, error) {
	return nil, messaging.ErrDeliveryNotFound
}

func (s *runtimeRetryDeliveryStore) ListDueIMSMessagingRetries(now time.Time, limit int) ([]messaging.IMSMessagingRetryEnvelope, error) {
	s.dueLimit = limit
	return messaging.SelectDueIMSMessagingRetryEnvelopes(s.dueRetries, now, limit), nil
}

func (s *runtimeRetryDeliveryStore) UpsertIMSMessagingRetry(envelope messaging.IMSMessagingRetryEnvelope) error {
	s.retryUpserts = append(s.retryUpserts, envelope)
	return nil
}

func (s *runtimeRetryDeliveryStore) DeleteIMSMessagingRetry(operation messaging.IMSMessagingRetryOperation, key string) error {
	s.retryDeletes = append(s.retryDeletes, runtimeRetryDelete{operation: operation, key: key})
	out := s.dueRetries[:0]
	for _, envelope := range s.dueRetries {
		if envelope.Key == key && (operation == "" || envelope.Operation == operation) {
			continue
		}
		out = append(out, envelope)
	}
	s.dueRetries = out
	return nil
}

func (t *runtimeWorkerSMSTransport) SendSMSPart(ctx context.Context, req messaging.SMSSendRequest) (messaging.SMSSendResult, error) {
	if t.sent != nil {
		select {
		case t.sent <- req:
		default:
		}
	}
	return messaging.SMSSendResult{State: "sent"}, nil
}

func (t *runtimeUSSDTransport) ExecuteUSSD(ctx context.Context, req messaging.USSDRequest) (messaging.USSDResult, error) {
	t.executeRequests = append(t.executeRequests, req)
	return messaging.USSDResult{Text: "ok", Done: true}, nil
}

func (t *runtimeUSSDTransport) ContinueUSSD(ctx context.Context, req messaging.USSDRequest) (messaging.USSDResult, error) {
	return messaging.USSDResult{Text: "continued", Done: false}, nil
}

func (t *runtimeUSSDTransport) CancelUSSD(ctx context.Context, req messaging.USSDRequest) error {
	return nil
}

func (t *runtimeUSSDTransport) HandleIMSInfo(ctx context.Context, req messaging.IMSUSSDDialogRequest) (messaging.IMSUSSDDialogResult, error) {
	t.infoRequests = append(t.infoRequests, req)
	if t.infoResult.StatusCode == 0 {
		t.infoResult = messaging.IMSUSSDDialogResult{Handled: true, StatusCode: 200, USSD: messaging.USSDResult{SessionID: "ussd-1", Done: false}}
	}
	return t.infoResult, nil
}

func (t *runtimeUSSDTransport) HandleIMSBye(ctx context.Context, req messaging.IMSUSSDDialogRequest) (messaging.IMSUSSDDialogResult, error) {
	t.byeRequests = append(t.byeRequests, req)
	if t.byeResult.StatusCode == 0 {
		t.byeResult = messaging.IMSUSSDDialogResult{Handled: true, StatusCode: 200, USSD: messaging.USSDResult{SessionID: "ussd-1", Done: true}}
	}
	return t.byeResult, nil
}

func (t *runtimeSMSTransport) SendSMSPart(ctx context.Context, req messaging.SMSSendRequest) (messaging.SMSSendResult, error) {
	t.requests = append(t.requests, req)
	return messaging.SMSSendResult{State: "sent"}, nil
}
