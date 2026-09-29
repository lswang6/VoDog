package e911

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/engine/swu"
	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
	"github.com/boa-z/vowifi-go/runtimehost/carrier"
)

type fakeHTTPClient struct {
	responses []*HTTPResponse
	requests  []*HTTPRequest
}

func (f *fakeHTTPClient) Do(req *HTTPRequest) (*HTTPResponse, error) {
	f.requests = append(f.requests, req)
	if len(f.responses) == 0 {
		return &HTTPResponse{StatusCode: 500, Body: []byte(`{}`)}, nil
	}
	resp := f.responses[0]
	f.responses = f.responses[1:]
	return resp, nil
}

type fakeAKAProvider struct {
	rand  []byte
	autn  []byte
	calls int
}

func (f *fakeAKAProvider) CalculateAKA(rand16, autn16 []byte) (sim.AKAResult, error) {
	f.calls++
	f.rand = append([]byte(nil), rand16...)
	f.autn = append([]byte(nil), autn16...)
	return e911AKAResult(), nil
}

type authFailureAKAProvider struct {
	calls int
}

func (p *authFailureAKAProvider) CalculateAKA(rand16, autn16 []byte) (sim.AKAResult, error) {
	p.calls++
	return sim.AKAResult{}, sim.ErrAuthFailure
}

func TestStartEmergencyAddressUpdateReturnsWebsheetFromEntitlementToken(t *testing.T) {
	client := &fakeHTTPClient{responses: []*HTTPResponse{{
		StatusCode: 200,
		Body:       []byte(`[{"status":1000,"token":"abc123","title":"E911"}]`),
	}}}
	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity: Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280"},
		Client:   client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.UserData != "abc123" || !strings.Contains(ws.URL, "token=abc123") || ws.Title != "E911" {
		t.Fatalf("websheet=%+v", ws)
	}
	if len(client.requests) != 1 || string(client.requests[0].Body) == "" {
		t.Fatalf("requests=%d body=%q", len(client.requests), client.requests[0].Body)
	}
}

func TestParseEntitlementResponseExtractsEmergencyPDNJSONVariants(t *testing.T) {
	result, err := parseEntitlementResponse([]byte(`{
		"statusCode": "1000",
		"addressUpdateUrl": "https://example.test/address",
		"authorizationToken": "tok-json",
		"pdn": {"name": "sos", "type": "ipv6", "apn": "sos.att.net", "realm": "ims.example"},
		"emergencyAddress": {
			"streetAddress": "1 Main St",
			"unit": "2A",
			"city": "Seattle",
			"state": "WA",
			"postalCode": "98101",
			"country": "US"
		},
		"locationValidationStatus": "validated"
	}`))
	if err != nil {
		t.Fatalf("parseEntitlementResponse() error = %v", err)
	}
	if result.Status != 1000 || result.WebsheetURL != "https://example.test/address" || result.UserData != "tok-json" {
		t.Fatalf("result basics=%+v", result)
	}
	if result.PDN != "sos" || result.PDNType != "ipv6" || result.APN != "sos.att.net" || result.Realm != "ims.example" {
		t.Fatalf("PDN fields=%+v", result)
	}
	if result.LocationValidationStatus != "validated" || result.EmergencyAddress["street"] != "1 Main St" ||
		result.EmergencyAddress["unit"] != "2A" || result.EmergencyAddress["postal_code"] != "98101" {
		t.Fatalf("address/status=%+v status=%q", result.EmergencyAddress, result.LocationValidationStatus)
	}
}

func TestParseEntitlementResponseExtractsEmergencyXMLVariants(t *testing.T) {
	result, err := parseEntitlementResponse([]byte(`
		<entitlement status="1000">
			<websheetEndpoint>https://example.test/xml-address</websheetEndpoint>
			<userDataToken>tok-xml</userDataToken>
			<emergencyPDN name="sos" type="ipv4v6" apn="sos.example" realm="ims.example"/>
			<emergencyAddress>
				<street1>2 Pine St</street1>
				<city>Portland</city>
				<region>OR</region>
				<zip>97035</zip>
				<countryCode>US</countryCode>
			</emergencyAddress>
			<validationStatus>pending</validationStatus>
		</entitlement>`))
	if err != nil {
		t.Fatalf("parseEntitlementResponse(XML) error = %v", err)
	}
	if result.Status != 1000 || result.Endpoint != "https://example.test/xml-address" || result.UserData != "tok-xml" {
		t.Fatalf("xml basics=%+v", result)
	}
	if result.PDN != "sos" || result.PDNType != "ipv4v6" || result.APN != "sos.example" || result.Realm != "ims.example" {
		t.Fatalf("xml PDN fields=%+v", result)
	}
	if result.LocationValidationStatus != "pending" || result.EmergencyAddress["street"] != "2 Pine St" ||
		result.EmergencyAddress["state"] != "OR" || result.EmergencyAddress["postal_code"] != "97035" {
		t.Fatalf("xml address/status=%+v status=%q", result.EmergencyAddress, result.LocationValidationStatus)
	}
}

func TestParseEntitlementResponseCapturesTS43JSONVariants(t *testing.T) {
	body := []byte(`{
		"entitlementStatus": "1000",
		"responseId": "json-response",
		"websheet": {"url": "https://example.test/e911/json"},
		"userDataToken": "json-token",
		"mime-type": "text/html; charset=utf-8",
		"websheetTitle": "Update emergency address",
		"emergency-address": {
			"address-line1": "1 Main St",
			"address_line2": "Apt 9",
			"locality": "Atlanta",
			"region": "GA",
			"postal-code": "30301",
			"country-code": "US",
			"unknown-address-field": "ignored"
		},
		"emergency-pdn": {
			"name": "ims-emergency",
			"type": "IPv4v6",
			"apn": "sos",
			"realm": "ims.mnc410.mcc310.3gppnetwork.org"
		},
		"location-validation-status": "validated",
		"unknown-field": {"nested": "ignored"}
	}`)

	result, err := parseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("parseEntitlementResponse() error = %v", err)
	}
	if result.Status != 1000 || result.ResponseID != "json-response" {
		t.Fatalf("status=%d responseID=%v", result.Status, result.ResponseID)
	}
	if result.WebsheetURL != "https://example.test/e911/json" || result.UserData != "json-token" {
		t.Fatalf("websheet=%q token=%q", result.WebsheetURL, result.UserData)
	}
	if result.ContentType != "text/html; charset=utf-8" || result.Title != "Update emergency address" {
		t.Fatalf("contentType=%q title=%q", result.ContentType, result.Title)
	}
	if got := result.EmergencyAddress["street"]; got != "1 Main St" {
		t.Fatalf("street=%q", got)
	}
	if got := result.EmergencyAddress["unit"]; got != "Apt 9" {
		t.Fatalf("unit=%q", got)
	}
	if got := result.EmergencyAddress["city"]; got != "Atlanta" {
		t.Fatalf("city=%q", got)
	}
	if got := result.EmergencyAddress["state"]; got != "GA" {
		t.Fatalf("state=%q", got)
	}
	if got := result.EmergencyAddress["postal_code"]; got != "30301" {
		t.Fatalf("postal_code=%q", got)
	}
	if got := result.EmergencyAddress["country"]; got != "US" {
		t.Fatalf("country=%q", got)
	}
	if _, ok := result.EmergencyAddress["unknown-address-field"]; ok {
		t.Fatalf("unknown emergency address field was retained: %+v", result.EmergencyAddress)
	}
	if result.PDN != "ims-emergency" || result.PDNType != "IPv4v6" || result.APN != "sos" || result.Realm != "ims.mnc410.mcc310.3gppnetwork.org" {
		t.Fatalf("pdn=%q type=%q apn=%q realm=%q", result.PDN, result.PDNType, result.APN, result.Realm)
	}
	if result.LocationValidationStatus != "validated" {
		t.Fatalf("validation status=%q", result.LocationValidationStatus)
	}
}

func TestParseEntitlementResponseCapturesTS43XMLVariants(t *testing.T) {
	body := []byte(`
		<ts43:response xmlns:ts43="urn:test">
			<status-code>1000</status-code>
			<response-id>xml-response</response-id>
			<endpoint>https://example.test/e911/xml</endpoint>
			<auth-token>xml-token</auth-token>
			<content-type>text/html</content-type>
			<title>XML emergency address</title>
			<emergency-address>
				<street-address>22 Market St</street-address>
				<city>Denver</city>
				<state>CO</state>
				<zip>80202</zip>
				<country>US</country>
			</emergency-address>
			<pdn name="ims-emergency" type="IPv6" apn="sos" realm="ims.mnc260.mcc310.3gppnetwork.org"/>
			<validation-status>pending</validation-status>
			<unknown name="ignored"/>
		</ts43:response>`)

	result, err := parseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("parseEntitlementResponse() error = %v", err)
	}
	if result.Status != 1000 || result.ResponseID != "xml-response" {
		t.Fatalf("status=%d responseID=%v", result.Status, result.ResponseID)
	}
	if result.Endpoint != "https://example.test/e911/xml" || result.UserData != "xml-token" {
		t.Fatalf("endpoint=%q token=%q", result.Endpoint, result.UserData)
	}
	if got := result.EmergencyAddress["street"]; got != "22 Market St" {
		t.Fatalf("street=%q", got)
	}
	if got := result.EmergencyAddress["city"]; got != "Denver" {
		t.Fatalf("city=%q", got)
	}
	if got := result.EmergencyAddress["postal_code"]; got != "80202" {
		t.Fatalf("postal_code=%q", got)
	}
	if result.PDN != "ims-emergency" || result.PDNType != "IPv6" || result.APN != "sos" || result.Realm != "ims.mnc260.mcc310.3gppnetwork.org" {
		t.Fatalf("pdn=%q type=%q apn=%q realm=%q", result.PDN, result.PDNType, result.APN, result.Realm)
	}
	if result.LocationValidationStatus != "pending" {
		t.Fatalf("validation status=%q", result.LocationValidationStatus)
	}
	ws := websheetFromEntitlement("", result)
	if ws.URL != "https://example.test/e911/xml" || ws.UserData != "xml-token" || ws.Title != "XML emergency address" {
		t.Fatalf("websheet=%+v", ws)
	}
}

func TestParseEntitlementResponseCapturesTS43RoutesAddressAndExpiryJSON(t *testing.T) {
	body := []byte(`{
		"status": 1000,
		"responseId": "route-json",
		"emergencyServiceRoutes": [
			{
				"serviceURN": "urn:service:sos",
				"p-cscf": ["pcscf1.ims.example", "pcscf2.ims.example"],
				"esrp-uri": "sip:esrp@example.test",
				"endpoint": "sips:sos@example.test"
			},
			{
				"service": "fire",
				"pcscfFqdn": "pcscf-fire.ims.example",
				"endpoints": ["tel:911"]
			}
		],
		"expires": "2026-07-07T09:30:00Z",
		"cache-control": "private, max-age=300",
		"emergencyAddress": {
			"A1": "WA",
			"A2": "King",
			"A3": "Seattle",
			"A6": "5th Ave",
			"HNO": "100",
			"PC": "98101",
			"countryCode": "US",
			"FLR": "7",
			"ROOM": "701"
		}
	}`)

	result, err := parseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("parseEntitlementResponse() error = %v", err)
	}
	if got, want := result.ExpiresAt, time.Date(2026, 7, 7, 9, 30, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("ExpiresAt=%s, want %s", got, want)
	}
	if result.CacheMaxAge != 5*time.Minute {
		t.Fatalf("CacheMaxAge=%s", result.CacheMaxAge)
	}
	if len(result.Routes) != 2 {
		t.Fatalf("routes=%+v", result.Routes)
	}
	first := result.Routes[0]
	if first.ServiceURN != "urn:service:sos" || !sameStrings(first.PCSCF, []string{"pcscf1.ims.example", "pcscf2.ims.example"}) ||
		!sameStrings(first.ESRP, []string{"sip:esrp@example.test"}) || !sameStrings(first.Endpoints, []string{"sips:sos@example.test"}) {
		t.Fatalf("first route=%+v", first)
	}
	second := result.Routes[1]
	if second.ServiceURN != "urn:service:sos.fire" || !sameStrings(second.PCSCF, []string{"pcscf-fire.ims.example"}) ||
		!sameStrings(second.Endpoints, []string{"tel:911"}) {
		t.Fatalf("second route=%+v", second)
	}
	if !containsString(result.ServiceURNs, "urn:service:sos") || !containsString(result.ServiceURNs, "urn:service:sos.fire") {
		t.Fatalf("service URNs=%+v", result.ServiceURNs)
	}
	if result.EmergencyAddress["state"] != "WA" || result.EmergencyAddress["county"] != "King" ||
		result.EmergencyAddress["city"] != "Seattle" || result.EmergencyAddress["street"] != "5th Ave" ||
		result.EmergencyAddress["house_number"] != "100" || result.EmergencyAddress["floor"] != "7" ||
		result.EmergencyAddress["room"] != "701" {
		t.Fatalf("emergency address=%+v", result.EmergencyAddress)
	}

	info, err := ParseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("ParseEntitlementResponse() error = %v", err)
	}
	if info.ResponseID != "route-json" || info.Address.HouseNumber != "100" || info.Address.County != "King" ||
		info.Address.PostalCode != "98101" || len(info.Routes) != 2 {
		t.Fatalf("public info=%+v", info)
	}
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	if got, want := info.EffectiveExpiresAt(base), time.Date(2026, 7, 7, 9, 30, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("EffectiveExpiresAt=%s, want %s", got, want)
	}
	if got, want := info.EffectiveCacheExpiresAt(base), base.Add(5*time.Minute); !got.Equal(want) {
		t.Fatalf("EffectiveCacheExpiresAt=%s, want %s", got, want)
	}
}

func TestParseEntitlementResponsePreservesWebsheetUserDataAndLocationValidationContext(t *testing.T) {
	body := []byte(`{
		"status": 1000,
		"token": "entitlement-token",
		"websheet": {
			"url": "https://example.test/e911/websheet",
			"user-data": "opaque-websheet-state",
			"content-type": "text/html"
		},
		"location-validation": {
			"status": "validated"
		},
		"emergency-pdn": {
			"dnn": "sos.dnn.example",
			"pdp-type": "IPv4v6",
			"domain": "ims.example"
		},
		"emergency-location": {
			"civicAddress": {
				"PRD": "N",
				"RD": "Main",
				"STS": "St",
				"POD": "SW",
				"LMK": "Library",
				"LOC": "Lobby",
				"PLC": "office",
				"POBOX": "123",
				"ADDCODE": "A1",
				"SEAT": "42"
			}
		}
	}`)

	info, err := ParseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("ParseEntitlementResponse() error = %v", err)
	}
	if info.Status != 1000 {
		t.Fatalf("Status=%d", info.Status)
	}
	if info.UserData != "opaque-websheet-state" {
		t.Fatalf("UserData=%q, want websheet-scoped user-data", info.UserData)
	}
	if info.LocationValidationStatus != "validated" {
		t.Fatalf("LocationValidationStatus=%q", info.LocationValidationStatus)
	}
	if info.PDN.APN != "sos.dnn.example" || info.PDN.Type != "IPv4v6" || info.PDN.Realm != "ims.example" {
		t.Fatalf("PDN=%+v", info.PDN)
	}
	if info.Address.StreetDirection != "N" || info.Address.Street != "Main" ||
		info.Address.StreetSuffix != "St" || info.Address.StreetPostDirection != "SW" ||
		info.Address.Landmark != "Library" || info.Address.LocationDescription != "Lobby" ||
		info.Address.PlaceType != "office" || info.Address.PostOfficeBox != "123" ||
		info.Address.AdditionalCode != "A1" || info.Address.Seat != "42" {
		t.Fatalf("Address=%+v fields=%+v", info.Address, info.Address.Fields)
	}
	ws := websheetFromEntitlement("", entitlementResult{
		WebsheetURL: "https://example.test/e911/websheet",
		UserData:    info.UserData,
		ContentType: info.ContentType,
		Title:       info.Title,
	})
	if ws.UserData != "opaque-websheet-state" || ws.URL != "https://example.test/e911/websheet" {
		t.Fatalf("websheet=%+v", ws)
	}
}

func TestParseEntitlementResponseNormalizesLocationValidationStatus(t *testing.T) {
	for _, tc := range []struct {
		name string
		body []byte
		want string
	}{
		{
			name: "direct validated alias",
			body: []byte(`{"status":1000,"validation-status":"APPROVED"}`),
			want: "validated",
		},
		{
			name: "nested pending alias",
			body: []byte(`{"status":1000,"location-validation":{"result":"in progress"}}`),
			want: "pending",
		},
		{
			name: "xml invalid alias",
			body: []byte(`<response><address-validation><state>not-valid</state></address-validation></response>`),
			want: "invalid",
		},
		{
			name: "unknown status preserved",
			body: []byte(`{"status":1000,"location-validation-status":"carrier-review-needed"}`),
			want: "carrier-review-needed",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			info, err := ParseEntitlementResponse(tc.body)
			if err != nil {
				t.Fatalf("ParseEntitlementResponse() error = %v", err)
			}
			if info.LocationValidationStatus != tc.want {
				t.Fatalf("LocationValidationStatus=%q, want %q", info.LocationValidationStatus, tc.want)
			}
		})
	}
}

func TestParseEntitlementResponseCapturesRoutePDNAndCacheControlAliases(t *testing.T) {
	body := []byte(`{
		"status": 1000,
		"emergencyRouteInfo": {
			"service-type": "medical",
			"p-cscf-ip-address": ["2001:db8::1"],
			"e-cscf-uri": "sip:ecscf@example.test",
			"sos-uri": "sips:sos@example.test"
		},
		"pdnConfiguration": {
			"accessPointNameNetworkIdentifier": "sos.apn.example",
			"bearerType": "IPv6",
			"homeRealm": "ims.example"
		},
		"cache-control": {"max-age": "PT10M"},
		"expires-in": "PT30M"
	}`)

	info, err := ParseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("ParseEntitlementResponse() error = %v", err)
	}
	if info.CacheMaxAge != 10*time.Minute || info.ExpiresIn != 30*time.Minute {
		t.Fatalf("cache/expires: CacheMaxAge=%s ExpiresIn=%s", info.CacheMaxAge, info.ExpiresIn)
	}
	if info.PDN.APN != "sos.apn.example" || info.PDN.Type != "IPv6" || info.PDN.Realm != "ims.example" {
		t.Fatalf("PDN=%+v", info.PDN)
	}
	if !sameStrings(info.ServiceURNs, []string{"urn:service:sos.ambulance"}) {
		t.Fatalf("ServiceURNs=%+v", info.ServiceURNs)
	}
	if len(info.Routes) != 1 {
		t.Fatalf("routes=%+v", info.Routes)
	}
	route := info.Routes[0]
	if route.ServiceURN != "urn:service:sos.ambulance" ||
		!sameStrings(route.PCSCF, []string{"2001:db8::1"}) ||
		!sameStrings(route.Endpoints, []string{"sip:ecscf@example.test", "sips:sos@example.test"}) {
		t.Fatalf("route=%+v", route)
	}
}

func TestParseEntitlementResponseCapturesRetryAfterAndStaleIfError(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	body := []byte(`{
		"status": 6004,
		"response-id": "retry-json",
		"retry-after": "120",
		"cache-control": "private, max-age=60, stale-if-error=300"
	}`)

	info, err := ParseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("ParseEntitlementResponse() error = %v", err)
	}
	if info.ResponseID != "retry-json" || info.Status != 6004 {
		t.Fatalf("basics=%+v", info)
	}
	if info.RetryAfterIn != 2*time.Minute {
		t.Fatalf("RetryAfterIn=%s, want 2m", info.RetryAfterIn)
	}
	if got, want := info.EffectiveRetryAfter(base), base.Add(2*time.Minute); !got.Equal(want) {
		t.Fatalf("EffectiveRetryAfter=%s, want %s", got, want)
	}
	if info.CacheMaxAge != time.Minute || info.StaleIfError != 5*time.Minute {
		t.Fatalf("CacheMaxAge=%s StaleIfError=%s", info.CacheMaxAge, info.StaleIfError)
	}

	xmlInfo, err := ParseEntitlementResponse([]byte(`
		<response>
			<status>6004</status>
			<retry-after>Tue, 07 Jul 2026 09:05:00 GMT</retry-after>
			<stale-if-error>PT10M</stale-if-error>
		</response>`))
	if err != nil {
		t.Fatalf("ParseEntitlementResponse(XML) error = %v", err)
	}
	if got, want := xmlInfo.RetryAfter, base.Add(5*time.Minute); !got.Equal(want) {
		t.Fatalf("XML RetryAfter=%s, want %s", got, want)
	}
	if xmlInfo.StaleIfError != 10*time.Minute {
		t.Fatalf("XML StaleIfError=%s, want 10m", xmlInfo.StaleIfError)
	}
}

func TestParseEntitlementResponseNormalizesRegisteredEmergencyServiceAliases(t *testing.T) {
	body := []byte(`{
		"status": 1000,
		"emergencyServiceRoutes": [
			{"service": "poison", "endpoint": "sip:poison@example.test"},
			{"service": "physician", "endpoint": "sip:physician@example.test"},
			{"service": "animal-control", "endpoint": "sip:animal@example.test"},
			{"service": "gas", "endpoint": "sip:gas@example.test"}
		]
	}`)

	info, err := ParseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("ParseEntitlementResponse() error = %v", err)
	}
	wantURNs := []string{
		"urn:service:sos.poison",
		"urn:service:sos.physician",
		"urn:service:sos.animal-control",
		"urn:service:sos.gas",
	}
	if !sameStrings(info.ServiceURNs, wantURNs) {
		t.Fatalf("service URNs=%+v, want %+v", info.ServiceURNs, wantURNs)
	}
	if len(info.Routes) != len(wantURNs) {
		t.Fatalf("routes=%+v", info.Routes)
	}
	for i, wantURN := range wantURNs {
		if info.Routes[i].ServiceURN != wantURN {
			t.Fatalf("route[%d].ServiceURN=%q, want %q", i, info.Routes[i].ServiceURN, wantURN)
		}
	}
}

func TestParseEntitlementResponseCapturesTS43RoutesAndCacheXML(t *testing.T) {
	body := []byte(`
		<ts43:response xmlns:ts43="urn:test">
			<status-code>1000</status-code>
			<emergency-service>ambulance</emergency-service>
			<endpoint>https://example.test/e911/xml-websheet</endpoint>
			<emergencyRouting>
				<route serviceUrn="urn:service:sos.police">
					<p-cscf>
						<fqdn>pcscf-police.ims.example</fqdn>
					</p-cscf>
					<esrp-uri>sip:esrp-police@example.test</esrp-uri>
					<endpoint>sips:police@example.test</endpoint>
				</route>
			</emergencyRouting>
			<cacheExpires>Tue, 07 Jul 2026 08:15:00 GMT</cacheExpires>
		</ts43:response>`)

	info, err := ParseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("ParseEntitlementResponse() error = %v", err)
	}
	if info.Endpoint != "https://example.test/e911/xml-websheet" {
		t.Fatalf("websheet endpoint=%q", info.Endpoint)
	}
	if got, want := info.CacheExpiresAt, time.Date(2026, 7, 7, 8, 15, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("CacheExpiresAt=%s, want %s", got, want)
	}
	if !containsString(info.ServiceURNs, "urn:service:sos.ambulance") || !containsString(info.ServiceURNs, "urn:service:sos.police") {
		t.Fatalf("service URNs=%+v", info.ServiceURNs)
	}
	if len(info.Routes) != 1 {
		t.Fatalf("routes=%+v", info.Routes)
	}
	route := info.Routes[0]
	if route.ServiceURN != "urn:service:sos.police" || !sameStrings(route.PCSCF, []string{"pcscf-police.ims.example"}) ||
		!sameStrings(route.ESRP, []string{"sip:esrp-police@example.test"}) ||
		!sameStrings(route.Endpoints, []string{"sips:police@example.test"}) {
		t.Fatalf("route=%+v", route)
	}
}

func TestParseEntitlementResponseHandlesEmptyAndUnknownFields(t *testing.T) {
	body := []byte(`[{
		"status": 1000,
		"token": "",
		"websheet-url": "",
		"content-type": "",
		"title": "",
		"emergency-address": {
			"line1": "",
			"city": ""
		},
		"unknown-field": {
			"nested": "ignored"
		}
	}]`)

	result, err := parseEntitlementResponse(body)
	if err != nil {
		t.Fatalf("parseEntitlementResponse() error = %v", err)
	}
	if result.UserData != "" || result.WebsheetURL != "" {
		t.Fatalf("websheet=%q token=%q", result.WebsheetURL, result.UserData)
	}
	if result.ContentType != "text/html" || result.Title != "Emergency address" {
		t.Fatalf("defaults contentType=%q title=%q", result.ContentType, result.Title)
	}
	if len(result.EmergencyAddress) != 0 {
		t.Fatalf("empty emergency address fields should be ignored: %+v", result.EmergencyAddress)
	}
}

func TestStartEmergencyAddressUpdateSendsCachedTokenToEntitlement(t *testing.T) {
	client := &fakeHTTPClient{responses: []*HTTPResponse{{
		StatusCode: 200,
		Body:       []byte(`[{"status":1000,"websheet-url":"https://example.test/address"}]`),
	}}}
	_, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity: Identity{
			IMSI:        "310280000000001",
			IMEI:        "490154203237518",
			MCC:         "310",
			MNC:         "280",
			SIPUsername: "310280000000001@private.att.net",
			CachedToken: "cached-token-123",
		},
		Client: client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if len(client.requests) != 1 {
		t.Fatalf("requests=%d", len(client.requests))
	}
	req := client.requests[0]
	if got := headerValue(req.Headers, "Authorization"); got != "Bearer cached-token-123" {
		t.Fatalf("Authorization=%q", got)
	}
	if got := headerValue(req.Headers, "x-entitlement-token"); got != "cached-token-123" {
		t.Fatalf("x-entitlement-token=%q", got)
	}
	var payload []map[string]any
	if err := json.Unmarshal(req.Body, &payload); err != nil {
		t.Fatalf("request JSON error = %v body=%s", err, req.Body)
	}
	if len(payload) != 1 || stringValue(payload[0]["entitlement-token"]) != "cached-token-123" || stringValue(payload[0]["token"]) != "cached-token-123" {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestStartEmergencyAddressUpdateHandlesAKAChallenge(t *testing.T) {
	randHex := strings.ToUpper(hex.EncodeToString(bytesFrom(0x10, 16)))
	autnHex := strings.ToUpper(hex.EncodeToString(bytesFrom(0x40, 16)))
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":7,"rand":"` + randHex + `","autn":"` + autnHex + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280"},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests=%d, want challenge response", len(client.requests))
	}
	if got := strings.ToUpper(hex.EncodeToString(aka.rand)); got != randHex {
		t.Fatalf("AKA RAND=%s, want %s", got, randHex)
	}
	if got := string(client.requests[1].Body); !strings.Contains(got, "11223344") || !strings.Contains(got, "response-id") {
		t.Fatalf("AKA answer body=%s", got)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayChallenge(t *testing.T) {
	identity := "310280000000001@private.att.net"
	relayPacket := signedEAPRelayChallenge(t, identity, e911AKAResult())
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":9,"eap-relay-packet":"` + relayPacket + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	_, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests=%d, want relay challenge response", len(client.requests))
	}
	var payload []map[string]any
	if err := json.Unmarshal(client.requests[1].Body, &payload); err != nil {
		t.Fatalf("answer JSON error = %v body=%s", err, client.requests[1].Body)
	}
	relay, _ := payload[0]["eap-relay-packet"].(string)
	raw, err := base64.StdEncoding.DecodeString(relay)
	if err != nil {
		t.Fatalf("relay response base64 error = %v", err)
	}
	packet, err := eapaka.ParsePacket(raw)
	if err != nil {
		t.Fatalf("relay response parse error = %v", err)
	}
	resAttr, ok := eapaka.FindAttribute(packet.Attributes, eapaka.AttributeRES)
	if !ok || packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeChallenge {
		t.Fatalf("relay response packet=%+v", packet)
	}
	res, bits, err := resAttr.RESValue()
	if err != nil {
		t.Fatalf("RESValue() error = %v", err)
	}
	if bits != 32 || strings.ToUpper(hex.EncodeToString(res)) != "11223344" {
		t.Fatalf("RES bits=%d value=%s", bits, strings.ToUpper(hex.EncodeToString(res)))
	}
}

func TestStartEmergencyAddressUpdateCapturesEAPRelayEncryptedIdentityState(t *testing.T) {
	identity := "310280000000001@private.att.net"
	akaResult := e911AKAResult()
	keys, err := eapaka.DeriveKeys(identity, akaResult)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	iv := bytesFrom(0x70, 16)
	encrypted, err := eapaka.EncryptAttributes(keys.KEncr, iv, []eapaka.Attribute{
		eapaka.NextPseudonymAttribute("pseudo-e911"),
		eapaka.NextReauthIDAttribute("reauth-e911"),
	})
	if err != nil {
		t.Fatalf("EncryptAttributes() error = %v", err)
	}
	relayPacket := signedEAPRelayChallengeWithEncryptedAttrs(t, identity, akaResult, eapaka.IVAttribute(iv), encrypted)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":19,"eap-relay-packet":"` + relayPacket + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.EAPNextPseudonym != "pseudo-e911" || ws.EAPNextReauthID != "reauth-e911" {
		t.Fatalf("websheet EAP state pseudonym=%q reauth=%q", ws.EAPNextPseudonym, ws.EAPNextReauthID)
	}
	if aka.calls != 1 {
		t.Fatalf("AKA calls=%d, want one AKA calculation", aka.calls)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayAuthenticationReject(t *testing.T) {
	identity := "310280000000001@private.att.net"
	relayPacket := signedEAPRelayChallenge(t, identity, e911AKAResult())
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":18,"eap-relay-packet":"` + relayPacket + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &authFailureAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if aka.calls != 1 || len(client.requests) != 2 {
		t.Fatalf("AKA calls=%d requests=%d", aka.calls, len(client.requests))
	}
	answer := decodeEntitlementAnswer(t, client.requests[1].Body)
	if _, ok := answer["aka-res"]; ok {
		t.Fatalf("authentication reject answer must not include AKA RES: %s", client.requests[1].Body)
	}
	packet := decodeRelayPacket(t, answer)
	if packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeAuthenticationReject || len(packet.Attributes) != 0 {
		t.Fatalf("authentication reject relay response=%+v", packet)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayBiddingDown(t *testing.T) {
	identity := "310280000000001@private.att.net"
	relayPacket := signedEAPRelayChallengeWithEncryptedAttrs(t, identity, e911AKAResult(), eapaka.BiddingAttribute(true))
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":24,"eap-relay-packet":"` + relayPacket + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if aka.calls != 1 || len(client.requests) != 2 {
		t.Fatalf("AKA calls=%d requests=%d", aka.calls, len(client.requests))
	}
	answer := decodeEntitlementAnswer(t, client.requests[1].Body)
	if _, ok := answer["aka-res"]; ok {
		t.Fatalf("bidding-down answer must not include AKA RES: %s", client.requests[1].Body)
	}
	if _, ok := answer["aka-ck"]; ok {
		t.Fatalf("bidding-down answer must not include AKA CK: %s", client.requests[1].Body)
	}
	packet := decodeRelayPacket(t, answer)
	if packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeAuthenticationReject || len(packet.Attributes) != 0 {
		t.Fatalf("bidding-down relay response=%+v", packet)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayIdentityThenChallenge(t *testing.T) {
	identity := "310280000000001@private.att.net"
	identityRequest, identityRequestRaw := eapRelayIdentityRequestRaw(t)
	identityResponseRaw, err := (eapaka.Packet{
		Code:       eapaka.CodeResponse,
		Identifier: 6,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeIdentity,
		Attributes: []eapaka.Attribute{eapaka.IdentityAttribute(identity)},
	}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(identity response) error = %v", err)
	}
	identityTranscript := [][]byte{identityRequestRaw, identityResponseRaw}
	relayPacket := signedEAPRelayChallengeWithCheckcode(t, identity, e911AKAResult(), identityTranscript)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":12,"eap-relay-packet":"` + identityRequest + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":13,"eap-relay-packet":"` + relayPacket + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 3 {
		t.Fatalf("requests=%d, want identity response, AKA response, websheet", len(client.requests))
	}
	first := decodeEntitlementAnswer(t, client.requests[1].Body)
	firstPacket := decodeRelayPacket(t, first)
	if firstPacket.Code != eapaka.CodeResponse || firstPacket.Subtype != eapaka.SubtypeIdentity {
		t.Fatalf("identity relay response=%+v", firstPacket)
	}
	idAttr, ok := eapaka.FindAttribute(firstPacket.Attributes, eapaka.AttributeIdentity)
	if !ok {
		t.Fatalf("identity relay response missing AT_IDENTITY: %+v", firstPacket)
	}
	gotIdentity, err := idAttr.IdentityValue()
	if err != nil {
		t.Fatalf("IdentityValue() error = %v", err)
	}
	if gotIdentity != identity {
		t.Fatalf("identity=%q, want %q", gotIdentity, identity)
	}
	second := decodeEntitlementAnswer(t, client.requests[2].Body)
	secondPacket := decodeRelayPacket(t, second)
	if secondPacket.Code != eapaka.CodeResponse || secondPacket.Subtype != eapaka.SubtypeChallenge {
		t.Fatalf("challenge relay response=%+v", secondPacket)
	}
	checkcodeAttr, ok := eapaka.FindAttribute(secondPacket.Attributes, eapaka.AttributeCheckcode)
	if !ok {
		t.Fatal("challenge relay response missing AT_CHECKCODE")
	}
	if err := eapaka.VerifyCheckcodeAttribute(checkcodeAttr, identityTranscript); err != nil {
		t.Fatalf("VerifyCheckcodeAttribute(response) error = %v", err)
	}
	if aka.calls != 1 {
		t.Fatalf("AKA calls=%d, want one AKA calculation after identity", aka.calls)
	}
}

func TestBuildEntitlementChallengeAnswerSelectsEAPRelayIdentity(t *testing.T) {
	identity := "310280000000001@private.att.net"
	keys, err := eapaka.DeriveKeys(identity, e911AKAResult())
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	usableReauth := swu.EAPReauthenticationState{
		Identity:      "reauth-e911",
		NextPseudonym: "pseudo-e911",
		CounterOK:     true,
		Keys:          keys,
	}
	unusableReauth := swu.EAPReauthenticationState{
		Identity:      "reauth-without-keys",
		NextPseudonym: "pseudo-e911",
	}
	for _, tc := range []struct {
		name  string
		attrs []eapaka.Attribute
		state swu.EAPReauthenticationState
		want  string
	}{
		{
			name:  "any id uses usable reauth identity",
			attrs: []eapaka.Attribute{eapaka.AnyIDReqAttribute()},
			state: usableReauth,
			want:  "reauth-e911",
		},
		{
			name:  "any id skips unusable reauth identity",
			attrs: []eapaka.Attribute{eapaka.AnyIDReqAttribute()},
			state: unusableReauth,
			want:  "pseudo-e911",
		},
		{
			name:  "fullauth id uses pseudonym",
			attrs: []eapaka.Attribute{eapaka.FullAuthIDReqAttribute()},
			state: usableReauth,
			want:  "pseudo-e911",
		},
		{
			name:  "permanent id uses configured identity",
			attrs: []eapaka.Attribute{eapaka.PermanentIDReqAttribute()},
			state: usableReauth,
			want:  identity,
		},
		{
			name:  "plain identity request preserves existing fallback",
			attrs: nil,
			state: usableReauth,
			want:  identity,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			packet := eapaka.Packet{
				Code:       eapaka.CodeRequest,
				Identifier: 6,
				Type:       eapaka.TypeAKA,
				Subtype:    eapaka.SubtypeIdentity,
				Attributes: tc.attrs,
			}
			result := entitlementResult{EAPPacket: &packet}
			answer, _, _, _, _, _, err := buildEntitlementChallengeAnswer(Request{
				Identity: Identity{IMSI: "310280000000001", SIPUsername: identity},
			}, result, nil, nil, tc.state)
			if err != nil {
				t.Fatalf("buildEntitlementChallengeAnswer() error = %v", err)
			}
			if got := relayIdentityValue(t, answer); got != tc.want {
				t.Fatalf("identity=%q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildEntitlementChallengeAnswerHandlesEAPRelayVersionList(t *testing.T) {
	identity := "310280000000001@private.att.net"
	for _, tc := range []struct {
		name           string
		versions       []uint16
		wantSubtype    uint8
		wantSelected   bool
		wantClientCode uint16
	}{
		{
			name:         "supported version",
			versions:     []uint16{2, eapaka.SupportedVersion},
			wantSubtype:  eapaka.SubtypeIdentity,
			wantSelected: true,
		},
		{
			name:           "unsupported version",
			versions:       []uint16{2, 3},
			wantSubtype:    eapaka.SubtypeClientError,
			wantClientCode: eapaka.ClientErrorUnsupportedVersion,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			packet := eapaka.Packet{
				Code:       eapaka.CodeRequest,
				Identifier: 6,
				Type:       eapaka.TypeAKA,
				Subtype:    eapaka.SubtypeIdentity,
				Attributes: []eapaka.Attribute{
					eapaka.AnyIDReqAttribute(),
					eapaka.VersionListAttribute(tc.versions...),
				},
			}
			result := entitlementResult{EAPPacket: &packet}
			answer, _, _, _, _, _, err := buildEntitlementChallengeAnswer(Request{
				Identity: Identity{IMSI: "310280000000001", SIPUsername: identity},
			}, result, nil, nil, swu.EAPReauthenticationState{})
			if err != nil {
				t.Fatalf("buildEntitlementChallengeAnswer() error = %v", err)
			}
			response := decodeRelayPacket(t, answer)
			if response.Subtype != tc.wantSubtype {
				t.Fatalf("response subtype=%d, want %d: %+v", response.Subtype, tc.wantSubtype, response)
			}
			if tc.wantSelected {
				attr, ok := eapaka.FindAttribute(response.Attributes, eapaka.AttributeSelectedVersion)
				if !ok {
					t.Fatalf("missing AT_SELECTED_VERSION: %+v", response.Attributes)
				}
				selected, err := attr.SelectedVersionValue()
				if err != nil {
					t.Fatalf("SelectedVersionValue() error = %v", err)
				}
				if selected != eapaka.SupportedVersion {
					t.Fatalf("selected=%d", selected)
				}
			}
			if tc.wantClientCode != 0 {
				attr, ok := eapaka.FindAttribute(response.Attributes, eapaka.AttributeClientErrorCode)
				if !ok {
					t.Fatalf("missing AT_CLIENT_ERROR_CODE: %+v", response.Attributes)
				}
				code, err := attr.ClientErrorCodeValue()
				if err != nil {
					t.Fatalf("ClientErrorCodeValue() error = %v", err)
				}
				if code != tc.wantClientCode {
					t.Fatalf("client error=%d, want %d", code, tc.wantClientCode)
				}
			}
		})
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayAKAPrimeKDFNegotiation(t *testing.T) {
	identity := "310280000000001@private.att.net"
	kdfOffer := eapRelayAKAPrimeKDFOffer(t, "WLAN", []uint16{99, eapaka.AKAPrimeKDFDefault})
	selectedChallenge := signedEAPRelayAKAPrimeChallenge(t, identity, "WLAN", e911AKAResult(), []uint16{eapaka.AKAPrimeKDFDefault, 99})
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":10,"eap-relay-packet":"` + kdfOffer + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":11,"eap-relay-packet":"` + selectedChallenge + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 3 {
		t.Fatalf("requests=%d, want KDF negotiation then AKA response", len(client.requests))
	}
	first := decodeEntitlementAnswer(t, client.requests[1].Body)
	if _, ok := first["aka-res"]; ok {
		t.Fatalf("KDF negotiation answer must not include AKA RES: %s", client.requests[1].Body)
	}
	firstPacket := decodeRelayPacket(t, first)
	if len(firstPacket.Attributes) != 1 || firstPacket.Attributes[0].Type != eapaka.AttributeKDF {
		t.Fatalf("KDF negotiation packet=%+v", firstPacket)
	}
	kdf, err := firstPacket.Attributes[0].KDFValue()
	if err != nil {
		t.Fatalf("KDFValue() error = %v", err)
	}
	if kdf != eapaka.AKAPrimeKDFDefault {
		t.Fatalf("AT_KDF=%d", kdf)
	}
	second := decodeEntitlementAnswer(t, client.requests[2].Body)
	if strings.ToUpper(stringValue(second["aka-res"])) != "11223344" {
		t.Fatalf("AKA answer body=%s", client.requests[2].Body)
	}
	secondPacket := decodeRelayPacket(t, second)
	if secondPacket.Type != eapaka.TypeAKAPrime {
		t.Fatalf("AKA' relay response=%+v", secondPacket)
	}
	if _, ok := eapaka.FindAttribute(secondPacket.Attributes, eapaka.AttributeRES); !ok {
		t.Fatalf("AKA' relay response missing AT_RES: %+v", secondPacket)
	}
	if aka.calls != 1 {
		t.Fatalf("AKA calls=%d, want only selected challenge to use SIM", aka.calls)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayNotification(t *testing.T) {
	notification := eapRelayNotificationRequest(t, eapaka.NotificationGeneralFailureBeforeAuthentication)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":14,"eap-relay-packet":"` + notification + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity: Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280"},
		Client:   client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests=%d, want notification response", len(client.requests))
	}
	answer := decodeEntitlementAnswer(t, client.requests[1].Body)
	if _, ok := answer["aka-res"]; ok {
		t.Fatalf("notification answer must not include AKA RES: %s", client.requests[1].Body)
	}
	packet := decodeRelayPacket(t, answer)
	if packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeNotification || len(packet.Attributes) != 0 {
		t.Fatalf("notification relay response=%+v", packet)
	}
}

func TestStartEmergencyAddressUpdateHandlesAuthenticatedEAPRelayNotification(t *testing.T) {
	identity := "310280000000001@private.att.net"
	akaResult := e911AKAResult()
	challenge := signedEAPRelayChallenge(t, identity, akaResult)
	notification := signedEAPRelayNotification(t, identity, akaResult, eapaka.NotificationSuccess)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":15,"eap-relay-packet":"` + challenge + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":16,"eap-relay-packet":"` + notification + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 3 {
		t.Fatalf("requests=%d, want challenge response then notification response", len(client.requests))
	}
	notificationAnswer := decodeEntitlementAnswer(t, client.requests[2].Body)
	if _, ok := notificationAnswer["aka-res"]; ok {
		t.Fatalf("notification answer must not include AKA RES: %s", client.requests[2].Body)
	}
	packet := decodeRelayPacket(t, notificationAnswer)
	if packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeNotification {
		t.Fatalf("authenticated notification response=%+v", packet)
	}
	if len(packet.Attributes) != 1 || packet.Attributes[0].Type != eapaka.AttributeMAC {
		t.Fatalf("authenticated notification attributes=%+v", packet.Attributes)
	}
	keys, err := eapaka.DeriveKeys(identity, akaResult)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	if err := eapaka.VerifyMAC(keys.KAut, raw, nil); err != nil {
		t.Fatalf("VerifyMAC(notification response) error = %v", err)
	}
	if aka.calls != 1 {
		t.Fatalf("AKA calls=%d, want only challenge to use SIM", aka.calls)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelaySuccessTerminal(t *testing.T) {
	identity := "310280000000001@private.att.net"
	challenge := signedEAPRelayChallenge(t, identity, e911AKAResult())
	success := eapRelayTerminalPacket(t, eapaka.CodeSuccess, 22)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":22,"eap-relay-packet":"` + challenge + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":23,"eap-relay-packet":"` + success + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}
	aka := &fakeAKAProvider{}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity:    Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: identity},
		AKAProvider: aka,
		Client:      client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 3 {
		t.Fatalf("requests=%d, want challenge response, terminal ack, websheet", len(client.requests))
	}
	challengeAnswer := decodeEntitlementAnswer(t, client.requests[1].Body)
	if _, ok := challengeAnswer["eap-relay-packet"]; !ok {
		t.Fatalf("challenge answer missing relay packet: %s", client.requests[1].Body)
	}
	terminalAnswer := decodeEntitlementAnswer(t, client.requests[2].Body)
	if _, ok := terminalAnswer["eap-relay-packet"]; ok {
		t.Fatalf("terminal EAP-Success must not send relay response: %s", client.requests[2].Body)
	}
	if _, ok := terminalAnswer["aka-res"]; ok {
		t.Fatalf("terminal EAP-Success must not send AKA material: %s", client.requests[2].Body)
	}
	if terminalAnswer["response-id"].(float64) != 23 {
		t.Fatalf("terminal answer=%+v", terminalAnswer)
	}
	if aka.calls != 1 {
		t.Fatalf("AKA calls=%d, want only challenge to use SIM", aka.calls)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayReauthentication(t *testing.T) {
	fullIdentity := "310280000000001@private.att.net"
	reauthIdentity := "reauth-e911"
	akaResult := e911AKAResult()
	keys, err := eapaka.DeriveKeys(fullIdentity, akaResult)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	nonceS := []byte("0123456789abcdef")
	reauth := signedEAPRelayReauthenticationRequest(t, eapaka.TypeAKA, keys, 3, nonceS, []eapaka.Attribute{
		eapaka.NextPseudonymAttribute("pseudo-next"),
		eapaka.NextReauthIDAttribute("reauth-next"),
	}, nil)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":20,"eap-relay-packet":"` + reauth + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity: Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: fullIdentity},
		EAPReauthentication: swu.EAPReauthenticationState{
			Identity:  reauthIdentity,
			Counter:   2,
			CounterOK: true,
			Keys:      keys,
		},
		Client: client,
		Random: bytes.NewReader(bytes.Repeat([]byte{0x88}, 32)),
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests=%d, want reauthentication response", len(client.requests))
	}
	answer := decodeEntitlementAnswer(t, client.requests[1].Body)
	if _, ok := answer["aka-res"]; ok {
		t.Fatalf("reauth answer must not include AKA RES: %s", client.requests[1].Body)
	}
	packet := decodeRelayPacket(t, answer)
	if packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeReauthentication {
		t.Fatalf("reauth relay response=%+v", packet)
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(response) error = %v", err)
	}
	if err := eapaka.VerifyMAC(keys.KAut, raw, nonceS); err != nil {
		t.Fatalf("VerifyMAC(response) error = %v", err)
	}
	attrs := decryptedEAPRelayReauthenticationResponseAttrs(t, keys, packet)
	counterAttr, ok := eapaka.FindAttribute(attrs, eapaka.AttributeCounter)
	if !ok {
		t.Fatalf("reauth response missing AT_COUNTER: %+v", attrs)
	}
	counter, err := counterAttr.CounterValue()
	if err != nil {
		t.Fatalf("CounterValue() error = %v", err)
	}
	if counter != 3 {
		t.Fatalf("counter=%d", counter)
	}
	if _, ok := eapaka.FindAttribute(attrs, eapaka.AttributeCounterTooSmall); ok {
		t.Fatalf("normal reauth response included AT_COUNTER_TOO_SMALL: %+v", attrs)
	}
	expectedKeys, err := eapaka.DeriveReauthenticationKeys(reauthIdentity, keys, 3, nonceS)
	if err != nil {
		t.Fatalf("DeriveReauthenticationKeys() error = %v", err)
	}
	state := ws.EAPReauthentication
	if state.Identity != "reauth-next" || state.NextPseudonym != "pseudo-next" || state.Counter != 3 || !state.CounterOK || !state.Reauthenticated || state.CounterTooSmall {
		t.Fatalf("reauth state=%+v", state)
	}
	if state.LastAcceptedCounter != 3 || state.LastRejectedCounter != 0 {
		t.Fatalf("reauth counters accepted=%d rejected=%d", state.LastAcceptedCounter, state.LastRejectedCounter)
	}
	if !bytes.Equal(state.Keys.MSK, expectedKeys.MSK) || !bytes.Equal(state.Keys.EMSK, expectedKeys.EMSK) {
		t.Fatalf("reauth keys=%+v, want derived keys", state.Keys)
	}
	if ws.EAPNextReauthID != "reauth-next" || ws.EAPNextPseudonym != "pseudo-next" {
		t.Fatalf("websheet EAP aliases reauth=%q pseudonym=%q", ws.EAPNextReauthID, ws.EAPNextPseudonym)
	}
}

func TestStartEmergencyAddressUpdateHandlesEAPRelayReauthenticationCounterTooSmall(t *testing.T) {
	fullIdentity := "310280000000001@private.att.net"
	reauthIdentity := "reauth-e911"
	akaResult := e911AKAResult()
	keys, err := eapaka.DeriveKeys(fullIdentity, akaResult)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	nonceS := []byte("0123456789abcdef")
	reauth := signedEAPRelayReauthenticationRequest(t, eapaka.TypeAKA, keys, 2, nonceS, nil, nil)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":21,"eap-relay-packet":"` + reauth + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity: Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280", SIPUsername: fullIdentity},
		EAPReauthentication: swu.EAPReauthenticationState{
			Identity:  reauthIdentity,
			Counter:   5,
			CounterOK: true,
			Keys:      keys,
		},
		Client: client,
		Random: bytes.NewReader(bytes.Repeat([]byte{0x99}, 32)),
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	answer := decodeEntitlementAnswer(t, client.requests[1].Body)
	packet := decodeRelayPacket(t, answer)
	if packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeReauthentication {
		t.Fatalf("counter-too-small relay response=%+v", packet)
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(response) error = %v", err)
	}
	if err := eapaka.VerifyMAC(keys.KAut, raw, nonceS); err != nil {
		t.Fatalf("VerifyMAC(response) error = %v", err)
	}
	attrs := decryptedEAPRelayReauthenticationResponseAttrs(t, keys, packet)
	if tooSmall, ok := eapaka.FindAttribute(attrs, eapaka.AttributeCounterTooSmall); !ok {
		t.Fatalf("missing AT_COUNTER_TOO_SMALL in attrs=%+v", attrs)
	} else if err := tooSmall.CounterTooSmallValue(); err != nil {
		t.Fatalf("CounterTooSmallValue() error = %v", err)
	}
	state := ws.EAPReauthentication
	if state.Identity != reauthIdentity || state.Counter != 5 || !state.CounterOK || state.Reauthenticated || !state.CounterTooSmall || state.LastRejectedCounter != 2 {
		t.Fatalf("counter-too-small state=%+v", state)
	}
	if !bytes.Equal(state.Keys.MSK, keys.MSK) || !bytes.Equal(state.Keys.EMSK, keys.EMSK) {
		t.Fatal("counter-too-small response must preserve previous reauth keys")
	}
}

func TestStartEmergencyAddressUpdateSendsClientErrorForUnsupportedEAPRelaySubtype(t *testing.T) {
	unsupported := eapRelayUnsupportedRequest(t)
	client := &fakeHTTPClient{responses: []*HTTPResponse{
		{StatusCode: 200, Body: []byte(`{"status":6004,"response-id":17,"eap-relay-packet":"` + unsupported + `"}`)},
		{StatusCode: 200, Body: []byte(`{"status":1000,"websheet-url":"https://example.test/address?ok=1"}`)},
	}}

	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Identity: Identity{IMSI: "310280000000001", IMEI: "490154203237518", MCC: "310", MNC: "280"},
		Client:   client,
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/address?ok=1" {
		t.Fatalf("URL=%q", ws.URL)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests=%d, want client-error response", len(client.requests))
	}
	answer := decodeEntitlementAnswer(t, client.requests[1].Body)
	if _, ok := answer["aka-res"]; ok {
		t.Fatalf("client-error answer must not include AKA RES: %s", client.requests[1].Body)
	}
	packet := decodeRelayPacket(t, answer)
	if packet.Code != eapaka.CodeResponse || packet.Subtype != eapaka.SubtypeClientError {
		t.Fatalf("client-error relay response=%+v", packet)
	}
	attr, ok := eapaka.FindAttribute(packet.Attributes, eapaka.AttributeClientErrorCode)
	if !ok {
		t.Fatalf("client-error relay response missing AT_CLIENT_ERROR_CODE: %+v", packet)
	}
	code, err := attr.ClientErrorCodeValue()
	if err != nil {
		t.Fatalf("ClientErrorCodeValue() error = %v", err)
	}
	if code != eapaka.ClientErrorUnableToProcessPacket {
		t.Fatalf("client error code=%d", code)
	}
}

func TestStartEmergencyAddressUpdateReportsIncompleteChallenge(t *testing.T) {
	client := &fakeHTTPClient{responses: []*HTTPResponse{{
		StatusCode: 200,
		Body:       []byte(`[{"status":6004,"response-id":3}]`),
	}}}
	_, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{
				Provider:            "att-ts43",
				Websheet:            "https://example.test/websheet",
				EntitlementEndpoint: "https://example.test/entitlement",
			},
		},
		Client: client,
	})
	if !errors.Is(err, ErrChallengeNotImplemented) {
		t.Fatalf("err=%v, want ErrChallengeNotImplemented", err)
	}
}

func TestStartEmergencyAddressUpdateFallsBackToConfiguredWebsheet(t *testing.T) {
	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{Provider: "att-ts43", Websheet: "https://example.test/static"},
		},
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.URL != "https://example.test/static" {
		t.Fatalf("URL=%q", ws.URL)
	}
}

func TestStartEmergencyAddressUpdateFallsBackWithCachedToken(t *testing.T) {
	ws, err := StartEmergencyAddressUpdate(context.Background(), Request{
		Carrier: carrier.EffectiveCarrierConfig{
			E911: carrier.E911Config{Provider: "att-ts43", Websheet: "https://example.test/static?existing=1"},
		},
		Identity: Identity{CachedToken: "cached-token-abc"},
	})
	if err != nil {
		t.Fatalf("StartEmergencyAddressUpdate() error = %v", err)
	}
	if ws.UserData != "cached-token-abc" || !strings.Contains(ws.URL, "existing=1") || !strings.Contains(ws.URL, "token=cached-token-abc") {
		t.Fatalf("websheet=%+v", ws)
	}
}

func headerValue(headers []HeaderPair, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Key, name) {
			return header.Value
		}
	}
	return ""
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func bytesFrom(start byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i)
	}
	return out
}

func e911AKAResult() sim.AKAResult {
	return sim.AKAResult{
		RES: []byte{0x11, 0x22, 0x33, 0x44},
		CK:  bytesFrom(0xA0, 16),
		IK:  bytesFrom(0xB0, 16),
	}
}

func eapRelayIdentityRequest(t *testing.T) string {
	t.Helper()
	encoded, _ := eapRelayIdentityRequestRaw(t)
	return encoded
}

func eapRelayIdentityRequestRaw(t *testing.T) (string, []byte) {
	t.Helper()
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 6,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeIdentity,
		Attributes: []eapaka.Attribute{eapaka.AnyIDReqAttribute()},
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw), raw
}

func eapRelayNotificationRequest(t *testing.T, code uint16) string {
	t.Helper()
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 10,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeNotification,
		Attributes: []eapaka.Attribute{eapaka.NotificationAttribute(code)},
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func eapRelayTerminalPacket(t *testing.T, code uint8, identifier uint8) string {
	t.Helper()
	raw, err := (eapaka.Packet{Code: code, Identifier: identifier}).MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary(terminal EAP) error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func signedEAPRelayChallenge(t *testing.T, identity string, aka sim.AKAResult) string {
	t.Helper()
	keys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 7,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: []eapaka.Attribute{
			eapaka.RANDAttribute(bytesFrom(0x10, 16)),
			eapaka.AUTNAttribute(bytesFrom(0x40, 16)),
			eapaka.MACAttribute(nil),
		},
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	packet.Attributes[len(packet.Attributes)-1] = eapaka.MACAttribute(mac)
	raw, err = packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func signedEAPRelayChallengeWithEncryptedAttrs(t *testing.T, identity string, aka sim.AKAResult, attrs ...eapaka.Attribute) string {
	t.Helper()
	keys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	challengeAttrs := []eapaka.Attribute{
		eapaka.RANDAttribute(bytesFrom(0x10, 16)),
		eapaka.AUTNAttribute(bytesFrom(0x40, 16)),
	}
	challengeAttrs = append(challengeAttrs, attrs...)
	challengeAttrs = append(challengeAttrs, eapaka.MACAttribute(nil))
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 7,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: challengeAttrs,
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	packet.Attributes[len(packet.Attributes)-1] = eapaka.MACAttribute(mac)
	raw, err = packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func signedEAPRelayChallengeWithCheckcode(t *testing.T, identity string, aka sim.AKAResult, transcript [][]byte) string {
	t.Helper()
	keys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 7,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: []eapaka.Attribute{
			eapaka.RANDAttribute(bytesFrom(0x10, 16)),
			eapaka.AUTNAttribute(bytesFrom(0x40, 16)),
			eapaka.CheckcodeAttributeForPackets(transcript),
			eapaka.MACAttribute(nil),
		},
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	packet.Attributes[len(packet.Attributes)-1] = eapaka.MACAttribute(mac)
	raw, err = packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func signedEAPRelayNotification(t *testing.T, identity string, aka sim.AKAResult, code uint16) string {
	t.Helper()
	keys, err := eapaka.DeriveKeys(identity, aka)
	if err != nil {
		t.Fatalf("DeriveKeys() error = %v", err)
	}
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 11,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeNotification,
		Attributes: []eapaka.Attribute{
			eapaka.NotificationAttribute(code),
			eapaka.MACAttribute(nil),
		},
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	packet.Attributes[len(packet.Attributes)-1] = eapaka.MACAttribute(mac)
	raw, err = packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func signedEAPRelayReauthenticationRequest(t *testing.T, eapType uint8, keys eapaka.Keys, counter uint16, nonceS []byte, encryptedExtra, topLevelExtra []eapaka.Attribute) string {
	t.Helper()
	iv := bytes.Repeat([]byte{0x56}, 16)
	encryptedAttrs := []eapaka.Attribute{
		eapaka.CounterAttribute(counter),
		eapaka.NonceSAttribute(nonceS),
	}
	encryptedAttrs = append(encryptedAttrs, encryptedExtra...)
	encrypted, err := eapaka.EncryptAttributes(keys.KEncr, iv, encryptedAttrs)
	if err != nil {
		t.Fatalf("EncryptAttributes() error = %v", err)
	}
	attrs := []eapaka.Attribute{
		eapaka.IVAttribute(iv),
		encrypted,
	}
	attrs = append(attrs, topLevelExtra...)
	attrs = append(attrs, eapaka.MACAttribute(nil))
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 13,
		Type:       eapType,
		Subtype:    eapaka.SubtypeReauthentication,
		Attributes: attrs,
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	var mac []byte
	if eapType == eapaka.TypeAKAPrime {
		mac, err = eapaka.CalculateAKAPrimeMAC(keys.KAut, raw, nil)
	} else {
		mac, err = eapaka.CalculateMAC(keys.KAut, raw, nil)
	}
	if err != nil {
		t.Fatalf("CalculateMAC() error = %v", err)
	}
	packet.Attributes[len(packet.Attributes)-1] = eapaka.MACAttribute(mac)
	raw, err = packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func eapRelayUnsupportedRequest(t *testing.T) string {
	t.Helper()
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 12,
		Type:       eapaka.TypeAKA,
		Subtype:    eapaka.SubtypeReauthentication,
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func eapRelayAKAPrimeKDFOffer(t *testing.T, networkName string, kdfs []uint16) string {
	t.Helper()
	attrs := []eapaka.Attribute{
		eapaka.RANDAttribute(bytesFrom(0x10, 16)),
		eapaka.AUTNAttribute(bytesFrom(0x40, 16)),
		eapaka.KDFInputAttribute(networkName),
	}
	for _, kdf := range kdfs {
		attrs = append(attrs, eapaka.KDFAttribute(kdf))
	}
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 8,
		Type:       eapaka.TypeAKAPrime,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: attrs,
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func signedEAPRelayAKAPrimeChallenge(t *testing.T, identity, networkName string, aka sim.AKAResult, kdfs []uint16) string {
	t.Helper()
	autn := bytesFrom(0x40, 16)
	keys, err := eapaka.DeriveAKAPrimeKeys(identity, networkName, autn, aka)
	if err != nil {
		t.Fatalf("DeriveAKAPrimeKeys() error = %v", err)
	}
	attrs := []eapaka.Attribute{
		eapaka.RANDAttribute(bytesFrom(0x10, 16)),
		eapaka.AUTNAttribute(autn),
		eapaka.KDFInputAttribute(networkName),
	}
	for _, kdf := range kdfs {
		attrs = append(attrs, eapaka.KDFAttribute(kdf))
	}
	attrs = append(attrs, eapaka.MACAttribute(nil))
	packet := eapaka.Packet{
		Code:       eapaka.CodeRequest,
		Identifier: 9,
		Type:       eapaka.TypeAKAPrime,
		Subtype:    eapaka.SubtypeChallenge,
		Attributes: attrs,
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	mac, err := eapaka.CalculateAKAPrimeMAC(keys.KAut, raw, nil)
	if err != nil {
		t.Fatalf("CalculateAKAPrimeMAC() error = %v", err)
	}
	packet.Attributes[len(packet.Attributes)-1] = eapaka.MACAttribute(mac)
	raw, err = packet.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary() error = %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func decodeEntitlementAnswer(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var payload []map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("answer JSON error = %v body=%s", err, body)
	}
	if len(payload) != 1 {
		t.Fatalf("payload=%+v", payload)
	}
	return payload[0]
}

func decodeRelayPacket(t *testing.T, payload map[string]any) eapaka.Packet {
	t.Helper()
	relay, _ := payload["eap-relay-packet"].(string)
	raw, err := base64.StdEncoding.DecodeString(relay)
	if err != nil {
		t.Fatalf("relay response base64 error = %v", err)
	}
	packet, err := eapaka.ParsePacket(raw)
	if err != nil {
		t.Fatalf("relay response parse error = %v", err)
	}
	return packet
}

func relayIdentityValue(t *testing.T, payload map[string]any) string {
	t.Helper()
	packet := decodeRelayPacket(t, payload)
	attr, ok := eapaka.FindAttribute(packet.Attributes, eapaka.AttributeIdentity)
	if !ok {
		t.Fatalf("relay response missing AT_IDENTITY: %+v", packet)
	}
	identity, err := attr.IdentityValue()
	if err != nil {
		t.Fatalf("IdentityValue() error = %v", err)
	}
	return identity
}

func decryptedEAPRelayReauthenticationResponseAttrs(t *testing.T, keys eapaka.Keys, packet eapaka.Packet) []eapaka.Attribute {
	t.Helper()
	ivAttr, ok := eapaka.FindAttribute(packet.Attributes, eapaka.AttributeIV)
	if !ok {
		t.Fatal("missing AT_IV")
	}
	encryptedAttr, ok := eapaka.FindAttribute(packet.Attributes, eapaka.AttributeEncrData)
	if !ok {
		t.Fatal("missing AT_ENCR_DATA")
	}
	attrs, err := eapaka.DecryptEncryptedAttributes(keys.KEncr, ivAttr, encryptedAttr)
	if err != nil {
		t.Fatalf("DecryptEncryptedAttributes() error = %v", err)
	}
	return attrs
}
