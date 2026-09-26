import type { Metadata } from "next";
import { SubPage } from "@/components/site/SubPage";
import { FaqList } from "@/components/site/Info";

export const metadata: Metadata = {
  title: "FAQ | Ghostkeys",
  description: "Answers about typing, permissions, safety, pausing, open source and Windows.",
};

export default function FaqPage() {
  return (
    <SubPage label="FAQ" title={<>Asked <em>often.</em></>}>
      <FaqList />
    </SubPage>
  );
}
