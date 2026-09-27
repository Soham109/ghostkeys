import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, easeOut } from "../theme";
import { SplitHeadline, words } from "../components/Type";
import { Grain } from "../components/Atmos";

/** The one bold typographic moment: huge Switzer 200 on the void, two phrases, hard cut on the beat. */
export const TypeMoment: React.FC<{ start: number; cut: number; end: number }> = ({ start, cut, end }) => {
  const f = useCurrentFrame();
  if (f < start || f >= end) return null;
  const rule = interpolate(f, [start + 4, start + 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {f < cut ? (
        <>
          <div style={{ position: "absolute", left: 128, top: 120 }}>
            <SplitHeadline lines={[words("Nothing"), words("*leaves*"), words("your Mac.")]} start={start} stagger={15} size={250} exitAt={cut - 12} />
          </div>
          <div style={{ position: "absolute", left: 128, right: 128, bottom: 118, height: 1, background: C.hairline, transform: `scaleX(${rule})`, transformOrigin: "left" }} />
        </>
      ) : (
        <>
          <div style={{ position: "absolute", right: 128, bottom: 150 }}>
            <SplitHeadline lines={[words("No new"), words("*hardware.*")]} start={cut} stagger={15} size={250} align="right" exitAt={end - 14} />
          </div>
          <div style={{ position: "absolute", left: 128, right: 128, top: 118, height: 1, background: C.hairline }} />
        </>
      )}
      <Grain />
    </AbsoluteFill>
  );
};
