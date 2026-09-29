package e911

import (
	"strings"
	"time"

	"github.com/boa-z/vowifi-go/runtimehost/voiceclient"
)

const (
	EmergencyLocationSourceNone        = ""
	EmergencyLocationSourceConfig      = "config"
	EmergencyLocationSourceEntitlement = "entitlement"
)

const (
	EmergencyLocationRevalidationReasonNone    = ""
	EmergencyLocationRevalidationReasonMissing = "missing-location"
	EmergencyLocationRevalidationReasonExpired = "expired-location"
	EmergencyLocationRevalidationReasonInvalid = "invalid-location"
	EmergencyLocationRevalidationReasonPending = "pending-location-validation"
)

const (
	EmergencySIPRetryActionNone                = "none"
	EmergencySIPRetryActionRetrySameRequest    = "retry-same-request"
	EmergencySIPRetryActionAlternativeService  = "alternative-service"
	EmergencySIPRetryActionRefreshLocation     = "refresh-location"
	EmergencySIPRetryActionRecoverRegistration = "recover-registration"
	EmergencySIPRetryActionRefreshRoute        = "refresh-route"
)

type EmergencyNumberClassification struct {
	Input           string
	DialString      string
	CanonicalNumber string
	Emergency       bool
	ServiceURN      string
	Category        EmergencyServiceCategory
}

type EmergencyPlanConfig struct {
	DialString          string
	ServiceURN          string
	Category            EmergencyServiceCategory
	Now                 time.Time
	Cache               *EntitlementCache
	EntitlementSnapshot EntitlementSnapshot
	SIPHeaderConfig     EmergencySIPHeaderConfig
	IncludePIDFLO       bool
	PIDFLOConfig        EmergencyPIDFLOConfig
	PIDFLOUsageRules    EmergencyPIDFLOUsageRules
	Profile             voiceclient.IMSProfile
	Registration        voiceclient.RegistrationBinding
	ContactURI          string
	RegisterCallID      string
	RegisterCSeq        string
}

type EmergencyPlan struct {
	Emergency    bool
	DialString   string
	Number       EmergencyNumberClassification
	Service      EmergencyServiceClassification
	ServiceURN   string
	Category     EmergencyServiceCategory
	Entitlement  EmergencyEntitlementPlan
	Location     EmergencyLocationPlan
	SIP          EmergencySIPRequestInfo
	RequestURI   string
	Headers      map[string]string
	Routes       []EmergencyRoute
	RouteSet     []string
	Profile      voiceclient.IMSProfile
	Registration EmergencyRegistrationPlan
	Call         EmergencyCallPlan
}

type EmergencyEntitlementPlan struct {
	Snapshot              EntitlementSnapshot
	Decision              EntitlementCacheDecision
	Cached                bool
	CanUseCache           bool
	UseCache              bool
	RefreshRequired       bool
	RefreshNow            bool
	RefreshDeferred       bool
	RefreshReason         string
	NextAttemptAt         time.Time
	RetryAfter            time.Time
	RetryAfterDelay       time.Duration
	CanUseStaleOnError    bool
	StaleIfErrorExpiresAt time.Time
	ServiceSupported      bool
	RoutesUsable          bool
}

type EmergencyLocationPlan struct {
	Source                   string
	Address                  EmergencyAddress
	HasLocation              bool
	ValidationStatus         string
	Revalidation             EmergencyLocationRevalidationPlan
	GeolocationURI           string
	GeolocationHeader        string
	GeolocationRouting       bool
	GeolocationRoutingHeader string
	PIDFLOPresent            bool
	PIDFLOContentID          string
	PIDFLOContentType        string
	PIDFLOBody               []byte
	Routes                   []EmergencyRoute
	RouteSet                 []string
}

type EmergencyLocationRevalidationPlan struct {
	Required                 bool
	Reason                   string
	Missing                  bool
	Expired                  bool
	Invalid                  bool
	Pending                  bool
	EntitlementRefreshNeeded bool
	Retryable                bool
	RetryDeferred            bool
	RetryAfter               time.Time
	RetryAfterDelay          time.Duration
	NextAttemptAt            time.Time
	CanUseStaleOnError       bool
}

type EmergencyRegistrationPlan struct {
	Required          bool
	AlreadyRegistered bool
	Profile           voiceclient.IMSProfile
	ContactURI        string
	ContactHeader     string
	Headers           map[string]string
	Validation        EmergencyRegistrationValidation
}

type EmergencyCallPlan struct {
	Required    bool
	RequestURI  string
	Headers     map[string]string
	Routes      []EmergencyRoute
	RouteSet    []string
	RequestInfo EmergencySIPRequestInfo
	Body        EmergencyBodyPlan
}

type EmergencyBodyPlan struct {
	PIDFLOPresent     bool
	PIDFLOContentID   string
	PIDFLOContentType string
	PIDFLOBody        []byte
}

type EmergencySIPRetryPlan struct {
	Failure                    EmergencySIPFailure
	Action                     string
	Retry                      bool
	RetryAfter                 time.Duration
	NextAttemptAt              time.Time
	RegistrationRecoveryNeeded bool
	RouteRefreshNeeded         bool
	EntitlementRefreshNeeded   bool
	LocationRefreshNeeded      bool
	RebuildEmergencyPlan       bool
	RebuildPIDFLO              bool
	AlternativeService         bool
	AlternativeServiceURN      string
	AlternativeContactURI      string
	NextServiceURN             string
	NextRequestURI             string
	NextRouteSet               []string
	NextHeaders                map[string]string
	Reason                     string
}

// EmergencyRevalidationInputs captures the refresh and routing inputs that a
// runtime should prepare before retrying an emergency request after a SIP
// failure.
type EmergencyRevalidationInputs struct {
	Emergency                bool
	Required                 bool
	Retry                    bool
	Failure                  EmergencySIPFailure
	RetryPlan                EmergencySIPRetryPlan
	EntitlementRefreshNeeded bool
	LocationRefreshNeeded    bool
	RouteRefreshNeeded       bool
	RebuildEmergencyPlan     bool
	RebuildPIDFLO            bool
	AlternativeService       bool
	AlternativeServiceURN    string
	AlternativeServiceURNs   []string
	AlternativeContactURI    string
	ContactURIs              []string
	NextServiceURN           string
	NextRequestURI           string
	NextRouteSet             []string
	NextHeaders              map[string]string
	RetryAfter               time.Duration
	NextAttemptAt            time.Time
	Reason                   string
}

func ClassifyEmergencyNumber(value string) EmergencyNumberClassification {
	input := strings.TrimSpace(value)
	candidate := emergencyDialStringCandidate(input)
	canonical := canonicalEmergencyDialString(candidate)
	if canonical == "" {
		return EmergencyNumberClassification{Input: input, DialString: strings.TrimSpace(candidate)}
	}
	return EmergencyNumberClassification{
		Input:           input,
		DialString:      strings.TrimSpace(candidate),
		CanonicalNumber: canonical,
		Emergency:       true,
		ServiceURN:      DefaultEmergencyServiceURN,
	}
}

func IsEmergencyNumber(value string) bool {
	return ClassifyEmergencyNumber(value).Emergency
}

func EmergencyServiceURNForNumber(value string) string {
	return ClassifyEmergencyNumber(value).ServiceURN
}

func EmergencyAddressHasGeolocation(address EmergencyAddress) bool {
	return emergencyAddressHasGeolocation(address)
}

func EmergencyAddressHasLocation(address EmergencyAddress) bool {
	return emergencyAddressHasPIDFLOLocation(address)
}

func BuildEmergencyPlan(cfg EmergencyPlanConfig) (EmergencyPlan, error) {
	now := entitlementCacheNow(cfg.Now)
	number, service, serviceURN, category, emergency := emergencyPlanTarget(cfg)
	plan := EmergencyPlan{
		Emergency:  emergency,
		DialString: strings.TrimSpace(cfg.DialString),
		Number:     number,
		Service:    service,
		ServiceURN: serviceURN,
		Category:   category,
	}
	if !emergency {
		return plan, nil
	}

	snapshot, decision := emergencyPlanEntitlement(cfg, now)
	plan.Entitlement = emergencyEntitlementPlan(snapshot, decision)

	sipCfg, locationSource, err := emergencyPlanSIPConfig(cfg, snapshot, serviceURN, now)
	if err != nil {
		return plan, err
	}
	info, usedCache := emergencyPlanSIPRequestInfo(snapshot, sipCfg)
	plan.Entitlement.UseCache = usedCache
	plan.Entitlement.ServiceSupported = usedCache
	plan.Entitlement.RoutesUsable = usedCache && len(info.Routes) > 0

	profile := emergencyPlanProfile(cfg.Profile, info.Headers)
	registration, err := emergencyPlanRegistration(cfg, profile, emergency)
	if err != nil {
		return plan, err
	}

	plan.SIP = cloneEmergencySIPRequestInfo(info)
	plan.RequestURI = info.RequestURI
	plan.Headers = copyStringMap(info.Headers)
	plan.Routes = copyEmergencyRoutes(info.Routes)
	plan.RouteSet = copyStringSlice(info.RouteSet)
	plan.Profile = profile
	plan.Registration = registration
	plan.Location = emergencyLocationPlan(locationSource, sipCfg.Address, snapshot, decision, info)
	plan.Call = EmergencyCallPlan{
		Required:    true,
		RequestURI:  info.RequestURI,
		Headers:     copyStringMap(info.Headers),
		Routes:      copyEmergencyRoutes(info.Routes),
		RouteSet:    copyStringSlice(info.RouteSet),
		RequestInfo: cloneEmergencySIPRequestInfo(info),
		Body:        emergencyBodyPlan(info),
	}
	return plan, nil
}

func PlanEmergencyCall(number string, snapshot EntitlementSnapshot, cfg EmergencySIPHeaderConfig, now time.Time) (EmergencyPlan, error) {
	return BuildEmergencyPlan(EmergencyPlanConfig{
		DialString:          number,
		EntitlementSnapshot: snapshot,
		SIPHeaderConfig:     cfg,
		Now:                 now,
	})
}

func PlanEmergencyCallWithCache(number string, cache *EntitlementCache, cfg EmergencySIPHeaderConfig, now time.Time) (EmergencyPlan, error) {
	return BuildEmergencyPlan(EmergencyPlanConfig{
		DialString:      number,
		Cache:           cache,
		SIPHeaderConfig: cfg,
		Now:             now,
	})
}

func PlanEmergencySIPRetry(current EmergencyPlan, resp voiceclient.SIPResponse, now time.Time) EmergencySIPRetryPlan {
	failure := ClassifyEmergencySIPFailure(resp)
	plan := EmergencySIPRetryPlan{
		Failure:                    failure,
		Action:                     EmergencySIPRetryActionNone,
		RetryAfter:                 failure.RetryAfter,
		RegistrationRecoveryNeeded: failure.RegistrationRecoveryNeeded,
		RouteRefreshNeeded:         failure.RouteRefreshNeeded,
		EntitlementRefreshNeeded:   failure.EntitlementRefreshNeeded,
		LocationRefreshNeeded:      failure.LocationRefreshNeeded,
		NextServiceURN:             strings.TrimSpace(current.ServiceURN),
		NextRequestURI:             strings.TrimSpace(current.RequestURI),
		NextRouteSet:               copyStringSlice(current.RouteSet),
		NextHeaders:                copyStringMap(current.Headers),
		Reason:                     strings.TrimSpace(failure.Reason),
	}
	if plan.NextRequestURI == "" {
		plan.NextRequestURI = strings.TrimSpace(current.Call.RequestURI)
	}
	if len(plan.NextRouteSet) == 0 {
		plan.NextRouteSet = copyStringSlice(current.Call.RouteSet)
	}
	if len(plan.NextHeaders) == 0 {
		plan.NextHeaders = copyStringMap(current.Call.Headers)
	}
	if !failure.Retryable {
		if plan.Reason == "" {
			plan.Reason = "emergency SIP failure is not retryable"
		}
		return plan
	}
	plan.Retry = true
	if failure.RetryAfter > 0 && !now.IsZero() {
		plan.NextAttemptAt = now.Add(failure.RetryAfter)
	}
	switch {
	case failure.AlternativeService:
		plan.applyAlternativeEmergencyService(failure)
	case failure.LocationRefreshNeeded || failure.EntitlementRefreshNeeded:
		plan.Action = EmergencySIPRetryActionRefreshLocation
		plan.RebuildEmergencyPlan = true
		plan.RebuildPIDFLO = true
		if plan.Reason == "" {
			plan.Reason = "emergency location refresh required"
		}
	case failure.RegistrationRecoveryNeeded:
		plan.Action = EmergencySIPRetryActionRecoverRegistration
		if plan.Reason == "" {
			plan.Reason = "emergency registration recovery required"
		}
	case failure.RouteRefreshNeeded:
		plan.Action = EmergencySIPRetryActionRefreshRoute
		plan.RebuildEmergencyPlan = true
		if plan.Reason == "" {
			plan.Reason = "emergency route refresh required"
		}
	default:
		plan.Action = EmergencySIPRetryActionRetrySameRequest
		if plan.Reason == "" {
			plan.Reason = "emergency request retry required"
		}
	}
	return plan
}

// PrepareEmergencyRevalidationInputs classifies a SIP response and returns the
// emergency-only refresh, PIDF-LO rebuild, and alternate routing inputs needed
// before a retry.
func PrepareEmergencyRevalidationInputs(current EmergencyPlan, resp voiceclient.SIPResponse, now time.Time) EmergencyRevalidationInputs {
	failure := ClassifyEmergencySIPFailure(resp)
	out := EmergencyRevalidationInputs{
		Emergency:              emergencyPlanTargetsEmergency(current),
		Failure:                cloneEmergencySIPFailure(failure),
		AlternativeServiceURNs: copyStringSlice(failure.AlternativeServiceURNs),
		ContactURIs:            copyStringSlice(failure.ContactURIs),
		RetryAfter:             failure.RetryAfter,
		Reason:                 strings.TrimSpace(failure.Reason),
	}
	if !out.Emergency || !failure.Retryable {
		return out
	}

	retry := PlanEmergencySIPRetry(current, resp, now)
	out.RetryPlan = cloneEmergencySIPRetryPlan(retry)
	out.Retry = retry.Retry
	out.EntitlementRefreshNeeded = retry.EntitlementRefreshNeeded
	out.LocationRefreshNeeded = retry.LocationRefreshNeeded
	out.RouteRefreshNeeded = retry.RouteRefreshNeeded
	out.RebuildEmergencyPlan = retry.RebuildEmergencyPlan
	out.RebuildPIDFLO = retry.RebuildPIDFLO
	out.AlternativeService = retry.AlternativeService
	out.AlternativeServiceURN = strings.TrimSpace(retry.AlternativeServiceURN)
	out.AlternativeContactURI = strings.TrimSpace(retry.AlternativeContactURI)
	out.NextServiceURN = strings.TrimSpace(retry.NextServiceURN)
	out.NextRequestURI = strings.TrimSpace(retry.NextRequestURI)
	out.NextRouteSet = copyStringSlice(retry.NextRouteSet)
	out.NextHeaders = copyStringMap(retry.NextHeaders)
	out.RetryAfter = retry.RetryAfter
	out.NextAttemptAt = retry.NextAttemptAt
	out.Reason = strings.TrimSpace(retry.Reason)
	out.Required = emergencyRevalidationRequired(retry)
	return out
}

func (p *EmergencySIPRetryPlan) applyAlternativeEmergencyService(failure EmergencySIPFailure) {
	p.Action = EmergencySIPRetryActionAlternativeService
	p.AlternativeService = true
	p.RouteRefreshNeeded = true
	if serviceURN := firstEmergencyRetryAlternativeServiceURN(failure); serviceURN != "" {
		p.AlternativeServiceURN = serviceURN
		p.NextServiceURN = serviceURN
		p.NextRequestURI = EmergencyRequestURI(serviceURN)
	}
	if contactURI := firstEmergencyRetryAlternativeContactURI(failure.ContactURIs); contactURI != "" {
		p.AlternativeContactURI = contactURI
		if p.AlternativeServiceURN == "" {
			p.NextRequestURI = contactURI
		}
	}
	if routeSet := emergencyRetryRouteSetFromContacts(failure.ContactURIs); len(routeSet) > 0 {
		p.NextRouteSet = routeSet
	}
	if p.Reason == "" {
		p.Reason = "alternative emergency service available"
	}
}

func firstEmergencyRetryAlternativeServiceURN(failure EmergencySIPFailure) string {
	if len(failure.AlternativeServiceURNs) > 0 {
		return strings.TrimSpace(failure.AlternativeServiceURNs[0])
	}
	for _, contact := range failure.ContactURIs {
		if urn := NormalizeEmergencyServiceURN(contact); urn != "" {
			return urn
		}
	}
	return ""
}

func firstEmergencyRetryAlternativeContactURI(contacts []string) string {
	for _, contact := range contacts {
		contact = strings.TrimSpace(contact)
		lower := strings.ToLower(contact)
		if strings.HasPrefix(lower, "sip:") || strings.HasPrefix(lower, "sips:") {
			return contact
		}
	}
	return ""
}

func emergencyRetryRouteSetFromContacts(contacts []string) []string {
	var out []string
	for _, contact := range contacts {
		route := emergencyRetryRouteFromContact(contact)
		if route != "" {
			out = appendUniqueStrings(out, route)
		}
	}
	return out
}

func emergencyRetryRouteFromContact(contact string) string {
	contact = strings.TrimSpace(contact)
	lower := strings.ToLower(contact)
	if !strings.HasPrefix(lower, "sip:") && !strings.HasPrefix(lower, "sips:") {
		return ""
	}
	if strings.HasPrefix(contact, "<") && strings.HasSuffix(contact, ">") {
		return contact
	}
	return "<" + contact + ">"
}

func emergencyRevalidationRequired(retry EmergencySIPRetryPlan) bool {
	return retry.Retry && (retry.EntitlementRefreshNeeded ||
		retry.LocationRefreshNeeded ||
		retry.RouteRefreshNeeded ||
		retry.RebuildEmergencyPlan ||
		retry.RebuildPIDFLO ||
		retry.AlternativeService)
}

func emergencyPlanTargetsEmergency(plan EmergencyPlan) bool {
	if plan.Emergency || plan.Number.Emergency || plan.Service.Emergency {
		return true
	}
	for _, value := range []string{
		plan.DialString,
		plan.ServiceURN,
		plan.RequestURI,
		plan.Call.RequestURI,
	} {
		if ClassifyEmergencyNumber(value).Emergency || ClassifyEmergencyService(value).Emergency {
			return true
		}
	}
	return false
}

func emergencyPlanTarget(cfg EmergencyPlanConfig) (EmergencyNumberClassification, EmergencyServiceClassification, string, EmergencyServiceCategory, bool) {
	number := ClassifyEmergencyNumber(cfg.DialString)
	serviceValue := firstNonEmpty(cfg.ServiceURN, cfg.SIPHeaderConfig.ServiceURN)
	service := ClassifyEmergencyService(serviceValue)
	if service.Emergency {
		return number, service, service.ServiceURN, service.Category, true
	}
	if cfg.Category != 0 {
		urns := EmergencyServiceURNsForCategory(cfg.Category)
		if len(urns) > 0 {
			return number, ClassifyEmergencyService(urns[0]), urns[0], cfg.Category, true
		}
	}
	if number.Emergency {
		return number, ClassifyEmergencyService(number.ServiceURN), number.ServiceURN, number.Category, true
	}
	if fromDial := ClassifyEmergencyService(cfg.DialString); fromDial.Emergency {
		return number, fromDial, fromDial.ServiceURN, fromDial.Category, true
	}
	return number, service, "", 0, false
}

func emergencyPlanEntitlement(cfg EmergencyPlanConfig, now time.Time) (EntitlementSnapshot, EntitlementCacheDecision) {
	if cfg.Cache != nil {
		snapshot := cfg.Cache.Snapshot(now)
		return snapshot, snapshot.CacheDecision(now)
	}
	snapshot := cloneEntitlementSnapshot(cfg.EntitlementSnapshot)
	if !snapshot.Cached && snapshot.RefreshReason == "" && snapshot.StoredAt.IsZero() && !entitlementInfoHasData(snapshot.Info) {
		snapshot = entitlementSnapshot(EntitlementInfo{}, time.Time{}, now, false, EntitlementCachePolicy{})
	}
	return snapshot, ClassifyEntitlementCacheDecision(snapshot, now)
}

func emergencyEntitlementPlan(snapshot EntitlementSnapshot, decision EntitlementCacheDecision) EmergencyEntitlementPlan {
	return EmergencyEntitlementPlan{
		Snapshot:              cloneEntitlementSnapshot(snapshot),
		Decision:              decision,
		Cached:                decision.Cached,
		CanUseCache:           decision.CanUseCache,
		RefreshRequired:       decision.RefreshRequired,
		RefreshNow:            decision.RefreshNow,
		RefreshDeferred:       decision.DeferRefresh,
		RefreshReason:         decision.RefreshReason,
		NextAttemptAt:         decision.NextAttemptAt,
		RetryAfter:            decision.RetryAfter,
		RetryAfterDelay:       decision.RetryAfterDelay,
		CanUseStaleOnError:    decision.CanUseStaleOnError,
		StaleIfErrorExpiresAt: decision.StaleIfErrorExpiresAt,
	}
}

func emergencyPlanSIPConfig(cfg EmergencyPlanConfig, snapshot EntitlementSnapshot, serviceURN string, now time.Time) (EmergencySIPHeaderConfig, string, error) {
	sipCfg := cfg.SIPHeaderConfig
	sipCfg.ServiceURN = serviceURN
	sipCfg.GeolocationValues = append([]GeolocationHeaderValue(nil), sipCfg.GeolocationValues...)
	sipCfg.PIDFLOBody = append([]byte(nil), sipCfg.PIDFLOBody...)
	address, source := emergencyPlanAddress(sipCfg.Address, cfg.PIDFLOConfig.Address, snapshot)
	if emergencyAddressHasPIDFLOLocation(address) {
		sipCfg.Address = address
	}

	if emergencyPlanShouldBuildPIDFLO(cfg) {
		pidfCfg := cfg.PIDFLOConfig
		if !emergencyAddressHasPIDFLOLocation(pidfCfg.Address) {
			pidfCfg.Address = address
		}
		if pidfCfg.Timestamp.IsZero() {
			pidfCfg.Timestamp = now
		}
		body, err := BuildEmergencyPIDFLOWithUsageRules(pidfCfg, cfg.PIDFLOUsageRules)
		if err != nil {
			return EmergencySIPHeaderConfig{}, source, err
		}
		sipCfg.PIDFLOBody = body
	}
	return sipCfg, source, nil
}

func emergencyPlanSIPRequestInfo(snapshot EntitlementSnapshot, cfg EmergencySIPHeaderConfig) (EmergencySIPRequestInfo, bool) {
	if info, ok := BuildUsableEmergencySIPRequestInfo(snapshot, cfg); ok {
		return info, true
	}
	return BuildEmergencySIPRequestInfo(cfg), false
}

func emergencyPlanAddress(primary, pidf EmergencyAddress, snapshot EntitlementSnapshot) (EmergencyAddress, string) {
	if emergencyAddressHasPIDFLOLocation(primary) {
		return cloneEmergencyAddress(primary), EmergencyLocationSourceConfig
	}
	if emergencyAddressHasPIDFLOLocation(pidf) {
		return cloneEmergencyAddress(pidf), EmergencyLocationSourceConfig
	}
	if snapshot.Usable() && emergencyAddressHasPIDFLOLocation(snapshot.Info.Address) {
		return cloneEmergencyAddress(snapshot.Info.Address), EmergencyLocationSourceEntitlement
	}
	if emergencyAddressHasAnyField(primary) {
		return cloneEmergencyAddress(primary), EmergencyLocationSourceConfig
	}
	if emergencyAddressHasAnyField(pidf) {
		return cloneEmergencyAddress(pidf), EmergencyLocationSourceConfig
	}
	if emergencyAddressHasAnyField(snapshot.Info.Address) {
		return cloneEmergencyAddress(snapshot.Info.Address), EmergencyLocationSourceEntitlement
	}
	return EmergencyAddress{}, EmergencyLocationSourceNone
}

func emergencyPlanShouldBuildPIDFLO(cfg EmergencyPlanConfig) bool {
	return cfg.IncludePIDFLO || emergencyPIDFLOConfigPresent(cfg.PIDFLOConfig) || emergencyPIDFLOUsageRulesPresent(cfg.PIDFLOUsageRules)
}

func emergencyPIDFLOConfigPresent(cfg EmergencyPIDFLOConfig) bool {
	return firstNonEmpty(cfg.Entity, cfg.TupleID, cfg.Method) != "" ||
		!cfg.Timestamp.IsZero() ||
		emergencyAddressHasPIDFLOLocation(cfg.Address)
}

func emergencyPlanProfile(profile voiceclient.IMSProfile, headers map[string]string) voiceclient.IMSProfile {
	if pani := emergencyStringHeaderValue(headers, "P-Access-Network-Info"); pani != "" {
		profile.AccessNetworkInfo = pani
	}
	return profile
}

func emergencyPlanRegistration(cfg EmergencyPlanConfig, profile voiceclient.IMSProfile, emergency bool) (EmergencyRegistrationPlan, error) {
	validation := EmergencyRegistrationBindingValidation(cfg.Registration)
	out := EmergencyRegistrationPlan{
		Required:          emergency && !validation.Valid,
		AlreadyRegistered: validation.Valid,
		Profile:           profile,
		Validation:        validation,
	}
	contactURI := firstNonEmpty(cfg.ContactURI, cfg.Registration.ContactURI)
	if contactURI == "" {
		return out, nil
	}
	markedURI, err := MarkEmergencyContactURI(contactURI)
	if err != nil {
		return EmergencyRegistrationPlan{}, err
	}
	out.ContactURI = markedURI
	out.ContactHeader = "<" + markedURI + ">"
	if cfg.RegisterCallID == "" || cfg.RegisterCSeq == "" {
		return out, nil
	}
	headers, err := BuildEmergencyRegisterHeaders(profile, contactURI, cfg.RegisterCallID, cfg.RegisterCSeq)
	if err != nil {
		return EmergencyRegistrationPlan{}, err
	}
	out.Headers = headers
	out.ContactHeader = headers["Contact"]
	return out, nil
}

func emergencyLocationPlan(source string, address EmergencyAddress, snapshot EntitlementSnapshot, decision EntitlementCacheDecision, info EmergencySIPRequestInfo) EmergencyLocationPlan {
	geolocationHeader := emergencyStringHeaderValue(info.Headers, "Geolocation")
	routingHeader := emergencyStringHeaderValue(info.Headers, "Geolocation-Routing")
	contentID := strings.TrimSpace(info.PIDFLOContentID)
	if len(info.PIDFLOBody) > 0 || contentID != "" {
		contentID = emergencyContentIDForHeader(contentID, defaultEmergencyPIDFLOContentID)
	}
	hasLocation := emergencyAddressHasPIDFLOLocation(address) || geolocationHeader != ""
	validationStatus := strings.TrimSpace(snapshot.Info.LocationValidationStatus)
	out := EmergencyLocationPlan{
		Source:                   source,
		Address:                  cloneEmergencyAddress(address),
		HasLocation:              hasLocation,
		ValidationStatus:         validationStatus,
		Revalidation:             emergencyLocationRevalidationPlan(source, hasLocation, validationStatus, snapshot, decision),
		GeolocationURI:           emergencyPlanGeolocationURI(geolocationHeader),
		GeolocationHeader:        geolocationHeader,
		GeolocationRouting:       strings.EqualFold(routingHeader, GeolocationRoutingYes),
		GeolocationRoutingHeader: routingHeader,
		PIDFLOPresent:            len(info.PIDFLOBody) > 0,
		PIDFLOContentID:          contentID,
		PIDFLOBody:               append([]byte(nil), info.PIDFLOBody...),
		Routes:                   copyEmergencyRoutes(info.Routes),
		RouteSet:                 copyStringSlice(info.RouteSet),
	}
	if out.PIDFLOPresent {
		out.PIDFLOContentType = EmergencyPIDFLOContentType
	}
	return out
}

func emergencyLocationRevalidationPlan(source string, hasLocation bool, validationStatus string, snapshot EntitlementSnapshot, decision EntitlementCacheDecision) EmergencyLocationRevalidationPlan {
	out := EmergencyLocationRevalidationPlan{
		RetryAfter:         decision.RetryAfter,
		RetryAfterDelay:    decision.RetryAfterDelay,
		NextAttemptAt:      decision.NextAttemptAt,
		CanUseStaleOnError: decision.CanUseStaleOnError,
	}
	if !hasLocation {
		out.Missing = true
		out.Reason = EmergencyLocationRevalidationReasonMissing
	}
	if !out.Missing && source == EmergencyLocationSourceEntitlement && !snapshot.Usable() && snapshot.RefreshReason == EntitlementRefreshReasonExpired {
		out.Expired = true
		out.Reason = EmergencyLocationRevalidationReasonExpired
	}
	switch strings.ToLower(strings.TrimSpace(validationStatus)) {
	case "invalid":
		if out.Reason == EmergencyLocationRevalidationReasonNone {
			out.Reason = EmergencyLocationRevalidationReasonInvalid
		}
		out.Invalid = true
	case "pending":
		if out.Reason == EmergencyLocationRevalidationReasonNone {
			out.Reason = EmergencyLocationRevalidationReasonPending
		}
		out.Pending = true
	}
	out.Required = out.Reason != EmergencyLocationRevalidationReasonNone
	if out.Required {
		out.EntitlementRefreshNeeded = true
		out.Retryable = true
		out.RetryDeferred = decision.DeferRefresh
	}
	return out
}

func emergencyBodyPlan(info EmergencySIPRequestInfo) EmergencyBodyPlan {
	contentID := strings.TrimSpace(info.PIDFLOContentID)
	if len(info.PIDFLOBody) > 0 || contentID != "" {
		contentID = emergencyContentIDForHeader(contentID, defaultEmergencyPIDFLOContentID)
	}
	out := EmergencyBodyPlan{
		PIDFLOContentID: contentID,
		PIDFLOBody:      append([]byte(nil), info.PIDFLOBody...),
	}
	if len(info.PIDFLOBody) > 0 {
		out.PIDFLOPresent = true
		out.PIDFLOContentType = EmergencyPIDFLOContentType
	}
	return out
}

func emergencyPlanGeolocationURI(header string) string {
	values, err := ParseGeolocationHeader(header)
	if err != nil || len(values) == 0 {
		return strings.TrimSpace(header)
	}
	return values[0].URI
}

func emergencyDialStringCandidate(value string) string {
	value = strings.TrimSpace(value)
	for {
		candidate, ok := emergencyServiceWrappedCandidate(value)
		if !ok || strings.EqualFold(strings.TrimSpace(candidate), value) {
			break
		}
		value = strings.TrimSpace(candidate)
	}
	if user, _, ok := strings.Cut(value, "@"); ok {
		value = user
	}
	if idx := strings.IndexAny(value, ";?"); idx >= 0 {
		value = value[:idx]
	}
	value = strings.Trim(strings.TrimSpace(value), `"`)
	return value
}

func canonicalEmergencyDialString(value string) string {
	var digits strings.Builder
	for _, r := range strings.TrimSpace(value) {
		switch {
		case r >= '0' && r <= '9':
			digits.WriteRune(r)
		case r == ' ' || r == '-' || r == '.' || r == '(' || r == ')':
			continue
		default:
			return ""
		}
	}
	switch digits.String() {
	case "911", "112":
		return digits.String()
	default:
		return ""
	}
}

func emergencyAddressHasAnyField(address EmergencyAddress) bool {
	if emergencyAddressHasPIDFLOLocation(address) {
		return true
	}
	return firstNonEmpty(
		address.Street, address.Unit, address.City, address.State, address.PostalCode,
		address.Country, address.Formatted, address.HouseNumber, address.HouseNumberSuffix,
		address.County, address.District, address.Neighborhood, address.Building,
		address.Floor, address.Room, address.Name, address.StreetDirection,
		address.StreetPostDirection, address.StreetSuffix, address.Landmark,
		address.LocationDescription, address.PlaceType, address.Premise,
		address.PostOfficeBox, address.AdditionalCode, address.Seat,
		address.RoadSection, address.RoadBranch, address.RoadSubBranch,
	) != "" || len(address.Fields) > 0
}

func cloneEmergencyAddress(address EmergencyAddress) EmergencyAddress {
	address.Fields = copyStringMap(address.Fields)
	return address
}

func cloneEntitlementSnapshot(snapshot EntitlementSnapshot) EntitlementSnapshot {
	snapshot.Info = cloneEntitlementInfo(snapshot.Info)
	snapshot.ServiceURNs = copyStringSlice(snapshot.ServiceURNs)
	snapshot.Routes = copyEmergencyRoutes(snapshot.Routes)
	return snapshot
}

func cloneEmergencySIPRequestInfo(info EmergencySIPRequestInfo) EmergencySIPRequestInfo {
	info.Headers = copyStringMap(info.Headers)
	info.Routes = copyEmergencyRoutes(info.Routes)
	info.RouteSet = copyStringSlice(info.RouteSet)
	info.PIDFLOBody = append([]byte(nil), info.PIDFLOBody...)
	return info
}

func cloneEmergencySIPFailure(failure EmergencySIPFailure) EmergencySIPFailure {
	failure.AlternativeServiceURNs = copyStringSlice(failure.AlternativeServiceURNs)
	failure.ContactURIs = copyStringSlice(failure.ContactURIs)
	return failure
}

func cloneEmergencySIPRetryPlan(plan EmergencySIPRetryPlan) EmergencySIPRetryPlan {
	plan.Failure = cloneEmergencySIPFailure(plan.Failure)
	plan.NextRouteSet = copyStringSlice(plan.NextRouteSet)
	plan.NextHeaders = copyStringMap(plan.NextHeaders)
	return plan
}
