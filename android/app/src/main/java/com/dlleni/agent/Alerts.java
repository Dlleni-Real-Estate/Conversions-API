package com.dlleni.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Everything the agent sees or hears outside the app.
 *
 * The ring is a notification that behaves like an incoming call: the phone's
 * ringtone on repeat (FLAG_INSISTENT), full screen over the lock screen, an
 * Answer button that dials the customer. It rings for a minute; a lead still
 * unopened after that rings again every few minutes until someone opens it.
 */
final class Alerts {
    static final String CH_RING = "lead_ring_v1";
    static final String CH_FOLLOW = "follow_up_v1";
    static final String CH_SHIFT = "on_shift_v1";

    static final int ID_RING = 1001;
    static final int ID_SHIFT = 1002;
    static final int ID_SIGNED_OUT = 1003;

    /** One minute of ringing per round, then a pause before the next. */
    static final long RING_MS = 60_000;
    static final long RE_RING_MS = 3 * 60_000;

    static final String ACTION_SNOOZE = "com.dlleni.agent.SNOOZE";

    /** The lead ringing right now, and when it started. */
    static volatile String ringingLead = null;
    static volatile long ringingSince = 0;
    /** lead id -> when it last rang, and until when it is snoozed. */
    static final Map<String, Long> lastRing = new ConcurrentHashMap<>();
    static final Map<String, Long> snoozedUntil = new ConcurrentHashMap<>();

    private Alerts() {}

    static final class Lead {
        final String id;
        final String name;
        final String phone;
        final String campaign;
        final String answers;

        Lead(String id, String name, String phone, String campaign, String answers) {
            this.id = id;
            this.name = name == null || name.isEmpty() ? "—" : name;
            this.phone = phone == null ? "" : phone;
            this.campaign = campaign == null ? "" : campaign;
            this.answers = answers == null ? "" : answers;
        }
    }

    static boolean arabic() {
        return "ar".equals(java.util.Locale.getDefault().getLanguage());
    }

    static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;

        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (ring == null) ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        NotificationChannel leads = new NotificationChannel(
                CH_RING, arabic() ? "ليد جديدة (رنة)" : "New lead (ringing)", NotificationManager.IMPORTANCE_HIGH);
        leads.setDescription(arabic() ? "بترن زي المكالمة لما توصلك ليد" : "Rings like a call when a lead is handed to you");
        leads.setSound(ring, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        leads.enableVibration(true);
        leads.setVibrationPattern(new long[]{0, 900, 700, 900, 700, 900});
        leads.enableLights(true);
        leads.setLightColor(Color.GREEN);
        leads.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(leads);

        NotificationChannel follow = new NotificationChannel(
                CH_FOLLOW, arabic() ? "مواعيد المتابعة" : "Follow-ups", NotificationManager.IMPORTANCE_HIGH);
        follow.enableVibration(true);
        nm.createNotificationChannel(follow);

        NotificationChannel shift = new NotificationChannel(
                CH_SHIFT, arabic() ? "متاح لاستقبال الليدز" : "On shift", NotificationManager.IMPORTANCE_LOW);
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
        i.putExtra("lead_id", lead.id);
        i.putExtra("phone", lead.phone);
        return i;
    }

    static void ring(Context c, Lead lead, int alsoWaiting) {
        ensureChannels(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean ar = arabic();

        Intent full = new Intent(c, IncomingLeadActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
                .putExtra("lead_id", lead.id)
                .putExtra("name", lead.name)
                .putExtra("phone", lead.phone)
                .putExtra("campaign", lead.campaign)
                .putExtra("answers", lead.answers)
                .putExtra("waiting", alsoWaiting);
        PendingIntent fullPi = PendingIntent.getActivity(c, 10, full, flags());
        PendingIntent callPi = PendingIntent.getActivity(c, 11, mainIntent(c, "call", lead), flags());
        PendingIntent openPi = PendingIntent.getActivity(c, 12, mainIntent(c, "open", lead), flags());
        PendingIntent laterPi = PendingIntent.getBroadcast(c, 13,
                new Intent(c, ActionReceiver.class).setAction(ACTION_SNOOZE).putExtra("lead_id", lead.id), flags());

        String title = (ar ? "ليد جديدة: " : "New lead: ") + lead.name;
        StringBuilder text = new StringBuilder();
        if (!lead.campaign.isEmpty()) text.append(lead.campaign);
        if (alsoWaiting > 0) {
            if (text.length() > 0) text.append(" · ");
            text.append(ar ? "+" + alsoWaiting + " مستنيين" : "+" + alsoWaiting + " waiting");
        }

        // On Android 12+ the system's own incoming-call look: the caller's
        // name, a green Answer and a red Decline. Android refuses that style
        // without a full-screen intent, and on 14+ a full-screen intent needs
        // the user's permission, so without it the plain ring is used.
        boolean callStyle = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && (Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent());
        try {
            nm.notify(ID_RING, build(c, lead, title, text.toString(), fullPi, openPi, callPi, laterPi, callStyle));
        } catch (RuntimeException refused) {
            nm.notify(ID_RING, build(c, lead, title, text.toString(), fullPi, openPi, callPi, laterPi, false));
        }

        ringingLead = lead.id;
        ringingSince = System.currentTimeMillis();
        lastRing.put(lead.id, ringingSince);
    }

    private static Notification build(Context c, Lead lead, String title, String text, PendingIntent fullPi,
                                      PendingIntent openPi, PendingIntent callPi, PendingIntent laterPi,
                                      boolean callStyle) {
        boolean ar = arabic();
        Notification.Builder b = new Notification.Builder(c, CH_RING)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(title)
                .setContentText(text)
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setColor(0xFF10B981)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fullPi, true)
                .setContentIntent(openPi)
                .setTimeoutAfter(RING_MS);
        if (callStyle) {
            Person caller = new Person.Builder().setName(lead.name).setImportant(true).build();
            b.setStyle(Notification.CallStyle.forIncomingCall(caller, laterPi, callPi));
        } else {
            if (!lead.answers.isEmpty()) b.setStyle(new Notification.BigTextStyle().bigText(text + "\n" + lead.answers));
            b.addAction(new Notification.Action.Builder(null, ar ? "اتصل دلوقتي" : "Call now", callPi).build());
            b.addAction(new Notification.Action.Builder(null, ar ? "بعدين" : "Later", laterPi).build());
        }
        Notification n = b.build();
        // Insistent: the ringtone repeats until the agent acts or the minute is up.
        n.flags |= Notification.FLAG_INSISTENT;
        return n;
    }

    /** Stop the ring. The lead will not ring again for a while. */
    static void stopRing(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(ID_RING);
        if (ringingLead != null) lastRing.put(ringingLead, System.currentTimeMillis());
        ringingLead = null;
    }

    static void snooze(Context c, String leadId) {
        snoozedUntil.put(leadId, System.currentTimeMillis() + RE_RING_MS);
        stopRing(c);
    }

    static void followUp(Context c, String leadId, String name, String phone) {
        ensureChannels(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean ar = arabic();
        Lead lead = new Lead(leadId, name, phone, "", "");
        PendingIntent openPi = PendingIntent.getActivity(c, leadId.hashCode(), mainIntent(c, "open", lead), flags());
        PendingIntent callPi = PendingIntent.getActivity(c, leadId.hashCode() + 1, mainIntent(c, "call", lead), flags());
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
        nm.notify(2000 + (leadId.hashCode() & 0xffff), n);
    }

    static Notification shift(Context c, String text) {
        ensureChannels(c);
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return new Notification.Builder(c, CH_SHIFT)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(arabic() ? "دلني · متاح لاستقبال الليدز" : "Dlleni · on shift")
                .setContentText(text)
                .setOngoing(true)
                .setShowWhen(false)
                .setColor(0xFF4F46E5)
                .setContentIntent(PendingIntent.getActivity(c, 1, open, flags()))
                .build();
    }

    static void signedOut(Context c) {
        ensureChannels(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        nm.cancel(ID_RING);
        nm.notify(ID_SIGNED_OUT, new Notification.Builder(c, CH_FOLLOW)
                .setSmallIcon(R.drawable.ic_stat_lead)
                .setContentTitle(arabic() ? "اتعملك تسجيل خروج" : "You were signed out")
                .setContentText(arabic() ? "ادخل تاني عشان توصلك الليدز" : "Sign in again to keep receiving leads")
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(c, 2, open, flags()))
                .build());
    }
}
