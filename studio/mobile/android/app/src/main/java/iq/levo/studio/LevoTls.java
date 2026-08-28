package iq.levo.studio;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** TLS helpers shared by the MQTT and FTPS printer transports. */
final class LevoTls {
    private static final Pattern COMMON_NAME = Pattern.compile("(?:^|,)CN=([^,]+)", Pattern.CASE_INSENSITIVE);

    private LevoTls() {}

    static X509Certificate inspectCertificate(String host, int port, int timeoutMs) throws Exception {
        TrustManager[] trust = new TrustManager[]{new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }};
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trust, new SecureRandom());
        try (SSLSocket socket = createSocket(context, host, port, timeoutMs)) {
            return (X509Certificate) socket.getSession().getPeerCertificates()[0];
        }
    }

    static SSLSocket connectPinned(String host, int port, String expectedFingerprint, int timeoutMs) throws Exception {
        return createSocket(pinnedContext(expectedFingerprint), host, port, timeoutMs);
    }

    static SSLSocket wrapPinned(Socket connectedSocket, String host, String expectedFingerprint, int timeoutMs) throws Exception {
        SSLSocket socket = (SSLSocket) pinnedContext(expectedFingerprint).getSocketFactory()
            .createSocket(connectedSocket, host, connectedSocket.getPort(), true);
        try {
            socket.setSoTimeout(timeoutMs);
            socket.startHandshake();
            return socket;
        } catch (Exception error) {
            try { socket.close(); } catch (Exception ignored) {}
            throw error;
        }
    }

    private static SSLContext pinnedContext(String expectedFingerprint) throws Exception {
        final String expected = normalizeFingerprint(expectedFingerprint);
        if (expected.length() != 64) throw new CertificateException("A valid SHA-256 certificate pin is required.");
        TrustManager[] trust = new TrustManager[]{new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}

            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("The printer sent no TLS certificate.");
                try {
                    String actual = fingerprint(chain[0]);
                    if (!actual.equalsIgnoreCase(expected)) throw new CertificateException("The printer certificate pin changed.");
                } catch (CertificateException error) {
                    throw error;
                } catch (Exception error) {
                    throw new CertificateException("The printer certificate could not be verified.", error);
                }
            }

            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }};
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trust, new SecureRandom());
        return context;
    }

    static String fingerprint(X509Certificate certificate) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));
    }

    static String commonName(X509Certificate certificate) {
        if (certificate == null) return null;
        Matcher match = COMMON_NAME.matcher(certificate.getSubjectX500Principal().getName());
        return match.find() ? match.group(1).trim() : null;
    }

    static String normalizeFingerprint(String value) {
        return value == null ? "" : value.replace(":", "").replace(" ", "").trim().toLowerCase(Locale.US);
    }

    private static SSLSocket createSocket(SSLContext context, String host, int port, int timeoutMs) throws Exception {
        SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket();
        try {
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
            socket.startHandshake();
            return socket;
        } catch (Exception error) {
            try { socket.close(); } catch (Exception ignored) {}
            throw error;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.US, "%02x", value));
        return result.toString();
    }
}
