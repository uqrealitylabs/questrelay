package transport

import (
	"testing"
	"time"

	"github.com/pion/rtcp"
)

func TestPublisherRequiresHTTPSOriginAndValidHeadset(t *testing.T) {
	key := "12345678901234567890123456789012"
	for _, endpoint := range []string{
		"http://example.com", "https://example.com/ws/relay", "https://user@example.com",
		"https://example.com?key=secret", "https://:443",
	} {
		if _, err := NewPublisher(endpoint, key, "quest-1"); err == nil {
			t.Errorf("accepted invalid endpoint %q", endpoint)
		}
	}
	if _, err := NewPublisher("https://example.com", key, "quest 1"); err == nil {
		t.Error("accepted headset name with spaces")
	}
	if _, err := NewPublisher("https://example.com", key, "quest-1"); err != nil {
		t.Fatalf("rejected valid publisher: %v", err)
	}
}

func TestPublisherUsesRecentVideoLossFeedback(t *testing.T) {
	p := &Publisher{}
	if got := p.LossPercent(); got != -1 {
		t.Fatalf("missing feedback = %d, want -1", got)
	}
	p.applyFeedback([]rtcp.Packet{&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{FractionLost: 64}}}}, false)
	if got := p.LossPercent(); got != -1 {
		t.Fatalf("audio feedback changed video loss to %d", got)
	}
	p.applyFeedback([]rtcp.Packet{
		&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{FractionLost: 64}}},
		&rtcp.PictureLossIndication{},
	}, true)
	if got := p.LossPercent(); got != 25 {
		t.Fatalf("video loss = %d, want 25", got)
	}
	if !p.NeedsKeyframe() {
		t.Fatal("picture loss indication did not request a keyframe")
	}
	p.lossAt.Store(time.Now().Add(-16 * time.Second).UnixMilli())
	if got := p.LossPercent(); got != -1 {
		t.Fatalf("stale feedback = %d, want -1", got)
	}
}
