package com.uqrealitylabs.questrelay;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Surface;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public final class CaptureService extends Service {
    static final String STOP = "com.uqrealitylabs.questrelay.STOP";
    static volatile String status = "Stopped";
    static volatile boolean running;
    static volatile long startedAtMs;
    static volatile int reconnects;
    static volatile Stats stats = new Stats(0, 0, 0, 0, 0, 0);

    static final class Stats {
        final long videoPackets;
        final long audioPackets;
        final long videoBitrate;
        final long audioBitrate;
        final long queueBytes;
        final long sampledAtMs;

        Stats(long videoPackets, long audioPackets, long videoBitrate, long audioBitrate,
                long queueBytes, long sampledAtMs) {
            this.videoPackets = videoPackets;
            this.audioPackets = audioPackets;
            this.videoBitrate = videoBitrate;
            this.audioBitrate = audioBitrate;
            this.queueBytes = queueBytes;
            this.sampledAtMs = sampledAtMs;
        }
    }
    private static final String TAG = "QuestRelay";
    private static final String CHANNEL = "capture";
    private static final int AUDIO_BYTES = 48_000 / 50 * 2 * 2;
    private final AtomicBoolean active = new AtomicBoolean();
    private volatile MediaCodec video;
    static volatile int captureWidth = 1280;
    static volatile int captureHeight = 720;
    static volatile int captureFps = 30;
    static volatile int targetBitrateBps = 4_000_000;
    static volatile int publisherLoad = 1;
    static volatile int viewerLoad;
    static volatile boolean videoEnabled = true;
    static volatile boolean audioEnabled = true;
    private volatile int encoderCeilingBps = 8_000_000;
    private volatile int requestedBitrateBps;
    private volatile boolean autoQuality;
    private volatile long egressBudgetBps = 200_000_000L;
    private long lastKeyframeRequest;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!active.compareAndSet(false, true)) return START_NOT_STICKY;
        running = true;
        startedAtMs = SystemClock.elapsedRealtime();
        reconnects = 0;
        stats = new Stats(0, 0, 0, 0, 0, 0);
        videoEnabled = true;
        audioEnabled = true;
        publisherLoad = 1;
        viewerLoad = 0;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "QuestRelay capture",
                NotificationManager.IMPORTANCE_LOW));
        Intent stop = new Intent(this, CaptureService.class).setAction(STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 0, stop,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setContentTitle("QuestRelay is sharing your headset")
                .setContentText("Video and device audio are live")
                .setOngoing(true)
                .addAction(android.R.drawable.ic_media_pause, "Stop sharing", stopAction)
                .build();
        startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        status = "Starting capture";
        new Thread(() -> capture(intent), "quest-capture").start();
        return START_NOT_STICKY;
    }

    private void capture(Intent intent) {
        MediaProjection projection = null;
        VirtualDisplay display = null;
        Surface surface = null;
        MediaCodec audio = null;
        AudioRecord record = null;
        RelaySocket relay = null;
        Thread videoThread = null;
        Thread audioThread = null;
        try {
            Intent consent = intent.getParcelableExtra("consent", Intent.class);
            if (consent == null) throw new IllegalArgumentException("Capture consent missing");
            MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
            projection = manager.getMediaProjection(Activity.RESULT_OK, consent);
            if (projection == null) throw new IllegalStateException("Capture consent expired");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    if (active.getAndSet(false)) {
                        status = "Screen sharing was stopped by the headset";
                        stopSelf();
                    }
                }
            }, new Handler(Looper.getMainLooper()));

            Rtp rtp = new Rtp();
            relay = new RelaySocket(intent.getStringExtra("url"), intent.getStringExtra("key"),
                    intent.getStringExtra("headsetId"), this, this::requestKeyframe, () -> {
                        active.set(false);
                        stopSelf();
                    });
            relay.start();

            video = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            MediaCodecInfo.VideoCapabilities capabilities = video.getCodecInfo()
                    .getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).getVideoCapabilities();
            captureWidth = 0;
            captureHeight = 0;
            captureFps = 0;
            int requestedFps = intent.getIntExtra("fps", 60) == 30 ? 30 : 60;
            int[][] profiles = requestedFps == 60
                    ? new int[][] {{1920, 1080, 60}, {1920, 1080, 30},
                            {1280, 720, 60}, {1280, 720, 30}}
                    : new int[][] {{1920, 1080, 30}, {1280, 720, 30}};
            for (int[] profile : profiles) {
                if (capabilities.areSizeAndRateSupported(profile[0], profile[1], profile[2])) {
                    captureWidth = profile[0];
                    captureHeight = profile[1];
                    captureFps = profile[2];
                    break;
                }
            }
            if (!capabilities.areSizeAndRateSupported(captureWidth, captureHeight, captureFps)) {
                throw new IllegalStateException("No supported low-latency H.264 capture profile");
            }
            encoderCeilingBps = Math.min(capabilities.getBitrateRange().getUpper(),
                    Math.max(8_000_000, captureWidth * captureHeight * captureFps / 5));
            autoQuality = intent.getBooleanExtra("autoQuality", true);
            requestedBitrateBps = intent.getIntExtra("bitrate", 8_000_000);
            targetBitrateBps = Math.min(encoderCeilingBps,
                    autoQuality ? Math.min(8_000_000, encoderCeilingBps) : requestedBitrateBps);
            MediaFormat videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC,
                    captureWidth, captureHeight);
            videoFormat.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            videoFormat.setInteger(MediaFormat.KEY_BIT_RATE, targetBitrateBps);
            videoFormat.setInteger(MediaFormat.KEY_FRAME_RATE, captureFps);
            videoFormat.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
            videoFormat.setInteger(MediaFormat.KEY_PROFILE,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline);
            videoFormat.setInteger(MediaFormat.KEY_LEVEL,
                    MediaCodecInfo.CodecProfileLevel.AVCLevel42);
            videoFormat.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
            videoFormat.setInteger(MediaFormat.KEY_LATENCY, 0);
            Log.i(TAG, "Video encoder: " + video.getName());
            video.configure(videoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            surface = video.createInputSurface();
            video.start();
            DisplayMetrics metrics = getResources().getDisplayMetrics();
            display = projection.createVirtualDisplay("QuestRelay", captureWidth, captureHeight,
                    metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    surface, null, null);

            AudioPlaybackCaptureConfiguration captureAudio =
                    new AudioPlaybackCaptureConfiguration.Builder(projection)
                            .addMatchingUsage(AudioAttributes.USAGE_GAME)
                            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                            .build();
            AudioFormat pcm = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(48_000)
                    .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                    .build();
            int bufferBytes = Math.max(AudioRecord.getMinBufferSize(48_000,
                    AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT),
                    AUDIO_BYTES * 4);
            record = new AudioRecord.Builder()
                    .setAudioFormat(pcm)
                    .setBufferSizeInBytes(bufferBytes)
                    .setAudioPlaybackCaptureConfig(captureAudio)
                    .build();
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new IllegalStateException("Device audio capture unavailable");
            }
            MediaFormat audioFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS,
                    48_000, 2);
            audioFormat.setInteger(MediaFormat.KEY_BIT_RATE, 128_000);
            audioFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, AUDIO_BYTES);
            audio = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            Log.i(TAG, "Audio encoder: " + audio.getName());
            audio.configure(audioFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            audio.start();
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new IllegalStateException("Device audio capture did not start");
            }
            MediaCodec runningVideo = video;
            MediaCodec runningAudio = audio;
            AudioRecord runningRecord = record;
            RelaySocket runningRelay = relay;
            videoThread = new Thread(() -> drainVideo(runningVideo, rtp, runningRelay),
                    "video-encoder");
            audioThread = new Thread(() -> drainAudio(runningRecord, runningAudio, rtp,
                    runningRelay), "audio-encoder");
            videoThread.start();
            audioThread.start();
            PowerManager power = getSystemService(PowerManager.class);
            while (active.get()) {
                if (!power.isInteractive()) {
                    status = "Headset asleep; sharing stopped";
                    break;
                }
                SystemClock.sleep(1_000);
            }
        } catch (Exception error) {
            status = "Capture failed: " + error.getMessage();
            Log.e(TAG, "Capture failed", error);
        } finally {
            active.set(false);
            if (record != null) {
                try { record.stop(); } catch (IllegalStateException ignored) { }
            }
            join(videoThread);
            join(audioThread);
            if (display != null) display.release();
            if (record != null) record.release();
            if (audio != null) release(audio);
            if (video != null) release(video);
            video = null;
            if (surface != null) surface.release();
            if (relay != null) relay.close();
            if (projection != null) projection.stop();
            stopSelf();
        }
    }

    private void drainVideo(MediaCodec encoder, Rtp rtp, RelaySocket relay) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        try {
            while (active.get()) {
                int index = encoder.dequeueOutputBuffer(info, 10_000);
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat format = encoder.getOutputFormat();
                    rtp.setVideoConfig(bytes(format.getByteBuffer("csd-0")),
                            bytes(format.getByteBuffer("csd-1")));
                } else if (index >= 0) {
                    ByteBuffer output = encoder.getOutputBuffer(index);
                    if (output != null && info.size > 0) {
                        output.position(info.offset);
                        output.limit(info.offset + info.size);
                        byte[] data = new byte[info.size];
                        output.get(data);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            rtp.setVideoConfig(data, null);
                        } else {
                            List<byte[]> packets = rtp.video(data, info.presentationTimeUs,
                                    (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0);
                            if (!packets.isEmpty() && !relay.sendVideo(packets)) requestKeyframe();
                        }
                    }
                    encoder.releaseOutputBuffer(index, false);
                }
            }
        } catch (Exception error) {
            if (active.get()) fail("Video encoding failed", error);
        }
    }

    private void drainAudio(AudioRecord record, MediaCodec encoder, Rtp rtp, RelaySocket relay) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] pcm = new byte[AUDIO_BYTES];
        try {
            while (active.get()) {
                int offset = 0;
                while (offset < pcm.length && active.get()) {
                    int read = record.read(pcm, offset, pcm.length - offset,
                            AudioRecord.READ_BLOCKING);
                    if (read <= 0) throw new IllegalStateException("Audio capture stopped: " + read);
                    offset += read;
                }
                if (!active.get()) break;
                int input = encoder.dequeueInputBuffer(10_000);
                if (input >= 0) {
                    ByteBuffer buffer = encoder.getInputBuffer(input);
                    if (buffer == null) throw new IllegalStateException("Opus input unavailable");
                    buffer.clear();
                    buffer.put(pcm);
                    long presentationUs = SystemClock.elapsedRealtimeNanos() / 1_000 - 20_000;
                    encoder.queueInputBuffer(input, 0, pcm.length, presentationUs, 0);
                }
                int output;
                while ((output = encoder.dequeueOutputBuffer(info, 0)) >= 0) {
                    ByteBuffer buffer = encoder.getOutputBuffer(output);
                    if (buffer != null && info.size > 0
                            && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        buffer.position(info.offset);
                        buffer.limit(info.offset + info.size);
                        byte[] data = new byte[info.size];
                        buffer.get(data);
                        relay.sendAudio(rtp.audio(data, info.presentationTimeUs));
                    }
                    encoder.releaseOutputBuffer(output, false);
                }
            }
        } catch (Exception error) {
            if (active.get()) fail("Audio encoding failed", error);
        }
    }

    private synchronized void requestKeyframe() {
        MediaCodec encoder = video;
        long now = SystemClock.elapsedRealtime();
        if (encoder == null || now - lastKeyframeRequest < 1_000) return;
        lastKeyframeRequest = now;
        try {
            Bundle parameters = new Bundle();
            parameters.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            encoder.setParameters(parameters);
        } catch (IllegalStateException ignored) { }
    }

    void onControl(boolean publishVideo, boolean publishAudio, int publishers, int viewers,
            long budgetBps) {
        boolean resumeVideo = !videoEnabled && publishVideo;
        videoEnabled = publishVideo;
        audioEnabled = publishAudio;
        publisherLoad = Math.max(1, publishers);
        viewerLoad = Math.max(0, viewers);
        egressBudgetBps = Math.max(1_000_000L, budgetBps);
        if (resumeVideo) requestKeyframe();
        status = publishVideo || publishAudio ? "Live: "
                + (publishVideo ? "video" : "video paused") + ", "
                + (publishAudio ? "device audio" : "audio paused")
                : "Live: publishing paused by operator";
    }

    void adjustBitrate(long queueBytes) {
        MediaCodec encoder = video;
        if (encoder == null || !autoQuality) return;
        long fanout = (long) publisherLoad * Math.max(1, viewerLoad);
        int budget = (int) Math.max(1_000_000L, Math.min(encoderCeilingBps,
                egressBudgetBps / fanout));
        int next = targetBitrateBps;
        if (queueBytes > 128_000) next = Math.max(1_000_000, next * 2 / 3);
        else if (queueBytes < 32_000) next = Math.min(budget, next + Math.max(250_000, next / 6));
        next = Math.min(next, budget);
        if (next == targetBitrateBps) return;
        try {
            Bundle parameters = new Bundle();
            parameters.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, next);
            encoder.setParameters(parameters);
            targetBitrateBps = next;
        } catch (IllegalStateException error) {
            Log.w(TAG, "Encoder rejected bitrate update", error);
        }
    }

    private void fail(String message, Exception error) {
        status = message;
        Log.e(TAG, message, error);
        active.set(false);
        stopSelf();
    }

    private static byte[] bytes(ByteBuffer buffer) {
        if (buffer == null) return null;
        ByteBuffer copy = buffer.duplicate();
        byte[] data = new byte[copy.remaining()];
        copy.get(data);
        return data;
    }

    private static void release(MediaCodec codec) {
        try { codec.stop(); } catch (IllegalStateException ignored) { }
        codec.release();
    }

    private static void join(Thread thread) {
        if (thread == null) return;
        boolean interrupted = false;
        while (thread.isAlive()) {
            try {
                thread.join(100);
            } catch (InterruptedException ignored) {
                interrupted = true;
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    @Override
    public void onDestroy() {
        active.set(false);
        running = false;
        if (status.startsWith("Live") || status.startsWith("Connecting")
                || status.equals("Stopping") || status.equals("Starting capture")) status = "Stopped";
        super.onDestroy();
    }
}
