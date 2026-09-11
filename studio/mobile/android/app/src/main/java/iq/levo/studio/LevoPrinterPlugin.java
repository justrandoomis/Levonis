package iq.levo.studio;

import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;

@CapacitorPlugin(name = "LevoPrinter")
public class LevoPrinterPlugin extends Plugin {
    private static final String MQTT_PORT_HELP = "Enable LAN Only or Developer Mode on the printer, then verify its IP, serial and LAN access code.";
    private static final long MAX_PROJECT_BYTES = 512L * 1024L * 1024L;
    private static final long MAX_GCODE_BYTES = 512L * 1024L * 1024L;
    private static final int MAX_CHUNK_BYTES = 192 * 1024;
    private final ExecutorService queue = Executors.newSingleThreadExecutor();
    private final Map<String, Transfer> transfers = new ConcurrentHashMap<>();
    private final Object reportLock = new Object();
    private volatile JSObject connectedPrinter;
    private volatile LevoMqttClient mqtt;
    private volatile JSONObject lastReport = new JSONObject();
    private volatile String lastConnectionError;
    private volatile String connectedIp;
    private volatile String connectedAccessCode;
    private volatile String mqttFingerprint;
    private volatile String ftpsFingerprint;
    private volatile boolean fileTransferVerified;

    private static final class Transfer {
        final File directory;
        final long projectBytes;
        final long gcodeBytes;
        final String name;
        int nextProjectChunk;
        int nextGcodeChunk;
        long projectWritten;
        long gcodeWritten;

        Transfer(File directory, long projectBytes, long gcodeBytes, String name) {
            this.directory = directory;
            this.projectBytes = projectBytes;
            this.gcodeBytes = gcodeBytes;
            this.name = name;
        }
    }

    @PluginMethod
    public void getEnvironment(PluginCall call) {
        JSObject capabilities = new JSObject();
        capabilities.put("discovery", true);
        capabilities.put("lanConnection", true);
        capabilities.put("telemetry", true);
        capabilities.put("rawGcodePrintJob", true);
        capabilities.put("packagePrintJob", false);
        capabilities.put("fileTransfer", true);
        capabilities.put("startPrint", true);
        JSObject result = new JSObject();
        result.put("native", true);
        result.put("platform", "android");
        result.put("bridgeVersion", "1.1.0");
        result.put("capabilities", capabilities);
        call.resolve(result);
    }

    @PluginMethod
    public void discoverPrinters(PluginCall call) {
        queue.execute(() -> {
            JSArray printers = new JSArray();
            try {
                List<JSObject> found = Collections.synchronizedList(new ArrayList<>());
                ExecutorService scanner = Executors.newFixedThreadPool(40);
                for (String address : localSubnetCandidates()) scanner.execute(() -> {
                    if (!portOpen(address, 8883, 260)) return;
                    JSObject printer = new JSObject();
                    printer.put("id", address);
                    printer.put("name", "Bambu LAN " + address);
                    printer.put("ip", address);
                    try {
                        X509Certificate certificate = LevoTls.inspectCertificate(address, 8883, 1_800);
                        String commonName = LevoTls.commonName(certificate);
                        if (commonName != null && commonName.matches("[A-Za-z0-9_-]{6,64}")) {
                            printer.put("id", commonName);
                            printer.put("serial", commonName);
                            printer.put("name", "Bambu " + commonName);
                        }
                    } catch (Exception ignored) {}
                    found.add(printer);
                });
                scanner.shutdown();
                scanner.awaitTermination(6, TimeUnit.SECONDS);
                scanner.shutdownNow();
                found.sort(Comparator.comparing(item -> item.optString("ip", "")));
                for (JSObject printer : found) printers.put(printer);
                JSObject result = new JSObject();
                result.put("printers", printers);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not scan the current Wi-Fi network. Enter the printer IP manually.", error);
            }
        });
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String ip = trim(call.getString("ip"));
        String serial = trim(call.getString("serial"));
        String accessCode = trim(call.getString("accessCode"));
        String trustedMqtt = trim(call.getString("trustedFingerprint"));
        String trustedFtps = trim(call.getString("trustedFileFingerprint"));
        if (ip == null || serial == null || accessCode == null) {
            call.reject("Printer IP, serial and LAN access code are required.");
            return;
        }
        if (!serial.matches("[A-Za-z0-9_-]{6,64}") || accessCode.length() < 6 || accessCode.length() > 32) {
            call.reject("The printer serial or LAN access code is invalid.");
            return;
        }

        queue.execute(() -> {
            disconnectInternal();
            try {
                X509Certificate mqttCertificate = LevoTls.inspectCertificate(ip, 8883, 4_500);
                String inspectedMqtt = LevoTls.fingerprint(mqttCertificate);
                String inspectedFtps = null;
                if (portOpen(ip, 990, 900)) {
                    inspectedFtps = LevoTls.fingerprint(LevoTls.inspectCertificate(ip, 990, 4_500));
                }

                boolean mqttTrusted = inspectedMqtt.equalsIgnoreCase(LevoTls.normalizeFingerprint(trustedMqtt));
                boolean ftpsTrusted = inspectedFtps == null || inspectedFtps.equalsIgnoreCase(LevoTls.normalizeFingerprint(trustedFtps));
                if (!mqttTrusted || !ftpsTrusted) {
                    JSObject result = new JSObject();
                    result.put("connected", false);
                    result.put("state", "offline");
                    result.put("requiresTrust", true);
                    result.put("certificateFingerprint", inspectedMqtt);
                    if (inspectedFtps != null) result.put("fileTransferFingerprint", inspectedFtps);
                    result.put("fileTransferVerified", inspectedFtps != null);
                    call.resolve(result);
                    return;
                }

                LevoMqttClient candidate = new LevoMqttClient(ip, serial, accessCode, inspectedMqtt, new LevoMqttClient.Listener() {
                    @Override
                    public void onMessage(JSONObject message) { mergeReport(message); }

                    @Override
                    public void onConnectionLost(String reason) {
                        lastConnectionError = reason;
                        connectedPrinter = null;
                    }
                });
                candidate.connect();
                boolean ftpsReady = false;
                String ftpsError = null;
                if (inspectedFtps != null) {
                    try {
                        new LevoFtpsClient(ip, accessCode, inspectedFtps).verify();
                        ftpsReady = true;
                    } catch (Exception error) {
                        ftpsError = error.getMessage() == null ? "Encrypted file-transfer authentication failed." : error.getMessage();
                    }
                }
                mqtt = candidate;
                mqttFingerprint = inspectedMqtt;
                ftpsFingerprint = inspectedFtps;
                connectedIp = ip;
                connectedAccessCode = accessCode;
                fileTransferVerified = ftpsReady;
                lastConnectionError = inspectedFtps == null
                    ? "MQTT is connected, but encrypted file transfer on port 990 is unavailable."
                    : ftpsError;

                JSObject printer = new JSObject();
                printer.put("id", serial);
                printer.put("name", "Bambu " + serial);
                printer.put("ip", ip);
                printer.put("serial", serial);
                connectedPrinter = printer;
                call.resolve(statusObject());
            } catch (SecurityException error) {
                disconnectInternal();
                call.reject(error.getMessage() + " " + MQTT_PORT_HELP, error);
            } catch (Exception error) {
                disconnectInternal();
                String detail = error.getMessage() == null ? "TLS/MQTT connection failed." : error.getMessage();
                call.reject(detail + " " + MQTT_PORT_HELP, error);
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        queue.execute(() -> {
            disconnectInternal();
            JSObject result = new JSObject();
            result.put("connected", false);
            result.put("state", "offline");
            call.resolve(result);
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) { call.resolve(statusObject()); }

    @PluginMethod
    public void beginPrintJob(PluginCall call) {
        Long projectBytes = call.getLong("projectBytes");
        Long gcodeBytes = call.getLong("gcodeBytes");
        String name = trim(call.getString("name"));
        if (projectBytes == null || gcodeBytes == null || projectBytes < 0 || gcodeBytes <= 0
            || projectBytes > MAX_PROJECT_BYTES || gcodeBytes > MAX_GCODE_BYTES) {
            call.reject("Invalid print-job sizes.");
            return;
        }
        if (!isConnected()) {
            call.reject("Connect and authenticate the printer before sending a print job.");
            return;
        }
        queue.execute(() -> {
            String id = UUID.randomUUID().toString().toLowerCase(Locale.US);
            File directory = new File(getContext().getCacheDir(), "levo-print-transfers/" + id);
            if (!directory.mkdirs() && !directory.isDirectory()) {
                call.reject("Could not prepare the private local transfer area.");
                return;
            }
            try {
                new File(directory, "project.3mf.part").createNewFile();
                new File(directory, "plate.gcode.part").createNewFile();
                transfers.put(id, new Transfer(directory, projectBytes, gcodeBytes, name == null ? "LEVO" : name));
                JSObject result = new JSObject();
                result.put("transferId", id);
                call.resolve(result);
            } catch (Exception error) {
                deleteRecursively(directory);
                call.reject("Could not prepare the local transfer area.", error);
            }
        });
    }

    @PluginMethod
    public void writePrintJobChunk(PluginCall call) {
        String transferId = call.getString("transferId");
        String asset = call.getString("asset");
        Integer index = call.getInt("index");
        String encoded = call.getString("base64");
        if (transferId == null || !("project".equals(asset) || "gcode".equals(asset)) || index == null || index < 0 || encoded == null) {
            call.reject("Invalid print-job chunk.");
            return;
        }
        if (encoded.length() > ((MAX_CHUNK_BYTES + 2) / 3) * 4) {
            call.reject("The print-job chunk exceeds the bridge limit.");
            return;
        }
        queue.execute(() -> {
            Transfer transfer = transfers.get(transferId);
            if (transfer == null) {
                call.reject("Unknown or expired transfer.");
                return;
            }
            int expected = "project".equals(asset) ? transfer.nextProjectChunk : transfer.nextGcodeChunk;
            if (index != expected) {
                call.reject("Out-of-order print-job chunk.");
                return;
            }
            try {
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (bytes.length <= 0 || bytes.length > MAX_CHUNK_BYTES) {
                    call.reject("The print-job chunk exceeds the bridge limit.");
                    return;
                }
                long written = "project".equals(asset) ? transfer.projectWritten : transfer.gcodeWritten;
                long expectedBytes = "project".equals(asset) ? transfer.projectBytes : transfer.gcodeBytes;
                if (written + bytes.length > expectedBytes) {
                    call.reject("The print-job asset is larger than declared.");
                    return;
                }
                File file = new File(transfer.directory, "project".equals(asset) ? "project.3mf.part" : "plate.gcode.part");
                try (FileOutputStream stream = new FileOutputStream(file, true)) { stream.write(bytes); }
                if ("project".equals(asset)) {
                    transfer.nextProjectChunk += 1;
                    transfer.projectWritten += bytes.length;
                } else {
                    transfer.nextGcodeChunk += 1;
                    transfer.gcodeWritten += bytes.length;
                }
                JSObject result = new JSObject();
                result.put("accepted", true);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not stage the print-job chunk.", error);
            }
        });
    }

    @PluginMethod
    public void commitPrintJob(PluginCall call) {
        String transferId = call.getString("transferId");
        String projectSha256 = call.getString("projectSha256");
        String gcodeSha256 = call.getString("gcodeSha256");
        if (transferId == null || projectSha256 == null || gcodeSha256 == null) {
            call.reject("Missing print-job checksums.");
            return;
        }
        queue.execute(() -> {
            Transfer transfer = transfers.remove(transferId);
            if (transfer == null) {
                call.reject("Unknown or expired transfer.");
                return;
            }
            try {
                if (!isConnected()) throw new IllegalStateException("The printer disconnected before upload.");
                if (!fileTransferVerified || ftpsFingerprint == null) {
                    throw new IllegalStateException("This printer did not expose the encrypted FTPS service on port 990.");
                }
                String state = currentState();
                if ("printing".equals(state) || "paused".equals(state)) {
                    throw new IllegalStateException("The printer is already busy. Stop or finish its current job first.");
                }

                File project = new File(transfer.directory, "project.3mf.part");
                File gcode = new File(transfer.directory, "plate.gcode.part");
                if (project.length() != transfer.projectBytes || gcode.length() != transfer.gcodeBytes
                    || !digest(project).equalsIgnoreCase(projectSha256)
                    || !digest(gcode).equalsIgnoreCase(gcodeSha256)) {
                    throw new IllegalArgumentException("Print-job checksum validation failed.");
                }
                validateGcode(gcode);

                String remoteName = safeRemoteName(transfer.name) + "-" + transferId.substring(0, 8) + ".gcode";
                new LevoFtpsClient(connectedIp, connectedAccessCode, ftpsFingerprint).upload(gcode, remoteName);

                LevoMqttClient client = mqtt;
                if (client == null || !client.isConnected()) throw new IllegalStateException("The printer disconnected after upload.");
                String sequence = client.nextSequence();
                JSONObject command = new JSONObject().put("print", new JSONObject()
                    .put("sequence_id", sequence)
                    .put("command", "gcode_file")
                    .put("param", remoteName));
                JSONObject acknowledgement;
                try {
                    acknowledgement = client.request(command, sequence, 15_000);
                } catch (TimeoutException timeout) {
                    if ("idle".equals(currentState())) throw new IllegalStateException("The file was uploaded, but the printer did not confirm the start command. Check its screen before retrying.", timeout);
                    acknowledgement = null;
                }
                verifyPrintAcknowledgement(acknowledgement, sequence);

                JSObject result = new JSObject();
                result.put("jobId", "lan-" + sequence);
                result.put("state", "queued");
                result.put("remoteFile", remoteName);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Could not send the print job." : error.getMessage(), error);
            } finally {
                deleteRecursively(transfer.directory);
            }
        });
    }

    @PluginMethod
    public void cancelPrintJob(PluginCall call) {
        String transferId = call.getString("transferId");
        queue.execute(() -> {
            Transfer transfer = transferId == null ? null : transfers.remove(transferId);
            if (transfer != null) deleteRecursively(transfer.directory);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        disconnectInternal();
        for (Transfer transfer : transfers.values()) deleteRecursively(transfer.directory);
        transfers.clear();
        queue.shutdownNow();
    }

    private boolean isConnected() {
        LevoMqttClient client = mqtt;
        return connectedPrinter != null && client != null && client.isConnected();
    }

    private JSObject statusObject() {
        JSObject result = new JSObject();
        boolean connected = isConnected();
        result.put("connected", connected);
        result.put("state", connected ? currentState() : "offline");
        result.put("fileTransferVerified", connected && fileTransferVerified);
        if (connectedPrinter != null && connected) result.put("printer", connectedPrinter);
        JSONObject print = currentPrintReport();
        if (print != null) {
            double progress = print.optDouble("mc_percent", Double.NaN);
            if (!Double.isNaN(progress)) result.put("progress", Math.max(0, Math.min(1, progress / 100.0)));
            double nozzle = print.optDouble("nozzle_temper", Double.NaN);
            if (!Double.isNaN(nozzle)) result.put("nozzleTemperature", nozzle);
            double bed = print.optDouble("bed_temper", Double.NaN);
            if (!Double.isNaN(bed)) result.put("bedTemperature", bed);
        }
        if (lastConnectionError != null) result.put("error", lastConnectionError);
        if (mqttFingerprint != null) result.put("certificateFingerprint", mqttFingerprint);
        if (ftpsFingerprint != null) result.put("fileTransferFingerprint", ftpsFingerprint);
        result.put("transportVerified", connected);
        return result;
    }

    private String currentState() {
        JSONObject print = currentPrintReport();
        if (print == null) return isConnected() ? "idle" : "offline";
        String state = print.optString("gcode_state", "IDLE").toUpperCase(Locale.US);
        if (state.contains("PAUSE")) return "paused";
        if (state.contains("RUN") || state.contains("PRINT") || state.contains("PREPARE") || state.contains("SLIC")) return "printing";
        if (state.contains("FAIL") || state.contains("ERROR")) return "error";
        return "idle";
    }

    private JSONObject currentPrintReport() {
        synchronized (reportLock) {
            return lastReport.optJSONObject("print");
        }
    }

    private void mergeReport(JSONObject incoming) {
        synchronized (reportLock) { mergeJson(lastReport, incoming); }
        lastConnectionError = null;
    }

    private static void mergeJson(JSONObject target, JSONObject source) {
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object next = source.opt(key);
            JSONObject existingObject = target.optJSONObject(key);
            if (next instanceof JSONObject && existingObject != null) mergeJson(existingObject, (JSONObject) next);
            else {
                try { target.put(key, next); } catch (Exception ignored) {}
            }
        }
    }

    private void disconnectInternal() {
        LevoMqttClient client = mqtt;
        mqtt = null;
        if (client != null) client.close();
        connectedPrinter = null;
        connectedIp = null;
        connectedAccessCode = null;
        mqttFingerprint = null;
        ftpsFingerprint = null;
        fileTransferVerified = false;
        lastConnectionError = null;
        synchronized (reportLock) { lastReport = new JSONObject(); }
    }

    private static void verifyPrintAcknowledgement(JSONObject acknowledgement, String sequence) {
        if (acknowledgement == null) return;
        JSONObject print = acknowledgement.optJSONObject("print");
        if (print == null || !sequence.equals(print.optString("sequence_id", ""))) {
            throw new IllegalStateException("The printer returned an invalid print acknowledgement.");
        }
        String result = print.optString("result", "");
        String reason = print.optString("reason", "");
        if (result.isEmpty() && !reason.isEmpty()) result = "failed";
        if (!"success".equalsIgnoreCase(result)) {
            throw new IllegalStateException(reason.isEmpty() ? "The printer rejected the print command." : reason);
        }
    }

    private static void validateGcode(File file) throws Exception {
        if (file.length() < 256) throw new IllegalArgumentException("The generated G-code is incomplete.");
        byte[] buffer = new byte[(int) Math.min(file.length(), 1024 * 1024)];
        int read;
        try (FileInputStream input = new FileInputStream(file)) { read = input.read(buffer); }
        if (read <= 0) throw new IllegalArgumentException("The generated G-code is empty.");
        String sample = new String(buffer, 0, read, StandardCharsets.UTF_8);
        if (sample.indexOf('\0') >= 0 || !(sample.contains("G0") || sample.contains("G1"))) {
            throw new IllegalArgumentException("The print payload is not valid text G-code.");
        }
        if (sample.matches("(?s).*(^|\\n)\\s*M112(?:\\s|;|$).*$")) {
            throw new IllegalArgumentException("Emergency-stop G-code was blocked.");
        }
    }

    private static String safeRemoteName(String value) {
        String safe = value == null ? "LEVO" : value.replaceAll("[^A-Za-z0-9._-]+", "-");
        safe = safe.replaceAll("^-+|-+$", "");
        if (safe.isEmpty()) safe = "LEVO";
        return safe.length() > 72 ? safe.substring(0, 72) : safe;
    }

    private static String digest(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read);
        }
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest.digest()) result.append(String.format(Locale.US, "%02x", value));
        return result.toString();
    }

    private static boolean portOpen(String host, int port, int timeout) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), timeout);
            return true;
        } catch (Exception ignored) { return false; }
    }

    private static List<String> localSubnetCandidates() throws Exception {
        Set<String> prefixes = new HashSet<>();
        for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!network.isUp() || network.isLoopback()) continue;
            for (InetAddress address : Collections.list(network.getInetAddresses())) {
                if (!(address instanceof Inet4Address) || !address.isSiteLocalAddress()) continue;
                byte[] own = address.getAddress();
                prefixes.add((own[0] & 255) + "." + (own[1] & 255) + "." + (own[2] & 255));
            }
        }
        List<String> orderedPrefixes = new ArrayList<>(prefixes);
        Collections.sort(orderedPrefixes);
        if (orderedPrefixes.size() > 3) orderedPrefixes = orderedPrefixes.subList(0, 3);
        List<String> result = new ArrayList<>(orderedPrefixes.size() * 254);
        for (String prefix : orderedPrefixes) for (int host = 1; host < 255; host++) result.add(prefix + "." + host);
        return result;
    }

    private static String trim(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }
}
