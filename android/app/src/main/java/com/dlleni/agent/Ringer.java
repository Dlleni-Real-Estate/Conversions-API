package com.dlleni.agent;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;

/**
 * The sound and the buzz of a ring, played by the app itself.
 *
 * Not left to the notification: many phones (Xiaomi, Oppo, Realme, Infinix,
 * Tecno) switch notification sound off for every newly installed app, so a
 * notification "ringtone" arrives as a silent buzz. This plays the phone's
 * ringtone on the alarm stream instead - the way an alarm clock does - so it
 * sounds whatever the notification settings say, and even in silent mode.
 *
 * While the phone is on a real call it goes quiet and comes back when the call
 * ends, within the same ring.
 */
final class Ringer {
    /** At least this share of the alarm volume while ringing; put back after. */
    private static final float VOLUME_FLOOR = 0.7f;
    private static final long[] PATTERN = {0, 1000, 800};

    private static final Handler main = new Handler(Looper.getMainLooper());

    private static MediaPlayer player;
    private static Vibrator vibrator;
    private static AudioFocusRequest focus;
    private static int restoreVolume = -1;
    private static boolean ringing = false;
    private static boolean silenced = false;
    private static boolean paused = false;
    private static long endsAt = 0;
    private static Runnable onTimeout;
    private static Context app;

    private Ringer() {}

    static synchronized boolean isRinging() {
        return ringing;
    }

    /**
     * Ring for up to {@code durationMs}, then stop and run {@code timeout}.
     * Ringing again while already ringing just extends the current ring.
     */
    static synchronized void start(Context c, long durationMs, Runnable timeout) {
        app = c.getApplicationContext();
        onTimeout = timeout;
        endsAt = System.currentTimeMillis() + durationMs;
        if (ringing) return;
        ringing = true;
        silenced = false;
        paused = false;
        if (inCall()) {
            paused = true;
        } else {
            sound();
            buzz();
        }
        main.removeCallbacks(TICK);
        main.postDelayed(TICK, 1000);
    }

    /** Stop everything and put the volume back. */
    static synchronized void stop() {
        main.removeCallbacks(TICK);
        ringing = false;
        silenced = false;
        paused = false;
        onTimeout = null;
        quiet();
    }

    /** Volume key on the ring screen: quiet now, but the alert stays up. */
    static synchronized void silence() {
        if (!ringing) return;
        silenced = true;
        quiet();
    }

    private static final Runnable TICK = new Runnable() {
        @Override
        public void run() {
            Runnable timedOut = null;
            synchronized (Ringer.class) {
                if (!ringing) return;
                if (System.currentTimeMillis() >= endsAt) {
                    timedOut = onTimeout;
                    ringing = false;
                    onTimeout = null;
                    quiet();
                } else if (!silenced) {
                    boolean call = inCall();
                    if (call && !paused) {
                        paused = true;
                        quiet();
                    } else if (!call && paused) {
                        paused = false;
                        sound();
                        buzz();
                    }
                }
                if (ringing) main.postDelayed(this, 1000);
            }
            if (timedOut != null) timedOut.run();
        }
    };

    private static boolean inCall() {
        AudioManager am = app == null ? null : app.getSystemService(AudioManager.class);
        if (am == null) return false;
        int mode = am.getMode();
        return mode == AudioManager.MODE_IN_CALL
                || mode == AudioManager.MODE_IN_COMMUNICATION
                || mode == AudioManager.MODE_RINGTONE;
    }

    private static AudioAttributes alarmAttrs() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
    }

    private static void sound() {
        if (app == null || player != null) return;
        AudioManager am = app.getSystemService(AudioManager.class);
        if (am != null) {
            // A ring nobody can hear is no ring: lift a low alarm volume for
            // the length of the ring only.
            try {
                int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                int cur = am.getStreamVolume(AudioManager.STREAM_ALARM);
                int floor = (int) Math.ceil(max * VOLUME_FLOOR);
                if (cur < floor) {
                    restoreVolume = cur;
                    am.setStreamVolume(AudioManager.STREAM_ALARM, floor, 0);
                }
            } catch (RuntimeException notAllowed) {
                restoreVolume = -1;
            }
            // Music or a video pauses while it rings, like a call.
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(alarmAttrs())
                    .build();
            try {
                am.requestAudioFocus(focus);
            } catch (RuntimeException ignored) {
                focus = null;
            }
        }
        // The phone's own ringtone first, so it sounds like a call; a ringtone
        // stored on the SD card may be unreadable, so then the alarm sound,
        // then the tone shipped with the app.
        Uri[] sources = {Settings.System.DEFAULT_RINGTONE_URI, Settings.System.DEFAULT_ALARM_ALERT_URI, null};
        for (Uri uri : sources) {
            MediaPlayer mp = new MediaPlayer();
            try {
                mp.setAudioAttributes(alarmAttrs());
                if (uri != null) {
                    mp.setDataSource(app, uri);
                } else {
                    try (AssetFileDescriptor fd = app.getResources().openRawResourceFd(R.raw.ring)) {
                        mp.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
                    }
                }
                mp.setLooping(true);
                mp.prepare();
                mp.start();
                player = mp;
                return;
            } catch (Exception unreadable) {
                mp.release();
            }
        }
    }

    private static void buzz() {
        if (app == null) return;
        if (vibrator == null) {
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = app.getSystemService(VibratorManager.class);
                vibrator = vm == null ? null : vm.getDefaultVibrator();
            } else {
                vibrator = app.getSystemService(Vibrator.class);
            }
        }
        if (vibrator == null || !vibrator.hasVibrator()) return;
        try {
            // Alarm usage: it buzzes in silent mode too.
            VibrationEffect effect = VibrationEffect.createWaveform(PATTERN, 0);
            if (Build.VERSION.SDK_INT >= 33) {
                vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM));
            } else {
                vibrator.vibrate(effect, alarmAttrs());
            }
        } catch (RuntimeException ignored) {
            // No vibration on this phone.
        }
    }

    private static void quiet() {
        if (player != null) {
            try {
                player.stop();
            } catch (RuntimeException ignored) {
                // Already stopped.
            }
            player.release();
            player = null;
        }
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (RuntimeException ignored) {
                // Nothing to cancel.
            }
        }
        AudioManager am = app == null ? null : app.getSystemService(AudioManager.class);
        if (am != null) {
            if (focus != null) {
                am.abandonAudioFocusRequest(focus);
                focus = null;
            }
            if (restoreVolume >= 0) {
                try {
                    am.setStreamVolume(AudioManager.STREAM_ALARM, restoreVolume, 0);
                } catch (RuntimeException ignored) {
                    // Left as it is.
                }
                restoreVolume = -1;
            }
        }
    }
}
