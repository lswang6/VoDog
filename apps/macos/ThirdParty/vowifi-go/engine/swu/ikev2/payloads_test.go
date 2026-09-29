package ikev2

import (
	"bytes"
	"encoding/hex"
	"errors"
	"net"
	"testing"
)

func TestNotifyPayloadMarshalParse(t *testing.T) {
	body, err := (Notify{
		ProtocolID:       ProtocolIKE,
		NotifyType:       NotifyMOBIKESupported,
		NotificationData: []byte{0xaa, 0xbb},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	if got, want := hex.EncodeToString(body), "0100400caabb"; got != want {
		t.Fatalf("notify body=%s, want %s", got, want)
	}
	parsed, err := ParseNotify(body)
	if err != nil {
		t.Fatalf("ParseNotify() error = %v", err)
	}
	if parsed.ProtocolID != ProtocolIKE || parsed.NotifyType != NotifyMOBIKESupported || hex.EncodeToString(parsed.NotificationData) != "aabb" {
		t.Fatalf("parsed=%+v", parsed)
	}
}

func TestNotifyErrorClassification(t *testing.T) {
	cases := []struct {
		name       string
		notifyType uint16
		want       error
	}{
		{"unsupported critical", NotifyUnsupportedCriticalPayload, ErrNotifyUnsupportedCriticalPayload},
		{"invalid ike spi", NotifyInvalidIKESPI, ErrNotifyInvalidIKESPI},
		{"invalid major version", NotifyInvalidMajorVersion, ErrNotifyInvalidMajorVersion},
		{"invalid syntax", NotifyInvalidSyntax, ErrNotifyInvalidSyntax},
		{"invalid message id", NotifyInvalidMessageID, ErrNotifyInvalidMessageID},
		{"invalid spi", NotifyInvalidSPI, ErrNotifyInvalidSPI},
		{"no proposal chosen", NotifyNoProposalChosen, ErrNotifyNoProposalChosen},
		{"invalid ke payload", NotifyInvalidKEPayload, ErrNotifyInvalidKEPayload},
		{"authentication failed", NotifyAuthenticationFailed, ErrNotifyAuthenticationFailed},
		{"single pair required", NotifySinglePairRequired, ErrNotifySinglePairRequired},
		{"no additional sas", NotifyNoAdditionalSAs, ErrNotifyNoAdditionalSAs},
		{"internal address failure", NotifyInternalAddressFailure, ErrNotifyInternalAddressFailure},
		{"failed cp required", NotifyFailedCPRequired, ErrNotifyFailedCPRequired},
		{"ts unacceptable", NotifyTSUnacceptable, ErrNotifyTSUnacceptable},
		{"invalid selectors", NotifyInvalidSelectors, ErrNotifyInvalidSelectors},
		{"unacceptable addresses", NotifyUnacceptableAddresses, ErrNotifyUnacceptableAddresses},
		{"unexpected nat detected", NotifyUnexpectedNATDetected, ErrNotifyUnexpectedNATDetected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := NotifyPayload(Notify{
				ProtocolID:       ProtocolIKE,
				NotifyType:       tc.notifyType,
				SPI:              []byte{0x01, 0x02, 0x03, 0x04},
				NotificationData: []byte{0xaa},
			})
			if err != nil {
				t.Fatalf("NotifyPayload() error = %v", err)
			}
			err = FirstNotifyError([]Payload{MOBIKESupportedNotify(), payload})
			if !errors.Is(err, ErrIKEv2NotifyError) || !errors.Is(err, tc.want) {
				t.Fatalf("FirstNotifyError() err=%v, want %v and ErrIKEv2NotifyError", err, tc.want)
			}
			var notifyErr *NotifyError
			if !errors.As(err, &notifyErr) {
				t.Fatalf("FirstNotifyError() err=%T, want *NotifyError", err)
			}
			if notifyErr.Notify.NotifyType != tc.notifyType ||
				hex.EncodeToString(notifyErr.Notify.SPI) != "01020304" ||
				hex.EncodeToString(notifyErr.Notify.NotificationData) != "aa" {
				t.Fatalf("notifyErr=%+v", notifyErr)
			}
		})
	}

	if err := FirstNotifyError([]Payload{MOBIKESupportedNotify()}); err != nil {
		t.Fatalf("FirstNotifyError(informational) error = %v", err)
	}
	if err := NotifyErrorFor(Notify{NotifyType: NotifyMOBIKESupported}); err != nil {
		t.Fatalf("NotifyErrorFor(MOBIKE_SUPPORTED) error = %v", err)
	}
	if got, want := NotifyTypeName(NotifyNoProposalChosen), "NO_PROPOSAL_CHOSEN"; got != want {
		t.Fatalf("NotifyTypeName()=%q, want %q", got, want)
	}
	if got, want := NotifyTypeName(NotifyAuthenticationFailed), "AUTHENTICATION_FAILED"; got != want {
		t.Fatalf("NotifyTypeName()=%q, want %q", got, want)
	}
}

func TestInvalidKEPayloadAlternativeGroup(t *testing.T) {
	notify := Notify{
		NotifyType:       NotifyInvalidKEPayload,
		NotificationData: []byte{0, byte(DHGroup2048BitMODP)},
	}
	group, ok, err := notify.InvalidKEPayloadAlternativeGroup()
	if err != nil || !ok || group != DHGroup2048BitMODP {
		t.Fatalf("InvalidKEPayloadAlternativeGroup() group=%d ok=%t err=%v", group, ok, err)
	}

	notifyErr := NotifyErrorFor(notify)
	group, ok, err = InvalidKEPayloadAlternativeGroupFromError(notifyErr)
	if err != nil || !ok || group != DHGroup2048BitMODP {
		t.Fatalf("InvalidKEPayloadAlternativeGroupFromError() group=%d ok=%t err=%v", group, ok, err)
	}

	group, ok, err = (Notify{NotifyType: NotifyMOBIKESupported}).InvalidKEPayloadAlternativeGroup()
	if err != nil || ok || group != 0 {
		t.Fatalf("non-INVALID_KE_PAYLOAD group=%d ok=%t err=%v", group, ok, err)
	}
	group, ok, err = InvalidKEPayloadAlternativeGroupFromError(errors.New("other"))
	if err != nil || ok || group != 0 {
		t.Fatalf("non-notify error group=%d ok=%t err=%v", group, ok, err)
	}

	for _, data := range [][]byte{
		nil,
		{0x00},
		{0x00, byte(DHGroup2048BitMODP), 0xff},
	} {
		group, ok, err = (Notify{NotifyType: NotifyInvalidKEPayload, NotificationData: data}).InvalidKEPayloadAlternativeGroup()
		if !ok || !errors.Is(err, ErrInvalidNotify) || group != 0 {
			t.Fatalf("malformed data=%x group=%d ok=%t err=%v, want ErrInvalidNotify", data, group, ok, err)
		}
	}
}

func TestInvalidSelectorReport(t *testing.T) {
	notify := Notify{
		ProtocolID:       ProtocolESP,
		NotifyType:       NotifyInvalidSelectors,
		SPI:              []byte{0xde, 0xad, 0xbe, 0xef},
		NotificationData: []byte{0x45, 0x00, 0x00, 0x54},
	}
	report, ok, err := notify.InvalidSelectorReport()
	if err != nil || !ok {
		t.Fatalf("InvalidSelectorReport() ok=%t err=%v", ok, err)
	}
	if report.ProtocolID != ProtocolESP ||
		hex.EncodeToString(report.SPI) != "deadbeef" ||
		hex.EncodeToString(report.PacketPrefix) != "45000054" {
		t.Fatalf("report=%+v", report)
	}
	report.SPI[0] = 0
	report.PacketPrefix[0] = 0
	if hex.EncodeToString(notify.SPI) != "deadbeef" ||
		hex.EncodeToString(notify.NotificationData) != "45000054" {
		t.Fatalf("InvalidSelectorReport() did not clone notify data: notify=%+v", notify)
	}

	notifyErr := NotifyErrorFor(notify)
	report, ok, err = InvalidSelectorReportFromError(notifyErr)
	if err != nil || !ok || report.ProtocolID != ProtocolESP || hex.EncodeToString(report.SPI) != "deadbeef" {
		t.Fatalf("InvalidSelectorReportFromError() report=%+v ok=%t err=%v", report, ok, err)
	}
	report, ok, err = (Notify{NotifyType: NotifyMOBIKESupported}).InvalidSelectorReport()
	if err != nil || ok || report.ProtocolID != 0 {
		t.Fatalf("non-INVALID_SELECTORS report=%+v ok=%t err=%v", report, ok, err)
	}
	report, ok, err = InvalidSelectorReportFromError(errors.New("other"))
	if err != nil || ok || report.ProtocolID != 0 {
		t.Fatalf("non-notify error report=%+v ok=%t err=%v", report, ok, err)
	}

	for _, tc := range []Notify{
		{ProtocolID: ProtocolIKE, NotifyType: NotifyInvalidSelectors, SPI: []byte{1, 2, 3, 4}, NotificationData: []byte{0x45}},
		{ProtocolID: ProtocolESP, NotifyType: NotifyInvalidSelectors, SPI: []byte{1, 2, 3}, NotificationData: []byte{0x45}},
		{ProtocolID: ProtocolESP, NotifyType: NotifyInvalidSelectors, SPI: []byte{1, 2, 3, 4}},
	} {
		report, ok, err = tc.InvalidSelectorReport()
		if !ok || !errors.Is(err, ErrInvalidNotify) || report.ProtocolID != 0 {
			t.Fatalf("malformed notify=%+v report=%+v ok=%t err=%v, want ErrInvalidNotify", tc, report, ok, err)
		}
	}
}

func TestDeletePayloadMarshalParseESP(t *testing.T) {
	payload, err := ESPDeletePayload(mustHex("01020304"), mustHex("aabbccdd"))
	if err != nil {
		t.Fatalf("ESPDeletePayload() error = %v", err)
	}
	if payload.Type != PayloadDelete {
		t.Fatalf("payload.Type=%d, want PayloadDelete", payload.Type)
	}
	if got, want := hex.EncodeToString(payload.Body), "0304000201020304aabbccdd"; got != want {
		t.Fatalf("delete body=%s, want %s", got, want)
	}
	parsed, err := ParseDelete(payload.Body)
	if err != nil {
		t.Fatalf("ParseDelete() error = %v", err)
	}
	if parsed.ProtocolID != ProtocolESP || len(parsed.SPIs) != 2 ||
		hex.EncodeToString(parsed.SPIs[0]) != "01020304" ||
		hex.EncodeToString(parsed.SPIs[1]) != "aabbccdd" {
		t.Fatalf("parsed=%+v", parsed)
	}
}

func TestDeletePayloadMarshalParseIKE(t *testing.T) {
	payload := IKEDeletePayload()
	if got, want := hex.EncodeToString(payload.Body), "01000000"; got != want {
		t.Fatalf("delete body=%s, want %s", got, want)
	}
	parsed, err := ParseDelete(payload.Body)
	if err != nil {
		t.Fatalf("ParseDelete() error = %v", err)
	}
	if parsed.ProtocolID != ProtocolIKE || len(parsed.SPIs) != 0 {
		t.Fatalf("parsed=%+v", parsed)
	}
}

func TestDeletePayloadRejectsInvalid(t *testing.T) {
	cases := [][]byte{
		{},
		{ProtocolESP, 4, 0, 2, 1, 2, 3, 4},
		{ProtocolIKE, 4, 0, 1, 1, 2, 3, 4},
		{99, 0, 0, 0},
	}
	for _, tc := range cases {
		if _, err := ParseDelete(tc); !errors.Is(err, ErrInvalidDelete) {
			t.Fatalf("ParseDelete(%x) err=%v, want ErrInvalidDelete", tc, err)
		}
	}
	if _, err := ESPDeletePayload(); !errors.Is(err, ErrInvalidDelete) {
		t.Fatalf("ESPDeletePayload() err=%v, want ErrInvalidDelete", err)
	}
	if _, err := DeletePayload(Delete{ProtocolID: ProtocolESP, SPIs: [][]byte{{1, 2, 3, 4}, {5}}}); !errors.Is(err, ErrInvalidDelete) {
		t.Fatalf("DeletePayload() err=%v, want ErrInvalidDelete", err)
	}
}

func TestTeardownDeletePayloadsUsesLocalChildSPI(t *testing.T) {
	payloads, err := TeardownDeletePayloads(ChildSAResult{
		LocalSPI:  []byte{0x11, 0x22, 0x33, 0x44},
		RemoteSPI: []byte{0xaa, 0xbb, 0xcc, 0xdd},
	}, true)
	if err != nil {
		t.Fatalf("TeardownDeletePayloads() error = %v", err)
	}
	if len(payloads) != 2 {
		t.Fatalf("payloads=%+v", payloads)
	}
	childDelete, err := ParseDelete(payloads[0].Body)
	if err != nil {
		t.Fatalf("ParseDelete(child) error = %v", err)
	}
	if childDelete.ProtocolID != ProtocolESP || len(childDelete.SPIs) != 1 || hex.EncodeToString(childDelete.SPIs[0]) != "11223344" {
		t.Fatalf("childDelete=%+v", childDelete)
	}
	ikeDelete, err := ParseDelete(payloads[1].Body)
	if err != nil {
		t.Fatalf("ParseDelete(ike) error = %v", err)
	}
	if ikeDelete.ProtocolID != ProtocolIKE || len(ikeDelete.SPIs) != 0 {
		t.Fatalf("ikeDelete=%+v", ikeDelete)
	}
}

func TestKeyExchangePayload(t *testing.T) {
	payload := KeyExchangePayload(DHGroupCurve25519, []byte{1, 2, 3})
	if payload.Type != PayloadKE || hex.EncodeToString(payload.Body) != "001f0000010203" {
		t.Fatalf("payload=%+v body=%x", payload, payload.Body)
	}
	parsed, err := ParseKeyExchange(payload.Body)
	if err != nil {
		t.Fatalf("ParseKeyExchange() error = %v", err)
	}
	if parsed.DHGroup != DHGroupCurve25519 || hex.EncodeToString(parsed.KeyData) != "010203" {
		t.Fatalf("parsed=%+v", parsed)
	}
}

func TestNATDetectionHash(t *testing.T) {
	hash, err := NATDetectionHash(0x0102030405060708, 0x1112131415161718, net.ParseIP("192.0.2.10"), 4500)
	if err != nil {
		t.Fatalf("NATDetectionHash(v4) error = %v", err)
	}
	if got, want := hex.EncodeToString(hash), "4241cad1dadc1360129f8fc22ffa37c931af3125"; got != want {
		t.Fatalf("v4 hash=%s, want %s", got, want)
	}
	hash, err = NATDetectionHash(0x0102030405060708, 0x1112131415161718, net.ParseIP("2001:db8::1"), 4500)
	if err != nil {
		t.Fatalf("NATDetectionHash(v6) error = %v", err)
	}
	if got, want := hex.EncodeToString(hash), "1ee24423bf8f59515e0265c6d0f08be3d038f7e5"; got != want {
		t.Fatalf("v6 hash=%s, want %s", got, want)
	}
}

func TestNATDetectionNotify(t *testing.T) {
	payload, err := NATDetectionNotify(NotifyNATDetectionSourceIP, 0x0102030405060708, 0x1112131415161718, net.ParseIP("192.0.2.10"), 4500)
	if err != nil {
		t.Fatalf("NATDetectionNotify() error = %v", err)
	}
	notify, err := ParseNotify(payload.Body)
	if err != nil {
		t.Fatalf("ParseNotify() error = %v", err)
	}
	if payload.Type != PayloadNotify || notify.NotifyType != NotifyNATDetectionSourceIP || len(notify.NotificationData) != 20 {
		t.Fatalf("payload=%+v notify=%+v", payload, notify)
	}
	if _, err := NATDetectionNotify(NotifyMOBIKESupported, 1, 2, net.ParseIP("192.0.2.10"), 4500); !errors.Is(err, ErrInvalidNotify) {
		t.Fatalf("NATDetectionNotify() err=%v, want ErrInvalidNotify", err)
	}
}

func TestMOBIKENotifyHelpers(t *testing.T) {
	update, err := ParseNotify(UpdateSAAddressesNotify().Body)
	if err != nil {
		t.Fatalf("ParseNotify(update) error = %v", err)
	}
	if update.ProtocolID != 0 || update.NotifyType != NotifyUpdateSAAddresses || len(update.SPI) != 0 {
		t.Fatalf("update=%+v", update)
	}
	noAdditional, err := ParseNotify(NoAdditionalAddressesNotify().Body)
	if err != nil {
		t.Fatalf("ParseNotify(noAdditional) error = %v", err)
	}
	if noAdditional.ProtocolID != 0 || noAdditional.NotifyType != NotifyNoAdditionalAddresses {
		t.Fatalf("noAdditional=%+v", noAdditional)
	}
	cookie, err := Cookie2Notify([]byte("12345678"))
	if err != nil {
		t.Fatalf("Cookie2Notify() error = %v", err)
	}
	parsedCookie, err := ParseNotify(cookie.Body)
	if err != nil {
		t.Fatalf("ParseNotify(cookie) error = %v", err)
	}
	if parsedCookie.NotifyType != NotifyCookie2 || string(parsedCookie.NotificationData) != "12345678" {
		t.Fatalf("parsedCookie=%+v", parsedCookie)
	}
	if _, err := Cookie2Notify([]byte("short")); !errors.Is(err, ErrInvalidNotify) {
		t.Fatalf("Cookie2Notify(short) err=%v, want ErrInvalidNotify", err)
	}
	ikeCookie, err := CookieNotify([]byte("cookie-1"))
	if err != nil {
		t.Fatalf("CookieNotify() error = %v", err)
	}
	parsedIKECookie, err := ParseNotify(ikeCookie.Body)
	if err != nil {
		t.Fatalf("ParseNotify(IKE cookie) error = %v", err)
	}
	cookieData, ok, err := parsedIKECookie.Cookie()
	if err != nil || !ok || string(cookieData) != "cookie-1" {
		t.Fatalf("Cookie() data=%q ok=%t err=%v", string(cookieData), ok, err)
	}
	cookieData[0] = 0
	if string(parsedIKECookie.NotificationData) != "cookie-1" {
		t.Fatalf("Cookie() did not clone notification data")
	}
	if parsedIKECookie.ProtocolID != 0 || parsedIKECookie.NotifyType != NotifyCookie || len(parsedIKECookie.SPI) != 0 {
		t.Fatalf("parsed IKE cookie=%+v", parsedIKECookie)
	}
	if got, want := NotifyTypeName(NotifyCookie), "COOKIE"; got != want {
		t.Fatalf("NotifyTypeName(COOKIE)=%q, want %q", got, want)
	}
	if _, err := CookieNotify(nil); !errors.Is(err, ErrInvalidNotify) {
		t.Fatalf("CookieNotify(empty) err=%v, want ErrInvalidNotify", err)
	}
	if _, err := CookieNotify(bytes.Repeat([]byte{0xaa}, MaxIKECookieLength+1)); !errors.Is(err, ErrInvalidNotify) {
		t.Fatalf("CookieNotify(long) err=%v, want ErrInvalidNotify", err)
	}
	if _, _, err := (Notify{NotifyType: NotifyCookie, SPI: []byte{1}, NotificationData: []byte{1}}).Cookie(); !errors.Is(err, ErrInvalidNotify) {
		t.Fatalf("Notify.Cookie(with SPI) err=%v, want ErrInvalidNotify", err)
	}
	ipv4, err := AdditionalIPAddressNotify(net.ParseIP("192.0.2.44"))
	if err != nil {
		t.Fatalf("AdditionalIPAddressNotify(v4) error = %v", err)
	}
	parsedIPv4, err := ParseNotify(ipv4.Body)
	if err != nil {
		t.Fatalf("ParseNotify(v4) error = %v", err)
	}
	if parsedIPv4.NotifyType != NotifyAdditionalIPv4Address || hex.EncodeToString(parsedIPv4.NotificationData) != "c000022c" {
		t.Fatalf("parsedIPv4=%+v", parsedIPv4)
	}
	ipv6, err := AdditionalIPAddressNotify(net.ParseIP("2001:db8::44"))
	if err != nil {
		t.Fatalf("AdditionalIPAddressNotify(v6) error = %v", err)
	}
	parsedIPv6, err := ParseNotify(ipv6.Body)
	if err != nil {
		t.Fatalf("ParseNotify(v6) error = %v", err)
	}
	if parsedIPv6.NotifyType != NotifyAdditionalIPv6Address || len(parsedIPv6.NotificationData) != 16 {
		t.Fatalf("parsedIPv6=%+v", parsedIPv6)
	}
}
