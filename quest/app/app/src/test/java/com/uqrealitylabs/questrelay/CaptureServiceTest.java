package com.uqrealitylabs.questrelay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertArrayEquals;

import org.junit.Test;

public class CaptureServiceTest {
    @Test
    public void autoBitrateNeedsCleanFeedbackToIncrease() {
        assertEquals(4_000_000, CaptureService.nextBitrate(4_000_000, 12_000_000, -1, -1));
        assertEquals(4_250_000, CaptureService.nextBitrate(4_000_000, 12_000_000, 0, -1));
        assertEquals(4_000_000, CaptureService.nextBitrate(4_000_000, 12_000_000, 1, -1));
        assertEquals(2_666_666, CaptureService.nextBitrate(4_000_000, 12_000_000, 3, -1));
        assertEquals(4_250_000, CaptureService.nextBitrate(4_000_000, 12_000_000, -1, 0));
        assertEquals(2_666_666, CaptureService.nextBitrate(4_000_000, 12_000_000, -1, 129_000));
        assertEquals(2_000_000, CaptureService.nextBitrate(4_000_000, 2_000_000, -1, -1));
    }

    @Test
    public void performanceProfileKeepsSixtyFramesAheadOfThirty() {
        assertArrayEquals(new int[] {1280, 720, 60}, CaptureService.captureProfiles(720, 60)[0]);
        assertArrayEquals(new int[] {1920, 1080, 60}, CaptureService.captureProfiles(1080, 60)[0]);
    }
}
