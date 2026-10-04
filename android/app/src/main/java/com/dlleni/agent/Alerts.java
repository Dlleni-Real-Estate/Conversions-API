package com.dlleni.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Everything the agent sees or hears outside the app.
 *
 * Two things ring like an incoming call:
 *   a new lead      rings for a minute; still unopened, it rings again every
 *                   three minutes until it is opened (or handed to someone else)
 *   a callback      the time the agent picked after a call ("try again in 30
 *                   minutes") has come; rings up to three times, five minutes
 *                   apart, until they call or snooze it
 *
 * The ring is a full-screen alert over the lock screen plus a call-style
 * notification; the sound and buzz come from {@link Ringer}, not from the
 * notification, so phones that mute new apps' notifications still ring.
 * Between rings the alert stays in the shade, silently, as "waiting".
 */
final class Alerts {
    // v2: the ring channel is silent - the Ringer makes the sound. Channels
    // cannot be changed once created, hence a new id.
    static final String CH_RING = "lead_ring_v2";
    static final String CH_WAITING = "lead_waiting_v1";
    static final String CH_FOLLOW = "follow_up_v1";
    static final String CH_SHIFT = "on_shift_v1";
    private static final String CH_RING_OLD = "lead_ring_v1";

    static final int ID_RING = 1001;
    static final int ID_SHIFT = 1002;
    static final int ID_SIGNED_OUT = 1003;

    /** One minute of ringing per round. */
    static final long RING_MS = 60_000;
    /** A new lead nobody opened rings again after this. */
    static final long RE_RING_MS = 3 * 60_000;
    /** "Later" on a new lead. */
    static final long SNOOZE_NEW_MS = 5 * 60_000;
    /** A callback nobody acted on rings again after this, up to CALLBACK_ROUNDS times. */
    static final long CALLBACK_RE_RING_MS = 5 * 60_000;
    static final int CALLBACK_ROUNDS = 3;
    /** "Snooze" on a callback moves it this many minutes, on the server too. */
    static final int SNOOZE_CALLBACK_MIN = 10;

    static final String ACTION_SNOOZE = "com.dlleni.agent.SNOOZE";
    static final String ACTION_SNOOZE_CALLBACK = "com.dlleni.agent.SNOOZE_CALLBACK";

    /** What the ring notification shows right now (ringing, or waiting between rings). */
    static volatile Lead current = null;
    static volatile long ringingSince = 0;
    /** key -> when it last rang / until when it is snoozed / how many times a callback rang. */
    static final Map<String, Long> lastRing = new ConcurrentHashMap<>();
    static final Map<String, Long> snoozedUntil = new ConcurrentHashMap<>();
    static final Map<String, Integer> rounds = new ConcurrentHashMap<>();

    private Alerts() {}

    static final class Lead {
        static final String NEW = "new";
        static final String CALLBACK = "callback";
        static final String TEST = "test";

        final String id;
        final String name;
        final String phone;
        final String campaign;
        final String answers;
        final String kind;
        /** Callback: the follow-up time. New lead: when it was handed over. */
        final long atMs;
        /** Callback: the lead's stage, already in the agent's language. */
        final String stage;

        Lead(String id, String name, String phone, String campaign, String answers, String kind, long atMs, String stage) {
            this.id = id == null ? "" : id;
            this.name = name == null || name.isEmpty() ? "—" : name;
            this.phone = phone == null ? "" : phone;
            this.campaign = campaign == null ? "" : campaign;
            this.answers = answers == null ? "" : answers;
            this.kind = kind == null ? NEW : kind;
            this.atMs = atMs;
            this.stage = stage == null ? "" : stage;
        }

        boolean isCallback() {
            return CALLBACK.equals(kind);
        }

        boolean isTest() {
            return TEST.equals(kind);
        }

        /** A callback is one follow-up time: a new time is a new callback. */
        String key() {
            return isCallback() ? id + "@" + atMs : id;
        }

        Intent toExtras(Intent i) {
            return i.putExtra("lead_id", id)
                    .putExtra("name", name)
                    .putExtra("phone", phone)
                    .putExtra("campaign", campaign)
                    .putExtra("answers", answers)
                    .putExtra("kind", kind)
                    .putExtra("at_ms", atMs)
                    .putExtra("stage", stage);
        }

        static Lead fromExtras(Intent i) {
            return new Lead(i.getStringExtra("lead_id"), i.getStringExtra("name"), i.getStringExtra("phone"),
                    i.getStringExtra("campaign"), i.getStringExtra("answers"), i.getStringExtra("kind"),
                    i.getLongExtra("at_ms", 0), i.getStringExtra("stage"));
        }

        /** A callback from the server's "due" or "upcoming" list. */
        static Lead callback(Context c, JSONObject j) {
            return new Lead(j.optString("lead_id"), j.optString("name", ""), j.optString("phone", ""),
                    j.optString("campaign", ""), "", CALLBACK, j.optLong("at_ms", 0),
                    arabic(c) ? j.optString("stage_ar", "") : j.optString("stage_en", ""));
        }
    }

    /** Arabic only when the agent picked it in the app; English otherwise. */
    static boolean arabic(Context c) {
        return "ar".equals(Prefs.lang(c));
    }

    static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean ar = arabic(c);
        nm.deleteNotificationChannel(CH_RING_OLD);

        NotificationChannel ring = new NotificationChannel(
                CH_RING, ar ? "ليد جديدة ومواعيد المكالمات" : "New leads and callbacks", NotificationManager.IMPORTANCE_HIGH);
        ring.setDescription(ar ? "بترن زي المكالمة. الصوت من التطبيق نفسه" : "Rings like a call. The app plays the sound itself");
        ring.setSound(null, null);
        ring.enableVibration(false);
        ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ring);

        NotificationChannel waiting = new NotificationChannel(
                CH_WAITING, ar ? "ليدز مستنية مكالمتك" : "Waiting for your call", NotificationManager.IMPORTANCE_DEFAULT);
        waiting.setSound(null, null);
        waiting.enableVibration(false);
        waiting.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(waiting);

        NotificationChannel follow = new NotificationChannel(
                CH_FOLLOW, ar ? "مواعيد المتابعة" : "Follow-ups", NotificationManager.IMPORTANCE_HIGH);
        follow.enableVibration(true);
        nm.createNotificationChannel(follow);

        NotificationChannel shift = new NotificationChannel(
                CH_SHIFT, ar ? "متاح لاستقبال الليدز" : "On shift", NotificationManager.IMPORTANCE_LOW);
        shift.setShowBadge(false);
        shift.setSound(null, null);
        nm.createNotificationChannel(shift);
    }

    private static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    /** Opens the app on this lead; action "call" also dials. */
    static Intent mainIntent(Context c, String action, Lead lead) {
        Intent i = new Intent(c, MainActivity.class)
                .setAction("com.dlleni.agent." + action + "." + lead.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra("action", action);
        i.putExtra("lead_id", lead.isTest() ? "test" : lead.id);
        i.putExtra("phone", lead.phone);
        return i;
    }

    private static PendingIntent laterIntent(Context c, Lead lead) {
        Intent i = lead.toExtras(new Intent(c, ActionReceiver.class)
                .setAction(lead.isCallback() ? ACTION_SNOOZE_CALLBACK : ACTION_SNOOZE));
        return PendingIntent.getBroadcast(c, 13, i, flags());
    }

    private static String title(Context c, Lead lead) {
        boolean ar = arabic(c);
        if (lead.isCallback()) return (ar ? "معاد مكالمة: " : "Call back: ") + lead.name;
        return (ar ? "ليد جديدة: " : "New lead: ") + lead.name;
    }

    private static String text(Context c, Lead lead, int alsoWaiting) {
        boolean ar = arabic(c);
        StringBuilder t = new StringBuilder();
        if (lead.isCallback()) {
            t.append(ar ? "المعاد اللي حددته جه" : "The time you picked is now");
            if (!lead.stage.isEmpty()) t.append(" · ").append(ar ? "آخر نتيجة: " : "Last: ").append(lead.stage);
        } else if (!lead.campaign.isEmpty()) {
            t.append(lead.campaign);
        }
        if (alsoWaiting > 0) {
            if (t.length() > 0) t.append(" · ");
            t.append(ar ? "+" + alsoWaiting + " مستنيين" : "+" + alsoWaiting + " waiting");
        }
        return t.toString();
    }

    /** Ring now: full screen over the lock screen, call-style notification, sound and buzz. */
    static void ring(Context c, Lead lead, int alsoWaiting) {
        ensureChannels(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean ar = arabic(c);

        Intent full = lead.toExtras(new Intent(c, IncomingLeadActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION))
                .putExtra("waiting", alsoWaiting);
        PendingIntent fullPi = PendingIntent.getActivity(c, 10, full, flags());
        PendingIntent callPi = PendingIntent.getActivity(c, 11, mainIntent(c, "call", lead), flags());
        PendingIntent openPi = PendingIntent.getActivity(c, 12, mainIntent(c, "open", lead), flags());
        PendingIntent laterPi = laterIntent(c, lead);
        String title = title(c, lead);
        String text = text(c, lead, alsoWaiting);

        // On Android 12+ the system's own incoming-call look: the caller's
        // name, a green Answer and a red Decline. Android refuses that style
        // without a full-screen intent, and on 14+ a full-screen intent needs
        // the user's permission, so without it the plain look is used.
        boolean callStyle = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && (Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent());
        String laterLabel = lead.isCallback()
                ? (ar ? "بعد " + SNOOZE_CALLBACK_MIN + " دقايق" : "In " + SNOOZE_CALLBACK_MIN + " min")
                : (ar ? "بعدين" : "Later");
        try {
            nm.notify(ID_RING, build(c, lead, title, text, fullPi, openPi, callPi, laterPi, laterLabel, callStyle));
        } catch (RuntimeException refused) {
            nm.notify(ID_RING, build(c, lead, title, text, fullPi, openPi, callPi, laterPi, laterLabel, false));
        }

        long now = System.currentTimeMillis();
        current = lead;
        ringingSince = now;
        lastRing.put(lead.key(), now);
        if (lead.isCallback()) rounds.merge(lead.key(), 1, Integer::sum);

        final Context app = c.getApplicationContext();
        Ringer.start(app, RING_MS, () -> onRingTimeout(app, lead));
    }

    private static Notification build(Context c, Lead lead, String title, String text, PendingIntent fullPi,
                                      PendingIntent openPi, PendingIntent callPi, PendingIntent laterPi,
                                      String laterLabel, boolean callStyle) {
        boolean ar = arabic(c);
        Notification.Builder b = new Notification.Builder(c, CH_RING)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(title)
                .setContentText(text)
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setColor(lead.isCallback() ? 0xFFD97706 : 0xFF10B981)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fullPi, true)
                .setContentIntent(openPi);
        if (callStyle) {
            Person caller = new Person.Builder().setName(lead.name).setImportant(true).build();
            b.setStyle(Notification.CallStyle.forIncomingCall(caller, laterPi, callPi));
        } else {
            if (!lead.answers.isEmpty()) b.setStyle(new Notification.BigTextStyle().bigText(text + "\n" + lead.answers));
            b.addAction(new Notification.Action.Builder(null, ar ? "اتصل دلوقتي" : "Call now", callPi).build());
            b.addAction(new Notification.Action.Builder(null, laterLabel, laterPi).build());
        }
        return b.build();
    }

    /**
     * The minute is up and nobody answered: stay in the shade, quietly, as
     * "waiting", until the next ring or until it is dealt with.
     */
    private static void onRingTimeout(Context c, Lead lead) {
        if (current == null || !current.key().equals(lead.key())) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (lead.isTest()) {
            nm.cancel(ID_RING);
            current = null;
            return;
        }
        boolean ar = arabic(c);
        PendingIntent callPi = PendingIntent.getActivity(c, 11, mainIntent(c, "call", lead), flags());
        PendingIntent openPi = PendingIntent.getActivity(c, 12, mainIntent(c, "open", lead), flags());
        String title = lead.isCallback()
                ? (ar ? "فاتتك مكالمة متابعة: " : "Missed callback: ") + lead.name
                : (ar ? "مستني مكالمتك: " : "Waiting for your call: ") + lead.name;
        nm.notify(ID_RING, new Notification.Builder(c, CH_WAITING)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(title)
                .setContentText(ar ? "هترن تاني بعد شوية لو ماتصلتش" : "It will ring again shortly if you don't call")
                .setCategory(Notification.CATEGORY_MISSED_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setColor(0xFFFF9500)
                .setShowWhen(true)
                .setWhen(ringingSince)
                .setContentIntent(openPi)
                .addAction(new Notification.Action.Builder(null, ar ? "اتصل" : "Call", callPi).build())
                .build());
    }

    /** Stop the ring and take the alert down. It will not ring again for a while. */
    static void stopRing(Context c) {
        Ringer.stop();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(ID_RING);
        Lead was = current;
        if (was != null) lastRing.put(was.key(), System.currentTimeMillis());
        current = null;
    }

    /** "Later" on a new lead: quiet for a few minutes, then it rings again. */
    static void snooze(Context c, Lead lead) {
        snoozedUntil.put(lead.key(), System.currentTimeMillis() + SNOOZE_NEW_MS);
        stopRing(c);
    }

    /**
     * "In 10 min" on a callback: the follow-up moves on the server too, so the
     * app's list, the other phones and the next ring all agree.
     */
    static void snoozeCallback(Context c, Lead lead) {
        snoozedUntil.put(lead.key(), System.currentTimeMillis() + SNOOZE_CALLBACK_MIN * 60_000L);
        stopRing(c);
        try {
            Api.postAsync(c, "/api/agent/leads/" + android.net.Uri.encode(lead.id),
                    new JSONObject().put("action", "snooze").put("minutes", SNOOZE_CALLBACK_MIN));
        } catch (Exception ignored) {
            // JSON put cannot fail for these values.
        }
    }

    /** Off shift, a callback is a plain reminder: no ringing. */
    static void followUp(Context c, Lead lead) {
        ensureChannels(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean ar = arabic(c);
        PendingIntent openPi = PendingIntent.getActivity(c, lead.id.hashCode(), mainIntent(c, "open", lead), flags());
        PendingIntent callPi = PendingIntent.getActivity(c, lead.id.hashCode() + 1, mainIntent(c, "call", lead), flags());
        Notification n = new Notification.Builder(c, CH_FOLLOW)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(ar ? "معاد المتابعة: " + lead.name : "Follow-up due: " + lead.name)
                .setContentText(ar ? "كلّمه دلوقتي" : "Call them now")
                .setCategory(Notification.CATEGORY_REMINDER)
                .setColor(0xFFD97706)
                .setAutoCancel(true)
                .setContentIntent(openPi)
                .addAction(new Notification.Action.Builder(null, ar ? "اتصل" : "Call", callPi).build())
                .build();
        nm.notify(2000 + (lead.id.hashCode() & 0xffff), n);
    }

    static Notification shift(Context c, String text) {
        ensureChannels(c);
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return new Notification.Builder(c, CH_SHIFT)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(arabic(c) ? "دلني · متاح لاستقبال الليدز" : "Dlleni · on shift")
                .setContentText(text)
                .setOngoing(true)
                .setShowWhen(false)
                .setColor(0xFF4F46E5)
                .setContentIntent(PendingIntent.getActivity(c, 1, open, flags()))
                .build();
    }

    static void signedOut(Context c) {
        ensureChannels(c);
        stopRing(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        nm.notify(ID_SIGNED_OUT, new Notification.Builder(c, CH_FOLLOW)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(arabic(c) ? "اتعملك تسجيل خروج" : "You were signed out")
                .setContentText(arabic(c) ? "ادخل تاني عشان توصلك الليدز" : "Sign in again to keep receiving leads")
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(c, 2, open, flags()))
                .build());
    }
}
