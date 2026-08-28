import SlicerClient from "./slicer-client";
import { getStudioUser } from "./studio-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getStudioUser();
  // SlicerClient still types its prop as { displayName, email } from the old
  // header-based identity. The new handoff deliberately transfers NO email
  // (mandate §3 — minimum identity only), so email is honestly empty until
  // the shell's prop shape is updated by its owner. Guests stay null and can
  // keep editing without an account.
  return <SlicerClient user={user ? { displayName: user.displayName, email: "" } : null} />;
}
