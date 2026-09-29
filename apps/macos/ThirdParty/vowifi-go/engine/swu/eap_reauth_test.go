package swu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
)

func TestEAPReauthenticationStateApplyUpdateAcceptsNextIdentityAndPseudonym(t *testing.T) {
	initialKeys := testEAPReauthKeys(0x01)
	nextKeys := testEAPReauthKeys(0x10)
	state := EAPReauthenticationState{
		Identity:            " reauth-old ",
		NextPseudonym:       " pseudo-old ",
		Counter:             2,
		CounterOK:           true,
		Keys:                initialKeys,
		LastAcceptedCounter: 2,
		LastRejectedCounter: 1,
	}

	updated, ok := state.ApplyUpdate(EAPReauthenticationUpdate{
		NextReauthID:    " reauth-next ",
		NextPseudonym:   " pseudo-next ",
		Keys:            nextKeys,
		Reauthenticated: true,
		Counter:         3,
	})
	if !ok {
		t.Fatal("ApplyUpdate() ok=false, want true")
	}
	if updated.Identity != "reauth-next" || updated.NextPseudonym != "pseudo-next" {
		t.Fatalf("updated identity=%q pseudonym=%q", updated.Identity, updated.NextPseudonym)
	}
	if updated.OperatorRealm != "" || !updated.ExpiresAt.IsZero() {
		t.Fatalf("updated metadata realm=%q expires=%v", updated.OperatorRealm, updated.ExpiresAt)
	}
	if !updated.Usable() || !updated.CounterOK || updated.Counter != 3 || updated.LastAcceptedCounter != 3 {
		t.Fatalf("updated counters usable=%t state=%+v", updated.Usable(), updated)
	}
	if updated.CounterTooSmall || !updated.Reauthenticated {
		t.Fatalf("updated flags reauthenticated=%t counterTooSmall=%t", updated.Reauthenticated, updated.CounterTooSmall)
	}
	if !bytes.Equal(updated.Keys.MSK, nextKeys.MSK) || !bytes.Equal(updated.Keys.EMSK, nextKeys.EMSK) {
		t.Fatalf("updated keys=%+v", updated.Keys)
	}
	nextKeys.MSK[0] = 0xff
	if updated.Keys.MSK[0] == 0xff {
		t.Fatal("updated state leaked update key slice")
	}
}

func TestEAPReauthenticationStateApplyUpdateCounterTooSmall(t *testing.T) {
	currentKeys := testEAPReauthKeys(0x20)
	state := EAPReauthenticationState{
		Identity:            "reauth-current",
		NextPseudonym:       "pseudo-current",
		Counter:             9,
		CounterOK:           true,
		Keys:                currentKeys,
		LastAcceptedCounter: 9,
		LastRejectedCounter: 4,
	}

	updated, ok := state.ApplyUpdate(EAPReauthenticationUpdate{
		NextReauthID:    " reauth-new ",
		NextPseudonym:   " pseudo-new ",
		Keys:            currentKeys,
		CounterTooSmall: true,
		Counter:         7,
	})
	if !ok {
		t.Fatal("ApplyUpdate() ok=false, want true")
	}
	if updated.Identity != "reauth-new" || updated.NextPseudonym != "pseudo-new" {
		t.Fatalf("updated identity=%q pseudonym=%q", updated.Identity, updated.NextPseudonym)
	}
	if updated.Counter != 9 || !updated.CounterOK || updated.LastAcceptedCounter != 9 || updated.LastRejectedCounter != 7 {
		t.Fatalf("counter-too-small state=%+v", updated)
	}
	if !updated.CounterTooSmall || updated.Reauthenticated {
		t.Fatalf("updated flags reauthenticated=%t counterTooSmall=%t", updated.Reauthenticated, updated.CounterTooSmall)
	}
}

func TestEAPReauthenticationStateApplyUpdateRequiresIdentityAndKeys(t *testing.T) {
	keys := testEAPReauthKeys(0x30)
	state := EAPReauthenticationState{
		Identity:  "reauth-current",
		Counter:   4,
		CounterOK: true,
		Keys:      keys,
	}

	updated, ok := state.ApplyUpdate(EAPReauthenticationUpdate{
		NextReauthID: "reauth-next",
		Keys:         eapaka.Keys{KAut: []byte{1}},
		Counter:      5,
	})
	if ok {
		t.Fatal("ApplyUpdate(incomplete keys) ok=true, want false")
	}
	if updated.Identity != "reauth-current" || updated.Counter != 4 || !updated.CounterOK {
		t.Fatalf("updated state after incomplete keys=%+v", updated)
	}

	updated, ok = (EAPReauthenticationState{}).ApplyUpdate(EAPReauthenticationUpdate{
		NextPseudonym: " pseudo-only ",
		Keys:          keys,
	})
	if !ok {
		t.Fatal("ApplyUpdate(pseudonym-only) ok=false, want true")
	}
	if updated.Identity != "" || updated.NextPseudonym != "pseudo-only" || updated.CounterOK {
		t.Fatalf("updated pseudonym-only state=%+v", updated)
	}
}

func TestEAPReauthenticationStateSnapshotJSONRoundTrip(t *testing.T) {
	expiresAt := time.Unix(3600, 123).UTC()
	state := EAPReauthenticationState{
		Identity:            " reauth-next ",
		NextPseudonym:       " pseudo-next ",
		ExpiresAt:           expiresAt,
		OperatorRealm:       "NAI.EPC.MNC280.MCC310.3GPPNETWORK.ORG",
		Counter:             7,
		CounterOK:           true,
		Keys:                testEAPReauthKeys(0x40),
		Reauthenticated:     true,
		LastAcceptedCounter: 7,
	}

	raw, err := json.Marshal(state.Snapshot())
	if err != nil {
		t.Fatalf("Marshal(snapshot) error = %v", err)
	}
	var snapshot EAPReauthenticationSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatalf("Unmarshal(snapshot) error = %v", err)
	}
	restored, err := snapshot.State()
	if err != nil {
		t.Fatalf("State() error = %v", err)
	}
	if restored.Identity != "reauth-next" || restored.NextPseudonym != "pseudo-next" ||
		restored.OperatorRealm != "nai.epc.mnc280.mcc310.3gppnetwork.org" || !restored.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("restored identity=%q pseudonym=%q realm=%q expiry=%v", restored.Identity, restored.NextPseudonym, restored.OperatorRealm, restored.ExpiresAt)
	}
	if !restored.CounterOK || restored.Counter != 7 || !restored.Reauthenticated || restored.LastAcceptedCounter != 7 {
		t.Fatalf("restored counters=%+v", restored)
	}
	if !bytes.Equal(restored.Keys.KAut, state.Keys.KAut) || !bytes.Equal(restored.Keys.MSK, state.Keys.MSK) {
		t.Fatalf("restored keys=%+v", restored.Keys)
	}
	snapshot.Keys.MSK[0] = 0xff
	if restored.Keys.MSK[0] == 0xff {
		t.Fatal("snapshot mutation leaked into restored state")
	}
}

func TestEAPReauthenticationSnapshotRejectsUnknownVersion(t *testing.T) {
	_, err := (EAPReauthenticationSnapshot{Version: EAPReauthenticationSnapshotVersion + 1}).State()
	if !errors.Is(err, ErrInvalidEAPReauthenticationState) {
		t.Fatalf("State() err=%v, want ErrInvalidEAPReauthenticationState", err)
	}
}

func TestEAPReauthenticationStateUsabilityHonorsExpiry(t *testing.T) {
	now := time.Unix(5000, 0)
	state := EAPReauthenticationState{
		Identity:      "reauth-current",
		NextPseudonym: "pseudo-current",
		Keys:          testEAPReauthKeys(0x50),
		ExpiresAt:     now.Add(time.Minute),
	}
	if !state.ReauthenticationUsableAt(now) || !state.PseudonymUsableAt(now) || !state.AnyUsableAt(now) {
		t.Fatalf("state should be usable before expiry: %+v", state)
	}
	if state.ReauthenticationUsableAt(now.Add(time.Minute)) || state.PseudonymUsableAt(now.Add(time.Minute)) || state.AnyUsableAt(now.Add(time.Minute)) {
		t.Fatalf("state should expire at expiry boundary: %+v", state)
	}
	pseudonymOnly := EAPReauthenticationState{NextPseudonym: "pseudo-only"}
	if pseudonymOnly.ReauthenticationUsableAt(now) || !pseudonymOnly.PseudonymUsableAt(now) || !pseudonymOnly.AnyUsableAt(now) {
		t.Fatalf("pseudonym-only usability=%+v", pseudonymOnly)
	}
}

func TestMemoryEAPReauthenticationStoreClonesSnapshots(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryEAPReauthenticationStore()
	snapshot := EAPReauthenticationState{
		Identity:      "reauth-store",
		NextPseudonym: "pseudo-store",
		Keys:          testEAPReauthKeys(0x60),
	}.Snapshot()

	if err := store.SaveEAPReauthentication(ctx, "ue-1", snapshot); err != nil {
		t.Fatalf("SaveEAPReauthentication() error = %v", err)
	}
	snapshot.Keys.MSK[0] = 0xff
	loaded, ok, err := store.LoadEAPReauthentication(ctx, "ue-1")
	if err != nil || !ok {
		t.Fatalf("LoadEAPReauthentication() ok=%t err=%v", ok, err)
	}
	if loaded.Keys.MSK[0] == 0xff {
		t.Fatal("store leaked saved snapshot slice")
	}
	loaded.Keys.MSK[0] = 0xee
	again, ok, err := store.LoadEAPReauthentication(ctx, "ue-1")
	if err != nil || !ok {
		t.Fatalf("second LoadEAPReauthentication() ok=%t err=%v", ok, err)
	}
	if again.Keys.MSK[0] == 0xee {
		t.Fatal("store leaked loaded snapshot slice")
	}
	if err := store.DeleteEAPReauthentication(ctx, "ue-1"); err != nil {
		t.Fatalf("DeleteEAPReauthentication() error = %v", err)
	}
	if _, ok, err := store.LoadEAPReauthentication(ctx, "ue-1"); err != nil || ok {
		t.Fatalf("Load after delete ok=%t err=%v", ok, err)
	}
}

func TestEAPReauthenticationStateManagerLoadSave(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(7000, 0)
	store := NewMemoryEAPReauthenticationStore()
	manager := EAPReauthenticationStateManager{
		Store:         store,
		Key:           "ue-1",
		OperatorRealm: "NAI.EPC.MNC280.MCC310.3GPPNETWORK.ORG",
		Lifetime:      time.Hour,
		Now: func() time.Time {
			return now
		},
	}
	if err := manager.Save(ctx, EAPReauthenticationState{
		Identity:      "reauth-manager",
		NextPseudonym: "pseudo-manager",
		Keys:          testEAPReauthKeys(0x70),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, ok, err := manager.Load(ctx)
	if err != nil || !ok {
		t.Fatalf("Load() ok=%t err=%v", ok, err)
	}
	if loaded.OperatorRealm != "nai.epc.mnc280.mcc310.3gppnetwork.org" || !loaded.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("loaded realm=%q expiry=%v", loaded.OperatorRealm, loaded.ExpiresAt)
	}
	manager.Now = func() time.Time {
		return now.Add(time.Hour)
	}
	if loaded, ok, err := manager.Load(ctx); err != nil || ok || loaded.AnyUsableAt(now.Add(time.Hour)) {
		t.Fatalf("expired Load() state=%+v ok=%t err=%v", loaded, ok, err)
	}
}

func TestEAPReauthenticationStateManagerFiltersRealmMismatch(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryEAPReauthenticationStore()
	if err := store.SaveEAPReauthentication(ctx, "ue-1", EAPReauthenticationState{
		Identity:      "reauth-manager",
		NextPseudonym: "pseudo-manager",
		OperatorRealm: "realm-a.example",
		Keys:          testEAPReauthKeys(0x80),
	}.Snapshot()); err != nil {
		t.Fatalf("SaveEAPReauthentication() error = %v", err)
	}
	manager := EAPReauthenticationStateManager{
		Store:         store,
		Key:           "ue-1",
		OperatorRealm: "realm-b.example",
	}
	loaded, ok, err := manager.Load(ctx)
	if err != nil || ok || loaded.AnyUsableAt(time.Now()) {
		t.Fatalf("realm mismatch Load() state=%+v ok=%t err=%v", loaded, ok, err)
	}
}

func testEAPReauthKeys(seed byte) eapaka.Keys {
	return eapaka.Keys{
		MK:    bytes.Repeat([]byte{seed}, 20),
		KEncr: bytes.Repeat([]byte{seed + 1}, eapaka.KeyLengthKEncr),
		KAut:  bytes.Repeat([]byte{seed + 2}, eapaka.KeyLengthKAut),
		MSK:   bytes.Repeat([]byte{seed + 3}, eapaka.KeyLengthMSK),
		EMSK:  bytes.Repeat([]byte{seed + 4}, eapaka.KeyLengthEMSK),
	}
}
