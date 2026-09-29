package com.uqrealitylabs.questrelay;

import java.util.List;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public final class RtpTest {
    @Test
    public void packetsKeepCodecConfigAndFragmentLargeFrames() {
        Rtp rtp = new Rtp();
        rtp.setVideoConfig(new byte[] {0, 0, 0, 1, 0x67, 0x42},
                new byte[] {0, 0, 0, 1, 0x68, 0x01});
        byte[] largeNal = new byte[2500];
        largeNal[0] = 0x65;
        List<byte[]> packets = rtp.video(largeNal, 1_000_000, false);
        assertEquals(5, packets.size());
        assertEquals(7, packets.get(0)[12] & 0x1f);
        assertEquals(8, packets.get(1)[12] & 0x1f);
        assertEquals(1200, packets.get(2).length);
        assertTrue((packets.get(2)[13] & 0x80) != 0);
        assertTrue((packets.get(4)[13] & 0x40) != 0);
        assertTrue((packets.get(4)[1] & 0x80) != 0);
        byte[] audio = rtp.audio(new byte[] {1, 2, 3}, 1_000_000);
        assertEquals(111, audio[1] & 0x7f);
        assertEquals(15, audio.length);
    }
}
