package com.dlleni.agent;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Plain HTTP to the agent API. Blocking: call it off the main thread. */
final class Api {
    private Api() {}

    /** The server no longer knows this session (signed out, password reset, disabled). */
    static final class Unauthorized extends IOException {
        Unauthorized() {
            super("unauthorized");
        }
    }

    static JSONObject get(Context c, String path) throws IOException {
        return call(c, "GET", path, null);
    }

    static JSONObject post(Context c, String path, JSONObject body) throws IOException {
        return call(c, "POST", path, body == null ? new JSONObject() : body);
    }

    private static JSONObject call(Context c, String method, String path, JSONObject body) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(Prefs.server(c) + path).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(12_000);
            conn.setReadTimeout(15_000);
            conn.setUseCaches(false);
            conn.setRequestProperty("x-agent-token", Prefs.token(c));
            conn.setRequestProperty("x-app-version", Prefs.version(c));
            // Is this phone set up to ring? Shown to the admin next to the agent.
            conn.setRequestProperty("x-device", Diag.header(c).replaceAll("[^\\x20-\\x7E]", "?"));
            conn.setRequestProperty("accept", "application/json");
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("content-type", "application/json");
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int code = conn.getResponseCode();
            if (code == 401) throw new Unauthorized();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : read(in);
            if (code >= 400) throw new IOException("HTTP " + code);
            try {
                return new JSONObject(text);
            } catch (Exception e) {
                throw new IOException("bad response");
            }
        } finally {
            conn.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    /** Fire and forget, for the small writes that must not hold up a tap. */
    static void postAsync(Context c, String path, JSONObject body) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                post(app, path, body);
            } catch (Exception ignored) {
                // The next screen load shows the true state either way.
            }
        }, "api-post").start();
    }
}
