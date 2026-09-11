package iq.levo.studio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(LevoPrinterPlugin.class);
        registerPlugin(LevoUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
