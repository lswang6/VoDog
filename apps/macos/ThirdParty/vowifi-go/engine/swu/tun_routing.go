package swu

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"strconv"
	"strings"
)

var ErrInvalidTUNRouting = errors.New("invalid swu tun routing")

type IPCommandRunner interface {
	RunIP(context.Context, ...string) error
}

type IPCommandRunnerFunc func(context.Context, ...string) error

func (f IPCommandRunnerFunc) RunIP(ctx context.Context, args ...string) error {
	if f == nil {
		return fmt.Errorf("%w: ip runner is nil", ErrInvalidTUNRouting)
	}
	return f(ctx, args...)
}

type ExecIPCommandRunner struct {
	Path string
}

func (r ExecIPCommandRunner) RunIP(ctx context.Context, args ...string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	path := strings.TrimSpace(r.Path)
	if path == "" {
		path = "ip"
	}
	cmd := exec.CommandContext(ctx, path, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg != "" {
			return fmt.Errorf("%w: %s %s: %v: %s", ErrInvalidTUNRouting, path, strings.Join(args, " "), err, msg)
		}
		return fmt.Errorf("%w: %s %s: %v", ErrInvalidTUNRouting, path, strings.Join(args, " "), err)
	}
	return nil
}

type TUNRoute struct {
	Destination string
	Via         string
	Source      string
	Table       string
	Metric      int
}

type TUNRule struct {
	Priority int
	From     string
	To       string
	FwMark   string
	Table    string
}

type EPDGRouteExclusion struct {
	Address       string
	InterfaceName string
	Via           string
	Source        string
	Table         string
	Tables        []string
	Metric        int
}

type TUNRoutingConfig struct {
	InterfaceName       string
	MTU                 int
	Addresses           []string
	EPDGRouteExclusions []EPDGRouteExclusion
	Routes              []TUNRoute
	Rules               []TUNRule
}

type TUNRoutingState struct {
	InterfaceName string
	undo          []ipCommand
}

type LinuxTUNRoutingManager struct {
	Runner IPCommandRunner
}

func (m LinuxTUNRoutingManager) Apply(ctx context.Context, cfg TUNRoutingConfig) (TUNRoutingState, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	runner := m.Runner
	if runner == nil {
		runner = ExecIPCommandRunner{}
	}
	commands, err := buildTUNRoutingCommands(cfg)
	if err != nil {
		return TUNRoutingState{}, err
	}
	state := TUNRoutingState{InterfaceName: strings.TrimSpace(cfg.InterfaceName)}
	for _, command := range commands {
		if err := runner.RunIP(ctx, command.args...); err != nil {
			rollbackErr := runIPUndo(ctx, runner, state.undo)
			if rollbackErr != nil {
				return state, errors.Join(err, rollbackErr)
			}
			return state, err
		}
		if len(command.undo) > 0 {
			state.undo = append(state.undo, ipCommand{args: append([]string(nil), command.undo...)})
		}
	}
	return state, nil
}

func (m LinuxTUNRoutingManager) Cleanup(ctx context.Context, state TUNRoutingState) error {
	if ctx == nil {
		ctx = context.Background()
	}
	runner := m.Runner
	if runner == nil {
		runner = ExecIPCommandRunner{}
	}
	return runIPUndo(ctx, runner, state.undo)
}

type ipCommand struct {
	args []string
	undo []string
}

func buildTUNRoutingCommands(cfg TUNRoutingConfig) ([]ipCommand, error) {
	iface := strings.TrimSpace(cfg.InterfaceName)
	if err := validateRoutingInterfaceName(iface); err != nil {
		return nil, err
	}
	if cfg.MTU < 0 {
		return nil, fmt.Errorf("%w: mtu must be positive", ErrInvalidTUNRouting)
	}
	var commands []ipCommand
	if cfg.MTU > 0 {
		commands = append(commands, ipCommand{args: []string{"link", "set", "dev", iface, "mtu", strconv.Itoa(cfg.MTU)}})
	}
	commands = append(commands, ipCommand{args: []string{"link", "set", "dev", iface, "up"}})
	for _, address := range cfg.Addresses {
		addr, err := normalizeIPPrefix(address, "address")
		if err != nil {
			return nil, err
		}
		commands = append(commands, ipCommand{
			args: []string{"addr", "add", addr, "dev", iface},
			undo: []string{"addr", "del", addr, "dev", iface},
		})
	}
	for _, exclusion := range cfg.EPDGRouteExclusions {
		exclusionCommands, err := epdgRouteExclusionCommands(exclusion)
		if err != nil {
			return nil, err
		}
		commands = append(commands, exclusionCommands...)
	}
	for _, route := range cfg.Routes {
		args, undo, err := routeCommands(iface, route)
		if err != nil {
			return nil, err
		}
		commands = append(commands, ipCommand{args: args, undo: undo})
	}
	for _, rule := range cfg.Rules {
		args, undo, err := ruleCommands(rule)
		if err != nil {
			return nil, err
		}
		commands = append(commands, ipCommand{args: args, undo: undo})
	}
	return commands, nil
}

func epdgRouteExclusionCommands(exclusion EPDGRouteExclusion) ([]ipCommand, error) {
	dst, err := normalizeIPPrefix(exclusion.Address, "epdg address")
	if err != nil {
		return nil, err
	}
	iface := strings.TrimSpace(exclusion.InterfaceName)
	if err := validateRoutingInterfaceName(iface); err != nil {
		return nil, fmt.Errorf("%w: epdg outer interface: %v", ErrInvalidTUNRouting, err)
	}
	if exclusion.Metric < 0 {
		return nil, fmt.Errorf("%w: epdg route metric must be positive", ErrInvalidTUNRouting)
	}
	tables, err := normalizedRoutingTables(exclusion.Table, exclusion.Tables)
	if err != nil {
		return nil, err
	}
	if len(tables) == 0 {
		tables = []string{""}
	}
	var commands []ipCommand
	for _, table := range tables {
		args := []string{"route", "add", dst, "dev", iface}
		undo := []string{"route", "del", dst, "dev", iface}
		if strings.TrimSpace(exclusion.Via) != "" {
			via, err := normalizeIPAddress(exclusion.Via, "epdg route via")
			if err != nil {
				return nil, err
			}
			args = append(args, "via", via)
			undo = append(undo, "via", via)
		}
		if strings.TrimSpace(exclusion.Source) != "" {
			source, err := normalizeIPAddress(exclusion.Source, "epdg route source")
			if err != nil {
				return nil, err
			}
			args = append(args, "src", source)
			undo = append(undo, "src", source)
		}
		if exclusion.Metric > 0 {
			metric := strconv.Itoa(exclusion.Metric)
			args = append(args, "metric", metric)
			undo = append(undo, "metric", metric)
		}
		if table != "" {
			args = append(args, "table", table)
			undo = append(undo, "table", table)
		}
		commands = append(commands, ipCommand{args: args, undo: undo})
	}
	return commands, nil
}

func routeCommands(iface string, route TUNRoute) ([]string, []string, error) {
	dst, err := normalizeRouteDestination(route.Destination)
	if err != nil {
		return nil, nil, err
	}
	args := []string{"route", "add", dst, "dev", iface}
	undo := []string{"route", "del", dst, "dev", iface}
	if strings.TrimSpace(route.Via) != "" {
		via, err := normalizeIPAddress(route.Via, "route via")
		if err != nil {
			return nil, nil, err
		}
		args = append(args, "via", via)
		undo = append(undo, "via", via)
	}
	if strings.TrimSpace(route.Source) != "" {
		source, err := normalizeIPAddress(route.Source, "route source")
		if err != nil {
			return nil, nil, err
		}
		args = append(args, "src", source)
		undo = append(undo, "src", source)
	}
	if route.Metric < 0 {
		return nil, nil, fmt.Errorf("%w: route metric must be positive", ErrInvalidTUNRouting)
	}
	if route.Metric > 0 {
		metric := strconv.Itoa(route.Metric)
		args = append(args, "metric", metric)
		undo = append(undo, "metric", metric)
	}
	if strings.TrimSpace(route.Table) != "" {
		table, err := normalizeRoutingToken(route.Table, "route table")
		if err != nil {
			return nil, nil, err
		}
		args = append(args, "table", table)
		undo = append(undo, "table", table)
	}
	return args, undo, nil
}

func ruleCommands(rule TUNRule) ([]string, []string, error) {
	table, err := normalizeRoutingToken(rule.Table, "rule table")
	if err != nil {
		return nil, nil, err
	}
	args := []string{"rule", "add"}
	undo := []string{"rule", "del"}
	if rule.Priority < 0 {
		return nil, nil, fmt.Errorf("%w: rule priority must be positive", ErrInvalidTUNRouting)
	}
	if rule.Priority > 0 {
		priority := strconv.Itoa(rule.Priority)
		args = append(args, "priority", priority)
		undo = append(undo, "priority", priority)
	}
	if strings.TrimSpace(rule.From) != "" {
		from, err := normalizeIPPrefix(rule.From, "rule from")
		if err != nil {
			return nil, nil, err
		}
		args = append(args, "from", from)
		undo = append(undo, "from", from)
	}
	if strings.TrimSpace(rule.To) != "" {
		to, err := normalizeIPPrefix(rule.To, "rule to")
		if err != nil {
			return nil, nil, err
		}
		args = append(args, "to", to)
		undo = append(undo, "to", to)
	}
	if strings.TrimSpace(rule.FwMark) != "" {
		fwmark, err := normalizeRoutingToken(rule.FwMark, "rule fwmark")
		if err != nil {
			return nil, nil, err
		}
		args = append(args, "fwmark", fwmark)
		undo = append(undo, "fwmark", fwmark)
	}
	args = append(args, "table", table)
	undo = append(undo, "table", table)
	return args, undo, nil
}

func runIPUndo(ctx context.Context, runner IPCommandRunner, undo []ipCommand) error {
	var out error
	for i := len(undo) - 1; i >= 0; i-- {
		if len(undo[i].args) == 0 {
			continue
		}
		if err := runner.RunIP(ctx, undo[i].args...); err != nil {
			out = errors.Join(out, err)
		}
	}
	return out
}

func normalizedRoutingTables(primary string, extra []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, value := range append([]string{primary}, extra...) {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		table, err := normalizeRoutingToken(value, "routing table")
		if err != nil {
			return nil, err
		}
		if seen[table] {
			continue
		}
		seen[table] = true
		out = append(out, table)
	}
	return out, nil
}

func validateRoutingInterfaceName(name string) error {
	if name == "" {
		return fmt.Errorf("%w: interface name is empty", ErrInvalidTUNRouting)
	}
	if strings.ContainsAny(name, "/\x00 \t\r\n") {
		return fmt.Errorf("%w: invalid interface name %q", ErrInvalidTUNRouting, name)
	}
	if len(name) >= 16 {
		return fmt.Errorf("%w: interface name %q exceeds 15 bytes", ErrInvalidTUNRouting, name)
	}
	return nil
}

func normalizeRouteDestination(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: route destination is empty", ErrInvalidTUNRouting)
	}
	if value == "default" {
		return value, nil
	}
	return normalizeIPPrefix(value, "route destination")
}

func normalizeIPPrefix(value, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: %s is empty", ErrInvalidTUNRouting, field)
	}
	if prefix, err := netip.ParsePrefix(value); err == nil {
		return prefix.Masked().String(), nil
	}
	if addr, err := netip.ParseAddr(value); err == nil {
		if addr.Is4() {
			return netip.PrefixFrom(addr, 32).String(), nil
		}
		return netip.PrefixFrom(addr, 128).String(), nil
	}
	return "", fmt.Errorf("%w: invalid %s %q", ErrInvalidTUNRouting, field, value)
}

func normalizeIPAddress(value, field string) (string, error) {
	value = strings.TrimSpace(value)
	addr, err := netip.ParseAddr(value)
	if err != nil {
		return "", fmt.Errorf("%w: invalid %s %q", ErrInvalidTUNRouting, field, value)
	}
	return addr.String(), nil
}

func normalizeRoutingToken(value, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%w: %s is empty", ErrInvalidTUNRouting, field)
	}
	if strings.ContainsAny(value, " \t\r\n\x00") {
		return "", fmt.Errorf("%w: invalid %s %q", ErrInvalidTUNRouting, field, value)
	}
	return value, nil
}
