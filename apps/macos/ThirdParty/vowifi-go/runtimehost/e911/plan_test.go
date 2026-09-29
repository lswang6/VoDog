package e911

import (
	"strings"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

func TestClassifyEmergencyNumberRecognizesDialStrings(t *testing.T) {
	for _, tc := range []struct {
		name      string
		value     string
		emergency bool
		canonical string
	}{
		{name: "911", value: "911", emergency: true, canonical: "911"},
		{name: "formatted 911", value: " 9-1-1 ", emergency: true, canonical: "911"},
		{name: "tel 112", value: "tel:112;phone-context=+1", emergency: true, canonical: "112"},
		{name: "sip 911", value: "sip:911@example.test;user=phone", emergency: true, canonical: "911"},
		{name: "display tel 112", value: `"Emergency" <tel:112;phone-context=+1>`, emergency: true, canonical: "112"},
		{name: "prefixed 911", value: "1911"},
		{name: "plus 911", value: "+911"},
		{name: "directory", value: "411"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyEmergencyNumber(tc.value)
			if got.Emergency != tc.emergency || got.CanonicalNumber != tc.canonical {
				t.Fatalf("ClassifyEmergencyNumber(%q)=%+v, want emergency=%v canonical=%q", tc.value, got, tc.emergency, tc.canonical)
			}
			if IsEmergencyNumber(tc.value) != tc.emergency {
				t.Fatalf("IsEmergencyNumber(%q)=%v, want %v", tc.value, IsEmergencyNumber(tc.value), tc.emergency)
			}
			if tc.emergency && EmergencyServiceURNForNumber(tc.value) != DefaultEmergencyServiceURN {
				t.Fatalf("EmergencyServiceURNForNumber(%q)=%q", tc.value, EmergencyServiceURNForNumber(tc.value))
			}
		})
	}
}

func TestBuildEmergencyPlanUsesUsableEntitlementForRegistrationAndCall(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{RefreshBefore: time.Minute})
	cache.Store(EntitlementInfo{
		Status:      1000,
		UserData:    "token-1",
		ServiceURNs: []string{"sos"},
		Routes: []EmergencyRoute{
			{ServiceURN: "sos", PCSCF: []string{"pcscf-emergency.ims.example"}},
			{Endpoints: []string{"sips:ecscf.example"}},
		},
		Address: EmergencyAddress{
			Latitude:  "47.6205",
			Longitude: "-122.3493",
		},
		CacheMaxAge:              10 * time.Minute,
		LocationValidationStatus: "validated",
	}, base)

	plan, err := BuildEmergencyPlan(EmergencyPlanConfig{
		DialString: "911",
		Cache:      cache,
		Now:        base.Add(time.Minute),
		SIPHeaderConfig: EmergencySIPHeaderConfig{
			AccessNetworkInfo:  EmergencyAccessNetworkInfo{WLANNodeID: "aa:bb:cc:dd:ee:ff"},
			GeolocationRouting: true,
		},
		Profile: voiceclient.IMSProfile{
			IMPI:      "001010123456789@ims.example",
			IMPU:      "sip:001010123456789@ims.example",
			Domain:    "ims.example",
			UserAgent: "vowifi-go-test",
		},
		ContactURI:     "sip:001010123456789@192.0.2.10:5060",
		RegisterCallID: "emergency-register-1",
		RegisterCSeq:   "1",
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPlan() error = %v", err)
	}
	if !plan.Emergency || !plan.Number.Emergency || plan.Number.CanonicalNumber != "911" || plan.ServiceURN != DefaultEmergencyServiceURN {
		t.Fatalf("target plan=%+v number=%+v", plan, plan.Number)
	}
	if plan.Entitlement.Decision.Action != EntitlementCacheActionUseCache ||
		!plan.Entitlement.CanUseCache || plan.Entitlement.RefreshNow || !plan.Entitlement.UseCache {
		t.Fatalf("entitlement plan=%+v", plan.Entitlement)
	}
	if plan.RequestURI != DefaultEmergencyServiceURN || plan.Call.RequestURI != DefaultEmergencyServiceURN {
		t.Fatalf("request URIs plan=%q call=%q", plan.RequestURI, plan.Call.RequestURI)
	}
	if got := plan.Headers["P-Access-Network-Info"]; got != `IEEE-802.11;i-wlan-node-id="aa:bb:cc:dd:ee:ff"` {
		t.Fatalf("P-Access-Network-Info=%q", got)
	}
	if plan.Profile.AccessNetworkInfo != plan.Headers["P-Access-Network-Info"] {
		t.Fatalf("profile AccessNetworkInfo=%q headers=%q", plan.Profile.AccessNetworkInfo, plan.Headers["P-Access-Network-Info"])
	}
	if plan.Headers["Geolocation"] != "<geo:47.6205,-122.3493>;inserted-by=endpoint" ||
		plan.Location.GeolocationURI != "geo:47.6205,-122.3493" ||
		!plan.Location.GeolocationRouting {
		t.Fatalf("location=%+v headers=%+v", plan.Location, plan.Headers)
	}
	if plan.Location.Source != EmergencyLocationSourceEntitlement ||
		!plan.Location.HasLocation ||
		plan.Location.ValidationStatus != "validated" {
		t.Fatalf("location metadata=%+v", plan.Location)
	}
	if plan.Location.Revalidation.Required {
		t.Fatalf("fresh validated location should not require revalidation: %+v", plan.Location.Revalidation)
	}
	if !sameStrings(plan.RouteSet, []string{"<sip:pcscf-emergency.ims.example;lr>", "<sips:ecscf.example;lr>"}) {
		t.Fatalf("RouteSet=%+v", plan.RouteSet)
	}
	if !plan.Registration.Required || plan.Registration.AlreadyRegistered {
		t.Fatalf("registration state=%+v", plan.Registration)
	}
	if plan.Registration.ContactURI != "sip:001010123456789@192.0.2.10:5060;sos" {
		t.Fatalf("registration ContactURI=%q", plan.Registration.ContactURI)
	}
	if contact := plan.Registration.Headers["Contact"]; !strings.Contains(contact, `sip:001010123456789@192.0.2.10:5060;sos`) ||
		!strings.Contains(contact, `+sip.instance=`) {
		t.Fatalf("registration Contact=%q", contact)
	}
}

func TestBuildEmergencyPlanKeepsRefreshWindowUsableAndBuildsPIDFLO(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{RefreshBefore: 2 * time.Minute})
	cache.Store(EntitlementInfo{
		Status:      1000,
		ServiceURNs: []string{"ambulance", "fire"},
		Routes: []EmergencyRoute{
			{ServiceURN: "ambulance", PCSCF: []string{"pcscf-ambulance.ims.example"}},
			{Endpoints: []string{"sips:any@example.test"}},
		},
		Address: EmergencyAddress{
			Latitude:  "40.7128",
			Longitude: "-74.0060",
		},
		CacheMaxAge: 5 * time.Minute,
	}, base)

	plan, err := BuildEmergencyPlan(EmergencyPlanConfig{
		DialString: "tel:112;phone-context=+1",
		Cache:      cache,
		Now:        base.Add(4 * time.Minute),
		SIPHeaderConfig: EmergencySIPHeaderConfig{
			ServiceURN:         "ambulance",
			AccessNetworkInfo:  EmergencyAccessNetworkInfo{Raw: "IEEE-802.11"},
			GeolocationRouting: true,
			PIDFLOContentID:    "location-inline",
		},
		IncludePIDFLO: true,
		PIDFLOConfig: EmergencyPIDFLOConfig{
			Entity: "pres:device@example.test",
		},
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPlan() error = %v", err)
	}
	if !plan.Emergency || plan.Number.CanonicalNumber != "112" || plan.ServiceURN != "urn:service:sos.ambulance" {
		t.Fatalf("target plan=%+v number=%+v", plan, plan.Number)
	}
	if plan.Entitlement.Decision.Action != EntitlementCacheActionRefresh ||
		!plan.Entitlement.RefreshNow || !plan.Entitlement.CanUseCache || !plan.Entitlement.UseCache ||
		plan.Entitlement.RefreshReason != EntitlementRefreshReasonRefreshWindow {
		t.Fatalf("refresh-window entitlement=%+v", plan.Entitlement)
	}
	if plan.RequestURI != "urn:service:sos.ambulance" {
		t.Fatalf("RequestURI=%q", plan.RequestURI)
	}
	if plan.Headers["Geolocation"] != "<cid:location-inline>;inserted-by=endpoint" ||
		plan.Location.PIDFLOContentID != "location-inline" ||
		plan.Location.PIDFLOContentType != EmergencyPIDFLOContentType ||
		!plan.Location.PIDFLOPresent {
		t.Fatalf("PIDF-LO location=%+v headers=%+v", plan.Location, plan.Headers)
	}
	if !plan.Call.Body.PIDFLOPresent ||
		plan.Call.Body.PIDFLOContentID != "location-inline" ||
		plan.Call.Body.PIDFLOContentType != EmergencyPIDFLOContentType {
		t.Fatalf("call body metadata=%+v", plan.Call.Body)
	}
	body := string(plan.Location.PIDFLOBody)
	if !strings.Contains(body, "<gml:pos>40.7128 -74.0060</gml:pos>") ||
		!strings.Contains(body, "<timestamp>2026-07-07T09:04:00Z</timestamp>") {
		t.Fatalf("PIDF-LO body=%s", body)
	}
	if string(plan.Call.Body.PIDFLOBody) != body {
		t.Fatalf("call body PIDF-LO=%s, want location body", string(plan.Call.Body.PIDFLOBody))
	}
	if !sameStrings(plan.RouteSet, []string{"<sip:pcscf-ambulance.ims.example;lr>", "<sips:any@example.test;lr>"}) {
		t.Fatalf("RouteSet=%+v", plan.RouteSet)
	}
}

func TestPlanEmergencyCallSurfacesNoCacheRefreshAndNonEmergency(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	plan, err := PlanEmergencyCall("112", EntitlementSnapshot{}, EmergencySIPHeaderConfig{}, base)
	if err != nil {
		t.Fatalf("PlanEmergencyCall() error = %v", err)
	}
	if !plan.Emergency || plan.RequestURI != DefaultEmergencyServiceURN {
		t.Fatalf("emergency plan=%+v", plan)
	}
	if plan.Entitlement.Decision.Action != EntitlementCacheActionRefresh ||
		!plan.Entitlement.RefreshNow ||
		plan.Entitlement.RefreshReason != EntitlementRefreshReasonNoCache ||
		plan.Entitlement.CanUseCache {
		t.Fatalf("no-cache entitlement=%+v", plan.Entitlement)
	}
	if plan.Headers["P-Access-Network-Info"] != "IEEE-802.11" {
		t.Fatalf("P-Access-Network-Info=%q", plan.Headers["P-Access-Network-Info"])
	}
	if plan.Location.HasLocation {
		t.Fatalf("no-cache plan should not invent location: %+v", plan.Location)
	}
	if !plan.Location.Revalidation.Required ||
		!plan.Location.Revalidation.Missing ||
		plan.Location.Revalidation.Reason != EmergencyLocationRevalidationReasonMissing ||
		!plan.Location.Revalidation.EntitlementRefreshNeeded ||
		!plan.Location.Revalidation.Retryable ||
		plan.Location.Revalidation.RetryDeferred {
		t.Fatalf("missing location revalidation=%+v", plan.Location.Revalidation)
	}

	nonEmergency, err := PlanEmergencyCall("411", EntitlementSnapshot{}, EmergencySIPHeaderConfig{}, base)
	if err != nil {
		t.Fatalf("PlanEmergencyCall(non-emergency) error = %v", err)
	}
	if nonEmergency.Emergency || nonEmergency.Entitlement.RefreshRequired || nonEmergency.RequestURI != "" {
		t.Fatalf("non-emergency plan=%+v", nonEmergency)
	}
}

func TestBuildEmergencyPlanFlagsExpiredEntitlementLocationForRevalidation(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{})
	cache.Store(EntitlementInfo{
		Status:       1000,
		UserData:     "token-1",
		ServiceURNs:  []string{"fire"},
		CacheMaxAge:  time.Minute,
		RetryAfterIn: 3 * time.Minute,
		StaleIfError: 5 * time.Minute,
		Address: EmergencyAddress{
			Latitude:  "47.6205",
			Longitude: "-122.3493",
		},
		LocationValidationStatus: "validated",
	}, base)

	plan, err := BuildEmergencyPlan(EmergencyPlanConfig{
		DialString: "911",
		Cache:      cache,
		Now:        base.Add(2 * time.Minute),
		SIPHeaderConfig: EmergencySIPHeaderConfig{
			ServiceURN:         "service:fire",
			AccessNetworkInfo:  EmergencyAccessNetworkInfo{Raw: "IEEE-802.11"},
			GeolocationRouting: true,
		},
	})
	if err != nil {
		t.Fatalf("BuildEmergencyPlan() error = %v", err)
	}
	if plan.ServiceURN != "urn:service:sos.fire" || plan.RequestURI != "urn:service:sos.fire" {
		t.Fatalf("service target service=%q request=%q", plan.ServiceURN, plan.RequestURI)
	}
	if plan.Entitlement.Decision.Action != EntitlementCacheActionDeferRefresh ||
		!plan.Entitlement.RefreshDeferred ||
		plan.Entitlement.RefreshReason != EntitlementRefreshReasonExpired ||
		plan.Entitlement.RetryAfterDelay != time.Minute ||
		!plan.Entitlement.CanUseStaleOnError {
		t.Fatalf("expired entitlement=%+v", plan.Entitlement)
	}
	if plan.Location.Source != EmergencyLocationSourceEntitlement ||
		!plan.Location.HasLocation ||
		plan.Location.GeolocationHeader != "<geo:47.6205,-122.3493>;inserted-by=endpoint" {
		t.Fatalf("expired entitlement location=%+v", plan.Location)
	}
	revalidation := plan.Location.Revalidation
	if !revalidation.Required ||
		!revalidation.Expired ||
		revalidation.Missing ||
		revalidation.Reason != EmergencyLocationRevalidationReasonExpired ||
		!revalidation.EntitlementRefreshNeeded ||
		!revalidation.Retryable ||
		!revalidation.RetryDeferred ||
		!revalidation.CanUseStaleOnError {
		t.Fatalf("expired location revalidation=%+v", revalidation)
	}
	if got, want := revalidation.NextAttemptAt, base.Add(3*time.Minute); !got.Equal(want) {
		t.Fatalf("NextAttemptAt=%s, want %s", got, want)
	}
	if revalidation.RetryAfterDelay != time.Minute {
		t.Fatalf("RetryAfterDelay=%s, want 1m", revalidation.RetryAfterDelay)
	}
}

func TestPlanEmergencySIPRetryUsesAlternativeServiceAndContactRoute(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	current := EmergencyPlan{
		ServiceURN: DefaultEmergencyServiceURN,
		RequestURI: DefaultEmergencyServiceURN,
		RouteSet:   []string{"<sip:pcscf-old.example;lr>"},
		Headers: map[string]string{
			"Geolocation": "<geo:47.6205,-122.3493>;inserted-by=endpoint",
		},
	}
	retry := PlanEmergencySIPRetry(current, voiceclient.SIPResponse{
		StatusCode: 380,
		Reason:     "Alternative Service",
		Headers: map[string][]string{
			"Retry-After": {"7"},
			"Contact":     {`<urn:service:sos.ambulance>, <sip:ecscf-alt.example;lr>`},
		},
	}, now)

	if !retry.Retry ||
		retry.Action != EmergencySIPRetryActionAlternativeService ||
		!retry.AlternativeService ||
		!retry.RouteRefreshNeeded ||
		retry.AlternativeServiceURN != "urn:service:sos.ambulance" ||
		retry.AlternativeContactURI != "sip:ecscf-alt.example;lr" ||
		retry.NextServiceURN != "urn:service:sos.ambulance" ||
		retry.NextRequestURI != "urn:service:sos.ambulance" ||
		retry.RetryAfter != 7*time.Second ||
		!retry.NextAttemptAt.Equal(now.Add(7*time.Second)) {
		t.Fatalf("alternative retry=%+v", retry)
	}
	if !sameStrings(retry.NextRouteSet, []string{"<sip:ecscf-alt.example;lr>"}) {
		t.Fatalf("NextRouteSet=%+v", retry.NextRouteSet)
	}
	if retry.NextHeaders["Geolocation"] != current.Headers["Geolocation"] {
		t.Fatalf("NextHeaders=%+v", retry.NextHeaders)
	}
}

func TestPlanEmergencySIPRetryRefreshesLocationOnBadLocation(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 1, 0, 0, time.UTC)
	current := EmergencyPlan{
		ServiceURN: "urn:service:sos.fire",
		RequestURI: "urn:service:sos.fire",
		RouteSet:   []string{"<sip:pcscf-fire.example;lr>"},
		Headers: map[string]string{
			"Geolocation": "<cid:location-inline>;inserted-by=endpoint",
		},
		Call: EmergencyCallPlan{
			RequestURI: "urn:service:sos.fire",
			RouteSet:   []string{"<sip:pcscf-fire.example;lr>"},
		},
	}
	retry := PlanEmergencySIPRetry(current, voiceclient.SIPResponse{
		StatusCode: 424,
		Reason:     "Bad Location Information",
		Headers: map[string][]string{
			"Retry-After": {"3"},
			"Warning":     {`399 ims.example "PIDF-LO rejected"`},
		},
	}, now)

	if !retry.Retry ||
		retry.Action != EmergencySIPRetryActionRefreshLocation ||
		!retry.LocationRefreshNeeded ||
		!retry.EntitlementRefreshNeeded ||
		!retry.RebuildEmergencyPlan ||
		!retry.RebuildPIDFLO ||
		retry.NextServiceURN != "urn:service:sos.fire" ||
		retry.NextRequestURI != "urn:service:sos.fire" ||
		retry.RetryAfter != 3*time.Second ||
		!retry.NextAttemptAt.Equal(now.Add(3*time.Second)) {
		t.Fatalf("location retry=%+v", retry)
	}
	if !sameStrings(retry.NextRouteSet, []string{"<sip:pcscf-fire.example;lr>"}) {
		t.Fatalf("NextRouteSet=%+v", retry.NextRouteSet)
	}
}

func TestPrepareEmergencyRevalidationInputsRefreshesLocationOnBadLocation(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 3, 0, 0, time.UTC)
	current := EmergencyPlan{
		Emergency:  true,
		ServiceURN: "urn:service:sos.fire",
		RequestURI: "urn:service:sos.fire",
		RouteSet:   []string{"<sip:pcscf-fire.example;lr>"},
		Headers: map[string]string{
			"Geolocation": "<cid:location-inline>;inserted-by=endpoint",
		},
	}
	inputs := PrepareEmergencyRevalidationInputs(current, voiceclient.SIPResponse{
		StatusCode: 424,
		Reason:     "Bad Location Information",
		Headers: map[string][]string{
			"Retry-After": {"3"},
			"Warning":     {`399 ims.example "PIDF-LO rejected"`},
		},
	}, now)

	if !inputs.Emergency ||
		!inputs.Required ||
		!inputs.Retry ||
		!inputs.EntitlementRefreshNeeded ||
		!inputs.LocationRefreshNeeded ||
		!inputs.RebuildEmergencyPlan ||
		!inputs.RebuildPIDFLO ||
		inputs.RouteRefreshNeeded ||
		inputs.AlternativeService ||
		inputs.RetryPlan.Action != EmergencySIPRetryActionRefreshLocation ||
		inputs.NextServiceURN != "urn:service:sos.fire" ||
		inputs.NextRequestURI != "urn:service:sos.fire" ||
		inputs.RetryAfter != 3*time.Second ||
		!inputs.NextAttemptAt.Equal(now.Add(3*time.Second)) {
		t.Fatalf("bad-location revalidation inputs=%+v", inputs)
	}
	if !sameStrings(inputs.NextRouteSet, []string{"<sip:pcscf-fire.example;lr>"}) {
		t.Fatalf("NextRouteSet=%+v", inputs.NextRouteSet)
	}
	if inputs.NextHeaders["Geolocation"] != current.Headers["Geolocation"] {
		t.Fatalf("NextHeaders=%+v", inputs.NextHeaders)
	}
}

func TestPrepareEmergencyRevalidationInputsUsesAlternativeServiceMetadata(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 4, 0, 0, time.UTC)
	current := EmergencyPlan{
		Emergency:  true,
		ServiceURN: DefaultEmergencyServiceURN,
		RequestURI: DefaultEmergencyServiceURN,
		RouteSet:   []string{"<sip:pcscf-old.example;lr>"},
	}
	inputs := PrepareEmergencyRevalidationInputs(current, voiceclient.SIPResponse{
		StatusCode: 380,
		Reason:     "Alternative Service",
		Headers: map[string][]string{
			"Contact": {`<urn:service:sos.ambulance>, <sip:ecscf-alt.example;lr>`},
		},
	}, now)

	if !inputs.Emergency ||
		!inputs.Required ||
		!inputs.Retry ||
		!inputs.RouteRefreshNeeded ||
		!inputs.AlternativeService ||
		inputs.EntitlementRefreshNeeded ||
		inputs.LocationRefreshNeeded ||
		inputs.RebuildPIDFLO ||
		inputs.RetryPlan.Action != EmergencySIPRetryActionAlternativeService ||
		inputs.AlternativeServiceURN != "urn:service:sos.ambulance" ||
		inputs.AlternativeContactURI != "sip:ecscf-alt.example;lr" ||
		inputs.NextServiceURN != "urn:service:sos.ambulance" ||
		inputs.NextRequestURI != "urn:service:sos.ambulance" {
		t.Fatalf("alternative revalidation inputs=%+v", inputs)
	}
	if !sameStrings(inputs.AlternativeServiceURNs, []string{"urn:service:sos.ambulance"}) {
		t.Fatalf("AlternativeServiceURNs=%+v", inputs.AlternativeServiceURNs)
	}
	if !sameStrings(inputs.ContactURIs, []string{"urn:service:sos.ambulance", "sip:ecscf-alt.example;lr"}) {
		t.Fatalf("ContactURIs=%+v", inputs.ContactURIs)
	}
	if !sameStrings(inputs.NextRouteSet, []string{"<sip:ecscf-alt.example;lr>"}) {
		t.Fatalf("NextRouteSet=%+v", inputs.NextRouteSet)
	}
}

func TestPrepareEmergencyRevalidationInputsNoRefreshForNonEmergency(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 5, 0, 0, time.UTC)
	current, err := PlanEmergencyCall("411", EntitlementSnapshot{}, EmergencySIPHeaderConfig{}, now)
	if err != nil {
		t.Fatalf("PlanEmergencyCall(non-emergency) error = %v", err)
	}
	inputs := PrepareEmergencyRevalidationInputs(current, voiceclient.SIPResponse{
		StatusCode: 424,
		Reason:     "Bad Location Information",
		Headers: map[string][]string{
			"Warning": {`399 ims.example "PIDF-LO rejected"`},
		},
	}, now)

	if inputs.Emergency ||
		inputs.Required ||
		inputs.Retry ||
		inputs.EntitlementRefreshNeeded ||
		inputs.LocationRefreshNeeded ||
		inputs.RouteRefreshNeeded ||
		inputs.RebuildEmergencyPlan ||
		inputs.RebuildPIDFLO ||
		inputs.AlternativeService ||
		inputs.NextServiceURN != "" ||
		inputs.NextRequestURI != "" ||
		len(inputs.NextRouteSet) != 0 ||
		len(inputs.NextHeaders) != 0 {
		t.Fatalf("non-emergency revalidation inputs=%+v", inputs)
	}
}

func TestPlanEmergencySIPRetryLeavesNonRetryableFailureTerminal(t *testing.T) {
	retry := PlanEmergencySIPRetry(EmergencyPlan{
		ServiceURN: DefaultEmergencyServiceURN,
		RequestURI: DefaultEmergencyServiceURN,
	}, voiceclient.SIPResponse{
		StatusCode: 403,
		Reason:     "Forbidden",
	}, time.Date(2026, 7, 7, 10, 2, 0, 0, time.UTC))

	if retry.Retry ||
		retry.Action != EmergencySIPRetryActionNone ||
		retry.NextRequestURI != DefaultEmergencyServiceURN ||
		retry.NextAttemptAt != (time.Time{}) ||
		retry.RegistrationRecoveryNeeded ||
		retry.LocationRefreshNeeded ||
		retry.RouteRefreshNeeded {
		t.Fatalf("non-retryable retry plan=%+v", retry)
	}
}
