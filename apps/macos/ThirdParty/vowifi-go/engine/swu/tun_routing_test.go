package swu

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestLinuxTUNRoutingManagerApplyAndCleanup(t *testing.T) {
	runner := &fakeIPRunner{}
	manager := LinuxTUNRoutingManager{Runner: runner}
	cfg := TUNRoutingConfig{
		InterfaceName: "vohive0",
		MTU:           1400,
		Addresses:     []string{"10.10.0.2/32", "2001:db8::2/128"},
		Routes: []TUNRoute{
			{Destination: "10.20.0.0/24", Source: "10.10.0.2", Table: "200", Metric: 50},
			{Destination: "default", Via: "10.10.0.1", Table: "200"},
		},
		Rules: []TUNRule{
			{Priority: 1000, FwMark: "0x1/0xffffffff", Table: "200"},
			{Priority: 1001, From: "10.10.0.2", Table: "200"},
		},
	}
	state, err := manager.Apply(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	wantApply := [][]string{
		{"link", "set", "dev", "vohive0", "mtu", "1400"},
		{"link", "set", "dev", "vohive0", "up"},
		{"addr", "add", "10.10.0.2/32", "dev", "vohive0"},
		{"addr", "add", "2001:db8::2/128", "dev", "vohive0"},
		{"route", "add", "10.20.0.0/24", "dev", "vohive0", "src", "10.10.0.2", "metric", "50", "table", "200"},
		{"route", "add", "default", "dev", "vohive0", "via", "10.10.0.1", "table", "200"},
		{"rule", "add", "priority", "1000", "fwmark", "0x1/0xffffffff", "table", "200"},
		{"rule", "add", "priority", "1001", "from", "10.10.0.2/32", "table", "200"},
	}
	if !reflect.DeepEqual(runner.commands, wantApply) {
		t.Fatalf("apply commands=\n%v\nwant\n%v", runner.commands, wantApply)
	}
	if err := manager.Cleanup(context.Background(), state); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}
	wantAll := append([][]string{}, wantApply...)
	wantAll = append(wantAll,
		[]string{"rule", "del", "priority", "1001", "from", "10.10.0.2/32", "table", "200"},
		[]string{"rule", "del", "priority", "1000", "fwmark", "0x1/0xffffffff", "table", "200"},
		[]string{"route", "del", "default", "dev", "vohive0", "via", "10.10.0.1", "table", "200"},
		[]string{"route", "del", "10.20.0.0/24", "dev", "vohive0", "src", "10.10.0.2", "metric", "50", "table", "200"},
		[]string{"addr", "del", "2001:db8::2/128", "dev", "vohive0"},
		[]string{"addr", "del", "10.10.0.2/32", "dev", "vohive0"},
	)
	if !reflect.DeepEqual(runner.commands, wantAll) {
		t.Fatalf("all commands=\n%v\nwant\n%v", runner.commands, wantAll)
	}
}

func TestLinuxTUNRoutingManagerRollsBackOnFailure(t *testing.T) {
	wantErr := errors.New("route failed")
	runner := &fakeIPRunner{failAt: 3, err: wantErr}
	manager := LinuxTUNRoutingManager{Runner: runner}
	_, err := manager.Apply(context.Background(), TUNRoutingConfig{
		InterfaceName: "vohive0",
		Addresses:     []string{"10.10.0.2/32"},
		Routes:        []TUNRoute{{Destination: "10.20.0.0/24", Table: "200"}},
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("Apply() err=%v, want route failure", err)
	}
	want := [][]string{
		{"link", "set", "dev", "vohive0", "up"},
		{"addr", "add", "10.10.0.2/32", "dev", "vohive0"},
		{"route", "add", "10.20.0.0/24", "dev", "vohive0", "table", "200"},
		{"addr", "del", "10.10.0.2/32", "dev", "vohive0"},
	}
	if !reflect.DeepEqual(runner.commands, want) {
		t.Fatalf("commands=\n%v\nwant\n%v", runner.commands, want)
	}
}

func TestLinuxTUNRoutingManagerInstallsEPDGExclusionsBeforeTunnelRoutes(t *testing.T) {
	runner := &fakeIPRunner{}
	manager := LinuxTUNRoutingManager{Runner: runner}
	state, err := manager.Apply(context.Background(), TUNRoutingConfig{
		InterfaceName: "vohive0",
		Addresses:     []string{"10.10.0.2/32"},
		EPDGRouteExclusions: []EPDGRouteExclusion{{
			Address:       "198.51.100.7",
			InterfaceName: "wwan0",
			Via:           "192.0.2.1",
			Source:        "192.0.2.23",
			Table:         "main",
			Tables:        []string{"200", "main"},
			Metric:        5,
		}},
		Routes: []TUNRoute{{Destination: "default", Table: "200"}},
		Rules:  []TUNRule{{Priority: 1000, From: "10.10.0.2", Table: "200"}},
	})
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	wantApply := [][]string{
		{"link", "set", "dev", "vohive0", "up"},
		{"addr", "add", "10.10.0.2/32", "dev", "vohive0"},
		{"route", "add", "198.51.100.7/32", "dev", "wwan0", "via", "192.0.2.1", "src", "192.0.2.23", "metric", "5", "table", "main"},
		{"route", "add", "198.51.100.7/32", "dev", "wwan0", "via", "192.0.2.1", "src", "192.0.2.23", "metric", "5", "table", "200"},
		{"route", "add", "default", "dev", "vohive0", "table", "200"},
		{"rule", "add", "priority", "1000", "from", "10.10.0.2/32", "table", "200"},
	}
	if !reflect.DeepEqual(runner.commands, wantApply) {
		t.Fatalf("apply commands=\n%v\nwant\n%v", runner.commands, wantApply)
	}
	if err := manager.Cleanup(context.Background(), state); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}
	wantAll := append([][]string{}, wantApply...)
	wantAll = append(wantAll,
		[]string{"rule", "del", "priority", "1000", "from", "10.10.0.2/32", "table", "200"},
		[]string{"route", "del", "default", "dev", "vohive0", "table", "200"},
		[]string{"route", "del", "198.51.100.7/32", "dev", "wwan0", "via", "192.0.2.1", "src", "192.0.2.23", "metric", "5", "table", "200"},
		[]string{"route", "del", "198.51.100.7/32", "dev", "wwan0", "via", "192.0.2.1", "src", "192.0.2.23", "metric", "5", "table", "main"},
		[]string{"addr", "del", "10.10.0.2/32", "dev", "vohive0"},
	)
	if !reflect.DeepEqual(runner.commands, wantAll) {
		t.Fatalf("all commands=\n%v\nwant\n%v", runner.commands, wantAll)
	}
}

func TestBuildTUNRoutingCommandsRejectsInvalidInput(t *testing.T) {
	cases := []struct {
		name string
		cfg  TUNRoutingConfig
	}{
		{name: "empty iface", cfg: TUNRoutingConfig{}},
		{name: "bad iface", cfg: TUNRoutingConfig{InterfaceName: "bad iface"}},
		{name: "bad address", cfg: TUNRoutingConfig{InterfaceName: "vohive0", Addresses: []string{"not-ip"}}},
		{name: "bad route destination", cfg: TUNRoutingConfig{InterfaceName: "vohive0", Routes: []TUNRoute{{Destination: "not-ip"}}}},
		{name: "bad via", cfg: TUNRoutingConfig{InterfaceName: "vohive0", Routes: []TUNRoute{{Destination: "10.0.0.0/24", Via: "not-ip"}}}},
		{name: "bad epdg", cfg: TUNRoutingConfig{InterfaceName: "vohive0", EPDGRouteExclusions: []EPDGRouteExclusion{{Address: "not-ip", InterfaceName: "wwan0"}}}},
		{name: "bad epdg interface", cfg: TUNRoutingConfig{InterfaceName: "vohive0", EPDGRouteExclusions: []EPDGRouteExclusion{{Address: "198.51.100.7", InterfaceName: "bad iface"}}}},
		{name: "bad epdg table", cfg: TUNRoutingConfig{InterfaceName: "vohive0", EPDGRouteExclusions: []EPDGRouteExclusion{{Address: "198.51.100.7", InterfaceName: "wwan0", Table: "bad table"}}}},
		{name: "missing rule table", cfg: TUNRoutingConfig{InterfaceName: "vohive0", Rules: []TUNRule{{Priority: 1000}}}},
		{name: "bad token", cfg: TUNRoutingConfig{InterfaceName: "vohive0", Rules: []TUNRule{{FwMark: "0x1 bad", Table: "200"}}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := buildTUNRoutingCommands(tc.cfg)
			if !errors.Is(err, ErrInvalidTUNRouting) {
				t.Fatalf("buildTUNRoutingCommands() err=%v, want ErrInvalidTUNRouting", err)
			}
		})
	}
}

func TestExecIPCommandRunnerReportsOutput(t *testing.T) {
	err := (ExecIPCommandRunner{Path: "sh"}).RunIP(context.Background(), "-c", "echo nope >&2; exit 7")
	if !errors.Is(err, ErrInvalidTUNRouting) || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("RunIP() err=%v, want wrapped command output", err)
	}
}

type fakeIPRunner struct {
	commands [][]string
	failAt   int
	err      error
}

func (r *fakeIPRunner) RunIP(ctx context.Context, args ...string) error {
	r.commands = append(r.commands, append([]string(nil), args...))
	if r.failAt > 0 && len(r.commands) == r.failAt {
		return r.err
	}
	return nil
}
