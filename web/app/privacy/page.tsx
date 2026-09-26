import type { Metadata } from "next";
import { SubPage } from "@/components/site/SubPage";
import { PrivacyList } from "@/components/site/Info";

export const metadata: Metadata = {
  title: "Privacy | Ghostkeys",
  description: "Ghostkeys runs on your Mac. No network, no telemetry, no account, nothing recorded.",
};

export default function PrivacyPage() {
  return (
    <SubPage label="Privacy" title={<>Nothing leaves your <em>Mac.</em></>}>
      <PrivacyList />
    </SubPage>
  );
}
