package e911

import (
	"testing"
	"time"
)

func TestEntitlementCacheSnapshotRefreshAndRoutes(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{RefreshBefore: time.Minute})
	snapshot := cache.Store(EntitlementInfo{
		Status:      1000,
		UserData:    "token-1",
		ServiceURNs: []string{"fire"},
		Routes: []EmergencyRoute{
			{ServiceURN: "urn:service:sos", PCSCF: []string{"pcscf.ims.example"}},
			{ServiceURN: "fire", ESRP: []string{"sip:fire@example.test"}},
			{Endpoints: []string{"sips:any@example.test"}},
		},
		ExpiresIn:      10 * time.Minute,
		CacheMaxAge:    5 * time.Minute,
		Endpoint:       "https://example.test/e911",
		ContentType:    "application/json",
		WebsheetURL:    "https://example.test/e911/websheet",
		CacheExpiresAt: time.Time{},
	}, base)

	if snapshot.RefreshRequired {
		t.Fatalf("RefreshRequired=%v reason=%q", snapshot.RefreshRequired, snapshot.RefreshReason)
	}
	if !snapshot.Usable() {
		t.Fatalf("snapshot should be usable: %+v", snapshot)
	}
	if snapshot.Token != "token-1" {
		t.Fatalf("Token=%q", snapshot.Token)
	}
	if got, want := snapshot.ExpiresAt, base.Add(10*time.Minute); !got.Equal(want) {
		t.Fatalf("ExpiresAt=%s, want %s", got, want)
	}
	if got, want := snapshot.CacheExpiresAt, base.Add(5*time.Minute); !got.Equal(want) {
		t.Fatalf("CacheExpiresAt=%s, want %s", got, want)
	}
	if got, want := snapshot.RefreshAt, base.Add(4*time.Minute); !got.Equal(want) {
		t.Fatalf("RefreshAt=%s, want %s", got, want)
	}
	if !sameStrings(snapshot.AvailableServiceURNs(), []string{"urn:service:sos.fire", "urn:service:sos"}) {
		t.Fatalf("ServiceURNs=%+v", snapshot.AvailableServiceURNs())
	}
	fireRoutes := snapshot.AvailableRoutes("fire")
	if len(fireRoutes) != 2 {
		t.Fatalf("fire routes=%+v", fireRoutes)
	}
	if fireRoutes[0].ServiceURN != "urn:service:sos.fire" || len(fireRoutes[1].Endpoints) != 1 {
		t.Fatalf("fire routes=%+v", fireRoutes)
	}
	allRoutes := cache.AvailableRoutes("", base.Add(time.Minute))
	if len(allRoutes) != 3 {
		t.Fatalf("all routes=%+v", allRoutes)
	}

	refreshing := cache.Snapshot(base.Add(4 * time.Minute))
	if !refreshing.RefreshRequired || refreshing.RefreshReason != entitlementRefreshReasonRefreshWindow {
		t.Fatalf("refreshing=%+v", refreshing)
	}
	if !refreshing.Usable() {
		t.Fatalf("refresh-window snapshot should remain usable: %+v", refreshing)
	}
	expired := cache.Snapshot(base.Add(5 * time.Minute))
	if !expired.RefreshRequired || expired.RefreshReason != entitlementRefreshReasonExpired {
		t.Fatalf("expired=%+v", expired)
	}
	if expired.Usable() {
		t.Fatalf("expired snapshot should not be usable: %+v", expired)
	}
}

func TestEntitlementCacheDefensiveCopies(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	info := EntitlementInfo{
		Status:      1000,
		UserData:    "token-1",
		ServiceURNs: []string{"police"},
		Routes:      []EmergencyRoute{{ServiceURN: "police", PCSCF: []string{"pcscf.ims.example"}}},
		Address: EmergencyAddress{
			Fields: map[string]string{"city": "Seattle"},
		},
	}
	cache := NewEntitlementCache(EntitlementCachePolicy{})
	snapshot := cache.Store(info, base)
	info.UserData = "changed"
	info.ServiceURNs[0] = "fire"
	info.Routes[0].PCSCF[0] = "changed.example"
	info.Address.Fields["city"] = "Changed"
	snapshot.ServiceURNs[0] = "changed"
	snapshot.Routes[0].PCSCF[0] = "changed.example"
	snapshot.Info.Address.Fields["city"] = "Changed"

	next := cache.Snapshot(base.Add(time.Second))
	if next.Token != "token-1" {
		t.Fatalf("Token=%q", next.Token)
	}
	if !sameStrings(next.ServiceURNs, []string{"urn:service:sos.police"}) {
		t.Fatalf("ServiceURNs=%+v", next.ServiceURNs)
	}
	if next.Routes[0].PCSCF[0] != "pcscf.ims.example" {
		t.Fatalf("route copy leaked: %+v", next.Routes)
	}
	if next.Info.Address.Fields["city"] != "Seattle" {
		t.Fatalf("address copy leaked: %+v", next.Info.Address.Fields)
	}
}

func TestEntitlementCacheRequiresRefreshWithoutUsableData(t *testing.T) {
	now := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{})
	if snapshot := cache.Snapshot(now); !snapshot.RefreshRequired || snapshot.RefreshReason != entitlementRefreshReasonNoCache {
		t.Fatalf("empty snapshot=%+v", snapshot)
	}
	if cache.Usable(now) {
		t.Fatal("empty cache should not be usable")
	}

	statusSnapshot := cache.Store(EntitlementInfo{Status: 6004, UserData: "token-1"}, now)
	if !statusSnapshot.RefreshRequired || statusSnapshot.RefreshReason != entitlementRefreshReasonStatus {
		t.Fatalf("status snapshot=%+v", statusSnapshot)
	}
	if statusSnapshot.Usable() {
		t.Fatalf("non-cacheable status snapshot should not be usable: %+v", statusSnapshot)
	}

	emptySnapshot := cache.Store(EntitlementInfo{Status: 1000}, now)
	if !emptySnapshot.RefreshRequired || emptySnapshot.RefreshReason != entitlementRefreshReasonEmpty {
		t.Fatalf("empty data snapshot=%+v", emptySnapshot)
	}
	if emptySnapshot.Usable() {
		t.Fatalf("empty data snapshot should not be usable: %+v", emptySnapshot)
	}
}

func TestEntitlementCacheUsableViewsRejectExpiredOrFailedEntitlement(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	info := EntitlementInfo{
		Status:      1000,
		UserData:    "token-1",
		ServiceURNs: []string{"fire"},
		Routes: []EmergencyRoute{
			{ServiceURN: "fire", PCSCF: []string{"pcscf-fire.ims.example"}},
			{Endpoints: []string{"sips:any@example.test"}},
		},
		CacheMaxAge: 5 * time.Minute,
	}
	cache := NewEntitlementCache(EntitlementCachePolicy{RefreshBefore: time.Minute})
	snapshot := cache.Store(info, base)

	if !snapshot.Usable() {
		t.Fatalf("fresh snapshot should be usable: %+v", snapshot)
	}
	if !sameStrings(snapshot.UsableServiceURNs(), []string{"urn:service:sos.fire"}) {
		t.Fatalf("usable service URNs=%+v", snapshot.UsableServiceURNs())
	}
	if routes := cache.UsableRoutes("fire", base.Add(4*time.Minute)); len(routes) != 2 {
		t.Fatalf("refresh-window routes=%+v, want service and generic routes", routes)
	}

	expired := cache.Snapshot(base.Add(5 * time.Minute))
	if expired.Usable() {
		t.Fatalf("expired snapshot should not be usable: %+v", expired)
	}
	if routes := expired.UsableRoutes("fire"); len(routes) != 0 {
		t.Fatalf("expired usable routes=%+v, want none", routes)
	}
	if urns := expired.UsableServiceURNs(); len(urns) != 0 {
		t.Fatalf("expired usable service URNs=%+v, want none", urns)
	}
	if routes := expired.AvailableRoutes("fire"); len(routes) != 2 {
		t.Fatalf("available routes should preserve legacy view, got %+v", routes)
	}

	failed := cache.Store(EntitlementInfo{
		Status:      6004,
		UserData:    "token-2",
		ServiceURNs: []string{"police"},
		Routes:      []EmergencyRoute{{ServiceURN: "police", PCSCF: []string{"pcscf-police.ims.example"}}},
	}, base.Add(time.Minute))
	if failed.Usable() {
		t.Fatalf("failed entitlement snapshot should not be usable: %+v", failed)
	}
	if routes := cache.UsableRoutes("police", base.Add(2*time.Minute)); len(routes) != 0 {
		t.Fatalf("failed entitlement usable routes=%+v, want none", routes)
	}
}

func TestEntitlementCacheSurfacesRetryAfterAndStaleIfError(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{})
	fresh := cache.Store(EntitlementInfo{
		Status:       1000,
		UserData:     "token-1",
		ExpiresIn:    time.Minute,
		RetryAfterIn: 30 * time.Second,
		StaleIfError: 5 * time.Minute,
	}, base)
	if got, want := fresh.RetryAfter, base.Add(30*time.Second); !got.Equal(want) {
		t.Fatalf("RetryAfter=%s, want %s", got, want)
	}
	if got, want := fresh.StaleIfErrorExpiresAt, base.Add(6*time.Minute); !got.Equal(want) {
		t.Fatalf("StaleIfErrorExpiresAt=%s, want %s", got, want)
	}
	if fresh.CanUseStaleOnError() {
		t.Fatalf("fresh snapshot should not need stale-if-error: %+v", fresh)
	}

	stale := cache.Snapshot(base.Add(90 * time.Second))
	if stale.Usable() {
		t.Fatalf("expired snapshot should not be normally usable: %+v", stale)
	}
	if !stale.CanUseStaleOnError() || !stale.StaleIfErrorAvailable {
		t.Fatalf("stale-if-error unavailable inside window: %+v", stale)
	}
	if routes := stale.UsableRoutes(""); len(routes) != 0 {
		t.Fatalf("normal usable routes should remain unavailable after expiry: %+v", routes)
	}

	expired := cache.Snapshot(base.Add(6 * time.Minute))
	if expired.CanUseStaleOnError() {
		t.Fatalf("stale-if-error should close at boundary: %+v", expired)
	}

	retry := cache.Store(EntitlementInfo{
		Status:       6004,
		RetryAfterIn: 2 * time.Minute,
	}, base)
	if got, want := retry.RetryAfter, base.Add(2*time.Minute); !got.Equal(want) {
		t.Fatalf("failed RetryAfter=%s, want %s", got, want)
	}
	if retry.CanUseStaleOnError() {
		t.Fatalf("failed entitlement without data should not be stale-if-error usable: %+v", retry)
	}
}

func TestEntitlementCacheDecisionClassifiesReuseRefreshAndBackoff(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{RefreshBefore: time.Minute})
	cache.Store(EntitlementInfo{
		Status:      1000,
		UserData:    "token-1",
		ServiceURNs: []string{"fire"},
		CacheMaxAge: 5 * time.Minute,
	}, base)

	fresh := cache.CacheDecision(base.Add(time.Minute))
	if fresh.Action != EntitlementCacheActionUseCache || !fresh.CanUseCache || fresh.RefreshNow || fresh.DeferRefresh {
		t.Fatalf("fresh decision=%+v", fresh)
	}

	refreshing := cache.CacheDecision(base.Add(4 * time.Minute))
	if refreshing.Action != EntitlementCacheActionRefresh || !refreshing.RefreshNow || !refreshing.CanUseCache ||
		refreshing.RefreshReason != EntitlementRefreshReasonRefreshWindow {
		t.Fatalf("refresh-window decision=%+v", refreshing)
	}

	cache.Store(EntitlementInfo{
		Status:       1000,
		UserData:     "token-2",
		ExpiresIn:    time.Minute,
		RetryAfterIn: 3 * time.Minute,
		StaleIfError: 5 * time.Minute,
	}, base)
	deferred := cache.CacheDecision(base.Add(2 * time.Minute))
	if deferred.Action != EntitlementCacheActionDeferRefresh || !deferred.DeferRefresh || deferred.RefreshNow ||
		deferred.CanUseCache || !deferred.CanUseStaleOnError {
		t.Fatalf("deferred decision=%+v", deferred)
	}
	if got, want := deferred.NextAttemptAt, base.Add(3*time.Minute); !got.Equal(want) {
		t.Fatalf("NextAttemptAt=%s, want %s", got, want)
	}
	if deferred.RetryAfterDelay != time.Minute {
		t.Fatalf("RetryAfterDelay=%s, want 1m", deferred.RetryAfterDelay)
	}

	afterBackoff := cache.CacheDecision(base.Add(3 * time.Minute))
	if afterBackoff.Action != EntitlementCacheActionRefresh || !afterBackoff.RefreshNow || afterBackoff.DeferRefresh ||
		!afterBackoff.CanUseStaleOnError {
		t.Fatalf("after-backoff decision=%+v", afterBackoff)
	}
}

func TestEntitlementCacheDecisionClassifiesNoCacheAndFailedRetryAfter(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{})

	empty := cache.CacheDecision(base)
	if empty.Action != EntitlementCacheActionRefresh || !empty.RefreshNow ||
		empty.RefreshReason != EntitlementRefreshReasonNoCache || empty.CanUseCache {
		t.Fatalf("empty decision=%+v", empty)
	}

	cache.Store(EntitlementInfo{
		Status:       6004,
		RetryAfterIn: 2 * time.Minute,
	}, base)
	wait := cache.CacheDecision(base.Add(30 * time.Second))
	if wait.Action != EntitlementCacheActionDeferRefresh || !wait.DeferRefresh || wait.RefreshNow ||
		wait.RefreshReason != EntitlementRefreshReasonStatus || wait.RetryAfterDelay != 90*time.Second {
		t.Fatalf("failed wait decision=%+v", wait)
	}

	retry := cache.CacheDecision(base.Add(2 * time.Minute))
	if retry.Action != EntitlementCacheActionRefresh || !retry.RefreshNow || retry.DeferRefresh ||
		retry.CanUseCache || retry.CanUseStaleOnError {
		t.Fatalf("failed retry decision=%+v", retry)
	}
}

func TestEntitlementCacheUsesPolicyDefaultsAndServiceFallback(t *testing.T) {
	base := time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)
	cache := NewEntitlementCache(EntitlementCachePolicy{
		DefaultExpiresIn:   30 * time.Minute,
		DefaultCacheMaxAge: 10 * time.Minute,
		RefreshBefore:      time.Minute,
	})
	snapshot := cache.Store(EntitlementInfo{
		Status:   1000,
		UserData: "token-1",
	}, base)
	if !sameStrings(snapshot.ServiceURNs, []string{DefaultEmergencyServiceURN}) {
		t.Fatalf("ServiceURNs=%+v", snapshot.ServiceURNs)
	}
	if got, want := snapshot.ExpiresAt, base.Add(30*time.Minute); !got.Equal(want) {
		t.Fatalf("ExpiresAt=%s, want %s", got, want)
	}
	if got, want := snapshot.CacheExpiresAt, base.Add(10*time.Minute); !got.Equal(want) {
		t.Fatalf("CacheExpiresAt=%s, want %s", got, want)
	}
	if got, want := snapshot.RefreshAt, base.Add(9*time.Minute); !got.Equal(want) {
		t.Fatalf("RefreshAt=%s, want %s", got, want)
	}
	if !cache.NeedRefresh(base.Add(9 * time.Minute)) {
		t.Fatal("cache should enter refresh window")
	}
	cache.Reset()
	if snapshot := cache.Snapshot(base.Add(time.Second)); snapshot.Cached || !snapshot.RefreshRequired {
		t.Fatalf("reset snapshot=%+v", snapshot)
	}
}
