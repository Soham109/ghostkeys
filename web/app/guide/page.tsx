import type { Metadata } from "next";
import { SubPage } from "@/components/site/SubPage";
import { Guide } from "@/components/site/Guide";

export const metadata: Metadata = {
  title: "Guide | Ghostkeys",
  description: "How Ghostkeys feels a tap, learns your hands, and turns the blank parts of your MacBook into keys.",
};

export default function GuidePage() {
  return (
    <SubPage label="Guide" title={<>How it <em>works.</em></>} lede="The sensor, the calibration, the zones, the gestures and the actions.">
      <Guide />
    </SubPage>
  );
}
