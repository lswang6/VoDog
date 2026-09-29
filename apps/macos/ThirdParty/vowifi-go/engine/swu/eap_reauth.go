package swu

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/boa-z/vowifi-go/engine/swu/eapaka"
)

const EAPReauthenticationSnapshotVersion = 1

var ErrInvalidEAPReauthenticationState = errors.New("invalid eap reauthentication state")

type EAPReauthenticationState struct {
	Identity            string
	Counter             uint16
	CounterOK           bool
	Keys                eapaka.Keys
	NextPseudonym       string
	ExpiresAt           time.Time
	OperatorRealm       string
	Reauthenticated     bool
	CounterTooSmall     bool
	LastAcceptedCounter uint16
	LastRejectedCounter uint16
}

type EAPReauthenticationUpdate struct {
	NextReauthID    string
	NextPseudonym   string
	Keys            eapaka.Keys
	Reauthenticated bool
	CounterTooSmall bool
	Counter         uint16
	ExpiresAt       time.Time
	OperatorRealm   string
}

type EAPReauthenticationKeySnapshot struct {
	MK      []byte `json:"mk,omitempty"`
	KEncr   []byte `json:"k_encr,omitempty"`
	KAut    []byte `json:"k_aut,omitempty"`
	KRe     []byte `json:"k_re,omitempty"`
	MSK     []byte `json:"msk,omitempty"`
	EMSK    []byte `json:"emsk,omitempty"`
	CKPrime []byte `json:"ck_prime,omitempty"`
	IKPrime []byte `json:"ik_prime,omitempty"`
}

type EAPReauthenticationSnapshot struct {
	Version             int                            `json:"version"`
	ReauthIdentity      string                         `json:"reauth_identity,omitempty"`
	Pseudonym           string                         `json:"pseudonym,omitempty"`
	Expiry              time.Time                      `json:"expiry,omitempty"`
	OperatorRealm       string                         `json:"operator_realm,omitempty"`
	Counter             uint16                         `json:"counter,omitempty"`
	CounterOK           bool                           `json:"counter_ok,omitempty"`
	Keys                EAPReauthenticationKeySnapshot `json:"keys,omitempty"`
	Reauthenticated     bool                           `json:"reauthenticated,omitempty"`
	CounterTooSmall     bool                           `json:"counter_too_small,omitempty"`
	LastAcceptedCounter uint16                         `json:"last_accepted_counter,omitempty"`
	LastRejectedCounter uint16                         `json:"last_rejected_counter,omitempty"`
}

type EAPReauthenticationStore interface {
	LoadEAPReauthentication(context.Context, string) (EAPReauthenticationSnapshot, bool, error)
	SaveEAPReauthentication(context.Context, string, EAPReauthenticationSnapshot) error
	DeleteEAPReauthentication(context.Context, string) error
}

type EAPReauthenticationStateManager struct {
	Store         EAPReauthenticationStore
	Key           string
	OperatorRealm string
	Lifetime      time.Duration
	Now           func() time.Time
}

type MemoryEAPReauthenticationStore struct {
	mu        sync.RWMutex
	snapshots map[string]EAPReauthenticationSnapshot
}

func (s EAPReauthenticationState) Usable() bool {
	return s.ReauthenticationUsableAt(time.Now())
}

func (s EAPReauthenticationState) AnyUsableAt(now time.Time) bool {
	return s.ReauthenticationUsableAt(now) || s.PseudonymUsableAt(now)
}

func (s EAPReauthenticationState) ReauthenticationUsableAt(now time.Time) bool {
	return !s.Expired(now) && strings.TrimSpace(s.Identity) != "" && len(s.Keys.KAut) > 0 && len(s.Keys.KEncr) > 0
}

func (s EAPReauthenticationState) PseudonymUsableAt(now time.Time) bool {
	return !s.Expired(now) && strings.TrimSpace(s.NextPseudonym) != ""
}

func (s EAPReauthenticationState) Expired(now time.Time) bool {
	if s.ExpiresAt.IsZero() {
		return false
	}
	if now.IsZero() {
		now = time.Now()
	}
	return !now.Before(s.ExpiresAt)
}

func (s EAPReauthenticationState) MatchesOperatorRealm(realm string) bool {
	stored := normalizeEAPOperatorRealm(s.OperatorRealm)
	current := normalizeEAPOperatorRealm(realm)
	return stored == "" || current == "" || stored == current
}

func (s EAPReauthenticationState) ApplyUpdate(update EAPReauthenticationUpdate) (EAPReauthenticationState, bool) {
	if len(update.Keys.KAut) == 0 || len(update.Keys.KEncr) == 0 {
		return s.clone(), false
	}
	current := s.clone()
	next := current
	if identity := strings.TrimSpace(update.NextReauthID); identity != "" {
		next.Identity = identity
	}
	if pseudonym := strings.TrimSpace(update.NextPseudonym); pseudonym != "" {
		next.NextPseudonym = pseudonym
	}
	if realm := normalizeEAPOperatorRealm(update.OperatorRealm); realm != "" {
		next.OperatorRealm = realm
	}
	next.ExpiresAt = update.ExpiresAt
	if strings.TrimSpace(next.Identity) == "" && strings.TrimSpace(next.NextPseudonym) == "" {
		return current, false
	}
	next.Keys = cloneEAPAKAKeys(update.Keys)
	next.Reauthenticated = update.Reauthenticated
	next.CounterTooSmall = update.CounterTooSmall
	if strings.TrimSpace(next.Identity) == "" {
		next.Counter = 0
		next.CounterOK = false
		next.LastAcceptedCounter = 0
		next.LastRejectedCounter = 0
		next.Reauthenticated = false
		next.CounterTooSmall = false
	} else {
		switch {
		case update.Reauthenticated:
			next.Counter = update.Counter
			next.CounterOK = true
			next.LastAcceptedCounter = update.Counter
		case update.CounterTooSmall:
			next.CounterOK = current.CounterOK
			next.LastRejectedCounter = update.Counter
		default:
			next.Counter = 0
			next.CounterOK = true
			next.LastAcceptedCounter = 0
			next.LastRejectedCounter = 0
		}
	}
	return next.clone(), true
}

func (s EAPReauthenticationState) Snapshot() EAPReauthenticationSnapshot {
	s = s.clone()
	return EAPReauthenticationSnapshot{
		Version:             EAPReauthenticationSnapshotVersion,
		ReauthIdentity:      s.Identity,
		Pseudonym:           s.NextPseudonym,
		Expiry:              s.ExpiresAt,
		OperatorRealm:       s.OperatorRealm,
		Counter:             s.Counter,
		CounterOK:           s.CounterOK,
		Keys:                snapshotEAPAKAKeys(s.Keys),
		Reauthenticated:     s.Reauthenticated,
		CounterTooSmall:     s.CounterTooSmall,
		LastAcceptedCounter: s.LastAcceptedCounter,
		LastRejectedCounter: s.LastRejectedCounter,
	}
}

func (s EAPReauthenticationSnapshot) State() (EAPReauthenticationState, error) {
	if s.Version != 0 && s.Version != EAPReauthenticationSnapshotVersion {
		return EAPReauthenticationState{}, fmt.Errorf("%w: snapshot version %d", ErrInvalidEAPReauthenticationState, s.Version)
	}
	return EAPReauthenticationState{
		Identity:            strings.TrimSpace(s.ReauthIdentity),
		Counter:             s.Counter,
		CounterOK:           s.CounterOK,
		Keys:                s.Keys.keys(),
		NextPseudonym:       strings.TrimSpace(s.Pseudonym),
		ExpiresAt:           s.Expiry,
		OperatorRealm:       normalizeEAPOperatorRealm(s.OperatorRealm),
		Reauthenticated:     s.Reauthenticated,
		CounterTooSmall:     s.CounterTooSmall,
		LastAcceptedCounter: s.LastAcceptedCounter,
		LastRejectedCounter: s.LastRejectedCounter,
	}.clone(), nil
}

func (m EAPReauthenticationStateManager) Load(ctx context.Context) (EAPReauthenticationState, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	store, key, err := m.storeAndKey()
	if err != nil {
		return EAPReauthenticationState{}, false, err
	}
	snapshot, ok, err := store.LoadEAPReauthentication(ctx, key)
	if err != nil || !ok {
		return EAPReauthenticationState{}, false, err
	}
	state, err := snapshot.State()
	if err != nil {
		return EAPReauthenticationState{}, false, err
	}
	if !state.MatchesOperatorRealm(m.OperatorRealm) || !state.AnyUsableAt(m.now()) {
		return EAPReauthenticationState{}, false, nil
	}
	return state.clone(), true, nil
}

func (m EAPReauthenticationStateManager) Save(ctx context.Context, state EAPReauthenticationState) error {
	if ctx == nil {
		ctx = context.Background()
	}
	store, key, err := m.storeAndKey()
	if err != nil {
		return err
	}
	state = state.clone()
	if realm := normalizeEAPOperatorRealm(m.OperatorRealm); state.OperatorRealm == "" && realm != "" {
		state.OperatorRealm = realm
	}
	if m.Lifetime > 0 {
		state.ExpiresAt = m.now().Add(m.Lifetime)
	}
	if !state.AnyUsableAt(m.now()) {
		return fmt.Errorf("%w: no usable identity or pseudonym", ErrInvalidEAPReauthenticationState)
	}
	return store.SaveEAPReauthentication(ctx, key, state.Snapshot())
}

func (m EAPReauthenticationStateManager) Delete(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	store, key, err := m.storeAndKey()
	if err != nil {
		return err
	}
	return store.DeleteEAPReauthentication(ctx, key)
}

func (m EAPReauthenticationStateManager) storeAndKey() (EAPReauthenticationStore, string, error) {
	if m.Store == nil {
		return nil, "", fmt.Errorf("%w: store is nil", ErrInvalidEAPReauthenticationState)
	}
	key := strings.TrimSpace(m.Key)
	if key == "" {
		return nil, "", fmt.Errorf("%w: store key is empty", ErrInvalidEAPReauthenticationState)
	}
	return m.Store, key, nil
}

func (m EAPReauthenticationStateManager) now() time.Time {
	if m.Now != nil {
		if now := m.Now(); !now.IsZero() {
			return now
		}
	}
	return time.Now()
}

func NewMemoryEAPReauthenticationStore() *MemoryEAPReauthenticationStore {
	return &MemoryEAPReauthenticationStore{
		snapshots: map[string]EAPReauthenticationSnapshot{},
	}
}

func (s *MemoryEAPReauthenticationStore) LoadEAPReauthentication(ctx context.Context, key string) (EAPReauthenticationSnapshot, bool, error) {
	_ = ctx
	if s == nil {
		return EAPReauthenticationSnapshot{}, false, fmt.Errorf("%w: store is nil", ErrInvalidEAPReauthenticationState)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return EAPReauthenticationSnapshot{}, false, fmt.Errorf("%w: store key is empty", ErrInvalidEAPReauthenticationState)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	snapshot, ok := s.snapshots[key]
	if !ok {
		return EAPReauthenticationSnapshot{}, false, nil
	}
	return snapshot.clone(), true, nil
}

func (s *MemoryEAPReauthenticationStore) SaveEAPReauthentication(ctx context.Context, key string, snapshot EAPReauthenticationSnapshot) error {
	_ = ctx
	if s == nil {
		return fmt.Errorf("%w: store is nil", ErrInvalidEAPReauthenticationState)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("%w: store key is empty", ErrInvalidEAPReauthenticationState)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.snapshots == nil {
		s.snapshots = map[string]EAPReauthenticationSnapshot{}
	}
	s.snapshots[key] = snapshot.clone()
	return nil
}

func (s *MemoryEAPReauthenticationStore) DeleteEAPReauthentication(ctx context.Context, key string) error {
	_ = ctx
	if s == nil {
		return fmt.Errorf("%w: store is nil", ErrInvalidEAPReauthenticationState)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("%w: store key is empty", ErrInvalidEAPReauthenticationState)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.snapshots, key)
	return nil
}

func (s EAPReauthenticationState) clone() EAPReauthenticationState {
	s.Identity = strings.TrimSpace(s.Identity)
	s.NextPseudonym = strings.TrimSpace(s.NextPseudonym)
	s.OperatorRealm = normalizeEAPOperatorRealm(s.OperatorRealm)
	s.Keys = cloneEAPAKAKeys(s.Keys)
	return s
}

func (s EAPReauthenticationState) authStateAt(now time.Time, operatorRealm string) EAPReauthenticationState {
	s = s.clone()
	if !s.MatchesOperatorRealm(operatorRealm) || s.Expired(now) {
		return EAPReauthenticationState{}
	}
	if s.OperatorRealm == "" {
		s.OperatorRealm = normalizeEAPOperatorRealm(operatorRealm)
	}
	if !s.PseudonymUsableAt(now) {
		s.NextPseudonym = ""
	}
	if !s.ReauthenticationUsableAt(now) {
		s.Identity = ""
		s.Counter = 0
		s.CounterOK = false
		s.Keys = eapaka.Keys{}
		s.Reauthenticated = false
		s.CounterTooSmall = false
		s.LastAcceptedCounter = 0
		s.LastRejectedCounter = 0
	}
	if s.Identity == "" && s.NextPseudonym == "" {
		return EAPReauthenticationState{}
	}
	return s.clone()
}

func (s EAPReauthenticationSnapshot) clone() EAPReauthenticationSnapshot {
	s.Keys = s.Keys.clone()
	return s
}

func (s EAPReauthenticationKeySnapshot) clone() EAPReauthenticationKeySnapshot {
	return EAPReauthenticationKeySnapshot{
		MK:      append([]byte(nil), s.MK...),
		KEncr:   append([]byte(nil), s.KEncr...),
		KAut:    append([]byte(nil), s.KAut...),
		KRe:     append([]byte(nil), s.KRe...),
		MSK:     append([]byte(nil), s.MSK...),
		EMSK:    append([]byte(nil), s.EMSK...),
		CKPrime: append([]byte(nil), s.CKPrime...),
		IKPrime: append([]byte(nil), s.IKPrime...),
	}
}

func (s EAPReauthenticationKeySnapshot) keys() eapaka.Keys {
	return eapaka.Keys{
		MK:      append([]byte(nil), s.MK...),
		KEncr:   append([]byte(nil), s.KEncr...),
		KAut:    append([]byte(nil), s.KAut...),
		KRe:     append([]byte(nil), s.KRe...),
		MSK:     append([]byte(nil), s.MSK...),
		EMSK:    append([]byte(nil), s.EMSK...),
		CKPrime: append([]byte(nil), s.CKPrime...),
		IKPrime: append([]byte(nil), s.IKPrime...),
	}
}

func snapshotEAPAKAKeys(keys eapaka.Keys) EAPReauthenticationKeySnapshot {
	return EAPReauthenticationKeySnapshot{
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

func normalizeEAPOperatorRealm(realm string) string {
	return strings.ToLower(strings.TrimSpace(realm))
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
