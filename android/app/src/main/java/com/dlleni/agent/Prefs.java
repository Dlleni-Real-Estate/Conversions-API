package com.dlleni.agent;

import android.content.Context;
import android.content.SharedPreferences;

/** The few things the app remembers between launches. */
final class Prefs {
    /** Where the system lives. The agent screens are served from here too. */
    static final String DEFAULT_SERVER = "https://conversions-api.vercel.app";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("dlleni_agent", Context.MODE_PRIVATE);
    }

    static String server(Context c) {
        return sp(c).getString("server", DEFAULT_SERVER);
    }

    static String token(Context c) {
        return sp(c).getString("token", "");
    }

    static boolean signedIn(Context c) {
        return !token(c).isEmpty();
    }

    static String agentName(Context c) {
        return sp(c).getString("agent_name", "");
    }

    static void setSession(Context c, String token, String agentName, boolean available) {
        sp(c).edit()
                .putString("token", token)
                .putString("agent_name", agentName)
                .putBoolean("available", available)
                .apply();
    }

    static void clearSession(Context c) {
        sp(c).edit().remove("token").remove("agent_name").apply();
    }

    /** The agent's on-shift switch. Off means no ringing and no background work. */
    static boolean available(Context c) {
        return sp(c).getBoolean("available", true);
    }

    static void setAvailable(Context c, boolean on) {
        sp(c).edit().putBoolean("available", on).apply();
    }

    /** Should the background watcher be running at all? */
    static boolean shouldWatch(Context c) {
        return signedIn(c) && available(c);
    }

    static String version(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }
}
