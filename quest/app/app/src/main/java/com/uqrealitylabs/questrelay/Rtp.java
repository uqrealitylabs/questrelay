package com.uqrealitylabs.questrelay;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

final class Rtp {
    private static final int HEADER = 12;
    private static final int MAX_PAYLOAD = 1188;
    private int videoSequence;
    private int audioSequence;
    private byte[] sps;
    private byte[] pps;

    Rtp() {
        SecureRandom random = new SecureRandom();
        videoSequence = random.nextInt(1 << 16);
        audioSequence = random.nextInt(1 << 16);
    }

    void setVideoConfig(byte[] first, byte[] second) {
        for (byte[] data : new byte[][] {first, second}) {
            if (data == null) continue;
            for (byte[] nal : nals(data)) {
                if (type(nal) == 7) sps = nal;
                if (type(nal) == 8) pps = nal;
            }
        }
    }

    List<byte[]> video(byte[] frame, long presentationUs, boolean keyframe) {
        List<byte[]> units = nals(frame);
        if (units.isEmpty()) return List.of();
        boolean hasSps = false;
        boolean hasPps = false;
        boolean hasIdr = false;
        for (byte[] nal : units) {
            hasSps |= type(nal) == 7;
            hasPps |= type(nal) == 8;
            hasIdr |= type(nal) == 5;
        }
        if ((keyframe || hasIdr) && sps != null && !hasSps) units.add(0, sps);
        if ((keyframe || hasIdr) && pps != null && !hasPps) {
            units.add(sps != null && !hasSps ? 1 : 0, pps);
        }
        int timestamp = (int) (presentationUs * 90_000L / 1_000_000L);
        List<byte[]> packets = new ArrayList<>();
        for (int index = 0; index < units.size(); index++) {
            byte[] nal = units.get(index);
            boolean last = index == units.size() - 1;
            if (nal.length <= MAX_PAYLOAD) {
                packets.add(packet(102, 10_001, videoSequence++, timestamp, last, nal));
                continue;
            }
            byte fuIndicator = (byte) ((nal[0] & 0xe0) | 28);
            int offset = 1;
            while (offset < nal.length) {
                int size = Math.min(MAX_PAYLOAD - 2, nal.length - offset);
                byte fuHeader = (byte) ((nal[0] & 0x1f)
                        | (offset == 1 ? 0x80 : 0)
                        | (offset + size == nal.length ? 0x40 : 0));
                byte[] payload = new byte[size + 2];
                payload[0] = fuIndicator;
                payload[1] = fuHeader;
                System.arraycopy(nal, offset, payload, 2, size);
                packets.add(packet(102, 10_001, videoSequence++, timestamp,
                        last && offset + size == nal.length, payload));
                offset += size;
            }
        }
        return packets;
    }

    byte[] audio(byte[] frame, long presentationUs) {
        if (frame.length == 0 || frame.length > MAX_PAYLOAD) {
            throw new IllegalArgumentException("Invalid Opus frame size");
        }
        int timestamp = (int) (presentationUs * 48_000L / 1_000_000L);
        return packet(111, 10_002, audioSequence++, timestamp, true, frame);
    }

    private static byte[] packet(int payloadType, int ssrc, int sequence, int timestamp,
            boolean marker, byte[] payload) {
        byte[] packet = new byte[HEADER + payload.length];
        packet[0] = (byte) 0x80;
        packet[1] = (byte) (payloadType | (marker ? 0x80 : 0));
        packet[2] = (byte) (sequence >>> 8);
        packet[3] = (byte) sequence;
        packet[4] = (byte) (timestamp >>> 24);
        packet[5] = (byte) (timestamp >>> 16);
        packet[6] = (byte) (timestamp >>> 8);
        packet[7] = (byte) timestamp;
        packet[8] = (byte) (ssrc >>> 24);
        packet[9] = (byte) (ssrc >>> 16);
        packet[10] = (byte) (ssrc >>> 8);
        packet[11] = (byte) ssrc;
        System.arraycopy(payload, 0, packet, HEADER, payload.length);
        return packet;
    }

    private static List<byte[]> nals(byte[] data) {
        List<byte[]> units = new ArrayList<>();
        int start = startCode(data, 0);
        if (start >= 0) {
            while (start >= 0) {
                int begin = start + (data[start + 2] == 1 ? 3 : 4);
                int next = startCode(data, begin);
                int end = next < 0 ? data.length : next;
                while (end > begin && data[end - 1] == 0) end--;
                if (end > begin) units.add(Arrays.copyOfRange(data, begin, end));
                start = next;
            }
            return units;
        }
        int position = 0;
        while (position + 4 <= data.length) {
            long length = ((long) (data[position] & 0xff) << 24)
                    | ((long) (data[position + 1] & 0xff) << 16)
                    | ((long) (data[position + 2] & 0xff) << 8)
                    | (data[position + 3] & 0xff);
            position += 4;
            if (length == 0 || length > data.length - position) break;
            units.add(Arrays.copyOfRange(data, position, position + (int) length));
            position += (int) length;
        }
        if (position == data.length && !units.isEmpty()) return units;
        return data.length == 0 ? List.of() : new ArrayList<>(List.of(data));
    }

    private static int startCode(byte[] data, int from) {
        for (int index = from; index + 3 < data.length; index++) {
            if (data[index] == 0 && data[index + 1] == 0
                    && (data[index + 2] == 1
                    || (data[index + 2] == 0 && data[index + 3] == 1))) {
                return index;
            }
        }
        return -1;
    }

    private static int type(byte[] nal) {
        return nal.length == 0 ? 0 : nal[0] & 0x1f;
    }
}
