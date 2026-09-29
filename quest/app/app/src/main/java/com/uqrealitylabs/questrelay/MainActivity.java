package com.uqrealitylabs.questrelay;

import android.Manifest;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.net.URI;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public final class MainActivity extends Activity {
    private static final int AUDIO_PERMISSION = 1;
    private static final int SCREEN_PERMISSION = 2;
    private static final int RAIL = 0xff101116;
    private static final int MAIN = 0xff24252d;
    private static final int SURFACE = 0xff2e3039;
    private static final int STAGE = 0xff1b1c23;
    private static final int TEXT = 0xfff1f2f5;
    private static final int MUTED = 0xffaab0bd;
    private static final int ACCENT = 0xff5865f2;
    private static final int GREEN = 0xff43cf92;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Button[] tabs = new Button[3];
    private final LinearLayout[] panels = new LinearLayout[3];
    private EditText url;
    private EditText key;
    private EditText headsetId;
    private TextView status;
    private TextView statusBadge;
    private TextView settingsMessage;
    private TextView bitrateLabel;
    private TextView statsText;
    private TextView statsAdvice;
    private android.widget.ProgressBar queueGauge;
    private Button startButton;
    private Button stopButton;
    private int bitrateMbps;
    private int fps;
    private boolean autoQuality;
    private int activeTab;
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            updateStatus();
            handler.postDelayed(this, 750);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(RAIL);
        getWindow().setNavigationBarColor(RAIL);
        bitrateMbps = getPreferences(MODE_PRIVATE).getInt("bitrateMbps", 8);
        fps = getPreferences(MODE_PRIVATE).getInt("fps", 60);
        autoQuality = getPreferences(MODE_PRIVATE).getBoolean("autoQuality", true);
        buildInterface();
        showTab(0);
    }

    private void buildInterface() {
        boolean compact = getResources().getConfiguration().screenWidthDp < 600;
        LinearLayout root = column();
        root.setOrientation(compact ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
        root.setBackgroundColor(MAIN);

        LinearLayout nav = column();
        nav.setOrientation(compact ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        nav.setPadding(dp(16), dp(20), dp(16), dp(16));
        nav.setBackgroundColor(RAIL);
        if (!compact) {
            TextView brand = text("QuestRelay", 22, TEXT, true);
            brand.setPadding(dp(4), dp(2), 0, dp(30));
            nav.addView(brand);
        }
        String[] names = {"Live", "Settings", "Stats"};
        for (int index = 0; index < names.length; index++) {
            final int destination = index;
            Button tab = button(names[index], false);
            tab.setGravity(Gravity.CENTER_VERTICAL | Gravity.LEFT);
            tab.setOnClickListener(view -> showTab(destination));
            LinearLayout.LayoutParams params = compact
                    ? new LinearLayout.LayoutParams(0, dp(48), 1)
                    : new LinearLayout.LayoutParams(-1, dp(48));
            params.bottomMargin = compact ? 0 : dp(6);
            nav.addView(tab, params);
            tabs[index] = tab;
        }
        root.addView(nav, compact ? new LinearLayout.LayoutParams(-1, dp(88))
                : new LinearLayout.LayoutParams(dp(170), -1));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout content = column();
        content.setPadding(dp(24), dp(22), dp(24), dp(28));
        scroll.addView(content);
        panels[0] = livePanel();
        panels[1] = settingsPanel();
        panels[2] = statsPanel();
        for (LinearLayout panel : panels) content.addView(panel);
        root.addView(scroll, compact ? new LinearLayout.LayoutParams(-1, 0, 1)
                : new LinearLayout.LayoutParams(0, -1, 1));
        setContentView(root);
    }

    private LinearLayout livePanel() {
        LinearLayout panel = column();
        TextView kicker = text("HEADSET / LIVE", 12, MUTED, true);
        kicker.setLetterSpacing(0.1f);
        panel.addView(kicker);
        TextView heading = text("Share your Quest", 29, TEXT, true);
        heading.setPadding(0, dp(8), 0, dp(5));
        panel.addView(heading);
        TextView intro = text("Your screen and game audio go straight to your room", 15, MUTED, false);
        intro.setPadding(0, 0, 0, dp(18));
        panel.addView(intro);

        LinearLayout card = card();
        LinearLayout top = row();
        ImageView avatar = new ImageView(this);
        avatar.setImageResource(R.drawable.capybara);
        avatar.setContentDescription("QuestRelay capybara");
        avatar.setOnClickListener(view -> {
            if (!ValueAnimator.areAnimatorsEnabled()) return;
            view.animate().cancel();
            view.animate().rotation(-8).setDuration(100).withEndAction(() ->
                    view.animate().rotation(0).setDuration(200).start()).start();
        });
        avatar.setOnHoverListener((view, event) -> {
            if (!ValueAnimator.areAnimatorsEnabled()) return false;
            if (event.getActionMasked() == MotionEvent.ACTION_HOVER_MOVE) {
                float tilt = (event.getX() / Math.max(1, view.getWidth()) - 0.5f) * 8;
                view.animate().rotation(tilt).setDuration(160).start();
            } else if (event.getActionMasked() == MotionEvent.ACTION_HOVER_EXIT) {
                view.animate().rotation(0).setDuration(180).start();
            }
            return false;
        });
        top.addView(avatar, new LinearLayout.LayoutParams(dp(74), dp(74)));
        LinearLayout details = column();
        details.setPadding(dp(15), dp(4), 0, 0);
        statusBadge = text("OFFLINE", 12, MUTED, true);
        details.addView(statusBadge);
        status = text(CaptureService.status, 18, TEXT, true);
        status.setPadding(0, dp(7), 0, 0);
        details.addView(status);
        top.addView(details, new LinearLayout.LayoutParams(0, -2, 1));
        card.addView(top);
        TextView helper = text("Sharing keeps running while you open a game. It stops when the headset sleeps or you press Stop", 13, MUTED, false);
        helper.setPadding(0, dp(15), 0, dp(18));
        card.addView(helper);
        LinearLayout controls = row();
        startButton = button("Start sharing", true);
        startButton.setOnClickListener(view -> start());
        controls.addView(startButton, new LinearLayout.LayoutParams(0, dp(52), 1));
        stopButton = button("Stop", false);
        stopButton.setOnClickListener(view -> {
            stopService(new Intent(this, CaptureService.class));
            CaptureService.status = "Stopping";
            updateStatus();
        });
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(dp(108), dp(52));
        stopParams.leftMargin = dp(10);
        controls.addView(stopButton, stopParams);
        card.addView(controls);
        panel.addView(card);
        return panel;
    }

    private LinearLayout settingsPanel() {
        LinearLayout panel = column();
        panel.addView(text("SETTINGS", 12, MUTED, true));
        TextView heading = text("Connection & capture", 29, TEXT, true);
        heading.setPadding(0, dp(8), 0, dp(16));
        panel.addView(heading);
        LinearLayout card = card();
        url = field(card, "Relay URL", "wss://relay.example.com/ws/relay", false);
        url.setText(getPreferences(MODE_PRIVATE).getString("url",
                BuildConfig.DEBUG ? "ws://127.0.0.1:8788/ws/relay" : ""));
        key = field(card, "Publisher key", "Paste your publisher key", true);
        try {
            String injected = BuildConfig.DEBUG ? getIntent().getStringExtra("publisherKey") : null;
            key.setText(injected != null ? injected : Secret.load(this));
        } catch (Exception error) {
            key.setText("");
        }
        headsetId = field(card, "Headset name", "quest-3", false);
        String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        String suffix = androidId == null ? "headset" : androidId.substring(Math.max(0, androidId.length() - 8));
        headsetId.setText(getPreferences(MODE_PRIVATE).getString("headsetId", "quest-" + suffix));
        settingsMessage = text("The publisher key stays encrypted on this headset", 12, MUTED, false);
        settingsMessage.setPadding(0, dp(9), 0, dp(12));
        card.addView(settingsMessage);
        LinearLayout actions = row();
        Button save = button("Save settings", true);
        save.setOnClickListener(view -> {
            if (saveSettings()) settingsMessage.setText("Settings saved on this headset");
        });
        actions.addView(save, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button test = button("Test relay", false);
        test.setOnClickListener(view -> testRelay());
        LinearLayout.LayoutParams testParams = new LinearLayout.LayoutParams(0, dp(48), 1);
        testParams.leftMargin = dp(10);
        actions.addView(test, testParams);
        card.addView(actions);
        panel.addView(card);

        LinearLayout quality = card();
        quality.addView(text("CAPTURE QUALITY", 12, MUTED, true));
        Switch auto = new Switch(this);
        auto.setText("Auto · balance quality and load");
        auto.setTextColor(TEXT);
        auto.setTextSize(15);
        auto.setChecked(autoQuality);
        auto.setPadding(0, dp(12), 0, dp(12));
        quality.addView(auto);
        bitrateLabel = text("Manual ceiling · " + bitrateMbps + " Mb/s", 16, TEXT, true);
        bitrateLabel.setPadding(0, dp(12), 0, dp(3));
        quality.addView(bitrateLabel);
        SeekBar bitrate = new SeekBar(this);
        bitrate.setMax(39);
        bitrate.setProgress(Math.max(0, Math.min(39, bitrateMbps - 1)));
        bitrate.setEnabled(!autoQuality);
        auto.setOnCheckedChangeListener((button, enabled) -> {
            autoQuality = enabled;
            bitrate.setEnabled(!enabled);
            bitrateLabel.setAlpha(enabled ? 0.55f : 1f);
        });
        bitrateLabel.setAlpha(autoQuality ? 0.55f : 1f);
        bitrate.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                bitrateMbps = progress + 1;
                bitrateLabel.setText("Manual ceiling · " + bitrateMbps + " Mb/s");
            }
            @Override public void onStartTrackingTouch(SeekBar bar) { }
            @Override public void onStopTrackingTouch(SeekBar bar) { }
        });
        quality.addView(bitrate);
        TextView guide = text("Auto adjusts to relay publisher/viewer load and the live send queue. Device encoder limits still apply", 12, MUTED, false);
        guide.setPadding(0, 0, 0, dp(14));
        quality.addView(guide);
        quality.addView(text("Frame rate", 14, TEXT, true));
        LinearLayout fpsControls = row();
        Button slow = button("30 fps", false);
        Button normal = button("60 fps", false);
        slow.setOnClickListener(view -> { fps = 30; styleChoice(slow, true); styleChoice(normal, false); });
        normal.setOnClickListener(view -> { fps = 60; styleChoice(slow, false); styleChoice(normal, true); });
        fpsControls.addView(slow, new LinearLayout.LayoutParams(0, dp(45), 1));
        LinearLayout.LayoutParams normalParams = new LinearLayout.LayoutParams(0, dp(45), 1);
        normalParams.leftMargin = dp(9);
        fpsControls.addView(normal, normalParams);
        fpsControls.setPadding(0, dp(8), 0, 0);
        quality.addView(fpsControls);
        styleChoice(slow, fps == 30);
        styleChoice(normal, fps == 60);
        panel.addView(quality);
        return panel;
    }

    private LinearLayout statsPanel() {
        LinearLayout panel = column();
        panel.addView(text("ENGINEERING", 12, MUTED, true));
        TextView heading = text("Stats for nerds", 29, TEXT, true);
        heading.setPadding(0, dp(8), 0, dp(4));
        panel.addView(heading);
        TextView subtitle = text("Relay ingest · updates every five seconds while sharing", 14, MUTED, false);
        subtitle.setPadding(0, 0, 0, dp(16));
        panel.addView(subtitle);
        LinearLayout card = card();
        statsText = text("No live sample yet", 15, TEXT, false);
        statsText.setTypeface(Typeface.MONOSPACE);
        statsText.setLineSpacing(dp(7), 1f);
        card.addView(statsText);
        TextView gaugeLabel = text("SEND QUEUE · target under 32 KB", 12, MUTED, true);
        gaugeLabel.setPadding(0, dp(18), 0, dp(7));
        card.addView(gaugeLabel);
        queueGauge = new android.widget.ProgressBar(this, null,
                android.R.attr.progressBarStyleHorizontal);
        queueGauge.setMax(256);
        card.addView(queueGauge, new LinearLayout.LayoutParams(-1, dp(10)));
        statsAdvice = text("Start sharing to see live guidance", 13, MUTED, false);
        statsAdvice.setPadding(0, dp(12), 0, 0);
        card.addView(statsAdvice);
        panel.addView(card);
        TextView caveat = text("Control and network delays are separate from glass-to-glass video latency. End-to-end latency is not measured yet", 12, MUTED, false);
        caveat.setPadding(dp(3), 0, 0, dp(14));
        panel.addView(caveat);
        Button copy = button("Copy diagnostics", false);
        copy.setOnClickListener(view -> copyDiagnostics());
        panel.addView(copy, new LinearLayout.LayoutParams(-1, dp(48)));
        return panel;
    }

    private void showTab(int index) {
        activeTab = index;
        for (int item = 0; item < panels.length; item++) {
            panels[item].setVisibility(item == index ? View.VISIBLE : View.GONE);
            styleChoice(tabs[item], item == index);
        }
        if (ValueAnimator.areAnimatorsEnabled()) {
            View panel = panels[index];
            panel.animate().cancel();
            panel.setAlpha(0.65f);
            panel.setTranslationY(dp(7));
            panel.animate().alpha(1).translationY(0).setDuration(170).start();
        }
        updateStatus();
    }

    private boolean saveSettings() {
        String address = url.getText().toString().trim();
        try {
            URI parsed = new URI(address);
            boolean secure = "wss".equals(parsed.getScheme());
            boolean localDebug = BuildConfig.DEBUG && "ws".equals(parsed.getScheme())
                    && ("127.0.0.1".equals(parsed.getHost()) || "localhost".equals(parsed.getHost()));
            if ((!secure && !localDebug) || parsed.getHost() == null
                    || !"/ws/relay".equals(parsed.getPath()) || parsed.getUserInfo() != null
                    || parsed.getRawQuery() != null || parsed.getRawFragment() != null) {
                settingsMessage.setText("Use a WSS relay URL ending in /ws/relay");
                return false;
            }
        } catch (Exception error) {
            settingsMessage.setText("Enter a valid relay URL");
            return false;
        }
        if (key.getText().length() < 32) {
            settingsMessage.setText("Publisher key needs at least 32 characters");
            return false;
        }
        String id = headsetId.getText().toString().trim();
        if (id.length() > 64 || !id.matches("[A-Za-z0-9_-]+")) {
            settingsMessage.setText("Headset name can use letters, numbers, _ and -");
            return false;
        }
        try {
            Secret.save(this, key.getText().toString());
            boolean saved = getPreferences(MODE_PRIVATE).edit()
                    .putString("url", address)
                    .putString("headsetId", id)
                    .putInt("bitrateMbps", bitrateMbps)
                    .putInt("fps", fps)
                    .putBoolean("autoQuality", autoQuality)
                    .commit();
            if (!saved) throw new IllegalStateException("Could not save settings");
            return true;
        } catch (Exception error) {
            settingsMessage.setText("Could not securely save settings");
            return false;
        }
    }

    private void start() {
        if (!saveSettings()) { showTab(1); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION);
        } else {
            askForScreen();
        }
    }

    private void askForScreen() {
        MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
        startActivityForResult(manager.createScreenCaptureIntent(), SCREEN_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == AUDIO_PERMISSION && grants.length > 0
                && grants[0] == PackageManager.PERMISSION_GRANTED) {
            askForScreen();
        } else {
            CaptureService.status = "Audio permission is needed for game audio";
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != SCREEN_PERMISSION) return;
        if (result != RESULT_OK || data == null) {
            CaptureService.status = "Screen sharing was cancelled";
            return;
        }
        Intent service = new Intent(this, CaptureService.class)
                .putExtra("consent", data)
                .putExtra("url", url.getText().toString().trim())
                .putExtra("key", key.getText().toString())
                .putExtra("headsetId", headsetId.getText().toString().trim())
                .putExtra("bitrate", bitrateMbps * 1_000_000)
                .putExtra("autoQuality", autoQuality)
                .putExtra("fps", fps);
        startForegroundService(service);
        CaptureService.status = "Starting capture";
        showTab(0);
    }

    private void testRelay() {
        String address = url.getText().toString().trim();
        URI health;
        try {
            URI relay = new URI(address);
            if (relay.getHost() == null || !"/ws/relay".equals(relay.getPath())) throw new IllegalArgumentException();
            health = new URI("wss".equals(relay.getScheme()) ? "https" : "http", null,
                    relay.getHost(), relay.getPort(), "/health", null, null);
        } catch (Exception error) {
            settingsMessage.setText("Enter a valid relay URL first");
            return;
        }
        settingsMessage.setText("Checking relay…");
        new Thread(() -> {
            OkHttpClient client = new OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build();
            long started = SystemClock.elapsedRealtime();
            String result;
            try (Response response = client.newCall(new Request.Builder().url(health.toString()).build()).execute()) {
                result = response.isSuccessful() ? "Relay healthy · " + (SystemClock.elapsedRealtime() - started) + " ms HTTP" : "Relay returned HTTP " + response.code();
            } catch (Exception error) {
                result = "Relay unreachable · check URL, Wi-Fi and TLS";
            } finally {
                client.dispatcher().executorService().shutdown();
                client.connectionPool().evictAll();
            }
            String message = result;
            runOnUiThread(() -> { if (!isDestroyed()) settingsMessage.setText(message); });
        }, "relay-probe").start();
    }

    private void copyDiagnostics() {
        CaptureService.Stats sample = CaptureService.stats;
        String report = String.format(Locale.US,
                "QuestRelay diagnostics\nStatus: %s\nHeadset: %s\nVideo: %d packets, %d b/s\nAudio: %d packets, %d b/s\nQueue: %d bytes\nReconnects: %d\nProfile: %dx%d %d fps\nQuality: %s, target %d b/s\nLoad: %d publishers, %d viewers\nMedia: video %s, audio %s\nSample age: %s",
                CaptureService.status, headsetId.getText(), sample.videoPackets,
                sample.videoBitrate, sample.audioPackets, sample.audioBitrate,
                sample.queueBytes, CaptureService.reconnects, CaptureService.captureWidth,
                CaptureService.captureHeight, CaptureService.captureFps,
                autoQuality ? "Auto" : "Manual", CaptureService.targetBitrateBps,
                CaptureService.publisherLoad, CaptureService.viewerLoad,
                CaptureService.videoEnabled ? "on" : "off",
                CaptureService.audioEnabled ? "on" : "off",
                sample.sampledAtMs == 0 ? "none" : (SystemClock.elapsedRealtime() - sample.sampledAtMs) + " ms");
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        clipboard.setPrimaryClip(ClipData.newPlainText("QuestRelay diagnostics", report));
        Toast.makeText(this, "Diagnostics copied without publisher key", Toast.LENGTH_SHORT).show();
    }

    private void updateStatus() {
        if (status == null) return;
        String current = CaptureService.status;
        status.setText(current);
        boolean live = current.startsWith("Live");
        statusBadge.setText(live ? "●  LIVE" : CaptureService.running ? "●  CONNECTING" : "●  OFFLINE");
        statusBadge.setTextColor(live ? GREEN : CaptureService.running ? 0xffe8ad67 : MUTED);
        startButton.setEnabled(!CaptureService.running);
        stopButton.setEnabled(CaptureService.running);
        if (activeTab != 2) return;
        CaptureService.Stats sample = CaptureService.stats;
        String age = sample.sampledAtMs == 0 ? "Waiting" : (SystemClock.elapsedRealtime() - sample.sampledAtMs) / 1000 + " s";
        String up = CaptureService.running ? (SystemClock.elapsedRealtime() - CaptureService.startedAtMs) / 1000 + " s" : "Stopped";
        statsText.setText(String.format(Locale.US,
                "Video       %,d packets  ·  %s\nAudio       %,d packets  ·  %s\nQueue       %,d bytes\nTarget      %s · %s\nLoad        %d publishers · %d viewers\nMedia       video %s · audio %s\nSample age  %s\nSession     %s\nReconnects  %d\nProfile     %d × %d · %d fps",
                sample.videoPackets, rate(sample.videoBitrate), sample.audioPackets,
                rate(sample.audioBitrate), sample.queueBytes,
                rate(CaptureService.targetBitrateBps), autoQuality ? "Auto" : "Manual",
                CaptureService.publisherLoad, CaptureService.viewerLoad,
                CaptureService.videoEnabled ? "on" : "off",
                CaptureService.audioEnabled ? "on" : "off",
                age, up, CaptureService.reconnects, CaptureService.captureWidth,
                CaptureService.captureHeight, CaptureService.captureFps));
        queueGauge.setProgress((int) Math.min(256, sample.queueBytes / 1000), true);
        statsAdvice.setText(sample.sampledAtMs == 0 ? "Waiting for a relay sample"
                : sample.queueBytes > 128_000 ? "Send queue rising · Auto will lower bitrate; check Wi-Fi"
                : sample.videoPackets == 0 && CaptureService.videoEnabled
                    ? "No video packets at relay · check screen capture consent"
                    : sample.audioPackets == 0 && CaptureService.audioEnabled
                        ? "No audio packets at relay · check the game's capture policy"
                        : "Relay ingest is healthy · viewer playback delay is not measured");
    }

    private String rate(long bits) {
        return bits >= 1_000_000 ? String.format(Locale.US, "%.1f Mb/s", bits / 1_000_000f)
                : String.format(Locale.US, "%d kb/s", bits / 1000);
    }

    private EditText field(LinearLayout card, String label, String hint, boolean secret) {
        TextView caption = text(label, 13, TEXT, true);
        caption.setPadding(0, dp(8), 0, dp(6));
        card.addView(caption);
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setTextColor(TEXT);
        input.setHintTextColor(MUTED);
        input.setTextSize(14);
        input.setPadding(dp(13), 0, dp(13), 0);
        input.setBackground(round(STAGE, 9, 0xff454855));
        input.setInputType(secret ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
                : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card.addView(input, new LinearLayout.LayoutParams(-1, dp(50)));
        return input;
    }

    private Button button(String label, boolean primary) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setTextColor(TEXT);
        button.setPadding(dp(15), 0, dp(15), 0);
        button.setElevation(0);
        button.setTag(primary);
        applyButtonBackground(button, primary, false);
        button.setOnFocusChangeListener((view, focused) ->
                applyButtonBackground(button, Boolean.TRUE.equals(button.getTag()), focused));
        return button;
    }

    private void styleChoice(Button button, boolean selected) {
        button.setTag(selected);
        button.setTextColor(selected ? TEXT : MUTED);
        applyButtonBackground(button, selected, button.hasFocus());
    }

    private void applyButtonBackground(Button button, boolean selected, boolean focused) {
        int fill = selected ? ACCENT : SURFACE;
        GradientDrawable shape = round(fill, 10, focused ? TEXT : fill);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x55ffffff), shape, round(Color.WHITE, 10, Color.WHITE)));
    }

    private GradientDrawable round(int fill, int radius, int border) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(radius));
        shape.setStroke(dp(1), border);
        return shape;
    }

    private LinearLayout card() {
        LinearLayout card = column();
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(round(STAGE, 13, 0xff3a3c47));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(14);
        card.setLayoutParams(params);
        return card;
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        return layout;
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setIncludeFontPadding(false);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(refresh);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(refresh);
        super.onPause();
    }
}
