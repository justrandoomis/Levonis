import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../app/globals.css";
import SlicerClient from "../../app/slicer-client";
import { exposeLevoNativeRuntime } from "./levo-printer-plugin";

exposeLevoNativeRuntime();

const root = document.getElementById("root");
if (!root) throw new Error("LEVO mobile root was not found.");

createRoot(root).render(
  <StrictMode>
    <SlicerClient />
  </StrictMode>,
);
