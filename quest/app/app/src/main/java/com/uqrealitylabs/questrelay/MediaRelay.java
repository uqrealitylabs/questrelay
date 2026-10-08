package com.uqrealitylabs.questrelay;

import java.util.List;

interface MediaRelay extends AutoCloseable {
    void start();
    boolean sendVideo(List<byte[]> packets);
    boolean sendAudio(byte[] packet);
    void close();
}
