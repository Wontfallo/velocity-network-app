package dev.velocity.smoke;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Test-only host. It runs the actual Android System WebView, not desktop emulation. */
public final class MainActivity extends Activity {
    private boolean injected = false;
    private boolean reported = false;
    private String testCase;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        testCase = getIntent().getStringExtra("case");
        String url = getIntent().getStringExtra("url");
        WebView web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        // Deliberately keep Android's secure defaults. A test must not disguise
        // opaque file-origin restrictions by disabling browser security.
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(true);
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface public void report(String json) { saveReport(json); }
        }, "VelocityTest");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i("VelocityWebView", message.messageLevel() + " " + message.message()
                    + " @ " + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String loadedUrl) {
                if (injected) return;
                injected = true;
                try {
                    String harness = new String(getAssets().open("probe.js").readAllBytes(), StandardCharsets.UTF_8);
                    view.evaluateJavascript("window.__velocityTestCase=" + JSONObject.quote(testCase)
                        + ";\n" + harness, null);
                } catch (Exception error) {
                    saveReport("{\"ok\":false,\"error\":" + JSONObject.quote(error.toString()) + "}");
                }
            }
        });
        web.loadUrl(url);
    }

    private synchronized void saveReport(String json) {
        if (reported) return;
        reported = true;
        try {
            JSONObject result = new JSONObject(json);
            result.put("case", testCase);
            result.put("androidApi", Build.VERSION.SDK_INT);
            result.put("androidRelease", Build.VERSION.RELEASE);
            result.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            PackageInfo provider = WebView.getCurrentWebViewPackage();
            result.put("webViewPackage", provider == null ? "unknown" : provider.packageName);
            result.put("webViewVersion", provider == null ? "unknown" : provider.versionName);
            try (FileOutputStream output = openFileOutput("report.json", MODE_PRIVATE)) {
                output.write(result.toString(2).getBytes(StandardCharsets.UTF_8));
            }
            Log.i("VelocityResult", result.toString());
        } catch (Exception error) { Log.e("VelocityResult", "Cannot write report", error); }
    }
}
