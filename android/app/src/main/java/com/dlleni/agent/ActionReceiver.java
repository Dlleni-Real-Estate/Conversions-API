package com.dlleni.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Later" on the ring: quiet for a few minutes, then it rings again. */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Alerts.ACTION_SNOOZE.equals(intent.getAction())) return;
        String leadId = intent.getStringExtra("lead_id");
        if (leadId != null) Alerts.snooze(context, leadId);
        else Alerts.stopRing(context);
    }
}
