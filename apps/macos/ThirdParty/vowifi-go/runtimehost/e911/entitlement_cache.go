package e911

import (
	"strings"
	"sync"
	"time"
)

const (
	EntitlementRefreshReasonNone          = ""
	EntitlementRefreshReasonNoCache       = "no-cache"
	EntitlementRefreshReasonEmpty         = "empty"
	EntitlementRefreshReasonStatus        = "status"
	EntitlementRefreshReasonExpired       = "expired"
	EntitlementRefreshReasonRefreshWindow = "refresh-window"
)

type EntitlementCacheAction string

const (
	EntitlementCacheActionNone         EntitlementCacheAction = ""
	EntitlementCacheActionUseCache     EntitlementCacheAction = "use-cache"
	EntitlementCacheActionRefresh      EntitlementCacheAction = "refresh"
	EntitlementCacheActionDeferRefresh EntitlementCacheAction = "defer-refresh"
)

const (
	entitlementRefreshReasonNone          = EntitlementRefreshReasonNone
	entitlementRefreshReasonNoCache       = EntitlementRefreshReasonNoCache
	entitlementRefreshReasonEmpty         = EntitlementRefreshReasonEmpty
	entitlementRefreshReasonStatus        = EntitlementRefreshReasonStatus
	entitlementRefreshReasonExpired       = EntitlementRefreshReasonExpired
	entitlementRefreshReasonRefreshWindow = EntitlementRefreshReasonRefreshWindow
)

// EntitlementCachePolicy controls local entitlement reuse decisions.
type EntitlementCachePolicy struct {
	RefreshBefore      time.Duration
	DefaultExpiresIn   time.Duration
	DefaultCacheMaxAge time.Duration
}

// EntitlementCache stores the last parsed TS.43/E911 entitlement result.
type EntitlementCache struct {
	mu       sync.RWMutex
	policy   EntitlementCachePolicy
	info     EntitlementInfo
	storedAt time.Time
	hasInfo  bool
}

// EntitlementSnapshot is the runtime-facing view of cached entitlement state.
type EntitlementSnapshot struct {
	Cached                bool
	RefreshRequired       bool
	RefreshReason         string
	StoredAt              time.Time
	ExpiresAt             time.Time
	CacheExpiresAt        time.Time
	RefreshAt             time.Time
	RetryAfter            time.Time
	StaleIfErrorExpiresAt time.Time
	StaleIfErrorAvailable bool
	Token                 string
	Info                  EntitlementInfo
	ServiceURNs           []string
	Routes                []EmergencyRoute
}

// EntitlementCacheDecision is a protocol-facing cache and retry decision.
//
// CanUseCache reports normal local reuse. CanUseStaleOnError is narrower: it
// applies only after a refresh attempt fails while stale-if-error is active.
type EntitlementCacheDecision struct {
	Action                EntitlementCacheAction
	RefreshReason         string
	Cached                bool
	CanUseCache           bool
	RefreshRequired       bool
	RefreshNow            bool
	DeferRefresh          bool
	NextAttemptAt         time.Time
	RetryAfter            time.Time
	RetryAfterDelay       time.Duration
	CanUseStaleOnError    bool
	StaleIfErrorExpiresAt time.Time
}

// NewEntitlementCache returns a zero-state cache with the supplied policy.
func NewEntitlementCache(policy EntitlementCachePolicy) *EntitlementCache {
	return &EntitlementCache{policy: normalizeEntitlementCachePolicy(policy)}
}

// SetPolicy replaces the cache policy without changing cached entitlement data.
func (c *EntitlementCache) SetPolicy(policy EntitlementCachePolicy) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.policy = normalizeEntitlementCachePolicy(policy)
}

// Store records parsed entitlement data and returns the current snapshot.
func (c *EntitlementCache) Store(info EntitlementInfo, now time.Time) EntitlementSnapshot {
	if c == nil {
		var empty EntitlementCache
		return empty.Store(info, now)
	}
	storedAt := entitlementCacheNow(now)
	storedInfo := cloneEntitlementInfo(info)
	c.mu.Lock()
	c.info = storedInfo
	c.storedAt = storedAt
	c.hasInfo = true
	policy := c.policy
	c.mu.Unlock()
	return entitlementSnapshot(storedInfo, storedAt, storedAt, true, policy)
}

// Update is an alias for Store.
func (c *EntitlementCache) Update(info EntitlementInfo, now time.Time) EntitlementSnapshot {
	return c.Store(info, now)
}

// Snapshot returns a copy of the current cache state.
func (c *EntitlementCache) Snapshot(now time.Time) EntitlementSnapshot {
	if c == nil {
		return entitlementSnapshot(EntitlementInfo{}, time.Time{}, entitlementCacheNow(now), false, EntitlementCachePolicy{})
	}
	c.mu.RLock()
	info := cloneEntitlementInfo(c.info)
	storedAt := c.storedAt
	hasInfo := c.hasInfo
	policy := c.policy
	c.mu.RUnlock()
	return entitlementSnapshot(info, storedAt, entitlementCacheNow(now), hasInfo, policy)
}

// NeedRefresh reports whether the cache is absent, stale, or inside its refresh window.
func (c *EntitlementCache) NeedRefresh(now time.Time) bool {
	return c.Snapshot(now).RefreshRequired
}

// CacheDecision classifies the current cache state for entitlement refresh orchestration.
func (c *EntitlementCache) CacheDecision(now time.Time) EntitlementCacheDecision {
	now = entitlementCacheNow(now)
	return ClassifyEntitlementCacheDecision(c.Snapshot(now), now)
}

// Usable reports whether cached entitlement data can still be used locally.
func (c *EntitlementCache) Usable(now time.Time) bool {
	return c.Snapshot(now).Usable()
}

// AvailableServiceURNs returns cached emergency service URNs without validating freshness.
func (c *EntitlementCache) AvailableServiceURNs(now time.Time) []string {
	return c.Snapshot(now).AvailableServiceURNs()
}

// UsableServiceURNs returns cached service URNs only when entitlement data is still valid.
func (c *EntitlementCache) UsableServiceURNs(now time.Time) []string {
	return c.Snapshot(now).UsableServiceURNs()
}

// AvailableRoutes returns cached emergency routes without validating freshness.
// An empty service returns all routes.
func (c *EntitlementCache) AvailableRoutes(service string, now time.Time) []EmergencyRoute {
	return c.Snapshot(now).AvailableRoutes(service)
}

// UsableRoutes returns cached emergency routes only when entitlement data is still valid.
func (c *EntitlementCache) UsableRoutes(service string, now time.Time) []EmergencyRoute {
	return c.Snapshot(now).UsableRoutes(service)
}

// UsableEmergencySIPRequestInfo snapshots the cache and builds runtime SIP
// request metadata when cached entitlement data is still locally usable.
func (c *EntitlementCache) UsableEmergencySIPRequestInfo(cfg EmergencySIPHeaderConfig, now time.Time) (EmergencySIPRequestInfo, EntitlementSnapshot, bool) {
	snapshot := c.Snapshot(now)
	info, ok := snapshot.UsableEmergencySIPRequestInfo(cfg)
	return info, snapshot, ok
}

// Reset drops cached entitlement state.
func (c *EntitlementCache) Reset() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.info = EntitlementInfo{}
	c.storedAt = time.Time{}
	c.hasInfo = false
}

// NeedsRefresh reports whether this snapshot should be refreshed.
func (s EntitlementSnapshot) NeedsRefresh() bool {
	return s.RefreshRequired
}

// CacheDecision classifies this snapshot for entitlement refresh orchestration.
func (s EntitlementSnapshot) CacheDecision(now time.Time) EntitlementCacheDecision {
	return ClassifyEntitlementCacheDecision(s, now)
}

// ClassifyEntitlementCacheDecision returns a typed decision for TS.43/E911
// entitlement cache reuse, refresh, Retry-After backoff, and stale-if-error use.
func ClassifyEntitlementCacheDecision(snapshot EntitlementSnapshot, now time.Time) EntitlementCacheDecision {
	now = entitlementCacheNow(now)
	decision := EntitlementCacheDecision{
		RefreshReason:         snapshot.RefreshReason,
		Cached:                snapshot.Cached,
		CanUseCache:           snapshot.Usable(),
		RefreshRequired:       snapshot.RefreshRequired,
		RetryAfter:            snapshot.RetryAfter,
		CanUseStaleOnError:    snapshot.CanUseStaleOnError(),
		StaleIfErrorExpiresAt: snapshot.StaleIfErrorExpiresAt,
	}
	if decision.RefreshRequired && !snapshot.RetryAfter.IsZero() && now.Before(snapshot.RetryAfter) {
		decision.Action = EntitlementCacheActionDeferRefresh
		decision.DeferRefresh = true
		decision.NextAttemptAt = snapshot.RetryAfter
		decision.RetryAfterDelay = snapshot.RetryAfter.Sub(now)
		return decision
	}
	if decision.RefreshRequired {
		decision.Action = EntitlementCacheActionRefresh
		decision.RefreshNow = true
		return decision
	}
	if decision.CanUseCache {
		decision.Action = EntitlementCacheActionUseCache
		return decision
	}
	decision.Action = EntitlementCacheActionRefresh
	decision.RefreshRequired = true
	decision.RefreshNow = true
	return decision
}

// Usable reports whether this snapshot can be reused for local emergency routing.
// A snapshot in the refresh window remains usable until its expiry or max-age.
func (s EntitlementSnapshot) Usable() bool {
	if !s.Cached {
		return false
	}
	if !entitlementInfoCacheableStatus(s.Info) || !entitlementInfoHasData(s.Info) {
		return false
	}
	switch s.RefreshReason {
	case entitlementRefreshReasonNone, entitlementRefreshReasonRefreshWindow:
		return true
	default:
		return false
	}
}

// CanUseStaleOnError reports whether expired cached entitlement data may still
// be used as a fallback when a refresh attempt fails.
func (s EntitlementSnapshot) CanUseStaleOnError() bool {
	return s.StaleIfErrorAvailable
}

// AvailableServiceURNs returns a defensive copy of the snapshot service URNs.
func (s EntitlementSnapshot) AvailableServiceURNs() []string {
	return copyStringSlice(s.ServiceURNs)
}

// UsableServiceURNs returns a defensive copy of service URNs when this snapshot is usable.
func (s EntitlementSnapshot) UsableServiceURNs() []string {
	if !s.Usable() {
		return nil
	}
	return s.AvailableServiceURNs()
}

// AvailableRoutes returns cached routes matching service without validating freshness.
// Generic routes without a service URN match any requested emergency service.
func (s EntitlementSnapshot) AvailableRoutes(service string) []EmergencyRoute {
	if len(s.Routes) == 0 {
		return nil
	}
	service = normalizeEmergencyServiceURN(service)
	var out []EmergencyRoute
	for _, route := range s.Routes {
		if service == "" || route.ServiceURN == "" || strings.EqualFold(route.ServiceURN, service) {
			out = append(out, route)
		}
	}
	return copyEmergencyRoutes(out)
}

// UsableRoutes returns matching cached routes only when this snapshot is usable.
func (s EntitlementSnapshot) UsableRoutes(service string) []EmergencyRoute {
	if !s.Usable() {
		return nil
	}
	return s.AvailableRoutes(service)
}

func entitlementSnapshot(info EntitlementInfo, storedAt, now time.Time, cached bool, policy EntitlementCachePolicy) EntitlementSnapshot {
	policy = normalizeEntitlementCachePolicy(policy)
	info = cloneEntitlementInfo(info)
	routes := normalizeEmergencyRoutes(info.Routes)
	info.Routes = copyEmergencyRoutes(routes)
	serviceURNs := entitlementInfoServiceURNs(info)
	info.ServiceURNs = copyStringSlice(serviceURNs)
	expiresAt := info.EffectiveExpiresAt(storedAt)
	if expiresAt.IsZero() && policy.DefaultExpiresIn > 0 && !storedAt.IsZero() {
		expiresAt = storedAt.Add(policy.DefaultExpiresIn)
	}
	cacheExpiresAt := info.EffectiveCacheExpiresAt(storedAt)
	if cacheExpiresAt.IsZero() && policy.DefaultCacheMaxAge > 0 && !storedAt.IsZero() {
		cacheExpiresAt = storedAt.Add(policy.DefaultCacheMaxAge)
	}
	refreshAt := earliestNonZeroTime(expiresAt, cacheExpiresAt)
	if !refreshAt.IsZero() && policy.RefreshBefore > 0 {
		refreshAt = refreshAt.Add(-policy.RefreshBefore)
		if !storedAt.IsZero() && refreshAt.Before(storedAt) {
			refreshAt = storedAt
		}
	}
	refreshRequired, reason := entitlementRefreshState(info, now, cached, expiresAt, cacheExpiresAt, refreshAt)
	retryAfter := info.EffectiveRetryAfter(storedAt)
	staleIfErrorExpiresAt := entitlementStaleIfErrorExpiresAt(info, expiresAt, cacheExpiresAt)
	staleIfErrorAvailable := entitlementStaleIfErrorAvailable(info, now, cached, expiresAt, cacheExpiresAt, staleIfErrorExpiresAt)
	return EntitlementSnapshot{
		Cached:                cached,
		RefreshRequired:       refreshRequired,
		RefreshReason:         reason,
		StoredAt:              storedAt,
		ExpiresAt:             expiresAt,
		CacheExpiresAt:        cacheExpiresAt,
		RefreshAt:             refreshAt,
		RetryAfter:            retryAfter,
		StaleIfErrorExpiresAt: staleIfErrorExpiresAt,
		StaleIfErrorAvailable: staleIfErrorAvailable,
		Token:                 strings.TrimSpace(info.UserData),
		Info:                  info,
		ServiceURNs:           serviceURNs,
		Routes:                routes,
	}
}

func entitlementRefreshState(info EntitlementInfo, now time.Time, cached bool, expiresAt, cacheExpiresAt, refreshAt time.Time) (bool, string) {
	if !cached {
		return true, entitlementRefreshReasonNoCache
	}
	if !entitlementInfoCacheableStatus(info) {
		return true, entitlementRefreshReasonStatus
	}
	if !entitlementInfoHasData(info) {
		return true, entitlementRefreshReasonEmpty
	}
	if !expiresAt.IsZero() && !now.Before(expiresAt) {
		return true, entitlementRefreshReasonExpired
	}
	if !cacheExpiresAt.IsZero() && !now.Before(cacheExpiresAt) {
		return true, entitlementRefreshReasonExpired
	}
	if !refreshAt.IsZero() && !now.Before(refreshAt) {
		return true, entitlementRefreshReasonRefreshWindow
	}
	return false, entitlementRefreshReasonNone
}

func entitlementInfoCacheableStatus(info EntitlementInfo) bool {
	return info.Status == 0 || info.Status == 1000
}

func entitlementInfoHasData(info EntitlementInfo) bool {
	return strings.TrimSpace(info.UserData) != "" ||
		strings.TrimSpace(info.WebsheetURL) != "" ||
		strings.TrimSpace(info.Endpoint) != "" ||
		strings.TrimSpace(info.PDN.Name) != "" ||
		strings.TrimSpace(info.PDN.APN) != "" ||
		len(info.ServiceURNs) > 0 ||
		len(info.Routes) > 0 ||
		len(info.Address.Fields) > 0
}

func entitlementInfoServiceURNs(info EntitlementInfo) []string {
	var out []string
	out = appendUniqueStrings(out, serviceURNsFromAny(info.ServiceURNs)...)
	for _, route := range info.Routes {
		if urn := normalizeEmergencyServiceURN(route.ServiceURN); urn != "" {
			out = appendUniqueStrings(out, urn)
		}
	}
	if len(out) == 0 && entitlementInfoHasData(info) {
		out = append(out, DefaultEmergencyServiceURN)
	}
	return out
}

func entitlementStaleIfErrorExpiresAt(info EntitlementInfo, expiresAt, cacheExpiresAt time.Time) time.Time {
	if info.StaleIfError <= 0 {
		return time.Time{}
	}
	staleBase := earliestNonZeroTime(expiresAt, cacheExpiresAt)
	if staleBase.IsZero() {
		return time.Time{}
	}
	return staleBase.Add(info.StaleIfError)
}

func entitlementStaleIfErrorAvailable(info EntitlementInfo, now time.Time, cached bool, expiresAt, cacheExpiresAt, staleExpiresAt time.Time) bool {
	if !cached || staleExpiresAt.IsZero() || !now.Before(staleExpiresAt) {
		return false
	}
	if !entitlementInfoCacheableStatus(info) || !entitlementInfoHasData(info) {
		return false
	}
	freshUntil := earliestNonZeroTime(expiresAt, cacheExpiresAt)
	return !freshUntil.IsZero() && !now.Before(freshUntil)
}

func normalizeEmergencyRoutes(routes []EmergencyRoute) []EmergencyRoute {
	if len(routes) == 0 {
		return nil
	}
	out := make([]EmergencyRoute, 0, len(routes))
	for _, route := range routes {
		out = append(out, normalizeEmergencyRoute(route))
	}
	return out
}

func normalizeEntitlementCachePolicy(policy EntitlementCachePolicy) EntitlementCachePolicy {
	if policy.RefreshBefore < 0 {
		policy.RefreshBefore = 0
	}
	if policy.DefaultExpiresIn < 0 {
		policy.DefaultExpiresIn = 0
	}
	if policy.DefaultCacheMaxAge < 0 {
		policy.DefaultCacheMaxAge = 0
	}
	return policy
}

func earliestNonZeroTime(items ...time.Time) time.Time {
	var out time.Time
	for _, item := range items {
		if item.IsZero() {
			continue
		}
		if out.IsZero() || item.Before(out) {
			out = item
		}
	}
	return out
}

func entitlementCacheNow(now time.Time) time.Time {
	if now.IsZero() {
		return time.Now().UTC()
	}
	return now.UTC()
}

func cloneEntitlementInfo(info EntitlementInfo) EntitlementInfo {
	info.ServiceURNs = copyStringSlice(info.ServiceURNs)
	info.Routes = copyEmergencyRoutes(info.Routes)
	info.Address.Fields = copyStringMap(info.Address.Fields)
	return info
}
