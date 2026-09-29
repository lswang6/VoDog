package swu

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

type kernelTunnelSession struct {
	mu           sync.Mutex
	result       TunnelResult
	xfrmManager  KernelXFRMManager
	xfrmState    KernelXFRMState
	closeHandler func(context.Context) error
	closed       bool
}

func newKernelTunnelSession(result TunnelResult, xfrmManager KernelXFRMManager, state KernelXFRMState, closeHandler func(context.Context) error) (*kernelTunnelSession, error) {
	if xfrmManager == nil {
		return nil, fmtInvalidKernelSession("xfrm manager is nil")
	}
	if result.Mode == "" {
		result.Mode = DataplaneModeKernel
	}
	if result.Reason == "" {
		result.Reason = "kernel ipsec tunnel ready"
	}
	return &kernelTunnelSession{
		result:       result,
		xfrmManager:  xfrmManager,
		xfrmState:    state,
		closeHandler: closeHandler,
	}, nil
}

func (s *kernelTunnelSession) Result() TunnelResult {
	if s == nil {
		return TunnelResult{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneTunnelResult(s.result)
}

func (s *kernelTunnelSession) MOBIKE(ctx context.Context, req MOBIKERequest) (MOBIKEResult, error) {
	if s == nil {
		return MOBIKEResult{}, ErrTunnelNotReady
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := contextReady(ctx); err != nil {
		return MOBIKEResult{}, err
	}
	s.mu.Lock()
	closed := s.closed
	result := s.result
	s.mu.Unlock()
	if closed {
		return MOBIKEResult{}, ErrPacketTunnelClosed
	}
	return completeMOBIKEResult(MOBIKEResult{Reason: "mobike unsupported"}, req, result, "mobike unsupported"), nil
}

func (s *kernelTunnelSession) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	xfrmManager := s.xfrmManager
	xfrmState := s.xfrmState
	closeHandler := s.closeHandler
	s.mu.Unlock()

	var err error
	if closeHandler != nil {
		err = closeHandler(ctx)
	}
	if xfrmManager != nil {
		err = errors.Join(err, xfrmManager.Cleanup(ctx, xfrmState))
	}
	return err
}

func fmtInvalidKernelSession(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidIKETunnelManager, reason)
}
