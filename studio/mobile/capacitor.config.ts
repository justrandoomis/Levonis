import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "iq.levo.studio",
  appName: "LEVO Studio",
  webDir: "dist",
  backgroundColor: "#101416",
  ios: {
    contentInset: "always",
    preferredContentMode: "mobile",
    scrollEnabled: false,
  },
  android: {
    backgroundColor: "#101416",
    allowMixedContent: false,
  },
};

export default config;
