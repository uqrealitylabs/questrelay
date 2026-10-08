// Package transport publishes QuestRelay's hardware-encoded RTP over WebRTC
package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

type Publisher struct {
	endpoint   string
	key        string
	headset    string
	client     *http.Client
	mu         sync.RWMutex
	pc         *webrtc.PeerConnection
	pending    *webrtc.PeerConnection
	connecting bool
	closed     bool
	video      *webrtc.TrackLocalStaticRTP
	audio      *webrtc.TrackLocalStaticRTP
	session    string
	keyframe   atomic.Bool
	loss       atomic.Int32
	lossAt     atomic.Int64
}

type description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type startRequest struct {
	Key                string      `json:"key"`
	HeadsetID          string      `json:"headsetId"`
	SessionDescription description `json:"sessionDescription"`
	VideoMid           string      `json:"videoMid"`
	AudioMid           string      `json:"audioMid"`
}

type startResponse struct {
	SessionID          string      `json:"sessionId"`
	SessionDescription description `json:"sessionDescription"`
}

func NewPublisher(endpoint, key, headset string) (*Publisher, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("relay URL must be an HTTPS origin")
	}
	if len(key) < 32 || headset == "" || len(headset) > 64 {
		return nil, errors.New("publisher key or headset name is invalid")
	}
	for _, char := range headset {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_') {
			return nil, errors.New("headset name may only use letters, numbers, _ or -")
		}
	}
	parsed.Path = ""
	return &Publisher{
		endpoint: parsed.String(), key: key, headset: headset,
		client: &http.Client{Timeout: 20 * time.Second},
	}, nil
}

func (p *Publisher) Connect() error {
	p.mu.Lock()
	if p.pc != nil || p.connecting || p.closed {
		p.mu.Unlock()
		return errors.New("publisher already connected")
	}
	p.connecting = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.connecting = false
		p.mu.Unlock()
	}()
	media := &webrtc.MediaEngine{}
	videoCodec := webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
		SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a",
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}},
	}
	if err := media.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: videoCodec, PayloadType: 102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return err
	}
	if err := media.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
		}, PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return err
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(media)).NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}},
	})
	if err != nil {
		return err
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		_ = pc.Close()
		return errors.New("publisher closed")
	}
	p.pending = pc
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		if p.pending == pc {
			p.pending = nil
		}
		keep := p.pc == pc
		p.mu.Unlock()
		if !keep {
			_ = pc.Close()
		}
	}()
	video, err := webrtc.NewTrackLocalStaticRTP(videoCodec, "video", p.headset)
	if err != nil {
		return err
	}
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
	}, "audio", p.headset)
	if err != nil {
		return err
	}
	videoTransceiver, err := pc.AddTransceiverFromTrack(video, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	})
	if err != nil {
		return err
	}
	audioTransceiver, err := pc.AddTransceiverFromTrack(audio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	})
	if err != nil {
		return err
	}
	connected := make(chan struct{}, 1)
	failed := make(chan struct{}, 1)
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			select {
			case connected <- struct{}{}:
			default:
			}
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			select {
			case failed <- struct{}{}:
			default:
			}
		}
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-gathered:
	case <-time.After(15 * time.Second):
		return errors.New("ICE gathering timed out")
	}
	local := pc.LocalDescription()
	if local == nil {
		return errors.New("local WebRTC offer missing")
	}
	var remote startResponse
	err = p.request("/api/publisher/start", startRequest{
		Key: p.key, HeadsetID: p.headset,
		SessionDescription: description{Type: "offer", SDP: local.SDP},
		VideoMid:           videoTransceiver.Mid(), AudioMid: audioTransceiver.Mid(),
	}, &remote)
	if err != nil {
		return err
	}
	if remote.SessionID == "" || remote.SessionDescription.Type != "answer" || remote.SessionDescription.SDP == "" {
		return errors.New("relay returned an invalid WebRTC answer")
	}
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer, SDP: remote.SessionDescription.SDP,
	}); err != nil {
		return fmt.Errorf("apply relay answer: %w", err)
	}
	select {
	case <-connected:
	case <-failed:
		return errors.New("WebRTC connection failed")
	case <-time.After(15 * time.Second):
		return errors.New("WebRTC connection timed out")
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return errors.New("publisher closed")
	}
	p.pc, p.video, p.audio, p.session = pc, video, audio, remote.SessionID
	p.pending = nil
	p.mu.Unlock()
	go p.readFeedback(videoTransceiver.Sender(), true)
	go p.readFeedback(audioTransceiver.Sender(), false)
	return nil
}

func (p *Publisher) readFeedback(sender *webrtc.RTPSender, video bool) {
	buffer := make([]byte, 1500)
	for {
		n, _, err := sender.Read(buffer)
		if err != nil {
			return
		}
		packets, err := rtcp.Unmarshal(buffer[:n])
		if err != nil {
			continue
		}
		p.applyFeedback(packets, video)
	}
}

func (p *Publisher) applyFeedback(packets []rtcp.Packet, video bool) {
	for _, packet := range packets {
		switch report := packet.(type) {
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			p.keyframe.Store(true)
		case *rtcp.ReceiverReport:
			if video && len(report.Reports) > 0 {
				p.loss.Store(int32(report.Reports[0].FractionLost) * 100 / 256)
				p.lossAt.Store(time.Now().UnixMilli())
			}
		}
	}
}

// LossPercent returns recent publisher-to-SFU packet loss, or -1 without recent feedback
func (p *Publisher) LossPercent() int {
	if at := p.lossAt.Load(); at == 0 || time.Now().UnixMilli()-at > 15_000 {
		return -1
	}
	return int(p.loss.Load())
}

func (p *Publisher) WriteVideo(packet []byte) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.video == nil {
		return false
	}
	_, err := p.video.Write(packet)
	return err == nil
}

func (p *Publisher) WriteAudio(packet []byte) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.audio == nil {
		return false
	}
	_, err := p.audio.Write(packet)
	return err == nil
}

func (p *Publisher) NeedsKeyframe() bool { return p.keyframe.Swap(false) }

func (p *Publisher) SessionID() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.session
}

func (p *Publisher) Connected() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.pc != nil && p.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
}

func (p *Publisher) Close() {
	p.mu.Lock()
	pc := p.pc
	pending := p.pending
	p.pc, p.video, p.audio = nil, nil, nil
	p.pending = nil
	p.closed = true
	p.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
	if pending != nil && pending != pc {
		_ = pending.Close()
	}
}

func (p *Publisher) request(path string, input any, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("relay returned HTTP %d: %s", resp.StatusCode, message)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(output)
}
