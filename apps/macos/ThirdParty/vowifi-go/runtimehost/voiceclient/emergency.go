package voiceclient

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

var ErrInvalidEmergencySIP = errors.New("invalid emergency SIP")

const (
	DefaultEmergencyServiceURN = "urn:service:sos"

	IMSMMTelServiceIdentifier            = imsMMTelService
	IMSEmergencyAcceptContact            = `*;` + imsMMTelContactFeature + `;require;explicit`
	EmergencySDPContentType              = "application/sdp"
	EmergencyPIDFLOContentType           = "application/pidf+xml"
	EmergencyMultipartRelatedContentType = "multipart/related"
	GeolocationRoutingYes                = "yes"
	GeolocationRoutingNo                 = "no"

	EmergencyContactURIParamSOS     = "sos"
	EmergencyContactURIParamRegType = "reg-type"
)

const (
	defaultEmergencyPIDFLOEntity      = "pres:anonymous@invalid"
	defaultEmergencyPIDFLOTuple       = "e911-location"
	defaultEmergencyPIDFLOMethod      = "Manual"
	defaultEmergencyPIDFLOContentID   = "location-1"
	defaultEmergencySDPContentID      = "sdp"
	defaultEmergencyMultipartBoundary = "e911-pidf-lo"
)

type EmergencyServiceCategory uint8

const (
	EmergencyServiceCategoryPolice EmergencyServiceCategory = 1 << iota
	EmergencyServiceCategoryAmbulance
	EmergencyServiceCategoryFire
	EmergencyServiceCategoryMarine
	EmergencyServiceCategoryMountain
	EmergencyServiceCategoryManualECall
	EmergencyServiceCategoryAutomaticECall
)

type EmergencyAccessNetworkInfo struct {
	Raw        string
	AccessType string
	WLANNodeID string
	Parameters map[string]string
}

type GeolocationHeaderValue struct {
	URI        string
	Parameters map[string]string
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

type EmergencyRoute struct {
	ServiceURN string
	PCSCF      []string
	ESRP       []string
	Endpoints  []string
}

type EmergencyPIDFLOConfig struct {
	Entity    string
	TupleID   string
	Method    string
	Timestamp time.Time
	Address   EmergencyAddress
}

type EmergencyPIDFLOUsageRules struct {
	RetransmissionAllowed *bool
	RetentionExpiry       time.Time
	RulesetReference      string
	NoteWell              string
}

type EmergencyMultipartRelatedConfig struct {
	Boundary        string
	SDPContentID    string
	PIDFLOContentID string
}

type EmergencySIPHeaderConfig struct {
	ServiceURN         string
	AccessNetworkInfo  EmergencyAccessNetworkInfo
	GeolocationURI     string
	GeolocationValues  []GeolocationHeaderValue
	Address            EmergencyAddress
	GeolocationRouting bool
	PIDFLOContentID    string
	PIDFLOBody         []byte
}

type EmergencySIPRequestInfo struct {
	RequestURI      string
	Headers         map[string]string
	Routes          []EmergencyRoute
	RouteSet        []string
	PIDFLOContentID string
	PIDFLOBody      []byte
}

type emergencyServiceURNDescriptor struct {
	urn      string
	category EmergencyServiceCategory
	aliases  []string
}

var emergencyServiceURNDescriptors = []emergencyServiceURNDescriptor{
	{
		urn:     DefaultEmergencyServiceURN,
		aliases: []string{"911", "112", "sos", "emergency", "e911"},
	},
	{
		urn:      "urn:service:sos.police",
		category: EmergencyServiceCategoryPolice,
		aliases:  []string{"police"},
	},
	{
		urn:      "urn:service:sos.ambulance",
		category: EmergencyServiceCategoryAmbulance,
		aliases:  []string{"ambulance", "medical", "ems"},
	},
	{
		urn:      "urn:service:sos.fire",
		category: EmergencyServiceCategoryFire,
		aliases:  []string{"fire"},
	},
	{
		urn:     "urn:service:sos.animal-control",
		aliases: []string{"animal-control", "animalcontrol"},
	},
	{
		urn:     "urn:service:sos.gas",
		aliases: []string{"gas"},
	},
	{
		urn:      "urn:service:sos.marine",
		category: EmergencyServiceCategoryMarine,
		aliases:  []string{"marine"},
	},
	{
		urn:      "urn:service:sos.mountain",
		category: EmergencyServiceCategoryMountain,
		aliases:  []string{"mountain"},
	},
	{
		urn:     "urn:service:sos.physician",
		aliases: []string{"physician"},
	},
	{
		urn:     "urn:service:sos.poison",
		aliases: []string{"poison"},
	},
	{
		urn:      "urn:service:sos.ecall.manual",
		category: EmergencyServiceCategoryManualECall,
		aliases:  []string{"ecall", "manual-ecall", "ecall-manual"},
	},
	{
		urn:      "urn:service:sos.ecall.automatic",
		category: EmergencyServiceCategoryAutomaticECall,
		aliases:  []string{"automatic-ecall", "ecall-automatic"},
	},
}

func NormalizeEmergencyServiceURN(s string) string {
	return normalizeEmergencyServiceURNValue(s, true)
}

func normalizeEmergencyServiceURNValue(value string, allowUnknownSubservice bool) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	if candidate, ok := emergencyServiceWrappedCandidate(value); ok {
		if urn := normalizeEmergencyServiceURNValue(candidate, false); urn != "" {
			return urn
		}
	}
	value = normalizeEmergencyServiceURNPathForm(value)
	value = strings.TrimPrefix(value, "service:")
	if strings.HasPrefix(value, "sos.") {
		value = "urn:service:" + value
	}
	if isEmergencyServiceURN(value) {
		return value
	}
	for _, descriptor := range emergencyServiceURNDescriptors {
		for _, alias := range descriptor.aliases {
			if value == alias {
				return descriptor.urn
			}
		}
	}
	if allowUnknownSubservice && !strings.Contains(value, ":") {
		return DefaultEmergencyServiceURN + "." + value
	}
	return ""
}

func emergencyServiceWrappedCandidate(value string) (string, bool) {
	if uri, ok := emergencyServiceAngleURI(value); ok {
		return uri, true
	}
	switch {
	case strings.HasPrefix(value, "sip:"):
		return emergencyServiceSIPURIUser(value[len("sip:"):])
	case strings.HasPrefix(value, "sips:"):
		return emergencyServiceSIPURIUser(value[len("sips:"):])
	case strings.HasPrefix(value, "tel:"):
		return emergencyServiceURIUser(value[len("tel:"):])
	default:
		return "", false
	}
}

func emergencyServiceAngleURI(value string) (string, bool) {
	start := strings.IndexByte(value, '<')
	if start < 0 {
		return "", false
	}
	end := strings.IndexByte(value[start+1:], '>')
	if end < 0 {
		return "", false
	}
	uri := strings.TrimSpace(value[start+1 : start+1+end])
	return uri, uri != ""
}

func emergencyServiceSIPURIUser(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if user, _, ok := strings.Cut(value, "@"); ok {
		return emergencyServiceURIUser(user)
	}
	return emergencyServiceURIUser(value)
}

func emergencyServiceURIUser(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if idx := strings.IndexAny(value, ";?"); idx >= 0 {
		value = strings.TrimSpace(value[:idx])
	}
	return value, value != ""
}

func normalizeEmergencyServiceURNPathForm(value string) string {
	for _, prefix := range []string{"urn/service/", "urn:service/"} {
		if strings.HasPrefix(value, prefix) {
			suffix := strings.Trim(strings.TrimPrefix(value, prefix), "/")
			if suffix == "" {
				return value
			}
			return "urn:service:" + strings.ReplaceAll(suffix, "/", ".")
		}
	}
	return value
}

func isEmergencyServiceURN(value string) bool {
	return value == DefaultEmergencyServiceURN || strings.HasPrefix(value, DefaultEmergencyServiceURN+".")
}

func EmergencyRequestURI(service string) string {
	if urn := NormalizeEmergencyServiceURN(service); urn != "" {
		return urn
	}
	return DefaultEmergencyServiceURN
}

func EmergencyServiceURNsForCategory(category EmergencyServiceCategory) []string {
	if category == 0 {
		return []string{DefaultEmergencyServiceURN}
	}
	var out []string
	for _, descriptor := range emergencyServiceURNDescriptors {
		if descriptor.category != 0 && category&descriptor.category != 0 {
			out = append(out, descriptor.urn)
		}
	}
	if len(out) == 0 {
		return []string{DefaultEmergencyServiceURN}
	}
	return out
}

func BuildPAccessNetworkInfo(info EmergencyAccessNetworkInfo) string {
	if raw := strings.TrimSpace(info.Raw); raw != "" {
		return raw
	}
	accessType := strings.TrimSpace(info.AccessType)
	if accessType == "" {
		accessType = "IEEE-802.11"
	}
	params := normalizeSIPHeaderParameters(info.Parameters)
	nodeID := strings.TrimSpace(info.WLANNodeID)
	if nodeID == "" {
		nodeID = params["i-wlan-node-id"]
	}
	delete(params, "i-wlan-node-id")
	var b strings.Builder
	b.WriteString(accessType)
	if nodeID != "" {
		b.WriteString(`;i-wlan-node-id=`)
		b.WriteString(quoteSIPParamValue(nodeID))
	}
	appendSIPHeaderParameters(&b, params)
	return b.String()
}

func BuildEmergencySIPHeaders(cfg EmergencySIPHeaderConfig) map[string]string {
	headers := map[string]string{
		"P-Preferred-Service":   IMSMMTelServiceIdentifier,
		"Accept-Contact":        IMSEmergencyAcceptContact,
		"P-Access-Network-Info": BuildPAccessNetworkInfo(cfg.AccessNetworkInfo),
	}
	if geolocation := emergencyGeolocationHeader(cfg); geolocation != "" {
		headers["Geolocation"] = geolocation
		if cfg.GeolocationRouting {
			headers["Geolocation-Routing"] = GeolocationRoutingYes
		}
	}
	return headers
}

func BuildEmergencySIPRequestInfo(cfg EmergencySIPHeaderConfig) EmergencySIPRequestInfo {
	return EmergencySIPRequestInfo{
		RequestURI:      EmergencyRequestURI(cfg.ServiceURN),
		Headers:         BuildEmergencySIPHeaders(cfg),
		PIDFLOContentID: strings.TrimSpace(cfg.PIDFLOContentID),
		PIDFLOBody:      append([]byte(nil), cfg.PIDFLOBody...),
	}
}

func BuildEmergencyInviteRequest(cfg DialogRequestConfig, info EmergencySIPRequestInfo, sdp []byte) (SIPRequestMessage, error) {
	requestURI := EmergencyRequestURI(info.RequestURI)
	if strings.TrimSpace(cfg.RemoteURI) == "" {
		cfg.RemoteURI = requestURI
	}
	if strings.TrimSpace(cfg.RemoteTargetURI) == "" {
		cfg.RemoteTargetURI = requestURI
	}
	if len(trimHeaderValues(info.RouteSet)) > 0 {
		cfg.RouteSet = append([]string(nil), trimHeaderValues(info.RouteSet)...)
	}

	body := append([]byte(nil), sdp...)
	contentType := ""
	if len(info.PIDFLOBody) > 0 {
		var err error
		contentType, body, err = BuildEmergencyPIDFLOMultipartBody(sdp, info.PIDFLOBody, EmergencyMultipartRelatedConfig{
			PIDFLOContentID: info.PIDFLOContentID,
		})
		if err != nil {
			return SIPRequestMessage{}, err
		}
	}

	msg, err := BuildInviteRequest(cfg, body)
	if err != nil {
		return SIPRequestMessage{}, err
	}
	msg.URI = requestURI

	headers := BuildEmergencySIPHeaders(EmergencySIPHeaderConfig{
		AccessNetworkInfo: EmergencyAccessNetworkInfo{
			Raw: emergencyStringHeaderValue(msg.Headers, "P-Access-Network-Info"),
		},
	})
	for key, value := range info.Headers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			continue
		}
		headers[canonicalHeaderName(key)] = value
	}
	if len(info.PIDFLOBody) > 0 &&
		emergencyStringHeaderValue(headers, "Geolocation") == "" &&
		emergencyStringHeaderValue(msg.Headers, "Geolocation") == "" {
		if contentID := emergencyContentIDForHeader(info.PIDFLOContentID, defaultEmergencyPIDFLOContentID); contentID != "" {
			headers["Geolocation"] = formatGeolocationURI("cid:" + contentID)
		}
	}
	for key, value := range headers {
		if key == "" || value == "" || isProtectedDialogRequestHeader(key) {
			continue
		}
		setDialogRequestHeader(msg.Headers, key, value)
	}
	if contentType != "" {
		msg.Headers["Content-Type"] = contentType
		msg.Headers["Accept"] = EmergencySDPContentType + ", " + EmergencyMultipartRelatedContentType
	}
	if routeSet := trimHeaderValues(info.RouteSet); len(routeSet) > 0 {
		msg.Headers["Route"] = strings.Join(routeSet, ", ")
	}
	if contact := emergencyStringHeaderValue(msg.Headers, "Contact"); contact != "" {
		marked, err := MarkEmergencyContactHeader(contact)
		if err != nil {
			return SIPRequestMessage{}, err
		}
		setDialogRequestHeader(msg.Headers, "Contact", marked)
	}
	return msg, nil
}

func BuildGeolocationHeader(values ...GeolocationHeaderValue) string {
	var out []string
	for _, value := range values {
		if formatted := formatGeolocationHeaderValue(value); formatted != "" {
			out = append(out, formatted)
		}
	}
	return strings.Join(out, ", ")
}

func BuildEmergencyPIDFLO(cfg EmergencyPIDFLOConfig) ([]byte, error) {
	return BuildEmergencyPIDFLOWithUsageRules(cfg, EmergencyPIDFLOUsageRules{})
}

func BuildEmergencyPIDFLOWithUsageRules(cfg EmergencyPIDFLOConfig, rules EmergencyPIDFLOUsageRules) ([]byte, error) {
	if !emergencyAddressHasPIDFLOLocation(cfg.Address) {
		return nil, fmt.Errorf("%w: pidf-lo requires location", ErrInvalidEmergencySIP)
	}
	if err := validateEmergencyPIDFLOUsageRules(cfg, rules); err != nil {
		return nil, err
	}
	entity := firstNonEmpty(cfg.Entity, defaultEmergencyPIDFLOEntity)
	tupleID := firstNonEmpty(cfg.TupleID, defaultEmergencyPIDFLOTuple)
	method := firstNonEmpty(cfg.Method, defaultEmergencyPIDFLOMethod)

	var body bytes.Buffer
	body.WriteString(xml.Header)
	enc := xml.NewEncoder(&body)
	enc.Indent("", "  ")

	if err := encodePIDFLOStart(enc, "presence",
		xml.Attr{Name: xml.Name{Local: "xmlns"}, Value: "urn:ietf:params:xml:ns:pidf"},
		xml.Attr{Name: xml.Name{Local: "xmlns:gp"}, Value: "urn:ietf:params:xml:ns:pidf:geopriv10"},
		xml.Attr{Name: xml.Name{Local: "xmlns:cl"}, Value: "urn:ietf:params:xml:ns:pidf:geopriv10:civicAddr"},
		xml.Attr{Name: xml.Name{Local: "xmlns:gml"}, Value: "http://www.opengis.net/gml"},
		xml.Attr{Name: xml.Name{Local: "entity"}, Value: entity},
	); err != nil {
		return nil, err
	}
	if err := encodePIDFLOStart(enc, "tuple", xml.Attr{Name: xml.Name{Local: "id"}, Value: tupleID}); err != nil {
		return nil, err
	}
	if err := encodePIDFLOStart(enc, "status"); err != nil {
		return nil, err
	}
	if err := encodePIDFLOStart(enc, "gp:geopriv"); err != nil {
		return nil, err
	}
	if err := encodePIDFLOStart(enc, "gp:location-info"); err != nil {
		return nil, err
	}
	if emergencyAddressHasGeolocation(cfg.Address) {
		if err := encodePIDFLOStart(enc, "gml:Point", xml.Attr{Name: xml.Name{Local: "srsName"}, Value: "urn:ogc:def:crs:EPSG::4326"}); err != nil {
			return nil, err
		}
		if err := encodePIDFLOTextElement(enc, "gml:pos", strings.TrimSpace(cfg.Address.Latitude)+" "+strings.TrimSpace(cfg.Address.Longitude)); err != nil {
			return nil, err
		}
		if err := encodePIDFLOEnd(enc, "gml:Point"); err != nil {
			return nil, err
		}
	}
	civicFields := emergencyAddressPIDFLOCivicFields(cfg.Address)
	if len(civicFields) > 0 {
		if err := encodePIDFLOStart(enc, "cl:civicAddress"); err != nil {
			return nil, err
		}
		for _, field := range civicFields {
			if err := encodePIDFLOTextElement(enc, "cl:"+field.name, field.value); err != nil {
				return nil, err
			}
		}
		if err := encodePIDFLOEnd(enc, "cl:civicAddress"); err != nil {
			return nil, err
		}
	}
	if err := encodePIDFLOEnd(enc, "gp:location-info"); err != nil {
		return nil, err
	}
	if err := encodePIDFLOUsageRules(enc, rules); err != nil {
		return nil, err
	}
	if err := encodePIDFLOTextElement(enc, "gp:method", method); err != nil {
		return nil, err
	}
	if err := encodePIDFLOEnd(enc, "gp:geopriv"); err != nil {
		return nil, err
	}
	if err := encodePIDFLOEnd(enc, "status"); err != nil {
		return nil, err
	}
	if !cfg.Timestamp.IsZero() {
		if err := encodePIDFLOTextElement(enc, "timestamp", cfg.Timestamp.UTC().Format(time.RFC3339Nano)); err != nil {
			return nil, err
		}
	}
	if err := encodePIDFLOEnd(enc, "tuple"); err != nil {
		return nil, err
	}
	if err := encodePIDFLOEnd(enc, "presence"); err != nil {
		return nil, err
	}
	if err := enc.Flush(); err != nil {
		return nil, err
	}
	return body.Bytes(), nil
}

func BuildEmergencyPIDFLOMultipartBody(sdp, pidfLO []byte, cfg EmergencyMultipartRelatedConfig) (string, []byte, error) {
	if len(pidfLO) == 0 {
		return "", nil, fmt.Errorf("%w: multipart body requires pidf-lo", ErrInvalidEmergencySIP)
	}
	sdpContentID, err := normalizeEmergencyContentID(cfg.SDPContentID, defaultEmergencySDPContentID)
	if err != nil {
		return "", nil, err
	}
	pidfContentID, err := normalizeEmergencyContentID(cfg.PIDFLOContentID, defaultEmergencyPIDFLOContentID)
	if err != nil {
		return "", nil, err
	}
	if strings.EqualFold(sdpContentID, pidfContentID) {
		return "", nil, fmt.Errorf("%w: multipart content ids must differ", ErrInvalidEmergencySIP)
	}
	boundary := strings.TrimSpace(cfg.Boundary)
	if boundary == "" {
		boundary = chooseEmergencyMultipartBoundary(sdp, pidfLO)
	}
	if err := validateEmergencyMultipartBoundary(boundary); err != nil {
		return "", nil, err
	}
	if emergencyMultipartBoundaryCollides(boundary, sdp, pidfLO) {
		return "", nil, fmt.Errorf("%w: multipart boundary collides with body", ErrInvalidEmergencySIP)
	}

	var body bytes.Buffer
	appendEmergencyMultipartPart(&body, boundary, EmergencySDPContentType, sdpContentID, "session;handling=required", sdp)
	appendEmergencyMultipartPart(&body, boundary, EmergencyPIDFLOContentType, pidfContentID, "by-reference;handling=optional", pidfLO)
	body.WriteString("--")
	body.WriteString(boundary)
	body.WriteString("--\r\n")

	contentType := EmergencyMultipartRelatedContentType +
		`;boundary=` + boundary +
		`;type="` + EmergencySDPContentType + `"` +
		`;start="<` + sdpContentID + `>"`
	return contentType, body.Bytes(), nil
}

func ParseEmergencyPIDFLO(body []byte) (EmergencyAddress, error) {
	dec := xml.NewDecoder(bytes.NewReader(body))
	var stack []pidfLOElement
	var address EmergencyAddress
	for {
		token, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return EmergencyAddress{}, err
		}
		switch x := token.(type) {
		case xml.StartElement:
			key := ""
			if inPIDFLOCivicAddress(stack) {
				key = x.Name.Local
			} else if isPIDFLOGeodeticPositionElement(x.Name.Local) {
				key = pidfLOPositionKey
			}
			stack = append(stack, pidfLOElement{local: x.Name.Local, key: key})
		case xml.CharData:
			if len(stack) == 0 {
				continue
			}
			stack[len(stack)-1].text = append(stack[len(stack)-1].text, x...)
		case xml.EndElement:
			if len(stack) == 0 {
				continue
			}
			elem := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			text := strings.TrimSpace(string(elem.text))
			if text == "" {
				continue
			}
			if elem.key == pidfLOPositionKey {
				collectPIDFLOGeodeticPosition(text, &address)
			} else if elem.key != "" {
				collectPIDFLOCivicField(elem.key, text, &address)
			}
		}
	}
	if !emergencyAddressHasPIDFLOLocation(address) {
		return EmergencyAddress{}, fmt.Errorf("%w: pidf-lo does not contain location", ErrInvalidEmergencySIP)
	}
	return address, nil
}

func MarkEmergencyContactHeader(contact string) (string, error) {
	contact = strings.TrimSpace(contact)
	if contact == "" {
		return "", fmt.Errorf("%w: emergency contact is empty", ErrInvalidEmergencySIP)
	}
	if start := strings.Index(contact, "<"); start >= 0 {
		end := strings.Index(contact[start+1:], ">")
		if end < 0 {
			return "", fmt.Errorf("%w: emergency contact missing closing angle", ErrInvalidEmergencySIP)
		}
		end += start + 1
		uri, err := MarkEmergencyContactURI(contact[start+1 : end])
		if err != nil {
			return "", err
		}
		prefix := strings.TrimSpace(contact[:start])
		if prefix != "" {
			prefix += " "
		}
		return prefix + "<" + uri + ">" + strings.TrimSpace(contact[end+1:]), nil
	}
	uri, err := MarkEmergencyContactURI(contact)
	if err != nil {
		return "", err
	}
	return "<" + uri + ">", nil
}

func MarkEmergencyContactURI(uri string) (string, error) {
	uri = strings.TrimSpace(uri)
	if uri == "" {
		return "", fmt.Errorf("%w: emergency contact URI is empty", ErrInvalidEmergencySIP)
	}
	lower := strings.ToLower(uri)
	if !strings.HasPrefix(lower, "sip:") && !strings.HasPrefix(lower, "sips:") {
		return "", fmt.Errorf("%w: emergency contact URI must be sip or sips", ErrInvalidEmergencySIP)
	}
	if emergencyContactURIHasMarker(uri) {
		return uri, nil
	}
	base, query, hasQuery := strings.Cut(uri, "?")
	uri = base + ";" + EmergencyContactURIParamSOS
	if hasQuery {
		uri += "?" + query
	}
	return uri, nil
}

func EmergencySIPRouteSet(routes []EmergencyRoute) []string {
	var out []string
	for _, route := range routes {
		out = appendEmergencySIPRouteSet(out, route.PCSCF...)
		out = appendEmergencySIPRouteSet(out, route.ESRP...)
		out = appendEmergencySIPRouteSet(out, route.Endpoints...)
	}
	return out
}

func appendEmergencySIPRouteSet(dst []string, values ...string) []string {
	for _, value := range values {
		route := formatEmergencySIPRoute(value)
		if route == "" || containsEmergencySIPRoute(dst, route) {
			continue
		}
		dst = append(dst, route)
	}
	return dst
}

func emergencyStringHeaderValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func emergencyGeolocationHeader(cfg EmergencySIPHeaderConfig) string {
	if uri := strings.TrimSpace(cfg.GeolocationURI); uri != "" {
		return formatGeolocationURI(uri)
	}
	if geolocation := BuildGeolocationHeader(cfg.GeolocationValues...); geolocation != "" {
		return geolocation
	}
	if len(cfg.PIDFLOBody) > 0 || strings.TrimSpace(cfg.PIDFLOContentID) != "" {
		if contentID := emergencyContentIDForHeader(cfg.PIDFLOContentID, defaultEmergencyPIDFLOContentID); contentID != "" {
			return formatGeolocationURI("cid:" + contentID)
		}
	}
	lat := strings.TrimSpace(cfg.Address.Latitude)
	lon := strings.TrimSpace(cfg.Address.Longitude)
	if lat == "" || lon == "" {
		return ""
	}
	return formatGeolocationURI("geo:" + lat + "," + lon)
}

func emergencyAddressHasGeolocation(address EmergencyAddress) bool {
	return strings.TrimSpace(address.Latitude) != "" && strings.TrimSpace(address.Longitude) != ""
}

func formatGeolocationURI(uri string) string {
	uri = strings.TrimSpace(uri)
	if uri == "" {
		return ""
	}
	if strings.HasPrefix(uri, "<") {
		return uri
	}
	return "<" + uri + ">;inserted-by=endpoint"
}

func formatGeolocationHeaderValue(value GeolocationHeaderValue) string {
	uri := strings.TrimSpace(value.URI)
	if uri == "" {
		return ""
	}
	params := normalizeSIPHeaderParameters(value.Parameters)
	if strings.HasPrefix(uri, "<") {
		parsed, err := parseGeolocationHeaderValue(uri)
		if err != nil {
			return ""
		}
		uri = parsed.URI
		params = mergeSIPHeaderParameters(parsed.Parameters, params)
	}
	if uri == "" {
		return ""
	}
	var b strings.Builder
	b.WriteByte('<')
	b.WriteString(uri)
	b.WriteByte('>')
	appendSIPHeaderParameters(&b, params)
	return b.String()
}

func parseGeolocationHeaderValue(value string) (GeolocationHeaderValue, error) {
	var uri string
	var params string
	if strings.HasPrefix(value, "<") {
		end := strings.Index(value, ">")
		if end < 0 {
			return GeolocationHeaderValue{}, fmt.Errorf("%w: geolocation missing closing angle", ErrInvalidEmergencySIP)
		}
		uri = strings.TrimSpace(value[1:end])
		params = strings.TrimSpace(value[end+1:])
		if params != "" && !strings.HasPrefix(params, ";") {
			return GeolocationHeaderValue{}, fmt.Errorf("%w: geolocation unexpected text after URI", ErrInvalidEmergencySIP)
		}
	} else {
		uri, params, _ = strings.Cut(value, ";")
		uri = strings.TrimSpace(uri)
		if params != "" {
			params = ";" + params
		}
	}
	if uri == "" {
		return GeolocationHeaderValue{}, fmt.Errorf("%w: geolocation URI is empty", ErrInvalidEmergencySIP)
	}
	parsedParams, err := parseSIPHeaderParameters(params)
	if err != nil {
		return GeolocationHeaderValue{}, err
	}
	return GeolocationHeaderValue{URI: uri, Parameters: parsedParams}, nil
}

func mergeSIPHeaderParameters(base, override map[string]string) map[string]string {
	if len(base) == 0 {
		return normalizeSIPHeaderParameters(override)
	}
	out := normalizeSIPHeaderParameters(base)
	for key, value := range normalizeSIPHeaderParameters(override) {
		out[key] = value
	}
	return out
}

func normalizeSIPHeaderParameters(params map[string]string) map[string]string {
	if len(params) == 0 {
		return nil
	}
	out := make(map[string]string, len(params))
	for key, value := range params {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			continue
		}
		out[key] = strings.TrimSpace(value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func appendSIPHeaderParameters(b *strings.Builder, params map[string]string) {
	params = normalizeSIPHeaderParameters(params)
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		b.WriteByte(';')
		b.WriteString(key)
		if value := strings.TrimSpace(params[key]); value != "" {
			b.WriteByte('=')
			b.WriteString(formatSIPParamValue(value))
		}
	}
}

func parseSIPHeaderParameters(params string) (map[string]string, error) {
	params = strings.TrimSpace(params)
	if params == "" {
		return nil, nil
	}
	params = strings.TrimPrefix(params, ";")
	parts, err := splitSIPHeaderSegments(params, ';')
	if err != nil {
		return nil, err
	}
	out := make(map[string]string)
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, hasValue := strings.Cut(part, "=")
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			return nil, fmt.Errorf("%w: SIP header parameter name is empty", ErrInvalidEmergencySIP)
		}
		if !hasValue {
			out[key] = ""
			continue
		}
		parsedValue, err := parseSIPHeaderParameterValue(value)
		if err != nil {
			return nil, err
		}
		out[key] = parsedValue
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func parseSIPHeaderParameterValue(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	quotedStart := strings.HasPrefix(value, `"`)
	quotedEnd := strings.HasSuffix(value, `"`)
	if quotedStart || quotedEnd {
		if !quotedStart || !quotedEnd || len(value) < 2 {
			return "", fmt.Errorf("%w: malformed quoted SIP header parameter", ErrInvalidEmergencySIP)
		}
		return unquoteSIPHeaderParameter(value), nil
	}
	if strings.Contains(value, `"`) {
		return "", fmt.Errorf("%w: unexpected quote in SIP header parameter", ErrInvalidEmergencySIP)
	}
	return value, nil
}

func splitSIPHeaderSegments(s string, sep rune) ([]string, error) {
	var out []string
	var b strings.Builder
	inQuote := false
	escaped := false
	angleDepth := 0
	for _, r := range s {
		if escaped {
			b.WriteRune(r)
			escaped = false
			continue
		}
		if inQuote {
			b.WriteRune(r)
			if r == '\\' {
				escaped = true
			} else if r == '"' {
				inQuote = false
			}
			continue
		}
		switch r {
		case '"':
			inQuote = true
			b.WriteRune(r)
		case '<':
			angleDepth++
			b.WriteRune(r)
		case '>':
			if angleDepth == 0 {
				return nil, fmt.Errorf("%w: unexpected closing angle", ErrInvalidEmergencySIP)
			}
			angleDepth--
			b.WriteRune(r)
		default:
			if r == sep && angleDepth == 0 {
				out = append(out, b.String())
				b.Reset()
				continue
			}
			b.WriteRune(r)
		}
	}
	if escaped || inQuote {
		return nil, fmt.Errorf("%w: unterminated quoted SIP header value", ErrInvalidEmergencySIP)
	}
	if angleDepth != 0 {
		return nil, fmt.Errorf("%w: unterminated angle URI", ErrInvalidEmergencySIP)
	}
	out = append(out, b.String())
	return out, nil
}

func unquoteSIPHeaderParameter(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '"' || value[len(value)-1] != '"' {
		return value
	}
	var b strings.Builder
	escaped := false
	for _, r := range value[1 : len(value)-1] {
		if escaped {
			b.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		b.WriteRune(r)
	}
	if escaped {
		b.WriteByte('\\')
	}
	return b.String()
}

func formatSIPParamValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if isSIPToken(value) {
		return value
	}
	return quoteSIPParamValue(value)
}

func isSIPToken(value string) bool {
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		switch r {
		case '-', '.', '!', '%', '*', '_', '+', '`', '\'', '~':
			continue
		default:
			return false
		}
	}
	return value != ""
}

func quoteSIPParamValue(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		if r == '\\' || r == '"' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

func validateEmergencyPIDFLOUsageRules(cfg EmergencyPIDFLOConfig, rules EmergencyPIDFLOUsageRules) error {
	if rules.RetentionExpiry.IsZero() || cfg.Timestamp.IsZero() {
		return nil
	}
	if !rules.RetentionExpiry.After(cfg.Timestamp) {
		return fmt.Errorf("%w: pidf-lo retention-expiry must be after timestamp", ErrInvalidEmergencySIP)
	}
	return nil
}

func emergencyPIDFLOUsageRulesPresent(rules EmergencyPIDFLOUsageRules) bool {
	return rules.RetransmissionAllowed != nil ||
		!rules.RetentionExpiry.IsZero() ||
		strings.TrimSpace(rules.RulesetReference) != "" ||
		strings.TrimSpace(rules.NoteWell) != ""
}

func emergencyAddressHasPIDFLOLocation(address EmergencyAddress) bool {
	return emergencyAddressHasGeolocation(address) || len(emergencyAddressPIDFLOCivicFields(address)) > 0
}

func emergencyAddressPIDFLOCivicFields(address EmergencyAddress) []pidfLOCivicField {
	var fields []pidfLOCivicField
	fields = appendPIDFLOCivicField(fields, "country", firstNonEmpty(address.Country, address.Fields["country"]))
	fields = appendPIDFLOCivicField(fields, "A1", firstNonEmpty(address.State, address.Fields["state"]))
	fields = appendPIDFLOCivicField(fields, "A2", firstNonEmpty(address.County, address.Fields["county"]))
	fields = appendPIDFLOCivicField(fields, "A3", firstNonEmpty(address.City, address.Fields["city"]))
	fields = appendPIDFLOCivicField(fields, "A4", firstNonEmpty(address.District, address.Fields["district"]))
	fields = appendPIDFLOCivicField(fields, "A5", firstNonEmpty(address.Neighborhood, address.Fields["neighborhood"]))
	fields = appendPIDFLOCivicField(fields, "A6", firstNonEmpty(address.Street, address.Fields["street"]))
	fields = appendPIDFLOCivicField(fields, "PRD", firstNonEmpty(address.StreetDirection, address.Fields["street_direction"]))
	fields = appendPIDFLOCivicField(fields, "POD", firstNonEmpty(address.StreetPostDirection, address.Fields["street_post_direction"]))
	fields = appendPIDFLOCivicField(fields, "STS", firstNonEmpty(address.StreetSuffix, address.Fields["street_suffix"]))
	fields = appendPIDFLOCivicField(fields, "HNO", firstNonEmpty(address.HouseNumber, address.Fields["house_number"]))
	fields = appendPIDFLOCivicField(fields, "HNS", firstNonEmpty(address.HouseNumberSuffix, address.Fields["house_number_suffix"]))
	fields = appendPIDFLOCivicField(fields, "UNIT", firstNonEmpty(address.Unit, address.Fields["unit"]))
	fields = appendPIDFLOCivicField(fields, "BLD", firstNonEmpty(address.Building, address.Fields["building"]))
	fields = appendPIDFLOCivicField(fields, "FLR", firstNonEmpty(address.Floor, address.Fields["floor"]))
	fields = appendPIDFLOCivicField(fields, "ROOM", firstNonEmpty(address.Room, address.Fields["room"]))
	fields = appendPIDFLOCivicField(fields, "NAM", firstNonEmpty(address.Name, address.Fields["name"]))
	fields = appendPIDFLOCivicField(fields, "PC", firstNonEmpty(address.PostalCode, address.Fields["postal_code"]))
	fields = appendPIDFLOCivicField(fields, "LMK", firstNonEmpty(address.Landmark, address.Fields["landmark"]))
	fields = appendPIDFLOCivicField(fields, "LOC", firstNonEmpty(address.LocationDescription, address.Fields["location_description"]))
	fields = appendPIDFLOCivicField(fields, "PLC", firstNonEmpty(address.PlaceType, address.Fields["place_type"]))
	fields = appendPIDFLOCivicField(fields, "PRM", firstNonEmpty(address.Premise, address.Fields["premise"]))
	fields = appendPIDFLOCivicField(fields, "POBOX", firstNonEmpty(address.PostOfficeBox, address.Fields["post_office_box"]))
	fields = appendPIDFLOCivicField(fields, "ADDCODE", firstNonEmpty(address.AdditionalCode, address.Fields["additional_code"]))
	fields = appendPIDFLOCivicField(fields, "SEAT", firstNonEmpty(address.Seat, address.Fields["seat"]))
	fields = appendPIDFLOCivicField(fields, "RDSEC", firstNonEmpty(address.RoadSection, address.Fields["road_section"]))
	fields = appendPIDFLOCivicField(fields, "RDBR", firstNonEmpty(address.RoadBranch, address.Fields["road_branch"]))
	fields = appendPIDFLOCivicField(fields, "RDSUBBR", firstNonEmpty(address.RoadSubBranch, address.Fields["road_sub_branch"]))
	return fields
}

func appendPIDFLOCivicField(fields []pidfLOCivicField, name, value string) []pidfLOCivicField {
	if value = strings.TrimSpace(value); value != "" {
		fields = append(fields, pidfLOCivicField{name: name, value: value})
	}
	return fields
}

type pidfLOElement struct {
	local string
	key   string
	text  []byte
}

type pidfLOCivicField struct {
	name  string
	value string
}

const pidfLOPositionKey = "\x00pidf-lo-position"

func encodePIDFLOStart(enc *xml.Encoder, local string, attrs ...xml.Attr) error {
	return enc.EncodeToken(xml.StartElement{Name: xml.Name{Local: local}, Attr: attrs})
}

func encodePIDFLOEnd(enc *xml.Encoder, local string) error {
	return enc.EncodeToken(xml.EndElement{Name: xml.Name{Local: local}})
}

func encodePIDFLOTextElement(enc *xml.Encoder, local, value string) error {
	if err := encodePIDFLOStart(enc, local); err != nil {
		return err
	}
	if err := enc.EncodeToken(xml.CharData(value)); err != nil {
		return err
	}
	return encodePIDFLOEnd(enc, local)
}

func encodePIDFLOUsageRules(enc *xml.Encoder, rules EmergencyPIDFLOUsageRules) error {
	if !emergencyPIDFLOUsageRulesPresent(rules) {
		return nil
	}
	if err := encodePIDFLOStart(enc, "gp:usage-rules"); err != nil {
		return err
	}
	if rules.RetransmissionAllowed != nil {
		value := "false"
		if *rules.RetransmissionAllowed {
			value = "true"
		}
		if err := encodePIDFLOTextElement(enc, "gp:retransmission-allowed", value); err != nil {
			return err
		}
	}
	if !rules.RetentionExpiry.IsZero() {
		if err := encodePIDFLOTextElement(enc, "gp:retention-expiry", rules.RetentionExpiry.UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	if ref := strings.TrimSpace(rules.RulesetReference); ref != "" {
		if err := encodePIDFLOTextElement(enc, "gp:ruleset-reference", ref); err != nil {
			return err
		}
	}
	if note := strings.TrimSpace(rules.NoteWell); note != "" {
		if err := encodePIDFLOTextElement(enc, "gp:note-well", note); err != nil {
			return err
		}
	}
	return encodePIDFLOEnd(enc, "gp:usage-rules")
}

func inPIDFLOCivicAddress(stack []pidfLOElement) bool {
	for i := len(stack) - 1; i >= 0; i-- {
		if strings.EqualFold(stack[i].local, "civicAddress") {
			return true
		}
	}
	return false
}

func isPIDFLOGeodeticPositionElement(local string) bool {
	return strings.EqualFold(local, "pos") || strings.EqualFold(local, "coordinates")
}

func collectPIDFLOGeodeticPosition(text string, out *EmergencyAddress) {
	text = strings.ReplaceAll(text, ",", " ")
	parts := strings.Fields(text)
	if len(parts) < 2 {
		return
	}
	if out.Latitude == "" {
		out.Latitude = parts[0]
	}
	if out.Longitude == "" {
		out.Longitude = parts[1]
	}
}

func collectPIDFLOCivicField(name, value string, out *EmergencyAddress) {
	switch name {
	case "country":
		out.Country = value
	case "A1":
		out.State = value
	case "A2":
		out.County = value
	case "A3":
		out.City = value
	case "A4":
		out.District = value
	case "A5":
		out.Neighborhood = value
	case "A6":
		out.Street = value
	case "PRD":
		out.StreetDirection = value
	case "POD":
		out.StreetPostDirection = value
	case "STS":
		out.StreetSuffix = value
	case "HNO":
		out.HouseNumber = value
	case "HNS":
		out.HouseNumberSuffix = value
	case "UNIT":
		out.Unit = value
	case "BLD":
		out.Building = value
	case "FLR":
		out.Floor = value
	case "ROOM":
		out.Room = value
	case "NAM":
		out.Name = value
	case "PC":
		out.PostalCode = value
	case "LMK":
		out.Landmark = value
	case "LOC":
		out.LocationDescription = value
	case "PLC":
		out.PlaceType = value
	case "PRM":
		out.Premise = value
	case "POBOX":
		out.PostOfficeBox = value
	case "ADDCODE":
		out.AdditionalCode = value
	case "SEAT":
		out.Seat = value
	case "RDSEC":
		out.RoadSection = value
	case "RDBR":
		out.RoadBranch = value
	case "RDSUBBR":
		out.RoadSubBranch = value
	}
	if out.Fields == nil {
		out.Fields = make(map[string]string)
	}
	out.Fields[name] = value
}

func appendEmergencyMultipartPart(dst *bytes.Buffer, boundary, contentType, contentID, disposition string, body []byte) {
	dst.WriteString("--")
	dst.WriteString(boundary)
	dst.WriteString("\r\nContent-Type: ")
	dst.WriteString(contentType)
	dst.WriteString("\r\nContent-ID: <")
	dst.WriteString(contentID)
	dst.WriteString(">")
	if disposition != "" {
		dst.WriteString("\r\nContent-Disposition: ")
		dst.WriteString(disposition)
	}
	dst.WriteString("\r\n\r\n")
	dst.Write(body)
	dst.WriteString("\r\n")
}

func chooseEmergencyMultipartBoundary(bodies ...[]byte) string {
	boundary := defaultEmergencyMultipartBoundary
	for i := 1; emergencyMultipartBoundaryCollides(boundary, bodies...); i++ {
		boundary = defaultEmergencyMultipartBoundary + "-" + strconv.Itoa(i)
	}
	return boundary
}

func emergencyMultipartBoundaryCollides(boundary string, bodies ...[]byte) bool {
	marker := []byte("--" + boundary)
	for _, body := range bodies {
		if bytes.Contains(body, marker) {
			return true
		}
	}
	return false
}

func normalizeEmergencyContentID(value, fallback string) (string, error) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(strings.ToLower(value), "cid:") {
		value = strings.TrimSpace(value[4:])
	}
	if strings.HasPrefix(value, "<") || strings.HasSuffix(value, ">") {
		if len(value) < 2 || value[0] != '<' || value[len(value)-1] != '>' {
			return "", fmt.Errorf("%w: invalid content-id", ErrInvalidEmergencySIP)
		}
		value = strings.TrimSpace(value[1 : len(value)-1])
	}
	if value == "" {
		value = fallback
	}
	if value == "" || strings.ContainsAny(value, "\r\n<> \t") {
		return "", fmt.Errorf("%w: invalid content-id", ErrInvalidEmergencySIP)
	}
	return value, nil
}

func emergencyContentIDForHeader(value, fallback string) string {
	contentID, err := normalizeEmergencyContentID(value, fallback)
	if err != nil {
		return ""
	}
	return contentID
}

func validateEmergencyMultipartBoundary(boundary string) error {
	if boundary == "" || len(boundary) > 70 {
		return fmt.Errorf("%w: invalid multipart boundary", ErrInvalidEmergencySIP)
	}
	for _, r := range boundary {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		switch r {
		case '\'', '(', ')', '+', '_', ',', '-', '.', '/', ':', '=', '?':
			continue
		default:
			return fmt.Errorf("%w: invalid multipart boundary", ErrInvalidEmergencySIP)
		}
	}
	return nil
}

func emergencyContactURIHasMarker(uri string) bool {
	base, _, _ := strings.Cut(strings.TrimSpace(uri), "?")
	semi := strings.Index(base, ";")
	if semi < 0 {
		return false
	}
	for _, param := range strings.Split(base[semi+1:], ";") {
		key, value, _ := strings.Cut(param, "=")
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.ToLower(strings.Trim(strings.TrimSpace(value), `"`))
		if key == EmergencyContactURIParamSOS {
			return true
		}
		if key == EmergencyContactURIParamRegType && value == EmergencyContactURIParamSOS {
			return true
		}
	}
	return false
}

func formatEmergencySIPRoute(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "<") {
		return value
	}
	uri := value
	lower := strings.ToLower(uri)
	if !strings.HasPrefix(lower, "sip:") && !strings.HasPrefix(lower, "sips:") && !strings.Contains(uri, ":") {
		uri = "sip:" + uri
		lower = strings.ToLower(uri)
	}
	if strings.HasPrefix(lower, "sip:") || strings.HasPrefix(lower, "sips:") {
		uri = ensureEmergencyLooseRoute(uri)
	}
	return "<" + uri + ">"
}

func ensureEmergencyLooseRoute(uri string) string {
	base, suffix, ok := strings.Cut(uri, "?")
	if strings.Contains(strings.ToLower(base), ";lr") {
		return uri
	}
	if ok {
		return base + ";lr?" + suffix
	}
	return base + ";lr"
}

func containsEmergencySIPRoute(routes []string, route string) bool {
	for _, existing := range routes {
		if strings.EqualFold(existing, route) {
			return true
		}
	}
	return false
}
