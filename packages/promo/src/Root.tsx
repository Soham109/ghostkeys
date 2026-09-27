import React from "react";
import { Composition } from "remotion";
import { Promo } from "./Promo";
import { Teaser } from "./Teaser";
import { FILM_LEN, TEASER_LEN } from "./timeline";
import { loadFonts } from "./theme";

loadFonts();

export const Root: React.FC = () => (
  <>
    <Composition id="GhostkeysPromo" component={Promo} defaultProps={{ vo: true }} durationInFrames={FILM_LEN} fps={30} width={1920} height={1080} />
    <Composition id="GhostkeysPromoNoVO" component={Promo} defaultProps={{ vo: false }} durationInFrames={FILM_LEN} fps={30} width={1920} height={1080} />
    <Composition id="GhostkeysTeaser" component={Teaser} durationInFrames={TEASER_LEN} fps={30} width={1080} height={1920} />
  </>
);
