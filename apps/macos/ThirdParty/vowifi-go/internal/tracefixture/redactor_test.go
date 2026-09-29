package tracefixture

import (
	"bytes"
	"strings"
	"testing"
)

func TestRedactStringRemovesIMSAndAuthMaterial(t *testing.T) {
	in := strings.Join([]string{
		`REGISTER sip:ims.mnc280.mcc310.3gppnetwork.org SIP/2.0`,
		`From: <sip:310280000000001@ims.mnc280.mcc310.3gppnetwork.org>;tag=abc`,
		`To: <tel:+13105551212>`,
		`Contact: <sip:310280000000001@192.0.2.10:5060>`,
		`Authorization: Digest username="310280000000001@ims.mnc280.mcc310.3gppnetwork.org", nonce="YWJj", response="0123456789abcdef0123456789abcdef"`,
		`WWW-Authenticate: Digest realm="ims.example", nonce="secret"`,
		`X-AKA: rand=00112233445566778899AABBCCDDEEFF ck=00112233445566778899aabbccddeeff0011`,
		`X-IMEI: 490154203237518`,
		`X-IP: 198.51.100.27`,
	}, "\r\n")

	out := RedactString(in)
	for _, sensitive := range []string{
		"310280000000001",
		"+13105551212",
		"490154203237518",
		"0123456789abcdef0123456789abcdef",
		"00112233445566778899aabbccddeeff0011",
		"192.0.2.10",
		"198.51.100.27",
		`nonce="secret"`,
		`response="`,
	} {
		if strings.Contains(out, sensitive) {
			t.Fatalf("redacted trace still contains %q:\n%s", sensitive, out)
		}
	}
	for _, want := range []string{
		"Authorization: <redacted>",
		"WWW-Authenticate: <redacted>",
		"X-AKA: <redacted>",
		"sip:<redacted-sip-user-1>@<redacted-domain-1>.invalid",
		"tel:<redacted-msisdn-1>",
		"<redacted-id-1>",
		"<redacted-ipv4-1>",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("redacted trace missing %q:\n%s", want, out)
		}
	}
}

func TestRedactStringSanitizesRealisticIMSRegisterFields(t *testing.T) {
	in := strings.Join([]string{
		`REGISTER sip:ims.mnc260.mcc310.3gppnetwork.org SIP/2.0`,
		`Via: SIP/2.0/TCP [2001:db8::10]:5060;branch=z9hG4bKfixture`,
		`From: <sip:001010123456789@ims.mnc260.mcc310.3gppnetwork.org>;tag=abc`,
		`To: <sip:001010123456789@ims.mnc260.mcc310.3gppnetwork.org>`,
		`Contact: <sip:001010123456789@[2001:db8::10]:5060;transport=tcp>;expires=600;+sip.instance="<urn:gsma:imei:49015420-323751-8>"`,
		`P-Access-Network-Info: 3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=310260ABCDEFFF;ue-ip=2001:db8::10;i-wlan-node-id=00:11:22:33:44:55;ssid="Home WiFi"`,
		`X-Debug-AKA: nonce=plainAKA rand=00112233445566778899AABBCCDDEEFF autn="FFEEDDCCBBAA99887766554433221100"`,
		`X-MSISDN: 15550101234`,
	}, "\r\n")

	out := RedactString(in)
	for _, sensitive := range []string{
		"001010123456789",
		"49015420-323751-8",
		"310260ABCDEFFF",
		"2001:db8::10",
		"00:11:22:33:44:55",
		"Home WiFi",
		"plainAKA",
		"15550101234",
	} {
		if strings.Contains(out, sensitive) {
			t.Fatalf("redacted trace still contains %q:\n%s", sensitive, out)
		}
	}
	for _, want := range []string{
		"Via: SIP/2.0/TCP [<redacted-ipv6-1>]:5060",
		"Contact: <sip:<redacted-sip-user-1>@[<redacted-ipv6-1>]:5060;transport=tcp>",
		`+sip.instance="<urn:gsma:imei:<redacted-id-1>>"`,
		"utran-cell-id-3gpp=<redacted-pani-1>",
		"ue-ip=<redacted-ipv6-1>",
		"i-wlan-node-id=<redacted-pani-2>",
		`ssid="<redacted-pani-3>"`,
		"nonce=<redacted>",
		"rand=<redacted>",
		`autn="<redacted>"`,
		"X-MSISDN: <redacted-msisdn-1>",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("redacted trace missing %q:\n%s", want, out)
		}
	}
}

func TestRedactorReusesPlaceholdersWithinTrace(t *testing.T) {
	redactor := NewRedactor()
	out := redactor.RedactString(strings.Join([]string{
		"From: <sip:alice@example.test>",
		"To: <sip:alice@example.test>",
		"Contact: <sip:bob@example.test>",
	}, "\n"))

	if strings.Count(out, "sip:<redacted-sip-user-1>@<redacted-domain-1>.invalid") != 2 {
		t.Fatalf("same SIP URI did not reuse placeholder:\n%s", out)
	}
	if !strings.Contains(out, "sip:<redacted-sip-user-2>@<redacted-domain-1>.invalid") {
		t.Fatalf("second SIP user/domain placeholders unexpected:\n%s", out)
	}
}

func TestRedactStringRemovesIMSIdentitiesFromSIPHeaderURIs(t *testing.T) {
	in := strings.Join([]string{
		"P-Preferred-Identity: <sip:15550101234@ims.example.invalid;user=phone>",
		"P-Associated-URI: <sip:imsi-001-01-0000000000@ims.example.invalid>",
		"Contact: <sip:imei490154203237518@ue.example.invalid:5060>",
	}, "\r\n")

	out := RedactString(in)
	for _, sensitive := range []string{
		"15550101234",
		"001-01-0000000000",
		"490154203237518",
		"ims.example.invalid",
		"ue.example.invalid",
	} {
		if strings.Contains(out, sensitive) {
			t.Fatalf("redacted trace still contains %q:\n%s", sensitive, out)
		}
	}
	for _, want := range []string{
		"P-Preferred-Identity: <sip:<redacted-sip-user-1>@<redacted-domain-1>.invalid;user=phone>",
		"P-Associated-URI: <sip:<redacted-sip-user-2>@<redacted-domain-1>.invalid>",
		"Contact: <sip:<redacted-sip-user-3>@<redacted-domain-2>.invalid:5060>",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("redacted trace missing %q:\n%s", want, out)
		}
	}
}

func TestRedactLinesUsesSharedMappingAndCopiesInput(t *testing.T) {
	lines := [][]byte{
		[]byte("sip:alice@example.test"),
		[]byte("sip:alice@example.test"),
	}
	out := RedactLines(lines)
	if !bytes.Equal(lines[0], []byte("sip:alice@example.test")) {
		t.Fatalf("input line mutated: %q", string(lines[0]))
	}
	if !bytes.Equal(out[0], out[1]) {
		t.Fatalf("shared line mapping not reused: %q vs %q", string(out[0]), string(out[1]))
	}
}
