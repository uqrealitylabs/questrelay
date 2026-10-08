package com.uqrealitylabs.questrelay;

import android.os.SystemClock;
import android.util.Log;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;
import transport.Publisher;
import transport.Transport;

final class CloudflareRelay implements MediaRelay {
    private static final String TAG = "QuestRelay";
    private static final MediaType JSON = MediaType.parse("application/json");
    private final OkHttpClient client = new OkHttpClient.Builder()
            .callTimeout(5, TimeUnit.SECONDS).build();
    private final String endpoint;
    private final String key;
    private final String headsetId;
    private final CaptureService service;
    private final Runnable onReady;
    private final Runnable onFatal;
    private final AtomicLong videoPackets = new AtomicLong();
    private final AtomicLong audioPackets = new AtomicLong();
    private final AtomicLong videoBytes = new AtomicLong();
    private final AtomicLong audioBytes = new AtomicLong();
    private volatile Publisher publisher;
    private volatile boolean running;
    private Thread thread;

    CloudflareRelay(String endpoint, String key, String headsetId, CaptureService service,
            Runnable onReady, Runnable onFatal) {
        this.endpoint = endpoint.replaceAll("/+$", "");
        this.key = key;
        this.headsetId = headsetId;
        this.service = service;
        this.onReady = onReady;
        this.onFatal = onFatal;
    }

    @Override
    public void start() {
        running = true;
        thread = new Thread(this::connectLoop, "cloudflare-connection");
        thread.start();
    }

    @Override
    public boolean sendVideo(List<byte[]> packets) {
        if (!CaptureService.videoEnabled) return true;
        Publisher current = publisher;
        if (current == null || !current.connected()) return false;
        for (byte[] packet : packets) {
            if (!current.writeVideo(packet)) return false;
            videoPackets.incrementAndGet();
            videoBytes.addAndGet(packet.length);
        }
        return true;
    }

    @Override
    public boolean sendAudio(byte[] packet) {
        if (!CaptureService.audioEnabled) return true;
        Publisher current = publisher;
        if (current == null || !current.connected() || !current.writeAudio(packet)) return false;
        audioPackets.incrementAndGet();
        audioBytes.addAndGet(packet.length);
        return true;
    }

    private void connectLoop() {
        int retrySeconds = 1;
        while (running) {
            Publisher current = null;
            try {
                CaptureService.status = "Connecting to Cloudflare";
                current = Transport.newPublisher(endpoint, key, headsetId);
                publisher = current;
                current.connect();
                if (!running) break;
                CaptureService.status = "Live: video and device audio";
                onReady.run();
                retrySeconds = 1;
                long sampled = SystemClock.elapsedRealtime();
                long lastHeartbeat = 0;
                long oldVideo = 0;
                long oldAudio = 0;
                while (running && current.connected()) {
                    if (current.needsKeyframe()) onReady.run();
                    long now = SystemClock.elapsedRealtime();
                    if (now - sampled >= 2_000) {
                        long videoTotal = videoBytes.get();
                        long audioTotal = audioBytes.get();
                        long elapsed = Math.max(1, now - sampled);
                        CaptureService.stats = new CaptureService.Stats(videoPackets.get(),
                                audioPackets.get(), (videoTotal - oldVideo) * 8_000 / elapsed,
                                (audioTotal - oldAudio) * 8_000 / elapsed, -1, now);
                        oldVideo = videoTotal;
                        oldAudio = audioTotal;
                        sampled = now;
                        service.adjustBitrate((int) current.lossPercent(), -1);
                    }
                    if (now - lastHeartbeat >= 5_000) {
                        heartbeat(current);
                        lastHeartbeat = now;
                    }
                    SystemClock.sleep(250);
                }
                if (running) throw new IOException("WebRTC connection closed");
            } catch (Exception error) {
                if (running) {
                    CaptureService.reconnects++;
                    CaptureService.status = "Cloudflare disconnected; retrying";
                    Log.w(TAG, "Cloudflare connection failed", error);
                    if (error.getMessage() != null && (error.getMessage().contains("HTTP 401")
                            || error.getMessage().contains("HTTP 403"))) {
                        CaptureService.status = "Publisher key rejected";
                        running = false;
                        onFatal.run();
                    }
                }
            } finally {
                if (publisher == current) publisher = null;
                if (current != null) {
                    try { stop(current); } catch (Exception error) {
                        Log.w(TAG, "Could not withdraw publisher session", error);
                    }
                    current.close();
                }
            }
            if (!running) break;
            try {
                Thread.sleep(retrySeconds * 1_000L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            }
            retrySeconds = Math.min(retrySeconds * 2, 10);
        }
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
    }

    private JSONObject identity(Publisher current) throws Exception {
        return new JSONObject().put("key", key).put("headsetId", headsetId)
                .put("sessionId", current.sessionID());
    }

    private void heartbeat(Publisher current) throws Exception {
        JSONObject body = identity(current)
                .put("videoPackets", videoPackets.get())
                .put("audioPackets", audioPackets.get())
                .put("videoBytes", videoBytes.get())
                .put("audioBytes", audioBytes.get())
                .put("videoBitrate", CaptureService.stats.videoBitrate)
                .put("audioBitrate", CaptureService.stats.audioBitrate)
                .put("targetBitrateBps", CaptureService.targetBitrateBps)
                .put("width", CaptureService.captureWidth)
                .put("height", CaptureService.captureHeight)
                .put("fps", CaptureService.captureFps)
                .put("encodedFps", CaptureService.encodedFps)
                .put("uplinkLossPercent", CaptureService.uplinkLossPercent);
        JSONObject result = request("/api/publisher/heartbeat", body);
        service.onControl(result.getBoolean("videoEnabled"), result.getBoolean("audioEnabled"),
                result.optInt("publishers", 1), result.optInt("viewers", 0),
                result.optLong("egressBudgetBps", 200_000_000L));
    }

    private void stop(Publisher current) throws Exception {
        if (!current.sessionID().isEmpty()) request("/api/publisher/stop", identity(current));
    }

    private JSONObject request(String path, JSONObject body) throws Exception {
        Request request = new Request.Builder().url(endpoint + path)
                .post(RequestBody.create(body.toString(), JSON)).build();
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("Relay returned HTTP " + response.code());
            if (response.body() == null) throw new IOException("Relay returned an empty response");
            return new JSONObject(response.body().string());
        }
    }

    @Override
    public void close() {
        running = false;
        Publisher current = publisher;
        if (current != null) current.close();
        if (thread != null) thread.interrupt();
    }
}
