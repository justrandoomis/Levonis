package iq.levo.studio;

import static org.junit.Assert.assertArrayEquals;

import org.junit.Test;

public class LevoMqttClientTest {
    @Test
    public void encodesMqttRemainingLengthBoundaries() throws Exception {
        assertArrayEquals(new byte[]{0}, LevoMqttClient.encodeRemainingLength(0));
        assertArrayEquals(new byte[]{127}, LevoMqttClient.encodeRemainingLength(127));
        assertArrayEquals(new byte[]{(byte) 0x80, 0x01}, LevoMqttClient.encodeRemainingLength(128));
        assertArrayEquals(new byte[]{(byte) 0xff, 0x7f}, LevoMqttClient.encodeRemainingLength(16_383));
        assertArrayEquals(new byte[]{(byte) 0x80, (byte) 0x80, 0x01}, LevoMqttClient.encodeRemainingLength(16_384));
    }

    @Test(expected = java.io.IOException.class)
    public void rejectsOversizedMqttRemainingLength() throws Exception {
        LevoMqttClient.encodeRemainingLength(268_435_456);
    }
}
