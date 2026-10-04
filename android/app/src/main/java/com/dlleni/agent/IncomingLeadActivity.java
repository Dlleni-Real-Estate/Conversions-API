package com.dlleni.agent;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The full-screen alert: what the agent sees when a lead arrives while the
 * phone is locked or the screen is off. Built in code - it is one screen, and
 * it has to appear instantly with no network and no web page behind it.
 *
 * The ringtone itself belongs to the notification, so it keeps sounding
 * whether this screen is up or the agent sees the heads-up banner instead.
 */
public class IncomingLeadActivity extends Activity {
    private String leadId;
    private String phone;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        render(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        render(intent);
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void render(Intent in) {
        boolean ar = Alerts.arabic(this);
        leadId = in.getStringExtra("lead_id");
        phone = in.getStringExtra("phone");
        String name = in.getStringExtra("name");
        String campaign = in.getStringExtra("campaign");
        String answers = in.getStringExtra("answers");
        int waiting = in.getIntExtra("waiting", 0);

        FrameLayout root = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0xFF312E81, 0xFF4F46E5, 0xFF047857});
        root.setBackground(bg);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(28), dp(56), dp(28), dp(36));
        root.addView(col, new FrameLayout.LayoutParams(-1, -1));

        TextView label = text(ar ? "ليد جديدة" : "New lead", 15, 0xCCFFFFFF, false);
        label.setLetterSpacing(0.08f);
        col.addView(label);

        // The pulsing circle with the customer's initials.
        FrameLayout pulseBox = new FrameLayout(this);
        View halo = new View(this);
        GradientDrawable haloBg = new GradientDrawable();
        haloBg.setShape(GradientDrawable.OVAL);
        haloBg.setColor(0x3310B981);
        halo.setBackground(haloBg);
        pulseBox.addView(halo, new FrameLayout.LayoutParams(dp(150), dp(150), Gravity.CENTER));
        TextView avatar = text(initials(name), 44, Color.WHITE, true);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable avBg = new GradientDrawable();
        avBg.setShape(GradientDrawable.OVAL);
        avBg.setColor(0xFF10B981);
        avatar.setBackground(avBg);
        pulseBox.addView(avatar, new FrameLayout.LayoutParams(dp(112), dp(112), Gravity.CENTER));
        LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(dp(170), dp(170));
        pbLp.topMargin = dp(28);
        col.addView(pulseBox, pbLp);
        ObjectAnimator pulse = ObjectAnimator.ofPropertyValuesHolder(halo,
                PropertyValuesHolder.ofFloat(View.SCALE_X, 0.85f, 1.12f),
                PropertyValuesHolder.ofFloat(View.SCALE_Y, 0.85f, 1.12f),
                PropertyValuesHolder.ofFloat(View.ALPHA, 1f, 0.35f));
        pulse.setDuration(900);
        pulse.setRepeatCount(ValueAnimator.INFINITE);
        pulse.setRepeatMode(ValueAnimator.REVERSE);
        pulse.start();

        TextView nameView = text(TextUtils.isEmpty(name) ? "—" : name, 30, Color.WHITE, true);
        nameView.setMaxLines(2);
        nameView.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nLp = new LinearLayout.LayoutParams(-2, -2);
        nLp.topMargin = dp(20);
        col.addView(nameView, nLp);

        if (!TextUtils.isEmpty(phone)) {
            TextView ph = text("+" + phone, 18, 0xDDFFFFFF, false);
            ph.setTextDirection(View.TEXT_DIRECTION_LTR);
            col.addView(ph);
        }
        if (!TextUtils.isEmpty(campaign)) {
            TextView cp = text(campaign, 15, 0xBBFFFFFF, false);
            LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(-2, -2);
            cLp.topMargin = dp(6);
            col.addView(cp, cLp);
        }
        if (!TextUtils.isEmpty(answers)) {
            TextView an = text(answers, 15, Color.WHITE, false);
            an.setMaxLines(4);
            an.setEllipsize(TextUtils.TruncateAt.END);
            GradientDrawable card = new GradientDrawable();
            card.setCornerRadius(dp(18));
            card.setColor(0x26FFFFFF);
            an.setBackground(card);
            an.setPadding(dp(16), dp(12), dp(16), dp(12));
            LinearLayout.LayoutParams aLp = new LinearLayout.LayoutParams(-1, -2);
            aLp.topMargin = dp(18);
            col.addView(an, aLp);
        }
        if (waiting > 0) {
            TextView w = text(ar ? "+" + waiting + " ليد تانية مستنية" : "+" + waiting + " more waiting", 14, 0xFFFDE68A, true);
            LinearLayout.LayoutParams wLp = new LinearLayout.LayoutParams(-2, -2);
            wLp.topMargin = dp(10);
            col.addView(w, wLp);
        }

        View spacer = new View(this);
        col.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        Button call = button(ar ? "📞  اتصل دلوقتي" : "📞  Call now", 0xFF10B981, Color.WHITE, 20);
        call.setOnClickListener(v -> go("call"));
        col.addView(call, buttonLp(64));

        Button open = button(ar ? "افتح التفاصيل" : "Open details", 0x33FFFFFF, Color.WHITE, 17);
        open.setOnClickListener(v -> go("open"));
        LinearLayout.LayoutParams oLp = buttonLp(54);
        oLp.topMargin = dp(12);
        col.addView(open, oLp);

        Button later = button(ar ? "بعدين" : "Later", Color.TRANSPARENT, 0xCCFFFFFF, 16);
        later.setOnClickListener(v -> {
            if (leadId != null) Alerts.snooze(this, leadId);
            finish();
        });
        LinearLayout.LayoutParams lLp = buttonLp(48);
        lLp.topMargin = dp(6);
        col.addView(later, lLp);

        setContentView(root);
    }

    private void go(String action) {
        Alerts.stopRing(this);
        Intent i = Alerts.mainIntent(this, action,
                new Alerts.Lead(leadId == null ? "" : leadId, "", phone, "", ""));
        // From the lock screen, ask to unlock first so the app and the dialer
        // can open; the dialer itself shows over the keyguard either way.
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km != null && km.isKeyguardLocked() && Build.VERSION.SDK_INT >= 26) {
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    startActivity(i);
                    finish();
                }

                @Override
                public void onDismissCancelled() {
                    startActivity(i);
                    finish();
                }

                @Override
                public void onDismissError() {
                    startActivity(i);
                    finish();
                }
            });
            return;
        }
        startActivity(i);
        finish();
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String s, int bgColor, int fg, float sp) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextColor(fg);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setStateListAnimator(null);
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(22));
        d.setColor(bgColor);
        b.setBackground(d);
        return b;
    }

    private LinearLayout.LayoutParams buttonLp(int heightDp) {
        return new LinearLayout.LayoutParams(-1, dp(heightDp));
    }

    private static String initials(String name) {
        if (TextUtils.isEmpty(name)) return "?";
        String[] parts = name.trim().split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(2, parts.length); i++) {
            if (!parts[i].isEmpty()) sb.appendCodePoint(parts[i].codePointAt(0));
        }
        return sb.toString().toUpperCase();
    }
}
