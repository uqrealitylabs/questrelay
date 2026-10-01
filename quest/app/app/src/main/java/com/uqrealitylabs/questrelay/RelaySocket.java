package com.uqrealitylabs.questrelay;

import android.util.Log;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

final class RelaySocket implements AutoCloseable {
    private static final String TAG = "QuestRelay";
    private static final String STREAMER_TOOLS_URL = "http://127.0.0.1:53502/data";
    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS)
            .build();
    private final OkHttpClient gameStatsClient = new OkHttpClient.Builder()
            .callTimeout(800, TimeUnit.MILLISECONDS)
            .build();
    private final String url;
    private final String key;
    private final String headsetId;
    private final CaptureService service;
    private final Runnable onReady;
    private final Runnable onFatal;
    private volatile boolean running;
    private volatile boolean ready;
    private volatile WebSocket socket;
    private Thread thread;
    private Thread gameStatsThread;
    private long nextGameStatsWarnAt;

    RelaySocket(String url, String key, String headsetId, CaptureService service,
            Runnable onReady, Runnable onFatal) {
        this.url = url;
        this.key = key;
        this.headsetId = headsetId;
        this.service = service;
        this.onReady = onReady;
        this.onFatal = onFatal;
    }

    void start() {
        running = true;
        thread = new Thread(this::connectLoop, "relay-connection");
        thread.start();
        gameStatsThread = new Thread(this::gameStatsLoop, "game-stats");
        gameStatsThread.start();
    }

    // ponytail: TCP can retain stale media on packet loss; move ingest to WebRTC/SRTP if WAN measurements miss the latency budget
    synchronized boolean sendVideo(List<byte[]> packets) {
        WebSocket current = socket;
        if (!CaptureService.videoEnabled) return true;
        if (!ready || current == null || current.queueSize() > 256_000) return false;
        for (byte[] packet : packets) {
            if (!current.send(ByteString.of(packet))) return false;
        }
        return true;
    }

    synchronized boolean sendAudio(byte[] packet) {
        WebSocket current = socket;
        if (!CaptureService.audioEnabled) return true;
        if (!ready || current == null) return false;
        if (current.queueSize() > 512_000) {
            ready = false;
            current.cancel();
            return false;
        }
        return current.send(ByteString.of(packet));
    }

    private void connectLoop() {
        int delaySeconds = 1;
        while (running) {
            CountDownLatch closed = new CountDownLatch(1);
            CaptureService.status = "Connecting to relay";
            try {
                Request request = new Request.Builder().url(url).build();
                socket = client.newWebSocket(request, new WebSocketListener() {
                    @Override
                    public void onOpen(WebSocket webSocket, Response response) {
                        try {
                            JSONObject join = new JSONObject()
                                    .put("id", 1)
                                    .put("action", "join")
                                    .put("role", "publisher")
                                    .put("key", key)
                                    .put("headsetId", headsetId);
                            webSocket.send(join.toString());
                        } catch (Exception error) {
                            fail(webSocket, error);
                        }
                    }

                    @Override
                    public void onMessage(WebSocket webSocket, String text) {
                        try {
                            JSONObject reply = new JSONObject(text);
                            if ("capture".equals(reply.optString("event"))) {
                                service.onControl(reply.getBoolean("videoEnabled"),
                                        reply.getBoolean("audioEnabled"),
                                        reply.getInt("publishers"), reply.getInt("viewers"),
                                        reply.getLong("egressBudgetBps"));
                                return;
                            }
                            int id = reply.optInt("id", 0);
                            if (id == 1) {
                                if (!reply.optBoolean("ok")) {
                                    CaptureService.status = reply.optString("error", "Join rejected");
                                    running = false;
                                    onFatal.run();
                                    webSocket.close(1008, "Join rejected");
                                    return;
                                }
                                webSocket.send(new JSONObject()
                                        .put("id", 2)
                                        .put("action", "startIngest")
                                        .toString());
                            } else if (id == 2) {
                                if (!reply.optBoolean("ok")) {
                                    CaptureService.status = reply.optString("error", "Ingest rejected");
                                    running = false;
                                    onFatal.run();
                                    webSocket.close(1008, "Ingest rejected");
                                    return;
                                }
                                JSONObject data = reply.getJSONObject("data");
                                if (data.getJSONObject("video").getInt("payloadType") != 102
                                        || data.getJSONObject("video").getInt("ssrc") != 10_001
                                        || data.getJSONObject("audio").getInt("payloadType") != 111
                                        || data.getJSONObject("audio").getInt("ssrc") != 10_002) {
                                    throw new IllegalStateException("Relay RTP settings changed");
                                }
                                ready = true;
                                CaptureService.status = CaptureService.videoEnabled
                                        || CaptureService.audioEnabled ? "Live: publishing"
                                        : "Live: publishing paused by operator";
                                onReady.run();
                            } else if (id == 3 && reply.optBoolean("ok")) {
                                JSONObject data = reply.getJSONObject("data");
                                long videoPackets = data.getJSONObject("video").getLong("packets");
                                long audioPackets = data.getJSONObject("audio").getLong("packets");
                                CaptureService.stats = new CaptureService.Stats(videoPackets,
                                        audioPackets,
                                        data.getJSONObject("video").getLong("bitrate"),
                                        data.getJSONObject("audio").getLong("bitrate"),
                                        webSocket.queueSize(),
                                        android.os.SystemClock.elapsedRealtime());
                                service.adjustBitrate(webSocket.queueSize());
                                Log.i(TAG, "Relay packets: video=" + videoPackets
                                        + " audio=" + audioPackets);
                            }
                        } catch (Exception error) {
                            fail(webSocket, error);
                        }
                    }

                    @Override
                    public void onClosing(WebSocket webSocket, int code, String reason) {
                        ready = false;
                        webSocket.close(code, reason);
                    }

                    @Override
                    public void onClosed(WebSocket webSocket, int code, String reason) {
                        ready = false;
                        closed.countDown();
                    }

                    @Override
                    public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                        ready = false;
                        if (running) {
                            CaptureService.reconnects++;
                            CaptureService.status = "Relay disconnected; retrying";
                            Log.w(TAG, "Relay connection failed", error);
                        }
                        closed.countDown();
                    }
                });
                while (running && !closed.await(5, TimeUnit.SECONDS)) {
                    WebSocket current = socket;
                    if (ready && current != null) {
                        current.send("{\"id\":3,\"action\":\"stats\"}");
                        try {
                            current.send(new JSONObject()
                                    .put("id", 4)
                                    .put("action", "captureStats")
                                    .put("videoEnabled", CaptureService.videoEnabled)
                                    .put("audioEnabled", CaptureService.audioEnabled)
                                    .put("queueBytes", current.queueSize())
                                    .put("targetBitrateBps", CaptureService.targetBitrateBps)
                                    .put("width", CaptureService.captureWidth)
                                    .put("height", CaptureService.captureHeight)
                                    .put("fps", CaptureService.captureFps)
                                    .toString());
                        } catch (Exception error) {
                            Log.w(TAG, "Could not report capture stats", error);
                        }
                    }
                }
            } catch (Exception error) {
                if (running) Log.w(TAG, "Relay connection failed", error);
            }
            ready = false;
            socket = null;
            if (!running) break;
            try {
                Thread.sleep(delaySeconds * 1_000L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            }
            delaySeconds = Math.min(delaySeconds * 2, 10);
        }
    }

    private void gameStatsLoop() {
        while (running) {
            WebSocket current = socket;
            if (ready && current != null) {
                try {
                    Request request = new Request.Builder().url(STREAMER_TOOLS_URL).build();
                    try (Response response = gameStatsClient.newCall(request).execute()) {
                        if (response.isSuccessful() && response.body() != null) {
                            JSONObject data = new JSONObject(response.body().string());
                            current.send(new JSONObject()
                                    .put("id", 5)
                                    .put("action", "gameStats")
                                    .put("score", data.optInt("score", 0))
                                    .put("goodCuts", data.optInt("goodCuts", 0))
                                    .put("badCuts", data.optInt("badCuts", 0))
                                    .put("missedNotes", data.optInt("missedNotes", 0))
                                    .put("combo", data.optInt("combo", 0))
                                    .toString());
                        }
                    }
                } catch (Exception error) {
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (now >= nextGameStatsWarnAt) {
                        nextGameStatsWarnAt = now + 15_000L;
                        Log.d(TAG, "Streamer-tools unavailable", error);
                    }
                }
            }
            try {
                Thread.sleep(1_000L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    private void fail(WebSocket webSocket, Exception error) {
        ready = false;
        CaptureService.status = "Relay protocol error";
        Log.e(TAG, "Relay protocol error", error);
        running = false;
        onFatal.run();
        webSocket.close(1002, "Protocol error");
    }

    @Override
    public void close() {
        running = false;
        ready = false;
        WebSocket current = socket;
        if (current != null) current.cancel();
        if (thread != null) thread.interrupt();
        if (gameStatsThread != null) gameStatsThread.interrupt();
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
        gameStatsClient.dispatcher().executorService().shutdown();
        gameStatsClient.connectionPool().evictAll();
    }
}
