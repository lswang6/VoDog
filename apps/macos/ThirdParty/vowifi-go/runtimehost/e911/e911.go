package e911

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/boa-z/vowifi-go/engine/sim"
	"github.com/boa-z/vowifi-go/engine/swu"
	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
	"github.com/boa-z/vowifi-go/runtimehost/carrier"
)

var (
	ErrUnsupportedProvider     = errors.New("unsupported e911 provider")
	ErrChallengeNotImplemented = errors.New("e911 challenge not implemented")
	ErrWebsheetUnavailable     = errors.New("e911 websheet unavailable")
)

const maxEntitlementChallengeResponses = 5

type HeaderPair struct {
	Key   string
	Value string
}

type HTTPRequest struct {
	Method  string
	URL     string
	Headers []HeaderPair
	Body    []byte
}

type HTTPResponse struct {
	StatusCode int
	Headers    []HeaderPair
	Body       []byte
}

type HTTPClient interface {
	Do(req *HTTPRequest) (*HTTPResponse, error)
}

type defaultHTTPClient struct {
	client *http.Client
}

func NewDefaultHTTPClient() HTTPClient {
	return defaultHTTPClient{client: http.DefaultClient}
}

func (c defaultHTTPClient) Do(req *HTTPRequest) (*HTTPResponse, error) {
	if req == nil {
		return nil, errors.New("nil request")
	}
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	hreq, err := http.NewRequest(method, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return nil, err
	}
	for _, h := range req.Headers {
		hreq.Header.Add(h.Key, h.Value)
	}
	client := c.client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(hreq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return &HTTPResponse{StatusCode: resp.StatusCode, Headers: responseHeaderPairs(resp.Header), Body: body}, nil
}

type Identity struct {
	IMSI        string
	IMEI        string
	MCC         string
	MNC         string
	SIPUsername string
	DisplayName string
	CachedToken string
}

type TraceSink interface {
	Request(*HTTPRequest)
	Response(*HTTPRequest, *HTTPResponse)
	Error(*HTTPRequest, error)
}

type Request struct {
	Carrier             carrier.EffectiveCarrierConfig
	Identity            Identity
	AKAProvider         sim.AKAProvider
	EAPReauthentication swu.EAPReauthenticationState
	Client              HTTPClient
	Trace               TraceSink
	Random              io.Reader
}

type WebsheetRequest struct {
	URL                 string
	UserData            string
	ContentType         string
	Title               string
	EAPNextPseudonym    string
	EAPNextReauthID     string
	EAPReauthentication swu.EAPReauthenticationState
}

type EmergencyAddress struct {
	Street              string
	Unit                string
	City                string
	State               string
	PostalCode          string
	Country             string
	Latitude            string
	Longitude           string
	Formatted           string
	HouseNumber         string
	HouseNumberSuffix   string
	County              string
	District            string
	Neighborhood        string
	Building            string
	Floor               string
	Room                string
	Name                string
	StreetDirection     string
	StreetPostDirection string
	StreetSuffix        string
	Landmark            string
	LocationDescription string
	PlaceType           string
	Premise             string
	PostOfficeBox       string
	AdditionalCode      string
	Seat                string
	RoadSection         string
	RoadBranch          string
	RoadSubBranch       string
	Fields              map[string]string
}

type EmergencyPDN struct {
	Name  string
	Type  string
	APN   string
	Realm string
}

type EmergencyRoute struct {
	ServiceURN string
	PCSCF      []string
	ESRP       []string
	Endpoints  []string
}

type EntitlementInfo struct {
	Status                   int
	ResponseID               string
	WebsheetURL              string
	Endpoint                 string
	UserData                 string
	ContentType              string
	Title                    string
	Address                  EmergencyAddress
	PDN                      EmergencyPDN
	ServiceURNs              []string
	Routes                   []EmergencyRoute
	ExpiresAt                time.Time
	ExpiresIn                time.Duration
	CacheExpiresAt           time.Time
	CacheMaxAge              time.Duration
	RetryAfter               time.Time
	RetryAfterIn             time.Duration
	StaleIfError             time.Duration
	LocationValidationStatus string
}

func (i EntitlementInfo) EffectiveExpiresAt(base time.Time) time.Time {
	if !i.ExpiresAt.IsZero() {
		return i.ExpiresAt
	}
	if i.ExpiresIn > 0 && !base.IsZero() {
		return base.Add(i.ExpiresIn)
	}
	return time.Time{}
}

func (i EntitlementInfo) EffectiveCacheExpiresAt(base time.Time) time.Time {
	if !i.CacheExpiresAt.IsZero() {
		return i.CacheExpiresAt
	}
	if i.CacheMaxAge > 0 && !base.IsZero() {
		return base.Add(i.CacheMaxAge)
	}
	return time.Time{}
}

func (i EntitlementInfo) EffectiveRetryAfter(base time.Time) time.Time {
	if !i.RetryAfter.IsZero() {
		return i.RetryAfter
	}
	if i.RetryAfterIn > 0 && !base.IsZero() {
		return base.Add(i.RetryAfterIn)
	}
	return time.Time{}
}

func ParseEntitlementResponse(body []byte) (EntitlementInfo, error) {
	result, err := parseEntitlementResponse(body)
	if err != nil {
		return EntitlementInfo{}, err
	}
	return entitlementInfoFromResult(result), nil
}

func StartEmergencyAddressUpdate(ctx context.Context, req Request) (WebsheetRequest, error) {
	provider := strings.ToLower(strings.TrimSpace(req.Carrier.E911.Provider))
	if provider == "" {
		return WebsheetRequest{}, ErrUnsupportedProvider
	}
	if provider != "att" && provider != "att-ts43" && provider != "ts43" {
		return WebsheetRequest{}, ErrUnsupportedProvider
	}
	if req.Carrier.E911.Websheet == "" {
		return WebsheetRequest{}, ErrWebsheetUnavailable
	}
	if endpoint := strings.TrimSpace(req.Carrier.E911.EntitlementEndpoint); endpoint != "" {
		ws, err := startTS43EmergencyAddressUpdate(ctx, endpoint, req)
		if err == nil && strings.TrimSpace(ws.URL) != "" {
			return ws, nil
		}
		if errors.Is(err, ErrChallengeNotImplemented) {
			return WebsheetRequest{}, err
		}
	}
	return fallbackWebsheetRequest(req), nil
}

func startTS43EmergencyAddressUpdate(ctx context.Context, endpoint string, req Request) (WebsheetRequest, error) {
	client := req.Client
	if client == nil {
		client = NewDefaultHTTPClient()
	}
	requestBody := map[string]any{
		"message-id":      1,
		"operation":       "emergency-address-update",
		"app-id":          "ap2003",
		"imsi":            req.Identity.IMSI,
		"imei":            req.Identity.IMEI,
		"mcc":             req.Identity.MCC,
		"mnc":             req.Identity.MNC,
		"sip-username":    req.Identity.SIPUsername,
		"terminal-vendor": "vowifi-go",
	}
	if token := strings.TrimSpace(req.Identity.CachedToken); token != "" {
		requestBody["entitlement-token"] = token
		requestBody["token"] = token
	}
	payload, err := json.Marshal([]map[string]any{requestBody})
	if err != nil {
		return WebsheetRequest{}, err
	}
	resp, err := doEntitlementWithHTTPDigest(ctx, client, req.Trace, &HTTPRequest{
		Method:  "POST",
		URL:     endpoint,
		Headers: entitlementHeaders(req),
		Body:    payload,
	}, req)
	if err != nil {
		return WebsheetRequest{}, err
	}
	result, err := parseEntitlementResponse(resp.Body)
	if err != nil {
		return WebsheetRequest{}, err
	}
	if ws := websheetFromEntitlement(req.Carrier.E911.Websheet, result); ws.URL != "" {
		return ws, nil
	}
	var eapKeys *eapaka.Keys
	var identityTranscript [][]byte
	var eapIdentityState eapaka.EncryptedIdentityState
	eapReauthState := cloneEAPReauthenticationState(req.EAPReauthentication)
	eapReauthStateUpdated := false
	if eapReauthState.Usable() {
		keys := cloneEAPAKAKeys(eapReauthState.Keys)
		eapKeys = &keys
	}
	for challengeResponses := 0; result.HasChallenge(); challengeResponses++ {
		if challengeResponses >= maxEntitlementChallengeResponses {
			return WebsheetRequest{}, ErrChallengeNotImplemented
		}
		answerBody, nextEAPKeys, nextIdentityTranscript, nextEAPIdentityState, nextReauthState, reauthUpdated, err := buildEntitlementChallengeAnswer(req, result, eapKeys, identityTranscript, eapReauthState)
		if err != nil {
			return WebsheetRequest{}, err
		}
		if nextEAPKeys != nil {
			eapKeys = nextEAPKeys
		}
		identityTranscript = nextIdentityTranscript
		eapIdentityState = mergeEAPIdentityState(eapIdentityState, nextEAPIdentityState)
		if reauthUpdated {
			eapReauthState = nextReauthState
			eapReauthStateUpdated = true
		} else if nextEAPKeys != nil {
			if state, ok := eapReauthenticationStateFromFullAuth(eapReauthState, *nextEAPKeys, eapIdentityState); ok {
				eapReauthState = state
				eapReauthStateUpdated = true
			}
		}
		answer, err := json.Marshal([]map[string]any{answerBody})
		if err != nil {
			return WebsheetRequest{}, err
		}
		resp, err = doEntitlementWithHTTPDigest(ctx, client, req.Trace, &HTTPRequest{
			Method:  "POST",
			URL:     endpoint,
			Headers: entitlementHeaders(req),
			Body:    answer,
		}, req)
		if err != nil {
			return WebsheetRequest{}, err
		}
		result, err = parseEntitlementResponse(resp.Body)
		if err != nil {
			return WebsheetRequest{}, err
		}
		if ws := websheetFromEntitlement(req.Carrier.E911.Websheet, result); ws.URL != "" {
			ws = websheetWithEAPIdentityState(ws, eapIdentityState)
			if eapReauthStateUpdated {
				ws = websheetWithEAPReauthenticationState(ws, eapReauthState)
			}
			return ws, nil
		}
	}
	if result.Status == 6004 || result.ChallengeRequired {
		return WebsheetRequest{}, ErrChallengeNotImplemented
	}
	return WebsheetRequest{}, fmt.Errorf("e911 entitlement response did not include websheet data")
}

func buildEntitlementChallengeAnswer(req Request, result entitlementResult, eapKeys *eapaka.Keys, identityTranscript [][]byte, reauthState swu.EAPReauthenticationState) (map[string]any, *eapaka.Keys, [][]byte, eapaka.EncryptedIdentityState, swu.EAPReauthenticationState, bool, error) {
	answerBody := map[string]any{
		"message-id":    2,
		"operation":     "emergency-address-update",
		"response-id":   result.ResponseID,
		"sip-username":  req.Identity.SIPUsername,
		"terminal-imei": req.Identity.IMEI,
	}
	if token := strings.TrimSpace(req.Identity.CachedToken); token != "" {
		answerBody["entitlement-token"] = token
		answerBody["token"] = token
	}
	nextIdentityTranscript := cloneByteSlices(identityTranscript)
	if isEAPRelayTerminalPacket(result) {
		return answerBody, nil, nextIdentityTranscript, eapaka.EncryptedIdentityState{}, reauthState, false, nil
	}
	if relay, raw, ok, err := buildEAPRelayIdentityAnswer(result, eapRelayIdentityOptions{
		PermanentIdentity: firstNonEmpty(req.Identity.SIPUsername, req.Identity.IMSI),
		ReauthState:       reauthState,
	}); err != nil {
		return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
	} else if ok {
		answerBody["eap-relay-packet"] = relay
		if len(result.EAPPacketRaw) > 0 {
			nextIdentityTranscript = append(nextIdentityTranscript, append([]byte(nil), result.EAPPacketRaw...))
		} else if result.EAPPacket != nil {
			requestRaw, err := result.EAPPacket.MarshalBinary()
			if err != nil {
				return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
			}
			nextIdentityTranscript = append(nextIdentityTranscript, requestRaw)
		}
		nextIdentityTranscript = append(nextIdentityTranscript, append([]byte(nil), raw...))
		return answerBody, nil, nextIdentityTranscript, eapaka.EncryptedIdentityState{}, reauthState, false, nil
	}
	if relay, negotiated, err := buildEAPRelayKDFNegotiationAnswer(result); err != nil {
		return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
	} else if negotiated {
		answerBody["eap-relay-packet"] = relay
		return answerBody, nil, nextIdentityTranscript, eapaka.EncryptedIdentityState{}, reauthState, false, nil
	}
	if relay, ok, err := buildEAPRelayNotificationAnswer(result, eapKeys); err != nil {
		return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
	} else if ok {
		answerBody["eap-relay-packet"] = relay
		return answerBody, nil, nextIdentityTranscript, eapaka.EncryptedIdentityState{}, reauthState, false, nil
	}
	if relay, keys, nextReauthState, handled, err := buildEAPRelayReauthenticationAnswer(req, result, reauthState); err != nil {
		return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
	} else if handled {
		answerBody["eap-relay-packet"] = relay
		return answerBody, keys, nextIdentityTranscript, eapaka.EncryptedIdentityState{}, nextReauthState, true, nil
	}
	if result.EAPPacket != nil && result.EAPPacket.Subtype != eapaka.SubtypeChallenge {
		relay, err := buildEAPRelayClientErrorAnswer(result, eapaka.ClientErrorUnableToProcessPacket)
		if err != nil {
			return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
		}
		answerBody["eap-relay-packet"] = relay
		return answerBody, nil, nextIdentityTranscript, eapaka.EncryptedIdentityState{}, reauthState, false, nil
	}
	if req.AKAProvider == nil {
		return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, ErrChallengeNotImplemented
	}
	aka, err := req.AKAProvider.CalculateAKA(result.RAND, result.AUTN)
	syncFailure := errors.Is(err, sim.ErrSyncFailure)
	authFailure := errors.Is(err, sim.ErrAuthFailure)
	if err != nil && !syncFailure && !authFailure {
		return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
	}
	if syncFailure && len(aka.AUTS) == 0 {
		return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
	}
	if authFailure {
		if result.EAPPacket == nil {
			return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
		}
		relay, err := buildEAPRelayAuthenticationRejectAnswer(result)
		if err != nil {
			return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
		}
		answerBody["eap-relay-packet"] = relay
		return answerBody, nil, nextIdentityTranscript, eapaka.EncryptedIdentityState{}, reauthState, false, nil
	}
	var nextEAPKeys *eapaka.Keys
	var nextEAPIdentityState eapaka.EncryptedIdentityState
	var relayAuthenticationReject bool
	if result.EAPPacket != nil {
		relay, keys, identityState, authenticationReject, err := buildEAPRelayAnswer(result, aka, firstNonEmpty(req.Identity.SIPUsername, req.Identity.IMSI), syncFailure, nextIdentityTranscript)
		if err != nil {
			return nil, nil, nil, eapaka.EncryptedIdentityState{}, swu.EAPReauthenticationState{}, false, err
		}
		if relay != "" {
			answerBody["eap-relay-packet"] = relay
			nextEAPKeys = keys
			nextEAPIdentityState = identityState
			relayAuthenticationReject = authenticationReject
		}
	}
	if !relayAuthenticationReject {
		answerBody["aka-res"] = strings.ToUpper(hex.EncodeToString(aka.RES))
		answerBody["aka-ck"] = strings.ToUpper(hex.EncodeToString(aka.CK))
		answerBody["aka-ik"] = strings.ToUpper(hex.EncodeToString(aka.IK))
		answerBody["aka-auts"] = strings.ToUpper(hex.EncodeToString(aka.AUTS))
	}
	return answerBody, nextEAPKeys, nextIdentityTranscript, nextEAPIdentityState, reauthState, false, nil
}

func isEAPRelayTerminalPacket(result entitlementResult) bool {
	if result.EAPPacket == nil {
		return false
	}
	switch result.EAPPacket.Code {
	case eapaka.CodeSuccess, eapaka.CodeFailure:
		return true
	default:
		return false
	}
}

func entitlementHeaders(req Request) []HeaderPair {
	headers := []HeaderPair{
		{Key: "Content-Type", Value: "application/json"},
		{Key: "Accept", Value: "application/json"},
		{Key: "x-protocol-version", Value: "2"},
	}
	if token := strings.TrimSpace(req.Identity.CachedToken); token != "" {
		headers = append(headers,
			HeaderPair{Key: "Authorization", Value: "Bearer " + token},
			HeaderPair{Key: "x-entitlement-token", Value: token},
		)
	}
	return headers
}

func fallbackWebsheetRequest(req Request) WebsheetRequest {
	url := strings.TrimSpace(req.Carrier.E911.Websheet)
	token := strings.TrimSpace(req.Identity.CachedToken)
	if token != "" {
		url = appendUserData(url, token)
	}
	return WebsheetRequest{
		URL:         url,
		UserData:    token,
		ContentType: "text/html",
		Title:       "Emergency address",
	}
}

func doEntitlement(ctx context.Context, client HTTPClient, trace TraceSink, req *HTTPRequest) (*HTTPResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if trace != nil {
		trace.Request(req)
	}
	resp, err := client.Do(req)
	if err != nil {
		if trace != nil {
			trace.Error(req, err)
		}
		return nil, err
	}
	if trace != nil {
		trace.Response(req, resp)
	}
	if resp == nil {
		return nil, errors.New("e911 entitlement HTTP client returned nil response")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if err := httpAuthenticationChallengeError(resp); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("e911 entitlement HTTP status %d", resp.StatusCode)
	}
	return resp, nil
}

type entitlementResult struct {
	Status                   int
	ResponseID               any
	WebsheetURL              string
	UserData                 string
	ContentType              string
	Title                    string
	RAND                     []byte
	AUTN                     []byte
	ChallengeRequired        bool
	EAPPacket                *eapaka.Packet
	EAPPacketRaw             []byte
	EmergencyAddress         map[string]string
	PDN                      string
	PDNType                  string
	APN                      string
	Realm                    string
	Endpoint                 string
	ServiceURNs              []string
	Routes                   []EmergencyRoute
	ExpiresAt                time.Time
	ExpiresIn                time.Duration
	CacheExpiresAt           time.Time
	CacheMaxAge              time.Duration
	RetryAfter               time.Time
	RetryAfterIn             time.Duration
	StaleIfError             time.Duration
	LocationValidationStatus string
}

func (r entitlementResult) HasChallenge() bool {
	return (len(r.RAND) == 16 && len(r.AUTN) == 16) || r.EAPPacket != nil
}

func parseEntitlementResponse(body []byte) (entitlementResult, error) {
	body = bytes.TrimSpace(body)
	var root any
	if err := json.Unmarshal(body, &root); err == nil {
		var out entitlementResult
		walkEntitlement(root, &out)
		collectJSONEmergencyRouting(root, &out)
		return finalizeEntitlementResult(out), nil
	} else if xmlResult, xmlErr := parseXMLEntitlementResponse(body); xmlErr == nil {
		return xmlResult, nil
	} else if looksXMLBody(body) {
		return entitlementResult{}, xmlErr
	} else {
		return entitlementResult{}, err
	}
}

func finalizeEntitlementResult(out entitlementResult) entitlementResult {
	if out.ContentType == "" {
		out.ContentType = "text/html"
	}
	if out.Title == "" {
		out.Title = "Emergency address"
	}
	return out
}

func entitlementInfoFromResult(result entitlementResult) EntitlementInfo {
	return EntitlementInfo{
		Status:                   result.Status,
		ResponseID:               responseIDString(result.ResponseID),
		WebsheetURL:              result.WebsheetURL,
		Endpoint:                 result.Endpoint,
		UserData:                 result.UserData,
		ContentType:              result.ContentType,
		Title:                    result.Title,
		Address:                  emergencyAddressFromFields(result.EmergencyAddress),
		PDN:                      EmergencyPDN{Name: result.PDN, Type: result.PDNType, APN: result.APN, Realm: result.Realm},
		ServiceURNs:              copyStringSlice(result.ServiceURNs),
		Routes:                   copyEmergencyRoutes(result.Routes),
		ExpiresAt:                result.ExpiresAt,
		ExpiresIn:                result.ExpiresIn,
		CacheExpiresAt:           result.CacheExpiresAt,
		CacheMaxAge:              result.CacheMaxAge,
		RetryAfter:               result.RetryAfter,
		RetryAfterIn:             result.RetryAfterIn,
		StaleIfError:             result.StaleIfError,
		LocationValidationStatus: result.LocationValidationStatus,
	}
}

func emergencyAddressFromFields(fields map[string]string) EmergencyAddress {
	copied := copyStringMap(fields)
	return EmergencyAddress{
		Street:              copied["street"],
		Unit:                copied["unit"],
		City:                copied["city"],
		State:               copied["state"],
		PostalCode:          copied["postal_code"],
		Country:             copied["country"],
		Latitude:            copied["latitude"],
		Longitude:           copied["longitude"],
		Formatted:           copied["formatted"],
		HouseNumber:         copied["house_number"],
		HouseNumberSuffix:   copied["house_number_suffix"],
		County:              copied["county"],
		District:            copied["district"],
		Neighborhood:        copied["neighborhood"],
		Building:            copied["building"],
		Floor:               copied["floor"],
		Room:                copied["room"],
		Name:                copied["name"],
		StreetDirection:     copied["street_direction"],
		StreetPostDirection: copied["street_post_direction"],
		StreetSuffix:        copied["street_suffix"],
		Landmark:            copied["landmark"],
		LocationDescription: copied["location_description"],
		PlaceType:           copied["place_type"],
		Premise:             copied["premise"],
		PostOfficeBox:       copied["post_office_box"],
		AdditionalCode:      copied["additional_code"],
		Seat:                copied["seat"],
		RoadSection:         copied["road_section"],
		RoadBranch:          copied["road_branch"],
		RoadSubBranch:       copied["road_sub_branch"],
		Fields:              copied,
	}
}

func responseIDString(value any) string {
	switch x := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(x)
	case json.Number:
		return x.String()
	default:
		return strings.TrimSpace(fmt.Sprint(x))
	}
}

func copyStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func copyStringSlice(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	return append([]string(nil), in...)
}

func copyEmergencyRoutes(in []EmergencyRoute) []EmergencyRoute {
	if len(in) == 0 {
		return nil
	}
	out := make([]EmergencyRoute, len(in))
	for i, route := range in {
		out[i] = EmergencyRoute{
			ServiceURN: route.ServiceURN,
			PCSCF:      copyStringSlice(route.PCSCF),
			ESRP:       copyStringSlice(route.ESRP),
			Endpoints:  copyStringSlice(route.Endpoints),
		}
	}
	return out
}

type entitlementXMLNode struct {
	XMLName  xml.Name
	Attrs    []xml.Attr           `xml:",any,attr"`
	Text     string               `xml:",chardata"`
	Children []entitlementXMLNode `xml:",any"`
}

type entitlementWalkContext struct {
	inEmergencyAddress   bool
	inEmergencyRoute     bool
	inLocationValidation bool
	inWebsheet           bool
}

func (c entitlementWalkContext) withKey(canonical string) entitlementWalkContext {
	c.inEmergencyAddress = c.inEmergencyAddress || isEmergencyAddressKey(canonical)
	c.inEmergencyRoute = c.inEmergencyRoute || isEmergencyRouteKey(canonical)
	c.inLocationValidation = c.inLocationValidation || isLocationValidationKey(canonical)
	c.inWebsheet = c.inWebsheet || isWebsheetKey(canonical)
	return c
}

func parseXMLEntitlementResponse(body []byte) (entitlementResult, error) {
	var root entitlementXMLNode
	if err := xml.Unmarshal(body, &root); err != nil {
		return entitlementResult{}, err
	}
	if root.XMLName.Local == "" {
		return entitlementResult{}, errors.New("empty e911 entitlement XML response")
	}
	var out entitlementResult
	walkXMLEntitlement(root, &out, false)
	collectXMLEmergencyRouting(root, &out)
	return finalizeEntitlementResult(out), nil
}

func walkEntitlement(v any, out *entitlementResult) {
	walkEntitlementValue(v, out, entitlementWalkContext{})
}

func walkEntitlementValue(v any, out *entitlementResult, ctx entitlementWalkContext) {
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			walkEntitlementValue(item, out, ctx)
		}
	case map[string]any:
		for key, value := range x {
			canonical := normalizeEntitlementKey(key)
			consumeEntitlementField(key, value, out, ctx)
			nextCtx := ctx.withKey(canonical)
			if nextCtx.inEmergencyAddress {
				collectEmergencyAddressField(key, value, out)
			}
			if nextCtx.inLocationValidation {
				collectLocationValidationField(key, value, out)
			}
			walkEntitlementValue(value, out, nextCtx)
		}
	}
}

func walkXMLEntitlement(node entitlementXMLNode, out *entitlementResult, inEmergencyAddress bool) {
	ctx := entitlementWalkContext{inEmergencyAddress: inEmergencyAddress}
	walkXMLEntitlementValue(node, out, ctx)
}

func walkXMLEntitlementValue(node entitlementXMLNode, out *entitlementResult, ctx entitlementWalkContext) {
	key := node.XMLName.Local
	canonical := normalizeEntitlementKey(key)
	text := strings.TrimSpace(node.Text)
	nextCtx := ctx.withKey(canonical)
	if text != "" {
		consumeEntitlementField(key, text, out, ctx)
	}
	if nextCtx.inEmergencyAddress && text != "" && len(node.Children) == 0 {
		collectEmergencyAddressField(key, text, out)
	}
	if nextCtx.inLocationValidation && text != "" && len(node.Children) == 0 {
		collectLocationValidationField(key, text, out)
	}
	for _, attr := range node.Attrs {
		consumeEntitlementField(attr.Name.Local, attr.Value, out, nextCtx)
		if isPDNKey(canonical) {
			consumePDNField(attr.Name.Local, attr.Value, out)
		}
		if nextCtx.inEmergencyAddress {
			collectEmergencyAddressField(attr.Name.Local, attr.Value, out)
		}
		if nextCtx.inLocationValidation {
			collectLocationValidationField(attr.Name.Local, attr.Value, out)
		}
	}
	for _, child := range node.Children {
		walkXMLEntitlementValue(child, out, nextCtx)
	}
}

func consumeEntitlementField(key string, value any, out *entitlementResult, ctx entitlementWalkContext) {
	canonical := normalizeEntitlementKey(key)
	if ctx.inLocationValidation && isLocationValidationStatusKey(canonical) {
		setLocationValidationStatus(&out.LocationValidationStatus, value)
		return
	}
	if isWebsheetUserDataKey(canonical) {
		setStringOverride(&out.UserData, value)
		return
	}
	switch canonical {
	case "status", "statuscode", "entitlementstatus", "resultcode", "responsecode":
		if n, ok := numberValue(value); ok {
			out.Status = n
			if n == 6004 {
				out.ChallengeRequired = true
			}
		}
	case "responseid", "responseidentifier", "requestid", "transactionid":
		if out.ResponseID == nil {
			out.ResponseID = value
		}
	case "websheet", "websheeturl", "e911websheet", "e911websheeturl", "addressurl", "addressupdateurl", "emergencyaddressurl", "emergencyaddresswebsheeturl", "emergencyaddressupdateurl", "e911addressurl", "e911addressupdateurl", "locationurl", "locationvalidationurl", "url":
		if !ctx.inEmergencyRoute {
			setHTTPURL(&out.WebsheetURL, value)
		}
	case "endpoint", "addressendpoint", "emergencyaddressendpoint", "e911endpoint", "websheetendpoint", "locationendpoint", "locationvalidationendpoint":
		if !ctx.inEmergencyRoute {
			setHTTPURL(&out.Endpoint, value)
		}
	case "userdata", "userdatatoken", "token", "entitlementtoken", "authtoken", "authorizationtoken", "accesstoken", "bearertoken":
		if ctx.inWebsheet || isWebsheetUserDataKey(canonical) {
			setStringOverride(&out.UserData, value)
			return
		}
		setString(&out.UserData, value)
	case "contenttype", "mimetype":
		setString(&out.ContentType, value)
	case "title", "websheettitle", "pagetitle", "displaytitle":
		setString(&out.Title, value)
	case "rand", "akarand", "eapakarand":
		if decoded, ok := decodeChallengeBytes(stringValue(value)); ok {
			out.RAND = decoded
		}
	case "autn", "akaautn", "eapakautn":
		if decoded, ok := decodeChallengeBytes(stringValue(value)); ok {
			out.AUTN = decoded
		}
	case "challenge", "akachallenge", "eapakachallenge", "aka":
		parseCombinedChallenge(value, out)
	case "eaprelaypacket", "eaprelay", "eappacket", "eapakapacket":
		parseEAPRelayPacket(value, out)
	case "challengerequired", "akachallengerequired", "eapchallengerequired":
		if b, ok := boolValue(value); ok && b {
			out.ChallengeRequired = true
		}
	case "pdn", "pdnname", "pdnid", "emergencypdn":
		parsePDN(value, out)
		setString(&out.PDN, value)
	case "pdntype", "emergencypdntype", "ipversion", "iptype", "pdptype", "pdnprotocol", "protocoltype", "bearertype", "ipaddresstype":
		setString(&out.PDNType, value)
	case "apn", "accesspointname", "emergencyapn", "imsapn", "dnn", "emergencydnn", "datanetworkname", "networkidentifier", "apnni", "accesspointnamenetworkidentifier":
		setString(&out.APN, value)
	case "realm", "networkrealm", "imsrealm", "nairealm", "homerealm":
		setString(&out.Realm, value)
	case "serviceurn", "serviceurns", "emergencyserviceurn", "emergencyserviceurns", "sosurn", "sosurns", "sosserviceurn", "sosserviceurns":
		collectServiceURNs(value, out)
	case "expires", "expiry", "expiration", "expiresat", "expirationtime", "validuntil", "validto", "notafter":
		setExpiry(&out.ExpiresAt, &out.ExpiresIn, value)
	case "expiresin", "expiresseconds", "expiressec", "ttl", "timetolive", "validity", "validityperiod", "validfor":
		setDuration(&out.ExpiresIn, value)
	case "cachecontrol":
		setCacheControlDirectives(&out.CacheMaxAge, &out.StaleIfError, value)
	case "cacheexpires", "cacheexpiry", "cacheexpiresat", "cacheexpiration", "cacheexpirationtime", "cachevaliduntil":
		setExpiry(&out.CacheExpiresAt, &out.CacheMaxAge, value)
	case "cacheexpiresin", "cachemaxage", "cachettl", "cachetimetolive", "maxage":
		setDuration(&out.CacheMaxAge, value)
	case "retryafter", "retryafterseconds", "retryin", "retryafterin", "nextretry", "retryat":
		setRetryAfter(&out.RetryAfter, &out.RetryAfterIn, value)
	case "staleiferror", "staleonerror", "staleiferrorseconds":
		setDuration(&out.StaleIfError, value)
	case "locationvalidationstatus", "validationstatus", "addressvalidationstatus", "e911addressvalidationstatus", "locationstatus", "locationvalidationresult", "validationresult", "addressvalidationresult", "civicaddressvalidationstatus", "civiclocationvalidationstatus":
		setLocationValidationStatus(&out.LocationValidationStatus, value)
	default:
		if isServiceURNKey(canonical) {
			collectServiceURNs(value, out)
		}
		if isEmergencyAddressKey(canonical) {
			parseEmergencyAddress(value, out)
		}
		if isLocationValidationKey(canonical) {
			collectLocationValidationField(key, value, out)
		}
	}
}

func normalizeEntitlementKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	if i := strings.LastIndex(key, ":"); i >= 0 {
		key = key[i+1:]
	}
	var b strings.Builder
	b.Grow(len(key))
	for _, r := range key {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func looksXMLBody(body []byte) bool {
	return bytes.HasPrefix(bytes.TrimSpace(body), []byte("<"))
}

func setString(dst *string, value any) {
	if dst == nil || strings.TrimSpace(*dst) != "" {
		return
	}
	if s := strings.TrimSpace(stringValue(value)); s != "" {
		*dst = s
	}
}

func setStringOverride(dst *string, value any) {
	if dst == nil {
		return
	}
	if s := strings.TrimSpace(stringValue(value)); s != "" {
		*dst = s
	}
}

func setScalarString(dst *string, value any) {
	if dst == nil || strings.TrimSpace(*dst) != "" {
		return
	}
	if s := strings.TrimSpace(scalarStringValue(value)); s != "" {
		*dst = s
	}
}

func setLocationValidationStatus(dst *string, value any) {
	if dst == nil || strings.TrimSpace(*dst) != "" {
		return
	}
	if s := strings.TrimSpace(scalarStringValue(value)); s != "" {
		*dst = normalizeLocationValidationStatus(s)
	}
}

func normalizeLocationValidationStatus(s string) string {
	s = strings.TrimSpace(s)
	switch normalizeEntitlementKey(s) {
	case "valid", "validated", "verified", "accepted", "approved", "success", "successful", "pass", "passed", "ok":
		return "validated"
	case "pending", "inprogress", "processing", "validating", "validationpending", "pendingvalidation", "pendingreview":
		return "pending"
	case "invalid", "notvalid", "validationfailed", "failed", "rejected", "denied":
		return "invalid"
	default:
		return s
	}
}

func setHTTPURL(dst *string, value any) {
	if dst == nil || strings.TrimSpace(*dst) != "" {
		return
	}
	if s := strings.TrimSpace(stringValue(value)); looksHTTPURL(s) {
		*dst = s
	}
}

func setExpiry(dstTime *time.Time, dstDuration *time.Duration, value any) {
	if dstTime == nil || dstDuration == nil {
		return
	}
	if t, d, ok := timeOrDurationValue(value); ok {
		if !t.IsZero() && dstTime.IsZero() {
			*dstTime = t
			return
		}
		if d > 0 && *dstDuration == 0 {
			*dstDuration = d
		}
	}
}

func setDuration(dst *time.Duration, value any) {
	if dst == nil || *dst != 0 {
		return
	}
	if d, ok := durationValue(value); ok && d > 0 {
		*dst = d
	}
}

func setRetryAfter(dstTime *time.Time, dstDuration *time.Duration, value any) {
	if dstTime == nil || dstDuration == nil {
		return
	}
	if t, d, ok := timeOrDurationValue(value); ok {
		if !t.IsZero() && dstTime.IsZero() {
			*dstTime = t
			return
		}
		if d > 0 && *dstDuration == 0 {
			*dstDuration = d
		}
	}
}

func setCacheControlDirectives(maxAge *time.Duration, staleIfError *time.Duration, value any) {
	if maxAge != nil && *maxAge == 0 {
		if d, ok := cacheControlDirectiveDurationValue(value, "maxage", "smaxage", "cachemaxage", "ttl"); ok && d > 0 {
			*maxAge = d
		}
	}
	if staleIfError != nil && *staleIfError == 0 {
		if d, ok := cacheControlDirectiveDurationValue(value, "staleiferror", "staleonerror"); ok && d > 0 {
			*staleIfError = d
		}
	}
}

func cacheControlDirectiveDurationValue(value any, keys ...string) (time.Duration, bool) {
	switch x := value.(type) {
	case map[string]any:
		for key, item := range x {
			if matchesNormalizedKey(normalizeEntitlementKey(key), keys...) {
				if d, ok := durationValue(item); ok && d > 0 {
					return d, true
				}
			}
		}
	case []any:
		for _, item := range x {
			if d, ok := cacheControlDirectiveDurationValue(item, keys...); ok {
				return d, true
			}
		}
	case []string:
		for _, item := range x {
			if d, ok := cacheControlDirectiveDurationValue(item, keys...); ok {
				return d, true
			}
		}
	}
	for _, s := range stringsFromAny(value) {
		if d, ok := cacheControlDirectiveDurationString(s, keys...); ok {
			return d, true
		}
	}
	return 0, false
}

func cacheControlDirectiveDurationString(s string, keys ...string) (time.Duration, bool) {
	for _, part := range strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ';'
	}) {
		item := strings.TrimSpace(part)
		if item == "" {
			continue
		}
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			key, value, ok = strings.Cut(item, ":")
		}
		if !ok {
			continue
		}
		if matchesNormalizedKey(normalizeEntitlementKey(key), keys...) {
			value = strings.Trim(strings.TrimSpace(value), `"'`)
			if d, ok := durationValue(value); ok && d > 0 {
				return d, true
			}
		}
	}
	return 0, false
}

func matchesNormalizedKey(key string, values ...string) bool {
	for _, value := range values {
		if key == normalizeEntitlementKey(value) {
			return true
		}
	}
	return false
}

func timeOrDurationValue(value any) (time.Time, time.Duration, bool) {
	if t, ok := timeValue(value); ok {
		return t, 0, true
	}
	if d, ok := durationValue(value); ok {
		return time.Time{}, d, true
	}
	return time.Time{}, 0, false
}

func timeValue(value any) (time.Time, bool) {
	if n, ok := int64Value(value); ok && n >= 946684800 {
		return time.Unix(n, 0).UTC(), true
	}
	s := strings.TrimSpace(stringValue(value))
	if s == "" {
		return time.Time{}, false
	}
	if n, ok := parseInt64String(s); ok && n >= 946684800 {
		return time.Unix(n, 0).UTC(), true
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		time.RFC1123Z,
		time.RFC1123,
		"2006-01-02T15:04:05-0700",
		"2006-01-02 15:04:05Z07:00",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func durationValue(value any) (time.Duration, bool) {
	if n, ok := int64Value(value); ok && n > 0 {
		return time.Duration(n) * time.Second, true
	}
	s := strings.TrimSpace(stringValue(value))
	if s == "" {
		return 0, false
	}
	if n, ok := parseInt64String(s); ok && n > 0 {
		return time.Duration(n) * time.Second, true
	}
	if d, err := time.ParseDuration(s); err == nil {
		return d, true
	}
	return iso8601DurationValue(s)
}

func int64Value(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case int:
		return int64(x), true
	case int64:
		return x, true
	case json.Number:
		n, err := x.Int64()
		return n, err == nil
	case string:
		return parseInt64String(x)
	default:
		return 0, false
	}
}

func parseInt64String(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	for i, r := range s {
		if i == 0 && (r == '+' || r == '-') {
			continue
		}
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	var n int64
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err == nil
}

func iso8601DurationValue(s string) (time.Duration, bool) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if !strings.HasPrefix(s, "P") {
		return 0, false
	}
	var total time.Duration
	var digits strings.Builder
	inTime := false
	for _, r := range s[1:] {
		switch {
		case r >= '0' && r <= '9':
			digits.WriteRune(r)
			continue
		case r == 'T':
			inTime = true
			continue
		}
		n, ok := parseInt64String(digits.String())
		if !ok {
			return 0, false
		}
		digits.Reset()
		switch r {
		case 'D':
			total += time.Duration(n) * 24 * time.Hour
		case 'H':
			if !inTime {
				return 0, false
			}
			total += time.Duration(n) * time.Hour
		case 'M':
			if !inTime {
				return 0, false
			}
			total += time.Duration(n) * time.Minute
		case 'S':
			if !inTime {
				return 0, false
			}
			total += time.Duration(n) * time.Second
		default:
			return 0, false
		}
	}
	if digits.Len() != 0 || total <= 0 {
		return 0, false
	}
	return total, true
}

func boolValue(v any) (bool, bool) {
	switch x := v.(type) {
	case bool:
		return x, true
	case string:
		switch strings.ToLower(strings.TrimSpace(x)) {
		case "true", "yes", "1", "required":
			return true, true
		case "false", "no", "0", "notrequired", "none":
			return false, true
		}
	case float64:
		return x != 0, true
	case int:
		return x != 0, true
	case int64:
		return x != 0, true
	case json.Number:
		n, err := x.Int64()
		return n != 0, err == nil
	}
	return false, false
}

func isEmergencyAddressKey(canonical string) bool {
	switch canonical {
	case "emergencyaddress", "e911address", "address", "civicaddress", "civiclocation", "serviceaddress", "registeredaddress", "locationaddress", "emergencylocation", "e911location", "location", "geolocation", "geodeticlocation":
		return true
	default:
		return false
	}
}

func isPDNKey(canonical string) bool {
	switch canonical {
	case "pdn", "pdninfo", "pdnconfiguration", "pdnconnection", "pdnsettings", "emergencypdn", "emergencypdninfo", "emergencypdnconfiguration", "emergencybearer", "imsbearer", "apnconfiguration", "apnsettings", "dnnconfiguration", "emergencyapn", "emergencydnn":
		return true
	default:
		return false
	}
}

func isEmergencyRouteKey(canonical string) bool {
	switch canonical {
	case "route", "routes", "routing", "routeinfo", "routesinfo", "routinginfo", "emergencyroute", "emergencyroutes", "emergencyrouteinfo", "emergencyrouting", "emergencyroutinginfo", "emergencyserviceroute", "emergencyserviceroutes", "emergencycallrouting", "sosroute", "sosroutes", "sosrouteinfo", "sosrouting", "imsrouting", "callrouting", "callroute", "callroutes", "siproute", "siproutes":
		return true
	default:
		return false
	}
}

func isLocationValidationKey(canonical string) bool {
	switch canonical {
	case "locationvalidation", "locationvalidationinfo", "locationvalidationresult", "locationvalidity", "addressvalidation", "addressvalidationinfo", "addressvalidationresult", "emergencyaddressvalidation", "e911addressvalidation", "civicaddressvalidation", "civiclocationvalidation":
		return true
	default:
		return false
	}
}

func isLocationValidationStatusKey(canonical string) bool {
	switch canonical {
	case "status", "state", "result", "statuscode", "resultcode", "validationstatus", "validationresult", "locationstatus", "locationvalidationstatus", "locationvalidationresult", "addressvalidationstatus", "addressvalidationresult":
		return true
	default:
		return false
	}
}

func isWebsheetKey(canonical string) bool {
	switch canonical {
	case "websheet", "websheetinfo", "websheetdata", "websheetrequest", "e911websheet", "emergencyaddresswebsheet", "addresswebsheet":
		return true
	default:
		return false
	}
}

func isWebsheetUserDataKey(canonical string) bool {
	switch canonical {
	case "websheetuserdata", "websheetuserdatatoken", "websheettoken", "websheetauthtoken", "websheetauthorizationtoken":
		return true
	default:
		return false
	}
}

func collectJSONEmergencyRouting(v any, out *entitlementResult) {
	before := len(out.Routes)
	collectExplicitJSONEmergencyRouting(v, out)
	if len(out.Routes) != before {
		return
	}
	if m, ok := v.(map[string]any); ok && routeMapHasDirectFields(m) {
		appendEmergencyRoute(out, emergencyRouteFromJSONMap(m, false))
	}
}

func collectExplicitJSONEmergencyRouting(v any, out *entitlementResult) {
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			collectExplicitJSONEmergencyRouting(item, out)
		}
	case map[string]any:
		for key, item := range x {
			canonical := normalizeEntitlementKey(key)
			if isEmergencyRouteKey(canonical) {
				appendEmergencyRoutesFromJSON(item, out, true)
				continue
			}
			collectExplicitJSONEmergencyRouting(item, out)
		}
	}
}

func appendEmergencyRoutesFromJSON(v any, out *entitlementResult, genericEndpoints bool) {
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			appendEmergencyRoutesFromJSON(item, out, genericEndpoints)
		}
	case map[string]any:
		appendEmergencyRoute(out, emergencyRouteFromJSONMap(x, genericEndpoints))
		for key, item := range x {
			if isEmergencyRouteKey(normalizeEntitlementKey(key)) {
				appendEmergencyRoutesFromJSON(item, out, true)
			}
		}
	case string:
		var route EmergencyRoute
		if urn := normalizeEmergencyServiceURN(x); urn != "" {
			route.ServiceURN = urn
		} else if s := strings.TrimSpace(x); s != "" {
			route.Endpoints = append(route.Endpoints, s)
		}
		appendEmergencyRoute(out, route)
	}
}

func emergencyRouteFromJSONMap(m map[string]any, genericEndpoints bool) EmergencyRoute {
	var route EmergencyRoute
	for key, value := range m {
		collectEmergencyRouteField(key, value, &route, genericEndpoints)
	}
	return normalizeEmergencyRoute(route)
}

func routeMapHasDirectFields(m map[string]any) bool {
	for key := range m {
		canonical := normalizeEntitlementKey(key)
		if isServiceURNKey(canonical) || isPCSCFKey(canonical) || isESRPKey(canonical) || isSpecificRouteEndpointKey(canonical) {
			return true
		}
	}
	return false
}

func collectXMLEmergencyRouting(root entitlementXMLNode, out *entitlementResult) {
	before := len(out.Routes)
	collectExplicitXMLEmergencyRouting(root, out)
	if len(out.Routes) != before {
		return
	}
	appendEmergencyRoute(out, emergencyRouteFromXMLNode(root, false))
}

func collectExplicitXMLEmergencyRouting(node entitlementXMLNode, out *entitlementResult) {
	if isEmergencyRouteKey(normalizeEntitlementKey(node.XMLName.Local)) {
		var hasChildRoute bool
		for _, child := range node.Children {
			if isEmergencyRouteKey(normalizeEntitlementKey(child.XMLName.Local)) {
				hasChildRoute = true
				collectExplicitXMLEmergencyRouting(child, out)
			}
		}
		if hasChildRoute {
			return
		}
		appendEmergencyRoute(out, emergencyRouteFromXMLNode(node, true))
		return
	}
	for _, child := range node.Children {
		collectExplicitXMLEmergencyRouting(child, out)
	}
}

func emergencyRouteFromXMLNode(node entitlementXMLNode, genericEndpoints bool) EmergencyRoute {
	var route EmergencyRoute
	collectXMLRouteFields(node, &route, genericEndpoints)
	return normalizeEmergencyRoute(route)
}

func collectXMLRouteFields(node entitlementXMLNode, route *EmergencyRoute, genericEndpoints bool) {
	canonical := normalizeEntitlementKey(node.XMLName.Local)
	switch {
	case isServiceURNKey(canonical):
		for _, urn := range serviceURNsFromAny(xmlStrings(node)) {
			if route.ServiceURN == "" {
				route.ServiceURN = urn
			}
		}
		return
	case isPCSCFKey(canonical):
		route.PCSCF = appendUniqueStrings(route.PCSCF, xmlStrings(node)...)
		return
	case isESRPKey(canonical):
		route.ESRP = appendUniqueStrings(route.ESRP, xmlStrings(node)...)
		return
	case isSpecificRouteEndpointKey(canonical) || genericEndpoints && isGenericRouteEndpointKey(canonical):
		route.Endpoints = appendUniqueStrings(route.Endpoints, xmlStrings(node)...)
		return
	}
	for _, attr := range node.Attrs {
		collectEmergencyRouteField(attr.Name.Local, attr.Value, route, genericEndpoints)
	}
	for _, child := range node.Children {
		collectXMLRouteFields(child, route, genericEndpoints)
	}
}

func collectEmergencyRouteField(key string, value any, route *EmergencyRoute, genericEndpoints bool) {
	if route == nil {
		return
	}
	canonical := normalizeEntitlementKey(key)
	switch {
	case isServiceURNKey(canonical):
		for _, urn := range serviceURNsFromAny(value) {
			if route.ServiceURN == "" {
				route.ServiceURN = urn
			}
		}
	case isPCSCFKey(canonical):
		route.PCSCF = appendUniqueStrings(route.PCSCF, stringsFromAny(value)...)
	case isESRPKey(canonical):
		route.ESRP = appendUniqueStrings(route.ESRP, stringsFromAny(value)...)
	case isSpecificRouteEndpointKey(canonical) || genericEndpoints && isGenericRouteEndpointKey(canonical):
		route.Endpoints = appendUniqueStrings(route.Endpoints, stringsFromAny(value)...)
	}
}

func isServiceURNKey(canonical string) bool {
	switch canonical {
	case "serviceurn", "serviceurns", "emergencyserviceurn", "emergencyserviceurns", "sosurn", "sosurns", "sosserviceurn", "sosserviceurns", "service", "servicetype", "emergencyservice", "emergencyservicetype":
		return true
	default:
		return false
	}
}

func isPCSCFKey(canonical string) bool {
	switch canonical {
	case "pcscf", "pcscfs", "pcscfaddress", "pcscfaddresses", "pcscffqdn", "pcscffqdns", "pcscfhost", "pcscfhosts", "pcscfdomain", "pcscfdomains", "pcscfserver", "pcscfservers", "pcscflist", "pcscfuri", "pcscfuris", "pcscfip", "pcscfipaddress", "pcscfipaddresses", "pcscfipv4", "pcscfipv4address", "pcscfipv6", "pcscfipv6address", "pcscfname", "proxycscf", "pcscfendpoint", "pcscfendpoints":
		return true
	default:
		return false
	}
}

func isESRPKey(canonical string) bool {
	switch canonical {
	case "esrp", "esrps", "esrpuri", "esrpuris", "esrpurl", "esrpurls", "esrpaddress", "esrpaddresses", "esrpfqdn", "esrpfqdns", "esrphost", "esrphosts", "esrpserver", "esrpservers", "esrpendpoint", "esrpendpoints", "emergencyservicesroutingproxy", "emergencyroutingproxy":
		return true
	default:
		return false
	}
}

func isSpecificRouteEndpointKey(canonical string) bool {
	switch canonical {
	case "routeendpoint", "routeendpoints", "routingendpoint", "routingendpoints", "emergencyendpoint", "emergencyendpoints", "sipendpoint", "sipendpoints", "sipsendpoint", "sipsendpoints", "callendpoint", "callendpoints", "sosendpoint", "sosendpoints", "sosuri", "sosuris", "ecscf", "ecscfs", "ecscfuri", "ecscfuris", "ecscfaddress", "ecscfaddresses", "ecscffqdn", "ecscffqdns", "ecscfendpoint", "ecscfendpoints", "emergencycscf", "emergencycscfuri", "emergencycscfendpoint":
		return true
	default:
		return false
	}
}

func isGenericRouteEndpointKey(canonical string) bool {
	switch canonical {
	case "endpoint", "endpoints", "uri", "uris", "url", "urls", "address", "addresses", "fqdn", "fqdns", "host", "hosts", "server", "servers":
		return true
	default:
		return false
	}
}

func collectServiceURNs(value any, out *entitlementResult) {
	if out == nil {
		return
	}
	out.ServiceURNs = appendUniqueStrings(out.ServiceURNs, serviceURNsFromAny(value)...)
}

func serviceURNsFromAny(value any) []string {
	var out []string
	for _, s := range stringsFromAny(value) {
		if urn := normalizeEmergencyServiceURN(s); urn != "" {
			out = appendUniqueStrings(out, urn)
		}
	}
	return out
}

func normalizeEmergencyServiceURN(s string) string {
	return normalizeEmergencyServiceURNValue(s)
}

func appendEmergencyRoute(out *entitlementResult, route EmergencyRoute) {
	if out == nil {
		return
	}
	route = normalizeEmergencyRoute(route)
	if route.ServiceURN == "" && len(route.PCSCF) == 0 && len(route.ESRP) == 0 && len(route.Endpoints) == 0 {
		return
	}
	if route.ServiceURN != "" {
		out.ServiceURNs = appendUniqueStrings(out.ServiceURNs, route.ServiceURN)
	}
	for _, existing := range out.Routes {
		if emergencyRoutesEqual(existing, route) {
			return
		}
	}
	out.Routes = append(out.Routes, route)
}

func normalizeEmergencyRoute(route EmergencyRoute) EmergencyRoute {
	route.ServiceURN = normalizeEmergencyServiceURN(route.ServiceURN)
	route.PCSCF = sortedUniqueStrings(route.PCSCF...)
	route.ESRP = sortedUniqueStrings(route.ESRP...)
	route.Endpoints = sortedUniqueStrings(route.Endpoints...)
	return route
}

func emergencyRoutesEqual(a, b EmergencyRoute) bool {
	return a.ServiceURN == b.ServiceURN &&
		strings.Join(a.PCSCF, "\x00") == strings.Join(b.PCSCF, "\x00") &&
		strings.Join(a.ESRP, "\x00") == strings.Join(b.ESRP, "\x00") &&
		strings.Join(a.Endpoints, "\x00") == strings.Join(b.Endpoints, "\x00")
}

func appendUniqueStrings(dst []string, values ...string) []string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		found := false
		for _, existing := range dst {
			if strings.EqualFold(existing, value) {
				found = true
				break
			}
		}
		if !found {
			dst = append(dst, value)
		}
	}
	return dst
}

func sortedUniqueStrings(values ...string) []string {
	out := appendUniqueStrings(nil, values...)
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	return out
}

func stringsFromAny(value any) []string {
	var out []string
	collectStringsFromAny(value, &out)
	return appendUniqueStrings(nil, out...)
}

func collectStringsFromAny(value any, out *[]string) {
	switch x := value.(type) {
	case string:
		*out = append(*out, splitStringList(x)...)
	case []any:
		for _, item := range x {
			collectStringsFromAny(item, out)
		}
	case []string:
		for _, item := range x {
			collectStringsFromAny(item, out)
		}
	case map[string]any:
		for _, item := range x {
			collectStringsFromAny(item, out)
		}
	case json.Number:
		*out = append(*out, x.String())
	case fmt.Stringer:
		*out = append(*out, x.String())
	}
}

func splitStringList(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if strings.Contains(s, ",") {
		parts := strings.Split(s, ",")
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			if item := strings.TrimSpace(part); item != "" {
				out = append(out, item)
			}
		}
		return out
	}
	fields := strings.Fields(s)
	if len(fields) > 1 {
		return fields
	}
	return []string{s}
}

func xmlStrings(node entitlementXMLNode) []string {
	var out []string
	collectXMLStrings(node, &out)
	return appendUniqueStrings(nil, out...)
}

func collectXMLStrings(node entitlementXMLNode, out *[]string) {
	if text := strings.TrimSpace(node.Text); text != "" {
		*out = append(*out, splitStringList(text)...)
	}
	for _, attr := range node.Attrs {
		if strings.EqualFold(attr.Name.Local, "type") {
			continue
		}
		*out = append(*out, splitStringList(attr.Value)...)
	}
	for _, child := range node.Children {
		collectXMLStrings(child, out)
	}
}

func parsePDN(value any, out *entitlementResult) {
	switch x := value.(type) {
	case map[string]any:
		for key, item := range x {
			consumePDNField(key, item, out)
		}
	case []any:
		for _, item := range x {
			parsePDN(item, out)
		}
	default:
		setString(&out.PDN, value)
	}
}

func consumePDNField(key string, value any, out *entitlementResult) {
	if out == nil {
		return
	}
	switch normalizeEntitlementKey(key) {
	case "name", "id", "pdn", "pdnname", "pdnid", "emergencypdn":
		setString(&out.PDN, value)
	case "type", "pdntype", "emergencypdntype", "iptype", "ipversion", "pdptype", "pdnprotocol", "protocol", "protocoltype", "bearertype", "ipaddresstype":
		setString(&out.PDNType, value)
	case "apn", "accesspointname", "emergencyapn", "imsapn", "dnn", "emergencydnn", "datanetworkname", "networkidentifier", "apnni", "accesspointnamenetworkidentifier":
		setString(&out.APN, value)
	case "realm", "networkrealm", "imsrealm", "nairealm", "homerealm", "domain", "fqdn", "operatoridentifier":
		setString(&out.Realm, value)
	case "endpoint", "url", "uri", "addressendpoint", "e911endpoint", "locationendpoint":
		setHTTPURL(&out.Endpoint, value)
	}
}

func parseEmergencyAddress(value any, out *entitlementResult) {
	switch x := value.(type) {
	case map[string]any:
		for key, item := range x {
			collectEmergencyAddressField(key, item, out)
			parseEmergencyAddress(item, out)
		}
	case []any:
		for _, item := range x {
			parseEmergencyAddress(item, out)
		}
	case string:
		if s := strings.TrimSpace(x); s != "" {
			if out.EmergencyAddress == nil {
				out.EmergencyAddress = make(map[string]string)
			}
			if out.EmergencyAddress["formatted"] == "" {
				out.EmergencyAddress["formatted"] = s
			}
		}
	}
}

func collectEmergencyAddressField(key string, value any, out *entitlementResult) {
	if out == nil {
		return
	}
	canonical := normalizeEntitlementKey(key)
	if isEmergencyAddressKey(canonical) {
		if canonical != "location" || strings.TrimSpace(stringValue(value)) == "" {
			parseEmergencyAddress(value, out)
			return
		}
	}
	switch canonical {
	case "street", "street1", "streetaddress", "addressline1", "address1", "line1", "road", "rd", "a6":
		canonical = "street"
	case "street2", "addressline2", "address2", "line2", "unit", "apartment", "apt", "suite":
		canonical = "unit"
	case "city", "locality", "municipality", "town", "a3":
		canonical = "city"
	case "state", "region", "province", "a1":
		canonical = "state"
	case "postalcode", "postcode", "zip", "zipcode", "pc":
		canonical = "postal_code"
	case "country", "countrycode":
		canonical = "country"
	case "latitude", "lat":
		canonical = "latitude"
	case "longitude", "lon", "lng":
		canonical = "longitude"
	case "formatted", "formattedaddress", "fulladdress", "displayaddress":
		canonical = "formatted"
	case "housenumber", "hno":
		canonical = "house_number"
	case "housenumbersuffix", "hns":
		canonical = "house_number_suffix"
	case "county", "a2":
		canonical = "county"
	case "district", "borough", "a4":
		canonical = "district"
	case "neighborhood", "neighbourhood", "a5":
		canonical = "neighborhood"
	case "building", "bld", "bldg":
		canonical = "building"
	case "floor", "flr":
		canonical = "floor"
	case "room", "roomnumber":
		canonical = "room"
	case "name", "nam":
		canonical = "name"
	case "prd", "predirectional", "streetdirection", "leadingstreetdirection":
		canonical = "street_direction"
	case "pod", "postdirectional", "streetpostdirection", "trailingstreetdirection":
		canonical = "street_post_direction"
	case "sts", "streetsuffix", "streettype", "roadtype":
		canonical = "street_suffix"
	case "lmk", "landmark":
		canonical = "landmark"
	case "loc", "location", "locationdescription":
		canonical = "location_description"
	case "plc", "placetype":
		canonical = "place_type"
	case "prm", "premise":
		canonical = "premise"
	case "pobox", "postofficebox":
		canonical = "post_office_box"
	case "addcode", "additionalcode":
		canonical = "additional_code"
	case "seat":
		canonical = "seat"
	case "rdsec", "roadsection":
		canonical = "road_section"
	case "rdbr", "roadbranch":
		canonical = "road_branch"
	case "rdsubbr", "roadsubbranch":
		canonical = "road_sub_branch"
	default:
		return
	}
	if s := strings.TrimSpace(stringValue(value)); s != "" {
		if out.EmergencyAddress == nil {
			out.EmergencyAddress = make(map[string]string)
		}
		out.EmergencyAddress[canonical] = s
	}
}

func collectLocationValidationField(key string, value any, out *entitlementResult) {
	if out == nil {
		return
	}
	canonical := normalizeEntitlementKey(key)
	switch {
	case isLocationValidationKey(canonical):
		setLocationValidationStatus(&out.LocationValidationStatus, value)
	case isLocationValidationStatusKey(canonical):
		setLocationValidationStatus(&out.LocationValidationStatus, value)
	}
}

func parseEAPRelayPacket(v any, out *entitlementResult) {
	raw, ok := decodeChallengeBytes(stringValue(v))
	if !ok || len(raw) == 0 {
		return
	}
	packet, err := eapaka.ParsePacket(raw)
	if err != nil {
		return
	}
	p := packet
	out.EAPPacket = &p
	out.EAPPacketRaw = append([]byte(nil), raw...)
	rand16, autn16, err := eapaka.ChallengeRANDAndAUTN(packet)
	if err != nil {
		return
	}
	if len(out.RAND) == 0 {
		out.RAND = rand16
	}
	if len(out.AUTN) == 0 {
		out.AUTN = autn16
	}
}

type eapRelayIdentityOptions struct {
	PermanentIdentity string
	ReauthState       swu.EAPReauthenticationState
}

func buildEAPRelayIdentityAnswer(result entitlementResult, opts eapRelayIdentityOptions) (string, []byte, bool, error) {
	if result.EAPPacket == nil {
		return "", nil, false, nil
	}
	request := *result.EAPPacket
	if request.Code != eapaka.CodeRequest || request.Subtype != eapaka.SubtypeIdentity {
		return "", nil, false, nil
	}
	identity := eapRelayRequestedIdentity(request, opts)
	if identity == "" {
		return "", nil, true, ErrChallengeNotImplemented
	}
	packet, err := eapaka.BuildIdentityResponse(identity, request)
	if err != nil {
		return "", nil, true, err
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		return "", nil, true, err
	}
	return base64.StdEncoding.EncodeToString(raw), raw, true, nil
}

func eapRelayRequestedIdentity(request eapaka.Packet, opts eapRelayIdentityOptions) string {
	permanent := strings.TrimSpace(opts.PermanentIdentity)
	state := cloneEAPReauthenticationState(opts.ReauthState)
	pseudonym := strings.TrimSpace(state.NextPseudonym)
	switch {
	case eapRelayHasIdentityRequest(request, eapaka.AttributePermanentIDReq):
		return permanent
	case eapRelayHasIdentityRequest(request, eapaka.AttributeFullAuthIDReq):
		return firstNonEmpty(pseudonym, permanent)
	case eapRelayHasIdentityRequest(request, eapaka.AttributeAnyIDReq):
		if state.Usable() {
			return firstNonEmpty(state.Identity, pseudonym, permanent)
		}
		return firstNonEmpty(pseudonym, permanent)
	default:
		return permanent
	}
}

func eapRelayHasIdentityRequest(request eapaka.Packet, typ uint8) bool {
	_, ok := eapaka.FindAttribute(request.Attributes, typ)
	return ok
}

func buildEAPRelayAnswer(result entitlementResult, aka sim.AKAResult, identity string, syncFailure bool, identityTranscript [][]byte) (string, *eapaka.Keys, eapaka.EncryptedIdentityState, bool, error) {
	if result.EAPPacket == nil {
		return "", nil, eapaka.EncryptedIdentityState{}, false, nil
	}
	var packet eapaka.Packet
	var keys *eapaka.Keys
	var identityState eapaka.EncryptedIdentityState
	var err error
	var authenticationReject bool
	if syncFailure {
		packet, err = eapaka.BuildSynchronizationFailureResponse(*result.EAPPacket, aka.AUTS)
	} else {
		response, responseKeys, responseErr := eapaka.BuildChallengeResponseWithCheckcode(strings.TrimSpace(identity), *result.EAPPacket, aka, identityTranscript)
		packet, err = response, responseErr
		if errors.Is(responseErr, eapaka.ErrBiddingDown) {
			packet, err = eapaka.BuildAuthenticationRejectResponse(*result.EAPPacket)
			authenticationReject = true
		}
		if err == nil && !authenticationReject {
			keys = &responseKeys
			if attrs, _, decryptErr := eapaka.DecryptChallengeEncryptedAttributes(*result.EAPPacket, responseKeys); decryptErr != nil {
				err = decryptErr
			} else if len(attrs) > 0 {
				identityState, err = eapaka.IdentityStateFromAttributes(attrs)
			}
		}
	}
	if err != nil {
		return "", nil, eapaka.EncryptedIdentityState{}, false, err
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		return "", nil, eapaka.EncryptedIdentityState{}, false, err
	}
	return base64.StdEncoding.EncodeToString(raw), keys, identityState, authenticationReject, nil
}

func cloneByteSlices(in [][]byte) [][]byte {
	if len(in) == 0 {
		return nil
	}
	out := make([][]byte, len(in))
	for i, item := range in {
		out[i] = append([]byte(nil), item...)
	}
	return out
}

func mergeEAPIdentityState(current, next eapaka.EncryptedIdentityState) eapaka.EncryptedIdentityState {
	if next.NextPseudonym != "" {
		current.NextPseudonym = next.NextPseudonym
	}
	if next.NextReauthID != "" {
		current.NextReauthID = next.NextReauthID
	}
	return current
}

func websheetWithEAPIdentityState(ws WebsheetRequest, state eapaka.EncryptedIdentityState) WebsheetRequest {
	ws.EAPNextPseudonym = state.NextPseudonym
	ws.EAPNextReauthID = state.NextReauthID
	return ws
}

func websheetWithEAPReauthenticationState(ws WebsheetRequest, state swu.EAPReauthenticationState) WebsheetRequest {
	state = cloneEAPReauthenticationState(state)
	ws.EAPReauthentication = state
	if ws.EAPNextPseudonym == "" {
		ws.EAPNextPseudonym = state.NextPseudonym
	}
	if ws.EAPNextReauthID == "" {
		ws.EAPNextReauthID = state.Identity
	}
	return ws
}

func buildEAPRelayAuthenticationRejectAnswer(result entitlementResult) (string, error) {
	if result.EAPPacket == nil {
		return "", nil
	}
	packet, err := eapaka.BuildAuthenticationRejectResponse(*result.EAPPacket)
	if err != nil {
		return "", err
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func buildEAPRelayKDFNegotiationAnswer(result entitlementResult) (string, bool, error) {
	if result.EAPPacket == nil {
		return "", false, nil
	}
	packet, negotiated, err := eapaka.BuildAKAPrimeKDFNegotiationResponse(*result.EAPPacket)
	if err != nil || !negotiated {
		return "", negotiated, err
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		return "", false, err
	}
	return base64.StdEncoding.EncodeToString(raw), true, nil
}

func buildEAPRelayNotificationAnswer(result entitlementResult, eapKeys *eapaka.Keys) (string, bool, error) {
	if result.EAPPacket == nil {
		return "", false, nil
	}
	packet, ok, err := eapaka.BuildNotificationResponse(*result.EAPPacket)
	if errors.Is(err, eapaka.ErrInvalidKeyMaterial) && eapKeys != nil {
		packet, ok, err = eapaka.BuildAuthenticatedNotificationResponse(*result.EAPPacket, eapKeys.KAut)
	}
	if err != nil || !ok {
		return "", ok, err
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		return "", false, err
	}
	return base64.StdEncoding.EncodeToString(raw), true, nil
}

func buildEAPRelayReauthenticationAnswer(req Request, result entitlementResult, state swu.EAPReauthenticationState) (string, *eapaka.Keys, swu.EAPReauthenticationState, bool, error) {
	if result.EAPPacket == nil || result.EAPPacket.Subtype != eapaka.SubtypeReauthentication {
		return "", nil, state, false, nil
	}
	state = cloneEAPReauthenticationState(state)
	if !state.Usable() {
		return "", nil, state, false, nil
	}
	parsed, err := eapaka.ParseReauthenticationRequest(*result.EAPPacket, state.Keys)
	if err != nil {
		return "", nil, swu.EAPReauthenticationState{}, true, err
	}
	iv, err := entitlementRandomBytes(req.Random, 16)
	if err != nil {
		return "", nil, swu.EAPReauthenticationState{}, true, err
	}
	next := state
	var packet eapaka.Packet
	var keys eapaka.Keys
	if state.CounterOK && parsed.Counter <= state.Counter {
		packet, err = eapaka.BuildReauthenticationCounterTooSmallResponse(*result.EAPPacket, state.Keys, iv)
		if err != nil {
			return "", nil, swu.EAPReauthenticationState{}, true, err
		}
		keys = state.Keys
		next.CounterTooSmall = true
		next.Reauthenticated = false
		next.LastRejectedCounter = parsed.Counter
	} else {
		identity := strings.TrimSpace(state.Identity)
		if identity == "" {
			return "", nil, swu.EAPReauthenticationState{}, true, ErrChallengeNotImplemented
		}
		packet, keys, err = eapaka.BuildReauthenticationResponse(identity, *result.EAPPacket, state.Keys, iv)
		if err != nil {
			return "", nil, swu.EAPReauthenticationState{}, true, err
		}
		next.Keys = cloneEAPAKAKeys(keys)
		next.Counter = parsed.Counter
		next.CounterOK = true
		next.CounterTooSmall = false
		next.Reauthenticated = true
		next.LastAcceptedCounter = parsed.Counter
		if parsed.IdentityState.NextReauthID != "" {
			next.Identity = strings.TrimSpace(parsed.IdentityState.NextReauthID)
		}
		if parsed.IdentityState.NextPseudonym != "" {
			next.NextPseudonym = strings.TrimSpace(parsed.IdentityState.NextPseudonym)
		}
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		return "", nil, swu.EAPReauthenticationState{}, true, err
	}
	next = cloneEAPReauthenticationState(next)
	return base64.StdEncoding.EncodeToString(raw), eapKeysPtr(keys), next, true, nil
}

func buildEAPRelayClientErrorAnswer(result entitlementResult, code uint16) (string, error) {
	if result.EAPPacket == nil {
		return "", nil
	}
	packet, err := eapaka.BuildClientErrorResponse(*result.EAPPacket, code)
	if err != nil {
		return "", err
	}
	raw, err := packet.MarshalBinary()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func eapReauthenticationStateFromFullAuth(current swu.EAPReauthenticationState, keys eapaka.Keys, state eapaka.EncryptedIdentityState) (swu.EAPReauthenticationState, bool) {
	next := cloneEAPReauthenticationState(current)
	if strings.TrimSpace(state.NextReauthID) != "" {
		next.Identity = strings.TrimSpace(state.NextReauthID)
	}
	if strings.TrimSpace(state.NextPseudonym) != "" {
		next.NextPseudonym = strings.TrimSpace(state.NextPseudonym)
	}
	if strings.TrimSpace(next.Identity) == "" {
		return swu.EAPReauthenticationState{}, false
	}
	next.Keys = cloneEAPAKAKeys(keys)
	next.Counter = 0
	next.CounterOK = true
	next.Reauthenticated = false
	next.CounterTooSmall = false
	next.LastAcceptedCounter = 0
	next.LastRejectedCounter = 0
	return cloneEAPReauthenticationState(next), true
}

func parseCombinedChallenge(v any, out *entitlementResult) {
	text := stringValue(v)
	if text == "" {
		return
	}
	raw, ok := decodeChallengeBytes(text)
	if !ok || len(raw) < 32 {
		return
	}
	if len(out.RAND) == 0 {
		out.RAND = append([]byte(nil), raw[:16]...)
	}
	if len(out.AUTN) == 0 {
		out.AUTN = append([]byte(nil), raw[16:32]...)
	}
}

func websheetFromEntitlement(fallbackURL string, result entitlementResult) WebsheetRequest {
	u := firstNonEmpty(result.WebsheetURL, result.Endpoint)
	userData := strings.TrimSpace(result.UserData)
	if u == "" && userData != "" {
		u = appendUserData(fallbackURL, userData)
	}
	if u == "" {
		return WebsheetRequest{}
	}
	return WebsheetRequest{
		URL:         u,
		UserData:    userData,
		ContentType: firstNonEmpty(result.ContentType, "text/html"),
		Title:       firstNonEmpty(result.Title, "Emergency address"),
	}
}

func appendUserData(rawURL, userData string) string {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := parsed.Query()
	if q.Get("token") == "" {
		q.Set("token", userData)
	}
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

func numberValue(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case int64:
		return int(x), true
	case json.Number:
		n, err := x.Int64()
		return int(n), err == nil
	case string:
		var n int
		_, err := fmt.Sscanf(strings.TrimSpace(x), "%d", &n)
		return n, err == nil
	default:
		return 0, false
	}
}

func stringValue(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case fmt.Stringer:
		return x.String()
	default:
		return ""
	}
}

func scalarStringValue(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case fmt.Stringer:
		return x.String()
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%.0f", x)
		}
		return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", x), "0"), ".")
	case int:
		return fmt.Sprint(x)
	case int64:
		return fmt.Sprint(x)
	default:
		return ""
	}
}

func decodeChallengeBytes(s string) ([]byte, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, false
	}
	clean := strings.NewReplacer(" ", "", ":", "", "-", "").Replace(s)
	if raw, err := hex.DecodeString(clean); err == nil {
		return raw, true
	}
	if raw, err := base64.StdEncoding.DecodeString(s); err == nil {
		return raw, true
	}
	if raw, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return raw, true
	}
	return nil, false
}

func entitlementRandomBytes(r io.Reader, n int) ([]byte, error) {
	if r == nil {
		r = crand.Reader
	}
	out := make([]byte, n)
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, err
	}
	return out, nil
}

func eapKeysPtr(keys eapaka.Keys) *eapaka.Keys {
	cloned := cloneEAPAKAKeys(keys)
	return &cloned
}

func cloneEAPReauthenticationState(state swu.EAPReauthenticationState) swu.EAPReauthenticationState {
	state.Identity = strings.TrimSpace(state.Identity)
	state.NextPseudonym = strings.TrimSpace(state.NextPseudonym)
	state.Keys = cloneEAPAKAKeys(state.Keys)
	return state
}

func cloneEAPAKAKeys(keys eapaka.Keys) eapaka.Keys {
	return eapaka.Keys{
		MK:      append([]byte(nil), keys.MK...),
		KEncr:   append([]byte(nil), keys.KEncr...),
		KAut:    append([]byte(nil), keys.KAut...),
		KRe:     append([]byte(nil), keys.KRe...),
		MSK:     append([]byte(nil), keys.MSK...),
		EMSK:    append([]byte(nil), keys.EMSK...),
		CKPrime: append([]byte(nil), keys.CKPrime...),
		IKPrime: append([]byte(nil), keys.IKPrime...),
	}
}

func looksHTTPURL(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "http://")
}

func firstNonEmpty(items ...string) string {
	for _, item := range items {
		if strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}
