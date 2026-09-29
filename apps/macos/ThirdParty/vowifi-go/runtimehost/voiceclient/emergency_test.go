package voiceclient

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"strings"
	"testing"
	"time"
)

func TestNormalizeEmergencyServiceURNHandlesCarrierForms(t *testing.T) {
	for _, tc := range []struct {
		name    string
		service string
		want    string
	}{
		{name: "dial string 112", service: "112", want: DefaultEmergencyServiceURN},
		{name: "emergency alias", service: "emergency", want: DefaultEmergencyServiceURN},
		{name: "service prefix", service: "service:fire", want: "urn:service:sos.fire"},
		{name: "medical alias", service: "medical", want: "urn:service:sos.ambulance"},
		{name: "slash urn", service: "urn/service/sos/ambulance", want: "urn:service:sos.ambulance"},
		{name: "sip urn wrapper", service: "sip:urn:service:sos.fire@ecscf.example;transport=tcp", want: "urn:service:sos.fire"},
		{name: "sips display wrapper", service: `"Alt" <sips:urn:service:sos.police@ecscf.example;lr>`, want: "urn:service:sos.police"},
		{name: "sip dial string wrapper", service: "sip:911@example.test;user=phone", want: DefaultEmergencyServiceURN},
		{name: "tel dial string wrapper", service: "tel:112;phone-context=+1", want: DefaultEmergencyServiceURN},
		{name: "non emergency tel wrapper", service: "tel:+15551212"},
		{name: "false sos prefix", service: "urn:service:sosatellite"},
		{name: "legacy private token", service: "private-carrier-service", want: "urn:service:sos.private-carrier-service"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeEmergencyServiceURN(tc.service); got != tc.want {
				t.Fatalf("NormalizeEmergencyServiceURN(%q)=%q, want %q", tc.service, got, tc.want)
			}
		})
	}
}

func TestBuildEmergencyPIDFLOWithUsageRules(t *testing.T) {
	allowed := true
	timestamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	body, err := BuildEmergencyPIDFLOWithUsageRules(EmergencyPIDFLOConfig{
		Entity:    "pres:device@example.test",
		TupleID:   "tuple-1",
		Method:    "GPS",
		Timestamp: timestamp,
		Address: EmergencyAddress{
			Latitude:    "47.6205",
			Longitude:   "-122.3493",
			Country:     "US",
			State:       "WA",
			City:        "Seattle",
			Street:      "Broad St",
			HouseNumber: "400",
			Unit:        "7",
			PostalCode:  "98109",
		},
	}, EmergencyPIDFLOUsageRules{
		RetransmissionAllowed: &allowed,
		RetentionExpiry:       timestamp.Add(time.Hour),
		NoteWell:              "emergency use",
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPIDFLOWithUsageRules() error = %v", err)
	}
	xmlBody := string(body)
	for _, want := range []string{
		`entity="pres:device@example.test"`,
		`<gml:pos>47.6205 -122.3493</gml:pos>`,
		`<cl:HNO>400</cl:HNO>`,
		`<cl:UNIT>7</cl:UNIT>`,
		`<gp:retransmission-allowed>true</gp:retransmission-allowed>`,
		`<gp:method>GPS</gp:method>`,
		`<timestamp>2026-01-02T03:04:05Z</timestamp>`,
	} {
		if !strings.Contains(xmlBody, want) {
			t.Fatalf("PIDF-LO body missing %q:\n%s", want, xmlBody)
		}
	}
	parsed, err := ParseEmergencyPIDFLO(body)
	if err != nil {
		t.Fatalf("ParseEmergencyPIDFLO() error = %v", err)
	}
	if parsed.Latitude != "47.6205" || parsed.Longitude != "-122.3493" ||
		parsed.City != "Seattle" || parsed.HouseNumber != "400" || parsed.Unit != "7" {
		t.Fatalf("parsed PIDF-LO address=%+v", parsed)
	}
}

func TestBuildEmergencyPIDFLOMultipartBody(t *testing.T) {
	pidfLO, err := BuildEmergencyPIDFLO(EmergencyPIDFLOConfig{
		Entity: "pres:device@example.test",
		Address: EmergencyAddress{
			Latitude:  "47.6205",
			Longitude: "-122.3493",
		},
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPIDFLO() error = %v", err)
	}
	contentType, body, err := BuildEmergencyPIDFLOMultipartBody([]byte("v=0\r\n"), pidfLO, EmergencyMultipartRelatedConfig{
		Boundary:        "e911-test-boundary",
		SDPContentID:    "sdp-1",
		PIDFLOContentID: "cid:location-1@example.test",
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPIDFLOMultipartBody() error = %v", err)
	}
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatalf("ParseMediaType(%q) error = %v", contentType, err)
	}
	if mediaType != EmergencyMultipartRelatedContentType ||
		params["boundary"] != "e911-test-boundary" ||
		params["type"] != EmergencySDPContentType ||
		params["start"] != "<sdp-1>" {
		t.Fatalf("multipart content type=%q params=%+v", mediaType, params)
	}

	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	part, err := reader.NextPart()
	if err != nil {
		t.Fatalf("first multipart part error = %v", err)
	}
	firstBody, err := io.ReadAll(part)
	if err != nil {
		t.Fatalf("read first multipart part error = %v", err)
	}
	if part.Header.Get("Content-Type") != EmergencySDPContentType ||
		part.Header.Get("Content-ID") != "<sdp-1>" ||
		part.Header.Get("Content-Disposition") != "session;handling=required" ||
		string(firstBody) != "v=0\r\n" {
		t.Fatalf("first part headers=%+v body=%q", part.Header, firstBody)
	}

	part, err = reader.NextPart()
	if err != nil {
		t.Fatalf("second multipart part error = %v", err)
	}
	secondBody, err := io.ReadAll(part)
	if err != nil {
		t.Fatalf("read second multipart part error = %v", err)
	}
	if part.Header.Get("Content-Type") != EmergencyPIDFLOContentType ||
		part.Header.Get("Content-ID") != "<location-1@example.test>" ||
		part.Header.Get("Content-Disposition") != "by-reference;handling=optional" {
		t.Fatalf("second part headers=%+v", part.Header)
	}
	if _, err := ParseEmergencyPIDFLO(secondBody); err != nil {
		t.Fatalf("second part PIDF-LO parse error = %v\n%s", err, secondBody)
	}
	if _, err := reader.NextPart(); err != io.EOF {
		t.Fatalf("extra multipart part err=%v", err)
	}
}

func TestBuildEmergencyInviteRequestEmbedsPIDFLOMultipartBody(t *testing.T) {
	pidfLO, err := BuildEmergencyPIDFLO(EmergencyPIDFLOConfig{
		Entity: "pres:device@example.test",
		Address: EmergencyAddress{
			Latitude:  "47.6205",
			Longitude: "-122.3493",
		},
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPIDFLO() error = %v", err)
	}
	info := BuildEmergencySIPRequestInfo(EmergencySIPHeaderConfig{
		ServiceURN:         "fire",
		AccessNetworkInfo:  EmergencyAccessNetworkInfo{Raw: `IEEE-802.11;i-wlan-node-id="aa:bb"`},
		PIDFLOContentID:    "location-inline",
		PIDFLOBody:         pidfLO,
		GeolocationRouting: true,
	})
	info.RouteSet = EmergencySIPRouteSet([]EmergencyRoute{{
		PCSCF:     []string{"pcscf-fire.ims.example"},
		Endpoints: []string{"sips:any@example.test"},
	}})

	msg, err := BuildEmergencyInviteRequest(DialogRequestConfig{
		Profile: IMSProfile{
			IMPU:      "sip:user@example.test",
			UserAgent: "vowifi-go-test",
		},
		Registration: RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@example.test",
		},
		CallID:   "emergency-call-pidf",
		LocalTag: "local",
	}, info, []byte("v=0\r\n"))
	if err != nil {
		t.Fatalf("BuildEmergencyInviteRequest() error = %v", err)
	}
	if msg.Method != "INVITE" || msg.URI != "urn:service:sos.fire" {
		t.Fatalf("INVITE method/URI=%s %s", msg.Method, msg.URI)
	}
	if msg.Headers["Accept-Contact"] != IMSEmergencyAcceptContact ||
		msg.Headers["P-Preferred-Service"] != IMSMMTelServiceIdentifier ||
		msg.Headers["P-Access-Network-Info"] != `IEEE-802.11;i-wlan-node-id="aa:bb"` ||
		msg.Headers["Geolocation"] != "<cid:location-inline>;inserted-by=endpoint" ||
		msg.Headers["Geolocation-Routing"] != GeolocationRoutingYes {
		t.Fatalf("emergency headers=%+v", msg.Headers)
	}
	if msg.Headers["Contact"] != "<sip:user@192.0.2.10:5060;sos>" {
		t.Fatalf("Contact=%q", msg.Headers["Contact"])
	}
	if msg.Headers["Route"] != "<sip:pcscf-fire.ims.example;lr>, <sips:any@example.test;lr>" {
		t.Fatalf("Route=%q", msg.Headers["Route"])
	}

	mediaType, params, err := mime.ParseMediaType(msg.Headers["Content-Type"])
	if err != nil {
		t.Fatalf("ParseMediaType(%q) error = %v", msg.Headers["Content-Type"], err)
	}
	if mediaType != EmergencyMultipartRelatedContentType ||
		params["type"] != EmergencySDPContentType ||
		params["start"] != "<sdp>" {
		t.Fatalf("Content-Type mediaType=%q params=%+v", mediaType, params)
	}
	reader := multipart.NewReader(bytes.NewReader(msg.Body), params["boundary"])
	part, err := reader.NextPart()
	if err != nil {
		t.Fatalf("first INVITE multipart part error = %v", err)
	}
	if part.Header.Get("Content-Type") != EmergencySDPContentType ||
		part.Header.Get("Content-ID") != "<sdp>" {
		t.Fatalf("first INVITE part headers=%+v", part.Header)
	}
	firstBody, err := io.ReadAll(part)
	if err != nil {
		t.Fatalf("read first INVITE part error = %v", err)
	}
	if string(firstBody) != "v=0\r\n" {
		t.Fatalf("first INVITE part body=%q", firstBody)
	}
	part, err = reader.NextPart()
	if err != nil {
		t.Fatalf("second INVITE multipart part error = %v", err)
	}
	secondBody, err := io.ReadAll(part)
	if err != nil {
		t.Fatalf("read second INVITE part error = %v", err)
	}
	if part.Header.Get("Content-Type") != EmergencyPIDFLOContentType ||
		part.Header.Get("Content-ID") != "<location-inline>" ||
		!strings.Contains(string(secondBody), "<gml:pos>47.6205 -122.3493</gml:pos>") {
		t.Fatalf("second INVITE part headers=%+v body=%q", part.Header, secondBody)
	}
}

func TestBuildEmergencyInviteRequestPreservesDialogAccessAndGeolocation(t *testing.T) {
	pidfLO, err := BuildEmergencyPIDFLO(EmergencyPIDFLOConfig{
		Entity: "pres:device@example.test",
		Address: EmergencyAddress{
			Latitude:  "47.6205",
			Longitude: "-122.3493",
		},
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPIDFLO() error = %v", err)
	}
	info := EmergencySIPRequestInfo{
		RequestURI:      "service:fire",
		PIDFLOContentID: "location-inline",
		PIDFLOBody:      pidfLO,
	}
	msg, err := BuildEmergencyInviteRequest(DialogRequestConfig{
		Profile: IMSProfile{
			IMPU:      "sip:user@example.test",
			UserAgent: "vowifi-go-test",
		},
		Registration: RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060",
			PublicIdentity: "sip:user@example.test",
		},
		RemoteURI:         "sip:911@ims.example",
		CallID:            "emergency-call-carrier-location",
		LocalTag:          "local",
		AccessNetworkInfo: "3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=0010100abcde",
		CarrierHeaders: map[string]string{
			"Geolocation":         "<https://lis.example.test/location/abc>;inserted-by=network",
			"Geolocation-Routing": GeolocationRoutingYes,
		},
	}, info, []byte("v=0\r\n"))
	if err != nil {
		t.Fatalf("BuildEmergencyInviteRequest() error = %v", err)
	}
	if msg.URI != "urn:service:sos.fire" {
		t.Fatalf("Request-URI=%q", msg.URI)
	}
	if msg.Headers["P-Access-Network-Info"] != "3GPP-E-UTRAN-FDD;utran-cell-id-3gpp=0010100abcde" {
		t.Fatalf("P-Access-Network-Info=%q", msg.Headers["P-Access-Network-Info"])
	}
	if msg.Headers["Geolocation"] != "<https://lis.example.test/location/abc>;inserted-by=network" ||
		msg.Headers["Geolocation-Routing"] != GeolocationRoutingYes {
		t.Fatalf("location headers=%+v", msg.Headers)
	}
	if msg.Headers["Accept-Contact"] != IMSEmergencyAcceptContact ||
		msg.Headers["P-Preferred-Service"] != IMSMMTelServiceIdentifier {
		t.Fatalf("emergency IMS headers=%+v", msg.Headers)
	}
	if msg.Headers["Contact"] != "<sip:user@192.0.2.10:5060;sos>" {
		t.Fatalf("Contact=%q", msg.Headers["Contact"])
	}
	if mediaType, _, err := mime.ParseMediaType(msg.Headers["Content-Type"]); err != nil || mediaType != EmergencyMultipartRelatedContentType {
		t.Fatalf("Content-Type=%q mediaType=%q err=%v", msg.Headers["Content-Type"], mediaType, err)
	}
}

func TestBuildEmergencyInviteRequestUsesGeoLocationWithoutPIDFLO(t *testing.T) {
	info := BuildEmergencySIPRequestInfo(EmergencySIPHeaderConfig{
		ServiceURN: "police",
		Address: EmergencyAddress{
			Latitude:  "40.7128",
			Longitude: "-74.0060",
		},
		GeolocationRouting: true,
	})
	msg, err := BuildEmergencyInviteRequest(DialogRequestConfig{
		Profile: IMSProfile{
			IMPU:      "sip:user@example.test",
			UserAgent: "vowifi-go-test",
		},
		Registration: RegistrationBinding{
			ContactURI:     "sip:user@192.0.2.10:5060;reg-type=sos",
			PublicIdentity: "sip:user@example.test",
		},
		CallID:   "emergency-call-geo",
		LocalTag: "local",
	}, info, []byte("v=0\r\n"))
	if err != nil {
		t.Fatalf("BuildEmergencyInviteRequest() error = %v", err)
	}
	if msg.URI != "urn:service:sos.police" ||
		msg.Headers["Content-Type"] != EmergencySDPContentType ||
		string(msg.Body) != "v=0\r\n" {
		t.Fatalf("geo INVITE uri=%q headers=%+v body=%q", msg.URI, msg.Headers, msg.Body)
	}
	if msg.Headers["Geolocation"] != "<geo:40.7128,-74.0060>;inserted-by=endpoint" ||
		msg.Headers["Geolocation-Routing"] != GeolocationRoutingYes {
		t.Fatalf("geo headers=%+v", msg.Headers)
	}
	if msg.Headers["Contact"] != "<sip:user@192.0.2.10:5060;reg-type=sos>" {
		t.Fatalf("Contact should keep existing emergency marker, got %q", msg.Headers["Contact"])
	}
}
