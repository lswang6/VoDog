//go:build darwin

package swu

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// DarwinTUNRoutingManager configures a utun interface without installing a
// system-wide default route. Callers explicitly supply only the DNS/P-CSCF host
// routes that belong inside SWu, keeping unrelated Mac traffic out of IMS.
type DarwinTUNRoutingManager struct {
	Runner DarwinNetworkCommandRunner

	mu     sync.Mutex
	states map[string][]darwinNetworkCommand
}

type DarwinNetworkCommandRunner interface {
	RunNetworkCommand(context.Context, string, ...string) error
}

type ExecDarwinNetworkCommandRunner struct{}

func (ExecDarwinNetworkCommandRunner) RunNetworkCommand(ctx context.Context, path string, args ...string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	out, err := exec.CommandContext(ctx, path, args...).CombinedOutput()
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(out))
	if detail == "" {
		return fmt.Errorf("%w: %s %s: %v", ErrInvalidTUNRouting, path, strings.Join(args, " "), err)
	}
	return fmt.Errorf("%w: %s %s: %v: %s", ErrInvalidTUNRouting, path, strings.Join(args, " "), err, detail)
}

type darwinNetworkCommand struct {
	path string
	args []string
}

func (m *DarwinTUNRoutingManager) Apply(ctx context.Context, cfg TUNRoutingConfig) (TUNRoutingState, error) {
	if m == nil {
		return TUNRoutingState{}, fmt.Errorf("%w: darwin routing manager is nil", ErrInvalidTUNRouting)
	}
	iface := strings.TrimSpace(cfg.InterfaceName)
	if !validDarwinUTUNName(iface) {
		return TUNRoutingState{}, fmt.Errorf("%w: interface must be an allocated utun device", ErrInvalidTUNRouting)
	}
	if len(cfg.Rules) != 0 || len(cfg.EPDGRouteExclusions) != 0 {
		return TUNRoutingState{}, fmt.Errorf("%w: darwin utun routing does not accept Linux rules or outer exclusions", ErrInvalidTUNRouting)
	}
	runner := m.Runner
	if runner == nil {
		runner = ExecDarwinNetworkCommandRunner{}
	}
	var apply, undo []darwinNetworkCommand
	if cfg.MTU > 0 {
		apply = append(apply, darwinNetworkCommand{"/sbin/ifconfig", []string{iface, "mtu", strconv.Itoa(cfg.MTU)}})
	}
	apply = append(apply, darwinNetworkCommand{"/sbin/ifconfig", []string{iface, "up"}})
	for _, raw := range cfg.Addresses {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil {
			addr, addrErr := netip.ParseAddr(strings.TrimSpace(raw))
			if addrErr != nil {
				return TUNRoutingState{}, fmt.Errorf("%w: invalid darwin utun address %q", ErrInvalidTUNRouting, raw)
			}
			bits := 128
			if addr.Is4() {
				bits = 32
			}
			prefix = netip.PrefixFrom(addr, bits)
		}
		addr := prefix.Addr().String()
		if prefix.Addr().Is4() {
			apply = append(apply, darwinNetworkCommand{"/sbin/ifconfig", []string{iface, "inet", addr, addr, "netmask", "255.255.255.255", "alias"}})
			undo = append(undo, darwinNetworkCommand{"/sbin/ifconfig", []string{iface, "inet", addr, "-alias"}})
		} else {
			value := prefix.String()
			apply = append(apply, darwinNetworkCommand{"/sbin/ifconfig", []string{iface, "inet6", value, "alias"}})
			undo = append(undo, darwinNetworkCommand{"/sbin/ifconfig", []string{iface, "inet6", value, "-alias"}})
		}
	}
	for _, route := range cfg.Routes {
		add, remove, err := darwinUTUNHostRouteCommands(iface, route.Destination)
		if err != nil {
			return TUNRoutingState{}, err
		}
		apply = append(apply, add)
		undo = append(undo, remove)
	}

	appliedUndo := make([]darwinNetworkCommand, 0, len(undo))
	undoIndex := 0
	for _, command := range apply {
		if err := runner.RunNetworkCommand(ctx, command.path, command.args...); err != nil {
			_ = runDarwinNetworkUndo(ctx, runner, appliedUndo)
			return TUNRoutingState{InterfaceName: iface}, err
		}
		// MTU/up do not have independent cleanup. Address and route commands do.
		if (command.path == "/sbin/ifconfig" && containsDarwinArg(command.args, "alias")) || command.path == "/sbin/route" {
			if undoIndex < len(undo) {
				appliedUndo = append(appliedUndo, undo[undoIndex])
				undoIndex++
			}
		}
	}
	m.mu.Lock()
	if m.states == nil {
		m.states = make(map[string][]darwinNetworkCommand)
	}
	m.states[iface] = append([]darwinNetworkCommand(nil), appliedUndo...)
	m.mu.Unlock()
	return TUNRoutingState{InterfaceName: iface}, nil
}

func (m *DarwinTUNRoutingManager) Cleanup(ctx context.Context, state TUNRoutingState) error {
	if m == nil {
		return nil
	}
	iface := strings.TrimSpace(state.InterfaceName)
	m.mu.Lock()
	undo := append([]darwinNetworkCommand(nil), m.states[iface]...)
	delete(m.states, iface)
	m.mu.Unlock()
	runner := m.Runner
	if runner == nil {
		runner = ExecDarwinNetworkCommandRunner{}
	}
	return runDarwinNetworkUndo(ctx, runner, undo)
}

func (m *DarwinTUNRoutingManager) ActiveInterfaceName() string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for iface := range m.states {
		return iface
	}
	return ""
}

// AddHostRoute adds a post-resolution P-CSCF route to an already configured
// utun session and records it for normal tunnel cleanup.
func (m *DarwinTUNRoutingManager) AddHostRoute(ctx context.Context, interfaceName, address string) error {
	if m == nil {
		return fmt.Errorf("%w: darwin routing manager is nil", ErrInvalidTUNRouting)
	}
	add, remove, err := darwinUTUNHostRouteCommands(interfaceName, address)
	if err != nil {
		return err
	}
	runner := m.Runner
	if runner == nil {
		runner = ExecDarwinNetworkCommandRunner{}
	}
	if err := runner.RunNetworkCommand(ctx, add.path, add.args...); err != nil {
		// Existing identical host routes are harmless and commonly arise when
		// SRV and A/AAAA results overlap.
		if !strings.Contains(strings.ToLower(err.Error()), "file exists") {
			return err
		}
	}
	m.mu.Lock()
	if m.states == nil {
		m.states = make(map[string][]darwinNetworkCommand)
	}
	m.states[strings.TrimSpace(interfaceName)] = append(m.states[strings.TrimSpace(interfaceName)], remove)
	m.mu.Unlock()
	return nil
}

func darwinUTUNHostRouteCommands(iface, rawAddress string) (darwinNetworkCommand, darwinNetworkCommand, error) {
	iface = strings.TrimSpace(iface)
	if !validDarwinUTUNName(iface) {
		return darwinNetworkCommand{}, darwinNetworkCommand{}, fmt.Errorf("%w: invalid utun interface %q", ErrInvalidTUNRouting, iface)
	}
	rawAddress = strings.TrimSpace(rawAddress)
	if strings.EqualFold(rawAddress, "default") {
		return darwinNetworkCommand{}, darwinNetworkCommand{}, fmt.Errorf("%w: system-wide default route is forbidden on darwin", ErrInvalidTUNRouting)
	}
	if prefix, err := netip.ParsePrefix(rawAddress); err == nil {
		rawAddress = prefix.Addr().String()
	}
	address, err := netip.ParseAddr(rawAddress)
	if err != nil {
		return darwinNetworkCommand{}, darwinNetworkCommand{}, fmt.Errorf("%w: route destination must be an IP host: %q", ErrInvalidTUNRouting, rawAddress)
	}
	family := "-inet"
	if address.Is6() {
		family = "-inet6"
	}
	args := []string{"-n", "add", family, "-host", address.String(), "-interface", iface}
	undo := []string{"-n", "delete", family, "-host", address.String(), "-interface", iface}
	return darwinNetworkCommand{"/sbin/route", args}, darwinNetworkCommand{"/sbin/route", undo}, nil
}

func runDarwinNetworkUndo(ctx context.Context, runner DarwinNetworkCommandRunner, commands []darwinNetworkCommand) error {
	var errs []error
	for i := len(commands) - 1; i >= 0; i-- {
		if err := runner.RunNetworkCommand(ctx, commands[i].path, commands[i].args...); err != nil &&
			!strings.Contains(strings.ToLower(err.Error()), "not in table") &&
			!strings.Contains(strings.ToLower(err.Error()), "can't assign requested address") {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func containsDarwinArg(args []string, value string) bool {
	for _, arg := range args {
		if arg == value {
			return true
		}
	}
	return false
}
