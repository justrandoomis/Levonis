package iq.levo.studio;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLSocket;
import org.json.JSONObject;

/** Small MQTT 3.1.1 client for the printer's authenticated local broker. */
final class LevoMqttClient implements Closeable {
    interface Listener {
        void onMessage(JSONObject message);
        void onConnectionLost(String reason);
    }

    private static final int MAX_PACKET_BYTES = 8 * 1024 * 1024;
    private final String host;
    private final String serial;
    private final String accessCode;
    private final String certificateFingerprint;
    private final Listener listener;
    private final AtomicInteger packetIds = new AtomicInteger(1);
    private final AtomicInteger sequences = new AtomicInteger(1);
    private final Map<String, CompletableFuture<JSONObject>> pending = new ConcurrentHashMap<>();
    private final CountDownLatch initialReport = new CountDownLatch(1);
    private volatile SSLSocket socket;
    private volatile InputStream input;
    private volatile OutputStream output;
    private volatile boolean connected;
    private Thread readerThread;
    private Thread heartbeatThread;

    LevoMqttClient(String host, String serial, String accessCode, String certificateFingerprint, Listener listener) {
        this.host = host;
        this.serial = serial;
        this.accessCode = accessCode;
        this.certificateFingerprint = certificateFingerprint;
        this.listener = listener;
    }

    void connect() throws Exception {
        SSLSocket opened = LevoTls.connectPinned(host, 8883, certificateFingerprint, 5_000);
        socket = opened;
        input = opened.getInputStream();
        output = opened.getOutputStream();

        sendConnect();
        Packet connack = readPacket(input);
        if (connack.type != 2 || connack.payload.length < 2) throw new IOException("The printer returned an invalid MQTT CONNACK.");
        int returnCode = connack.payload[1] & 0xff;
        if (returnCode != 0) {
            if (returnCode == 4 || returnCode == 5) throw new SecurityException("The LAN access code or printer serial was rejected.");
            throw new IOException("The printer rejected MQTT connection (code " + returnCode + ").");
        }

        subscribe("device/" + serial + "/report");
        connected = true;
        opened.setSoTimeout(0);
        startReader();
        startHeartbeat();
        publishJson("device/" + serial + "/request", new JSONObject()
            .put("pushing", new JSONObject()
                .put("sequence_id", nextSequence())
                .put("command", "pushall")
                .put("version", 1)
                .put("push_target", 1)), false);
        if (!initialReport.await(9, TimeUnit.SECONDS)) {
            close();
            throw new SocketTimeoutException("Authenticated, but no status report arrived. Check the printer serial and LAN mode.");
        }
    }

    boolean isConnected() { return connected && socket != null && !socket.isClosed(); }

    String nextSequence() {
        int value = sequences.getAndUpdate(current -> current >= 999_999 ? 1 : current + 1);
        return Integer.toString(value);
    }

    JSONObject request(JSONObject request, String sequence, long timeoutMs) throws Exception {
        if (!isConnected()) throw new IOException("The printer MQTT connection is offline.");
        CompletableFuture<JSONObject> response = new CompletableFuture<>();
        pending.put(sequence, response);
        try {
            publishJson("device/" + serial + "/request", request, true);
            return response.get(timeoutMs, TimeUnit.MILLISECONDS);
        } finally {
            pending.remove(sequence);
        }
    }

    @Override
    public void close() {
        boolean wasConnected = connected;
        connected = false;
        if (wasConnected) {
            try { writePacket(0xe0, new byte[0]); } catch (Exception ignored) {}
        }
        SSLSocket current = socket;
        socket = null;
        input = null;
        output = null;
        if (current != null) try { current.close(); } catch (Exception ignored) {}
        for (CompletableFuture<JSONObject> future : pending.values()) {
            future.completeExceptionally(new IOException("The printer connection closed."));
        }
        pending.clear();
        if (readerThread != null) readerThread.interrupt();
        if (heartbeatThread != null) heartbeatThread.interrupt();
    }

    private void sendConnect() throws Exception {
        ByteArrayOutputStream variable = new ByteArrayOutputStream();
        writeUtf8(variable, "MQTT");
        variable.write(4); // MQTT 3.1.1
        variable.write(0xc2); // username + password + clean session
        variable.write(0);
        variable.write(30); // keepalive seconds
        String suffix = serial.length() > 12 ? serial.substring(serial.length() - 12) : serial;
        writeUtf8(variable, "levo-" + suffix.toLowerCase(Locale.US));
        writeUtf8(variable, "bblp");
        writeUtf8(variable, accessCode);
        writePacket(0x10, variable.toByteArray());
    }

    private void subscribe(String topic) throws Exception {
        int packetId = nextPacketId();
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        payload.write((packetId >>> 8) & 0xff);
        payload.write(packetId & 0xff);
        writeUtf8(payload, topic);
        payload.write(0); // requested QoS
        writePacket(0x82, payload.toByteArray());
        Packet reply = readPacket(input);
        if (reply.type != 9 || reply.payload.length < 3 || (reply.payload[2] & 0xff) == 0x80) {
            throw new IOException("The printer rejected the MQTT status subscription.");
        }
    }

    private void publishJson(String topic, JSONObject json, boolean qosOne) throws Exception {
        byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream payload = new ByteArrayOutputStream(topic.length() + body.length + 8);
        writeUtf8(payload, topic);
        if (qosOne) {
            int packetId = nextPacketId();
            payload.write((packetId >>> 8) & 0xff);
            payload.write(packetId & 0xff);
        }
        payload.write(body);
        writePacket(qosOne ? 0x32 : 0x30, payload.toByteArray());
    }

    private synchronized void writePacket(int firstByte, byte[] payload) throws Exception {
        OutputStream current = output;
        if (current == null) throw new IOException("The printer MQTT socket is closed.");
        current.write(firstByte);
        writeRemainingLength(current, payload.length);
        current.write(payload);
        current.flush();
    }

    private void startReader() {
        readerThread = new Thread(() -> {
            try {
                while (connected) handlePacket(readPacket(input));
            } catch (Exception error) {
                if (connected) {
                    connected = false;
                    listener.onConnectionLost(error.getMessage() == null ? "MQTT connection lost." : error.getMessage());
                    close();
                }
            }
        }, "levo-mqtt-reader");
        readerThread.setDaemon(true);
        readerThread.start();
    }

    private void startHeartbeat() {
        heartbeatThread = new Thread(() -> {
            try {
                while (connected) {
                    Thread.sleep(20_000);
                    if (connected) writePacket(0xc0, new byte[0]);
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            } catch (Exception error) {
                if (connected) listener.onConnectionLost("MQTT heartbeat failed.");
                close();
            }
        }, "levo-mqtt-heartbeat");
        heartbeatThread.setDaemon(true);
        heartbeatThread.start();
    }

    private void handlePacket(Packet packet) throws Exception {
        if (packet.type != 3) return;
        ByteArrayInputStream bytes = new ByteArrayInputStream(packet.payload);
        int topicLength = readUnsignedShort(bytes);
        byte[] topic = readExactly(bytes, topicLength);
        int qos = (packet.flags >>> 1) & 0x03;
        int packetId = qos > 0 ? readUnsignedShort(bytes) : 0;
        byte[] jsonBytes = readExactly(bytes, bytes.available());
        JSONObject message = new JSONObject(new String(jsonBytes, StandardCharsets.UTF_8));
        listener.onMessage(message);
        initialReport.countDown();
        completePending(message);
        if (qos == 1) writePacket(0x40, new byte[]{(byte) (packetId >>> 8), (byte) packetId});
    }

    private void completePending(JSONObject message) {
        Iterator<String> keys = message.keys();
        while (keys.hasNext()) {
            Object value = message.opt(keys.next());
            if (!(value instanceof JSONObject)) continue;
            JSONObject envelope = (JSONObject) value;
            String sequence = envelope.optString("sequence_id", "");
            CompletableFuture<JSONObject> future = pending.get(sequence);
            if (future != null) future.complete(message);
        }
    }

    private int nextPacketId() {
        return packetIds.getAndUpdate(current -> current >= 65_535 ? 1 : current + 1);
    }

    static byte[] encodeRemainingLength(int value) throws IOException {
        if (value < 0 || value > 268_435_455) throw new IOException("Invalid MQTT remaining length.");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(4);
        do {
            int digit = value % 128;
            value /= 128;
            if (value > 0) digit |= 0x80;
            bytes.write(digit);
        } while (value > 0);
        return bytes.toByteArray();
    }

    private static void writeRemainingLength(OutputStream output, int value) throws IOException {
        output.write(encodeRemainingLength(value));
    }

    private static Packet readPacket(InputStream input) throws Exception {
        if (input == null) throw new EOFException("MQTT socket closed.");
        int first = input.read();
        if (first < 0) throw new EOFException("MQTT socket closed.");
        int multiplier = 1;
        int remaining = 0;
        int count = 0;
        int digit;
        do {
            digit = input.read();
            if (digit < 0) throw new EOFException("Truncated MQTT packet.");
            remaining += (digit & 0x7f) * multiplier;
            multiplier *= 128;
            count += 1;
            if (count > 4) throw new IOException("Malformed MQTT remaining length.");
        } while ((digit & 0x80) != 0);
        if (remaining < 0 || remaining > MAX_PACKET_BYTES) throw new IOException("MQTT packet is too large.");
        return new Packet((first >>> 4) & 0x0f, first & 0x0f, readExactly(input, remaining));
    }

    private static void writeUtf8(OutputStream output, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 65_535) throw new IOException("MQTT string is too long.");
        output.write((bytes.length >>> 8) & 0xff);
        output.write(bytes.length & 0xff);
        output.write(bytes);
    }

    private static int readUnsignedShort(InputStream input) throws IOException {
        int high = input.read();
        int low = input.read();
        if (high < 0 || low < 0) throw new EOFException("Truncated MQTT field.");
        return (high << 8) | low;
    }

    private static byte[] readExactly(InputStream input, int length) throws IOException {
        byte[] result = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(result, offset, length - offset);
            if (read < 0) throw new EOFException("Truncated MQTT packet.");
            offset += read;
        }
        return result;
    }

    private static final class Packet {
        final int type;
        final int flags;
        final byte[] payload;

        Packet(int type, int flags, byte[] payload) {
            this.type = type;
            this.flags = flags;
            this.payload = payload;
        }
    }
}
