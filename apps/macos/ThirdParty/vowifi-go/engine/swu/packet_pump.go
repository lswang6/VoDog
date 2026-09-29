package swu

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

var ErrInvalidPacketPump = errors.New("invalid swu packet pump")

type InnerPacketReader interface {
	ReadInnerPacket(context.Context) ([]byte, error)
}

type InnerPacketWriter interface {
	WriteInnerPacket(context.Context, []byte) error
}

type InnerPacketDevice interface {
	InnerPacketReader
	InnerPacketWriter
}

type InnerPacketDeviceCloser interface {
	InnerPacketDevice
	Close(context.Context) error
}

type PacketPumpDirection string

const (
	PacketPumpDeviceToESP PacketPumpDirection = "device_to_esp"
	PacketPumpESPToDevice PacketPumpDirection = "esp_to_device"
)

type PacketPumpStats struct {
	DeviceToESPPackets uint64
	DeviceToESPBytes   uint64
	ESPToDevicePackets uint64
	ESPToDeviceBytes   uint64
	DeviceReadErrors   uint64
	DeviceWriteErrors  uint64
	ESPReadErrors      uint64
	ESPSendErrors      uint64
	ChildSARekeys      uint64
	ChildSARekeyErrors uint64
}

type PacketPumpConfig struct {
	Session PacketTunnelReadSession
	Device  InnerPacketDevice
	OnError func(PacketPumpDirection, error)
}

type PacketPump struct {
	session PacketTunnelReadSession
	device  InnerPacketDevice
	onError func(PacketPumpDirection, error)

	mu            sync.Mutex
	maintenanceMu sync.Mutex
	stats         PacketPumpStats
	started       bool
	done          chan struct{}
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	err           error
	once          sync.Once
}

func NewPacketPump(cfg PacketPumpConfig) (*PacketPump, error) {
	if cfg.Session == nil {
		return nil, fmt.Errorf("%w: session is nil", ErrInvalidPacketPump)
	}
	if cfg.Device == nil {
		return nil, fmt.Errorf("%w: device is nil", ErrInvalidPacketPump)
	}
	return &PacketPump{
		session: cfg.Session,
		device:  cfg.Device,
		onError: cfg.OnError,
		done:    make(chan struct{}),
	}, nil
}

func (p *PacketPump) Start(ctx context.Context) error {
	if p == nil {
		return ErrInvalidPacketPump
	}
	if ctx == nil {
		ctx = context.Background()
	}
	p.mu.Lock()
	if p.started {
		p.mu.Unlock()
		return fmt.Errorf("%w: already started", ErrInvalidPacketPump)
	}
	ctx, cancel := context.WithCancel(ctx)
	p.cancel = cancel
	p.started = true
	p.mu.Unlock()

	p.wg.Add(3)
	go p.deviceToESP(ctx)
	go p.espToDevice(ctx)
	go p.closeOnContext(ctx)
	go func() {
		p.wg.Wait()
		close(p.done)
	}()
	return nil
}

func (p *PacketPump) Done() <-chan struct{} {
	if p == nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return p.done
}

func (p *PacketPump) Wait() (PacketPumpStats, error) {
	if p == nil {
		return PacketPumpStats{}, ErrInvalidPacketPump
	}
	p.mu.Lock()
	started := p.started
	done := p.done
	p.mu.Unlock()
	if !started {
		return PacketPumpStats{}, fmt.Errorf("%w: not started", ErrInvalidPacketPump)
	}
	<-done
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stats, p.err
}

func (p *PacketPump) Close(ctx context.Context) error {
	if p == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	p.mu.Lock()
	started := p.started
	cancel := p.cancel
	done := p.done
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	var err error
	if closer, ok := p.device.(InnerPacketDeviceCloser); ok {
		err = closer.Close(ctx)
	}
	if closeErr := p.session.Close(ctx); err == nil {
		err = closeErr
	}
	if !started {
		return err
	}
	select {
	case <-done:
	case <-ctx.Done():
		if err == nil {
			err = ctx.Err()
		}
	}
	return err
}

func (p *PacketPump) deviceToESP(ctx context.Context) {
	defer p.wg.Done()
	for {
		packet, err := p.device.ReadInnerPacket(ctx)
		if err != nil {
			if p.isNormalStop(ctx, err) {
				p.requestStop()
				return
			}
			p.recordError(PacketPumpDeviceToESP, err, func(stats *PacketPumpStats) { stats.DeviceReadErrors++ })
			return
		}
		if len(packet) == 0 {
			continue
		}
		if err := p.runChildSARekeyDue(ctx, PacketPumpDeviceToESP); err != nil {
			return
		}
		if err := p.session.SendInnerPacket(ctx, packet); err != nil {
			if p.isNormalStop(ctx, err) {
				p.requestStop()
				return
			}
			p.recordError(PacketPumpDeviceToESP, err, func(stats *PacketPumpStats) { stats.ESPSendErrors++ })
			return
		}
		p.mu.Lock()
		p.stats.DeviceToESPPackets++
		p.stats.DeviceToESPBytes += uint64(len(packet))
		p.mu.Unlock()
	}
}

func (p *PacketPump) espToDevice(ctx context.Context) {
	defer p.wg.Done()
	for {
		packet, err := p.session.ReadInnerPacket(ctx)
		if err != nil {
			if p.isNormalStop(ctx, err) {
				p.requestStop()
				return
			}
			p.recordError(PacketPumpESPToDevice, err, func(stats *PacketPumpStats) { stats.ESPReadErrors++ })
			return
		}
		if len(packet.Payload) == 0 {
			continue
		}
		if err := p.device.WriteInnerPacket(ctx, packet.Payload); err != nil {
			if p.isNormalStop(ctx, err) {
				p.requestStop()
				return
			}
			p.recordError(PacketPumpESPToDevice, err, func(stats *PacketPumpStats) { stats.DeviceWriteErrors++ })
			return
		}
		p.mu.Lock()
		p.stats.ESPToDevicePackets++
		p.stats.ESPToDeviceBytes += uint64(len(packet.Payload))
		p.mu.Unlock()
		if err := p.runChildSARekeyDue(ctx, PacketPumpESPToDevice); err != nil {
			return
		}
	}
}

func (p *PacketPump) runChildSARekeyDue(ctx context.Context, direction PacketPumpDirection) error {
	scheduler, ok := p.session.(ChildSARekeyScheduler)
	if !ok || scheduler == nil {
		return nil
	}
	now := time.Now()
	if dueAt, ok := scheduler.NextChildSARekeyDue(); !ok || now.Before(dueAt) {
		return nil
	}
	p.maintenanceMu.Lock()
	defer p.maintenanceMu.Unlock()

	now = time.Now()
	if dueAt, ok := scheduler.NextChildSARekeyDue(); !ok || now.Before(dueAt) {
		return nil
	}
	decision, err := scheduler.RunChildSARekeyDue(ctx, now)
	if err != nil {
		p.recordError(direction, err, func(stats *PacketPumpStats) { stats.ChildSARekeyErrors++ })
		return err
	}
	if decision.Action == ChildSARekeyDue {
		p.mu.Lock()
		p.stats.ChildSARekeys++
		p.mu.Unlock()
	}
	return nil
}

func (p *PacketPump) closeOnContext(ctx context.Context) {
	defer p.wg.Done()
	<-ctx.Done()
	if closer, ok := p.device.(InnerPacketDeviceCloser); ok {
		_ = closer.Close(context.Background())
	}
	_ = p.session.Close(context.Background())
}

func (p *PacketPump) recordError(direction PacketPumpDirection, err error, update func(*PacketPumpStats)) {
	p.mu.Lock()
	if update != nil {
		update(&p.stats)
	}
	p.mu.Unlock()
	p.once.Do(func() {
		if p.onError != nil {
			p.onError(direction, err)
		}
		p.mu.Lock()
		p.err = err
		cancel := p.cancel
		p.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	})
}

func (p *PacketPump) requestStop() {
	p.mu.Lock()
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (p *PacketPump) isNormalStop(ctx context.Context, err error) bool {
	return err == nil ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, ErrPacketTunnelClosed) ||
		(ctx != nil && ctx.Err() != nil)
}
