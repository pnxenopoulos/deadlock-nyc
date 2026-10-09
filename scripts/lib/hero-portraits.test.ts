import { expect, test } from "bun:test";
import { heroPortraitsFromVdata } from "./hero-portraits";

test("prefers small portraits and falls back for newer heroes and development slots", () => {
  const text = `{
    hero_base = {
      m_HeroID = 0
    }
    hero_ratking = {
      m_HeroID = 84
      m_strIconImageSmall = panorama:"file://{images}/heroes/ratking_sm.psd"
      m_strTopBarVertical = panorama:"file://{images}/heroes/ratking_vertical.psd"
    }
    hero_chessmaster = {
      m_HeroID = 85
      m_strTopBarVertical = panorama:"file://{images}/heroes/chessmaster_vertical.psd"
      m_strIconHeroCard = panorama:"file://{images}/heroes/chessmaster_card.psd"
    }
    hero_baba = {
      m_HeroID = 88
      m_strTopBarVertical = panorama:"file://{images}/heroes/baba_vertical.psd"
    }
    hero_opera = {
      m_HeroID = 82
    }
  }`;
  expect(heroPortraitsFromVdata(text)).toEqual({
    "84": "/heroes/ratking_sm_psd.webp",
    "85": "/heroes/chessmaster_vertical_psd.webp",
    "88": "/heroes/baba_vertical_psd.webp",
    "82": "/heroes/generic_vertical_psd.webp",
  });
});

test("uses minimap and card portraits when higher-priority images are absent", () => {
  expect(heroPortraitsFromVdata(`{
    hero_minimap = {
      m_HeroID = 1
      m_strMinimapImage = panorama:"file://{images}/heroes/minimap.png"
      m_strIconHeroCard = panorama:"file://{images}/heroes/card.psd"
    }
    hero_card = {
      m_HeroID = 2
      m_strIconHeroCard = panorama:"file://{images}/heroes/card.psd"
    }
  }`)).toEqual({
    "1": "/heroes/minimap_png.webp",
    "2": "/heroes/card_psd.webp",
  });
});
