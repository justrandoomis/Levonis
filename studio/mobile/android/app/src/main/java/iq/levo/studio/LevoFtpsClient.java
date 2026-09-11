package iq.levo.studio;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLSocket;

/** Minimal implicit-FTPS uploader for the printer's port 990 service. */
final class LevoFtpsClient implements Closeable {
    private static final Pattern EPSV_PORT = Pattern.compile("\\(\\|\\|\\|(\\d+)\\|\\)");
    private static final Pattern PASV_ADDRESS = Pattern.compile("\\((\\d+),(\\d+),(\\d+),(\\d+),(\\d+),(\\d+)\\)");
    private final String host;
    private final String accessCode;
    private final String certificateFingerprint;
    private SSLSocket control;
    private BufferedReader reader;
    private BufferedWriter writer;

    LevoFtpsClient(String host, String accessCode, String certificateFingerprint) {
        this.host = host;
        this.accessCode = accessCode;
        this.certificateFingerprint = certificateFingerprint;
    }

    void verify() throws Exception {
        connect();
        try {
            authenticate();
            command("QUIT");
        } finally {
            close();
        }
    }

    void upload(File localFile, String remoteName) throws Exception {
        connect();
        try {
            authenticate();

            int dataPort = passiveDataPort();

            Socket plainData = new Socket();
            plainData.connect(new InetSocketAddress(host, dataPort), 8_000);
            try {
                Response start = command("STOR " + remoteName);
                if (start.code != 125 && start.code != 150) throw new IOException("The printer rejected the G-code upload: " + start.message);
                try (SSLSocket data = LevoTls.wrapPinned(plainData, host, certificateFingerprint, 30_000)) {
                    try (InputStream source = new FileInputStream(localFile); OutputStream destination = data.getOutputStream()) {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while ((read = source.read(buffer)) >= 0) {
                            if (read > 0) destination.write(buffer, 0, read);
                        }
                        destination.flush();
                    }
                }
            } finally {
                try { plainData.close(); } catch (Exception ignored) {}
            }
            expect(readResponse(), 226, "The printer did not finish the G-code upload");
            command("QUIT");
        } finally {
            close();
        }
    }

    private void authenticate() throws Exception {
        Response user = command("USER bblp");
        if (user.code == 331) expect(command("PASS " + accessCode), 230, "FTPS login failed");
        else expect(user, 230, "FTPS login failed");
        expect(command("PBSZ 0"), 200, "FTPS PBSZ negotiation failed");
        expect(command("PROT P"), 200, "FTPS data encryption was rejected");
        expect(command("TYPE I"), 200, "FTPS binary mode was rejected");
    }

    private int passiveDataPort() throws Exception {
        Response passive = command("EPSV");
        if (passive.code == 229) {
            Matcher match = EPSV_PORT.matcher(passive.message);
            if (!match.find()) throw new IOException("The printer returned an invalid EPSV address.");
            return Integer.parseInt(match.group(1));
        }

        // Older printer firmware may implement PASV but not EPSV. The host from
        // the reply is deliberately ignored so the data channel cannot leave the
        // already pinned printer address.
        passive = command("PASV");
        expect(passive, 227, "The printer did not enter FTPS passive mode");
        Matcher match = PASV_ADDRESS.matcher(passive.message);
        if (!match.find()) throw new IOException("The printer returned an invalid PASV address.");
        int high = Integer.parseInt(match.group(5));
        int low = Integer.parseInt(match.group(6));
        if (high > 255 || low > 255) throw new IOException("The printer returned an invalid PASV port.");
        return high * 256 + low;
    }

    private void connect() throws Exception {
        control = LevoTls.connectPinned(host, 990, certificateFingerprint, 6_000);
        control.setSoTimeout(30_000);
        reader = new BufferedReader(new InputStreamReader(control.getInputStream(), StandardCharsets.US_ASCII));
        writer = new BufferedWriter(new OutputStreamWriter(control.getOutputStream(), StandardCharsets.US_ASCII));
        expect(readResponse(), 220, "The printer FTPS service did not become ready");
    }

    private Response command(String command) throws Exception {
        if (writer == null) throw new IOException("FTPS control socket is closed.");
        writer.write(command);
        writer.write("\r\n");
        writer.flush();
        return readResponse();
    }

    private Response readResponse() throws Exception {
        String first = reader == null ? null : reader.readLine();
        if (first == null || first.length() < 3) throw new IOException("The printer closed the FTPS connection.");
        int code;
        try { code = Integer.parseInt(first.substring(0, 3)); }
        catch (NumberFormatException error) { throw new IOException("Invalid FTPS response: " + first, error); }
        StringBuilder message = new StringBuilder(first);
        if (first.length() > 3 && first.charAt(3) == '-') {
            String terminator = String.format("%03d ", code);
            String line;
            do {
                line = reader.readLine();
                if (line == null) throw new IOException("Truncated FTPS response.");
                message.append('\n').append(line);
            } while (!line.startsWith(terminator));
        }
        return new Response(code, message.toString());
    }

    private static void expect(Response response, int code, String message) throws IOException {
        if (response.code != code) throw new IOException(message + " (" + response.message + ")");
    }

    @Override
    public void close() {
        if (control != null) try { control.close(); } catch (Exception ignored) {}
        control = null;
        reader = null;
        writer = null;
    }

    private static final class Response {
        final int code;
        final String message;

        Response(int code, String message) {
            this.code = code;
            this.message = message;
        }
    }
}
